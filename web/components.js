/**
 * 若华控制面板 —— 公共部件。
 *
 * 本地化（T）、DOM 构造、接口调用、提示条、浮层、格式化。
 * 原生 JS，无框架无依赖；挂到 window.RH 上给 app.js 用。
 * 面向用户的文字一律走 T('webui.*')，文字在 src/i18n/locales/zh-CN/webui.json。
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'ruohua.web.token';
  const THEME_KEY = 'ruohua.web.theme';
  const PLACEHOLDER_RE = /\{(\w+)\}/g;

  // ————————————————— 本地化 —————————————————

  let table = Object.create(null);

  function interpolate(text, params) {
    return text.replace(PLACEHOLDER_RE, (whole, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
    );
  }

  /** 取文字。找不到就返回键本身，方便一眼看出漏配。 */
  function T(key, params) {
    const name = String(key ?? '');
    const text = Object.prototype.hasOwnProperty.call(table, name) ? table[name] : name;
    return params ? interpolate(String(text), params) : String(text);
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(table, String(key ?? ''));
  }

  /** 装进一张 { 键: 文字 } 表（页面启动时从 GET /api/i18n 拉）。 */
  function setTable(values) {
    const next = Object.create(null);
    for (const [key, value] of Object.entries(values ?? {})) next[key] = String(value);
    table = next;
    return table;
  }

  function tableSnapshot() {
    return { ...table };
  }

  function pairs(text) {
    const out = [];
    for (const item of String(text ?? '').split(',')) {
      const at = item.indexOf(':');
      if (at < 0) continue;
      const attr = item.slice(0, at).trim();
      const key = item.slice(at + 1).trim();
      if (attr && key) out.push([attr, key]);
    }
    return out;
  }

  /** 把页面里 data-i18n / data-i18n-attr 的文字填上。 */
  function applyI18nDom(root) {
    const scope = root ?? document;
    for (const node of scope.querySelectorAll('[data-i18n]')) node.textContent = T(node.getAttribute('data-i18n'));
    for (const node of scope.querySelectorAll('[data-i18n-attr]')) {
      for (const [attr, key] of pairs(node.getAttribute('data-i18n-attr'))) node.setAttribute(attr, T(key));
    }
  }

  // ————————————————— DOM —————————————————

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function frag(children) {
    const box = document.createDocumentFragment();
    for (const child of children ?? []) if (child) box.append(child);
    return box;
  }

  function clear(node) {
    node.textContent = '';
    return node;
  }

  function spinner() {
    return el('span', 'spinner');
  }

  function pill(text, tone) {
    const node = el('span', 'pill', text);
    node.dataset.tone = tone || 'muted';
    return node;
  }

  function kv(rows) {
    const list = el('dl', 'kv');
    for (const [key, value] of rows) {
      list.append(el('dt', null, key));
      list.append(el('dd', null, value));
    }
    return list;
  }

  /** meta 行：labelKey 文字 + 值；值是 undefined / 空串就不显示。 */
  function metaRow(label, value) {
    const row = el('div', 'meta-row');
    row.append(el('span', 'meta-label', label));
    row.append(el('span', 'meta-value', value === undefined || value === null || value === '' ? T('webui.status.empty') : value));
    return row;
  }

  /** 多行文本域按内容长高（提示词这种长的要好用）。 */
  function autoGrow(node, maxPx) {
    const max = maxPx || Math.round(window.innerHeight * 0.5);
    const fit = () => {
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight + 2, max)}px`;
    };
    node.addEventListener('input', fit);
    fit();
    return node;
  }

  // ————————————————— 提示条 —————————————————

  function toast(message, kind) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const node = el('div', `toast ${kind ?? ''}`.trim(), message);
    box.append(node);
    setTimeout(() => node.remove(), kind === 'error' ? 8000 : 4000);
  }

  function copyText(text) {
    const body = String(text ?? '');
    if (!body) {
      toast(T('webui.toast.copyEmpty'), 'error');
      return;
    }
    const done = () => toast(T('webui.toast.copied'), 'ok');
    const fallback = () => {
      try {
        const area = document.createElement('textarea');
        area.value = body;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        done();
      } catch (error) {
        toast(T('webui.toast.copyBlocked'), 'error');
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(body).then(done, fallback);
    else fallback();
  }

  // ————————————————— 接口 —————————————————

  let token = '';
  try {
    token = window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (error) {
    token = '';
  }

  function getToken() {
    return token;
  }

  function setToken(value) {
    token = String(value ?? '').trim();
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      /* 存不了就算了，本次会话仍然带着它 */
    }
    return token;
  }

  /** 页面没通过服务地址打开时，接口一个都调不通。 */
  function viaFile() {
    return window.location.protocol === 'file:';
  }

  function withToken(url) {
    if (token) url.searchParams.set('token', token);
    return url;
  }

  async function api(path, options) {
    const { method = 'GET', body = undefined } = options ?? {};
    if (viaFile()) throw new Error(T('webui.error.fileProtocol'));
    const url = withToken(new URL(path, window.location.origin));
    let response = null;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(T('webui.error.network', { message: error.message }));
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.error ?? T('webui.error.http', { status: response.status, body: text.slice(0, 200) });
      const failure = new Error(message);
      failure.status = response.status;
      failure.payload = payload;
      if (response.status === 401) failure.hint = T('webui.error.tokenHint');
      throw failure;
    }
    return payload ?? {};
  }

  function errorText(error) {
    if (!error) return T('webui.error.unknown');
    if (error.hint) return T('webui.error.withHint', { message: error.message, hint: error.hint });
    return String(error.message ?? error);
  }

  // ————————————————— 浮层 —————————————————

  let opened = null;

  function closePanel() {
    if (!opened) return;
    const { anchor, node } = opened;
    opened = null;
    node.remove();
    if (anchor?.isConnected) anchor.setAttribute('aria-expanded', 'false');
  }

  /** 点某个元素后弹一块浮层（芯片详情、令牌面板都用它）。 */
  function showPanel(anchor, build) {
    const alreadyOpen = opened?.anchor === anchor;
    closePanel();
    if (alreadyOpen) return null;
    const node = el('div', 'float-panel');
    const content = build?.();
    if (content) node.append(content);
    node.dataset.owner = '';
    document.body.append(node);
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(below)}px`;
    const height = node.offsetHeight;
    if (below + height > window.innerHeight - 8) {
      node.style.top = `${Math.round(Math.max(8, rect.top - height - 8))}px`;
    }
    anchor.setAttribute('aria-expanded', 'true');
    opened = { anchor, node, fresh: true };
    return node;
  }

  document.addEventListener('click', (event) => {
    if (!opened) return;
    if (opened.fresh) {
      opened.fresh = false;
      return;
    }
    if (opened.node.contains(event.target) || opened.anchor.contains(event.target)) return;
    closePanel();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const panel = document.getElementById('tokenPanel');
    if (panel && !panel.hidden) {
      panel.hidden = true;
      const button = document.getElementById('tokenBtn');
      button?.setAttribute('aria-expanded', 'false');
      button?.focus();
      return;
    }
    closePanel();
  });

  // ————————————————— 主题 —————————————————

  function applyTheme(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch (error) {
      /* 存不了不影响这次切换 */
    }
  }

  function initTheme() {
    let stored = null;
    try {
      stored = window.localStorage.getItem(THEME_KEY);
    } catch (error) {
      stored = null;
    }
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    applyTheme(stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light');
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
    });
  }

  // ————————————————— 格式化 —————————————————

  function formatBytes(size) {
    const value = Number(size);
    if (!Number.isFinite(value)) return T('webui.status.empty');
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return T('webui.status.empty');
    return number.toLocaleString('zh-CN');
  }

  function formatClock(ts) {
    const date = new Date(Number(ts) || Date.now());
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  function formatTime(ts) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return T('webui.status.empty');
    return new Date(value).toLocaleString('zh-CN');
  }

  /** 毫秒 → 人话时长。 */
  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return T('webui.status.empty');
    const total = Math.floor(value / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return T('webui.duration.hours', { hours, minutes });
    if (minutes > 0) return T('webui.duration.minutes', { minutes, seconds });
    return T('webui.duration.seconds', { seconds });
  }

  function pretty(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  function clone(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function same(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }

  window.RH = {
    T,
    has,
    setTable,
    tableSnapshot,
    applyI18nDom,
    el,
    frag,
    clear,
    spinner,
    pill,
    kv,
    metaRow,
    autoGrow,
    toast,
    copyText,
    api,
    errorText,
    getToken,
    setToken,
    viaFile,
    showPanel,
    closePanel,
    applyTheme,
    initTheme,
    formatBytes,
    formatNumber,
    formatClock,
    formatTime,
    formatDuration,
    pretty,
    clone,
    same,
  };
})();
