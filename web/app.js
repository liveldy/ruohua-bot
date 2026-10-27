/**
 * 若华控制面板 —— 页面逻辑。
 *
 * 六个页签：主页面 / 配置 / 环境变量 / 本地化键 / 监视终端 / 实时调试。
 * 面向用户的文字一律走 T('webui.*')，本地化键表由 GET /api/i18n 提供；
 * 标识符英文，注释可以中文。原生 JS，无框架无依赖。
 */
(function () {
  'use strict';

  const RH = window.RH;
  const T = RH.T;
  const el = RH.el;
  const api = RH.api;
  const toast = RH.toast;
  const errorText = RH.errorText;
  const formatBytes = RH.formatBytes;
  const formatNumber = RH.formatNumber;
  const formatClock = RH.formatClock;
  const formatTime = RH.formatTime;
  const formatDuration = RH.formatDuration;
  const pretty = RH.pretty;
  const clone = RH.clone;
  const same = RH.same;

  const PAGES = ['home', 'config', 'env', 'i18n', 'stickers', 'monitor', 'debug'];
  const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
  const LOG_LIMIT = 1500;
  const STATUS_MS = 4000;
  const PEERS_MS = 20000;
  const I18N_ROW_LIMIT = 500;

  const $ = (id) => document.getElementById(id);

  const state = {
    page: 'home',
    mode: null,
    status: null,
    statusError: null,
    peers: [],
    peersDismissed: false,
    services: { list: [], error: null, mode: null, pending: null, last: null },
    config: {
      files: [],
      dir: '',
      backupDir: '',
      current: null,
      detail: null,
      fields: [],
      base: null,
      draft: null,
      mode: 'form',
      baseText: '',
      jsonText: '',
      jsonError: null,
      saving: false,
      loaded: false,
      lastBackup: null,
    },
    env: {
      file: '',
      exists: false,
      groups: [],
      base: {},
      draft: {},
      textMode: false,
      text: '',
      unknown: [],
      types: {},
      saving: false,
      loaded: false,
    },
    i18n: {
      keys: [],
      values: {},
      defaults: {},
      overrides: {},
      draft: {},
      filter: '',
      onlyChanged: false,
      file: '',
      stat: '',
      saving: false,
      loaded: false,
    },
    stickers: {
      items: [],
      total: 0,
      stats: null,
      notes: [],
      note: '',
      keyword: '',
      tag: '',
      loading: false,
      loaded: false,
      error: null,
      current: null,
      currentId: null,
    },
    monitor: {
      entries: [],
      pending: 0,
      paused: false,
      pinned: true,
      expanded: new Set(),
      filter: { level: 'info', channel: 'all', keyword: '' },
    },
    debug: { tool: 'message', tools: [], last: {}, note: '' },
    timers: { status: null, peers: null, ws: null, ping: null, filter: null, stickers: null },
    ws: null,
    wsRetry: 0,
  };

  // ————————————————— 小板凳 —————————————————

  /** 需要二次确认的动作：点第一下先「上膛」，第二下才真做。 */
  function armAction(node, run) {
    if (node.dataset.armed === 'true') {
      node.dataset.armed = 'false';
      run();
      return;
    }
    node.dataset.armed = 'true';
    toast(T('webui.toast.armHint'), 'warn');
    setTimeout(() => {
      node.dataset.armed = 'false';
    }, 5000);
  }

  function busyButton(button, busy) {
    if (!button) return;
    if (busy) {
      button.dataset.busy = 'true';
      button.disabled = true;
      button.append(RH.spinner());
    } else {
      delete button.dataset.busy;
      button.disabled = false;
      button.querySelector('.spinner')?.remove();
    }
  }

  function emptyNote(text) {
    return el('p', 'empty', text);
  }

  function statusTone(status) {
    const map = {
      running: 'ok',
      ok: 'ok',
      ready: 'ok',
      connected: 'ok',
      attached: 'ok',
      active: 'ok',
      starting: 'warn',
      stopped: 'muted',
      idle: 'muted',
      unknown: 'muted',
      missing: 'error',
      error: 'error',
      failed: 'error',
      crashed: 'error',
    };
    return map[String(status ?? '').toLowerCase()] ?? 'muted';
  }

  // ————————————————— 主题 / 令牌 / 页签 —————————————————

  function initToken() {
    const panel = $('tokenPanel');
    const button = $('tokenBtn');
    const input = $('tokenInput');
    if (!panel || !button || !input) return;
    input.value = RH.getToken();
    button.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) input.focus();
    });
    $('tokenSave').addEventListener('click', () => {
      const value = RH.setToken(input.value);
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      toast(value ? T('webui.toast.tokenSaved') : T('webui.toast.tokenCleared'), 'ok');
      refreshStatus();
      connectLogs();
      loadServices().catch(() => {});
      loadConfigList().catch(() => {});
      loadEnv().catch(() => {});
      loadI18n().catch(() => {});
    });
    $('tokenClear').addEventListener('click', () => {
      RH.setToken('');
      input.value = '';
      toast(T('webui.toast.tokenCleared'));
    });
  }

  function initTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => showPage(tab.dataset.page));
    }
    $('statusBar')?.addEventListener('click', (event) => {
      if (state.mode !== 'standalone') return;
      if (event.target.closest('.chip')) return;
      showPage('home');
    });
    $('standaloneHint')?.addEventListener('click', () => showPage('home'));
  }

  function showPage(page, options) {
    const target = PAGES.includes(page) ? page : 'home';
    state.page = target;
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.page === target));
    for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${target}`;
    if (options?.updateHash !== false && location.hash !== `#${target}`) {
      try {
        history.replaceState(null, '', `#${target}`);
      } catch (error) {
        /* file:// 下不让改就别改 */
      }
    }
    if (target === 'home') loadServices().catch(() => {});
    if (target === 'config' && !state.config.loaded) loadConfigList().catch(() => {});
    if (target === 'env' && !state.env.loaded) loadEnv().catch(() => {});
    if (target === 'i18n') {
      if (!state.i18n.loaded) loadI18n().catch(() => {});
      else renderI18nList();
    }
    if (target === 'stickers' && !state.stickers.loaded) loadStickers();
    if (target === 'debug' && !state.debug.tools.length) loadTools().catch(() => {});
  }

  // ————————————————— 状态条 —————————————————

  const CHIP_DEFS = {
    web: {
      labelKey: 'webui.status.web',
      detailKey: 'webui.status.detail.web',
      raw: (status) => status.web,
      text(status) {
        const web = status.web ?? {};
        const address = web.url || (web.host && web.port ? `${web.host}:${web.port}` : '');
        if (!address) return T('webui.chip.webLost');
        return `${address} · ${T('webui.chip.webClients', { count: Number(web.clients ?? 0) })}`;
      },
      tone: () => 'muted',
    },
    uptime: {
      labelKey: 'webui.status.uptime',
      detailKey: 'webui.status.detail.uptime',
      raw: (status) => status.bot,
      text(status) {
        const bot = status.bot;
        if (!bot) return T('webui.status.empty');
        return bot.uptimeText || formatDuration(bot.uptimeMs ?? bot.uptime);
      },
      tone: (status) => (status.bot ? 'ok' : 'muted'),
    },
    onebot: {
      labelKey: 'webui.status.onebot',
      detailKey: 'webui.status.detail.onebot',
      raw: (status) => status.onebot,
      text(status) {
        const onebot = status.onebot;
        if (!onebot) return T('webui.status.empty');
        const parts = [onebot.connected ? T('webui.chip.onebot.on') : T('webui.chip.onebot.off')];
        if (onebot.mode) parts.push(onebot.mode);
        const account = onebot.loginInfo?.user_id ?? onebot.userId;
        if (account) parts.push(T('webui.chip.onebot.account', { id: account }));
        if (onebot.messagesIn || onebot.messagesOut) {
          parts.push(T('webui.chip.onebot.messages', { incoming: Number(onebot.messagesIn ?? 0), outgoing: Number(onebot.messagesOut ?? 0) }));
        }
        return parts.join(' · ');
      },
      tone: (status) => (status.onebot?.connected ? 'ok' : 'error'),
    },
    llm: {
      labelKey: 'webui.status.llm',
      detailKey: 'webui.status.detail.llm',
      raw: (status) => status.llm,
      text(status) {
        const llm = status.llm;
        if (!llm) return T('webui.status.empty');
        const usage = llm.usage;
        if (!usage) return llm.model ?? T('webui.status.empty');
        return T('webui.chip.llm', {
          tokens: formatNumber(usage.totalTokens),
          requests: Number(usage.requests ?? 0),
          model: llm.model ?? T('webui.status.empty'),
        });
      },
      tone: (status) => (status.llm ? 'ok' : 'muted'),
    },
    balance: {
      labelKey: 'webui.status.balance',
      detailKey: 'webui.status.detail.balance',
      raw: (status) => status.llm?.balance,
      text(status) {
        const llm = status.llm;
        if (!llm) return T('webui.status.empty');
        const balance = llm.balance;
        if (!balance) return T('webui.chip.balanceUnset');
        const amount = `${balance.balance ?? T('webui.status.empty')} ${balance.currency ?? ''}`.trim();
        return balance.available === false ? T('webui.chip.balanceUnavailable', { amount }) : amount;
      },
      tone: (status) => (status.llm?.balance?.available === false ? 'warn' : 'muted'),
    },
    memory: {
      labelKey: 'webui.status.memory',
      detailKey: 'webui.status.detail.memory',
      raw: (status) => status.memory,
      text(status) {
        const memory = status.memory;
        if (!memory) return T('webui.status.empty');
        return T('webui.chip.memory', {
          temporary: Number(memory.temporary ?? 0),
          permanent: Number(memory.permanent ?? 0),
          users: Number(memory.users ?? 0),
        });
      },
      tone: (status) => (status.memory ? 'ok' : 'muted'),
    },
    emotion: {
      labelKey: 'webui.status.emotion',
      detailKey: 'webui.status.detail.emotion',
      raw: (status) => status.emotion,
      text(status) {
        const emotion = status.emotion;
        if (!emotion) return T('webui.status.empty');
        return T('webui.chip.emotion', { users: Number(emotion.users ?? 0) });
      },
      tone: (status) => (status.emotion ? 'ok' : 'muted'),
    },
    tasks: {
      labelKey: 'webui.status.tasks',
      detailKey: 'webui.status.detail.tasks',
      raw: (status) => status.tasks,
      text(status) {
        const tasks = status.tasks;
        if (!tasks) return T('webui.status.empty');
        return T('webui.chip.tasks', { active: Number(tasks.active ?? 0), count: Number(tasks.count ?? 0) });
      },
      tone: (status) => (state.status?.tasks?.active ? 'warn' : 'muted'),
    },
    sidecar: {
      labelKey: 'webui.status.sidecar',
      detailKey: 'webui.status.detail.sidecar',
      raw: (status) => status.sidecar,
      text(status) {
        const sidecar = status.sidecar;
        if (!sidecar) return T('webui.status.empty');
        const stateText =
          sidecar.available === true
            ? T('webui.chip.sidecar.available')
            : sidecar.available === false
              ? T('webui.chip.sidecar.unavailable')
              : T('webui.chip.sidecar.unknown');
        return sidecar.pid ? T('webui.chip.sidecar.pid', { state: stateText, pid: sidecar.pid }) : stateText;
      },
      tone: (status) => (status.sidecar?.available === true ? 'ok' : status.sidecar?.available === false ? 'error' : 'muted'),
    },
  };

  function chipValueNode(id) {
    return document.querySelector(`[data-chip-value="${id}"]`);
  }

  function renderChips() {
    const standalone = state.mode === 'standalone';
    const bar = $('statusBar');
    if (bar) bar.dataset.mode = state.statusError ? 'error' : state.mode ?? 'unknown';
    for (const [id, def] of Object.entries(CHIP_DEFS)) {
      const chip = document.querySelector(`.chip[data-chip="${id}"]`);
      const value = chipValueNode(id);
      if (!chip || !value) continue;
      if (state.statusError) {
        chip.dataset.tone = 'error';
        value.textContent = T('webui.status.unreachable');
      } else if (!state.status) {
        chip.dataset.tone = 'muted';
        value.textContent = T('webui.state.loading');
      } else if (standalone) {
        chip.dataset.tone = 'warn';
        value.textContent = T('webui.status.standalone');
      } else {
        chip.dataset.tone = def.tone(state.status);
        value.textContent = def.text(state.status);
      }
    }
    const hint = $('standaloneHint');
    if (hint) hint.hidden = !standalone;
    const note = $('statusNote');
    if (note) {
      if (state.statusError) note.textContent = state.statusError;
      else if (standalone) note.textContent = '';
      else if (state.status?.note) note.textContent = state.status.note;
      else note.textContent = dispatcherNote();
    }
  }

  function dispatcherNote() {
    const dispatcher = state.status?.dispatcher;
    if (!dispatcher) return '';
    return T('webui.status.note', {
      received: Number(dispatcher.received ?? 0),
      replied: Number(dispatcher.replied ?? 0),
      running: Number(dispatcher.running ?? 0),
    });
  }

  function chipPanel(id) {
    const def = CHIP_DEFS[id];
    const box = el('div', 'panel-body');
    box.append(el('h3', null, T(def.labelKey)));
    box.append(el('p', 'hint', T(def.detailKey)));
    const raw = state.status ? def.raw(state.status) : null;
    if (raw === undefined || raw === null) {
      box.append(el('p', 'hint', T('webui.status.detail.empty')));
    } else {
      box.append(el('pre', 'panel-pre', pretty(raw)));
    }
    return box;
  }

  function initChips() {
    for (const chip of document.querySelectorAll('.chip')) {
      chip.addEventListener('click', () => {
        RH.showPanel(chip, () => chipPanel(chip.dataset.chip));
      });
    }
  }

  async function refreshStatus() {
    try {
      const data = await api('/api/status');
      state.status = data;
      state.statusError = null;
      state.mode = data.mode ?? null;
    } catch (error) {
      state.statusError = errorText(error);
      state.mode = null;
    }
    renderChips();
    renderMode();
    renderDebugBanner();
  }

  function startStatusPolling() {
    refreshStatus();
    if (state.timers.status) clearInterval(state.timers.status);
    state.timers.status = setInterval(() => {
      if (!document.hidden) refreshStatus();
    }, STATUS_MS);
  }

  // ————————————————— 别的端口上的面板 —————————————————

  async function loadPeers() {
    try {
      const data = await api('/api/peers');
      state.peers = Array.isArray(data.peers) ? data.peers : [];
    } catch (error) {
      state.peers = [];
    }
    renderPeers();
  }

  function renderPeers() {
    const box = $('peersHint');
    if (!box) return;
    const peer = state.peers.find((item) => item.mode === 'attached') ?? state.peers[0];
    if (!peer || state.peersDismissed) {
      box.hidden = true;
      return;
    }
    const url = peer.url || `http://127.0.0.1:${peer.port}`;
    $('peersText').textContent = T('webui.peers.found', { url });
    const link = $('peersLink');
    link.href = url;
    link.textContent = T('webui.peers.go');
    box.hidden = false;
  }

  function startPeersPolling() {
    loadPeers();
    if (state.timers.peers) clearInterval(state.timers.peers);
    state.timers.peers = setInterval(() => {
      if (!document.hidden) loadPeers();
    }, PEERS_MS);
  }

  // ————————————————— ① 主页面 —————————————————

  function renderMode() {
    const banner = $('modeBanner');
    const title = $('modeTitle');
    const desc = $('modeDesc');
    const start = $('modeStart');
    if (!banner) return;
    if (state.statusError) {
      banner.dataset.tone = 'error';
      title.textContent = T('webui.home.mode.unreachable');
      desc.textContent = state.statusError;
      start.hidden = true;
      return;
    }
    if (!state.mode) {
      banner.dataset.tone = 'loading';
      title.textContent = T('webui.state.loading');
      desc.textContent = T('webui.home.mode.loadingDesc');
      start.hidden = true;
      return;
    }
    if (state.mode === 'standalone') {
      banner.dataset.tone = 'warn';
      title.textContent = T('webui.home.mode.standalone');
      desc.textContent = T('webui.home.mode.standaloneDesc');
      const startable = findStartTarget();
      start.hidden = false;
      start.disabled = !startable || Boolean(state.services.pending);
      start.textContent = T('webui.home.mode.start');
      return;
    }
    banner.dataset.tone = 'ok';
    title.textContent = T('webui.home.mode.attached');
    desc.textContent = T('webui.home.mode.attachedDesc', {
      url: state.status?.web?.url ?? '',
      clients: Number(state.status?.web?.clients ?? 0),
      uptime: formatDuration(state.status?.web?.uptimeMs),
    });
    start.hidden = true;
  }

  /** 「启动若华」：找带 start 动作的那个服务。 */
  function findStartTarget() {
    for (const service of state.services.list) {
      const action = (service.actions ?? []).find((item) => item.id === 'start');
      if (action) return { service, action };
    }
    return null;
  }

  async function loadServices() {
    try {
      const data = await api('/api/services');
      state.services.list = Array.isArray(data.services) ? data.services : [];
      state.services.mode = data.mode ?? null;
      state.services.error = null;
    } catch (error) {
      state.services.error = errorText(error);
    }
    renderServices();
    renderMode();
  }

  function actionKey(service, action) {
    return `${service.id}:${action.id}`;
  }

  function actionButton(service, action, options) {
    const key = actionKey(service, action);
    const button = el('button', `btn ${action.primary ? 'btn-primary' : ''} ${options?.compact ? 'btn-small' : ''}`.trim(), T(action.labelKey));
    button.type = 'button';
    const pending = state.services.pending === key;
    if (pending) busyButton(button, true);
    button.addEventListener('click', () => runServiceAction(service, action, button));
    if (state.services.pending && !pending) button.disabled = true;
    return button;
  }

  async function runServiceAction(service, action, button) {
    if (state.services.pending) return;
    const key = actionKey(service, action);
    state.services.pending = key;
    state.services.last = null;
    renderServices();
    let ok = true;
    let message = '';
    try {
      const data = await api(`/api/services/${encodeURIComponent(service.id)}`, { method: 'POST', body: { action: action.id } });
      if (Array.isArray(data.services)) state.services.list = data.services;
      // 起了就是起了：不再自动开一个新标签页（要看它自己的面板，服务卡里就写着地址）
      message = T('webui.home.actionDone', { action: T(action.labelKey), status: T(service.statusKey) });
    } catch (error) {
      ok = false;
      message = errorText(error);
      toast(message, 'error');
    } finally {
      state.services.pending = null;
      state.services.last = { key, ok, message };
      if (ok) toast(message, 'ok');
      try {
        await loadServices();
      } catch (error) {
        /* loadServices 自己吞异常，这里兜底 */
      }
      renderServices();
    }
    void button;
  }

  function renderServices() {
    const grid = $('serviceGrid');
    if (!grid) return;
    grid.textContent = '';
    if (state.services.error) {
      grid.append(emptyNote(T('webui.home.servicesError', { message: state.services.error })));
      return;
    }
    if (!state.services.list.length) {
      grid.append(emptyNote(T('webui.home.servicesEmpty')));
      return;
    }
    for (const service of state.services.list) grid.append(serviceCard(service));
  }

  function serviceCard(service) {
    const card = el('article', 'card service-card');
    card.dataset.status = service.status ?? '';
    const head = el('header', 'service-head');
    const titleWrap = el('div', 'service-title');
    titleWrap.append(el('h3', null, T(service.titleKey)));
    if (service.descKey) titleWrap.append(el('p', 'hint', T(service.descKey)));
    head.append(titleWrap);
    head.append(RH.pill(T(service.statusKey), statusTone(service.status)));
    card.append(head);

    const detail = service.detail ?? [];
    if (detail.length) {
      const meta = el('div', 'meta-list');
      for (const row of detail) {
        // 明细的值可能是现成的值，也可能是一个本地化键 + 参数；给了本地化键就按它渲染
        // （后端对 mode/source 这类机器码会同时给出原值，优先原值会把 attached 这种内部词露到界面上）
        const value = row.valueKey
          ? T(row.valueKey, row.params ?? {})
          : row.value !== undefined && row.value !== null && row.value !== ''
            ? row.value
            : '';
        meta.append(RH.metaRow(T(row.labelKey), value));
      }
      card.append(meta);
    }

    if (service.note) card.append(el('p', 'note-line', String(service.note)));

    const actions = service.actions ?? [];
    if (actions.length) {
      const bar = el('div', 'card-actions');
      for (const action of actions) bar.append(actionButton(service, action));
      card.append(bar);
    }

    const last = state.services.last;
    if (last && String(last.key).startsWith(`${service.id}:`)) card.append(el('p', 'note-line', last.message));
    return card;
  }

  function initHome() {
    $('modeReload')?.addEventListener('click', () => {
      refreshStatus();
      loadServices().catch(() => {});
      loadPeers();
    });
    $('modeStart')?.addEventListener('click', (event) => {
      const target = findStartTarget();
      if (!target) {
        toast(T('webui.home.startUnavailable'), 'error');
        return;
      }
      runServiceAction(target.service, target.action, event.currentTarget);
    });
    $('peersClose')?.addEventListener('click', () => {
      state.peersDismissed = true;
      renderPeers();
    });
  }

  // ————————————————— ② 配置 —————————————————

  function getPath(source, path) {
    let node = source;
    for (const part of String(path).split('.')) {
      if (node === null || node === undefined) return undefined;
      node = node[part];
    }
    return node;
  }

  function setPath(target, path, value) {
    const parts = String(path).split('.');
    let node = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }

  async function loadConfigList() {
    const data = await api('/api/config');
    state.config.files = Array.isArray(data.files) ? data.files : [];
    state.config.dir = data.dir ?? '';
    state.config.backupDir = data.backupDir ?? '';
    state.config.loaded = true;
    renderConfigList();
    if (!state.config.current && state.config.files.length) await selectConfig(state.config.files[0].name);
    else refreshConfigMeta();
    return data;
  }

  /**
   * 配置文件在面板里的名字：「这个文件是干什么的（文件名）」。
   * 没写含义的（新加的文件）就只显示文件名，别硬塞一句废话。
   */
  function configFileLabel(name) {
    const file = `${name}.json`;
    const key = `webui.config.file.${name}`;
    const label = RH.has(key) ? T(key) : '';
    return label ? T('webui.config.fileLabel', { label, name: file }) : file;
  }

  /**
   * 列表里只留「这个文件是干什么的（文件名）」这两样 —— 文件大小、目录说明这类都放到选中的那一栏去，
   * 挤在列表里只会让长名字折行。
   */
  function renderConfigList() {
    const list = $('configList');
    if (!list) return;
    list.textContent = '';
    if (!state.config.files.length) {
      list.append(emptyNote(T('webui.config.noFiles')));
      return;
    }
    for (const file of state.config.files) {
      const item = el('button', 'file-item');
      item.type = 'button';
      item.setAttribute('aria-current', String(state.config.current === file.name));
      item.append(el('span', 'file-name', configFileLabel(file.name)));
      if (file.parseError) item.append(el('span', 'file-badge', T('webui.config.brokenJson')));
      item.addEventListener('click', () => {
        if (state.config.current === file.name) return;
        if (configDirtyCount() > 0) {
          armAction(item, () => selectConfig(file.name));
          return;
        }
        selectConfig(file.name);
      });
      list.append(item);
    }
  }

  function refreshConfigMeta() {
    const file = state.config.files.find((item) => item.name === state.config.current);
    const node = $('configMeta');
    if (!node) return;
    if (!file) {
      node.textContent = T('webui.config.pickFileHint');
      return;
    }
    node.textContent = T('webui.config.meta', {
      file: file.file ?? '',
      size: formatBytes(file.size),
      updatedAt: formatTime(file.updatedAt),
    });
  }

  async function selectConfig(name) {
    try {
      const data = await api(`/api/config/${encodeURIComponent(name)}`);
      const cfg = state.config;
      cfg.current = name;
      cfg.detail = data;
      cfg.fields = Array.isArray(data.fields) ? data.fields : [];
      cfg.base = data.parseError ? null : clone(data.content ?? {});
      cfg.draft = cfg.base ? clone(cfg.base) : {};
      cfg.baseText = data.parseError ? String(data.raw ?? '') : `${JSON.stringify(data.content ?? {}, null, 2)}\n`;
      cfg.jsonText = cfg.baseText;
      cfg.jsonError = data.parseError ? String(data.parseError) : null;
      cfg.mode = data.parseError || !cfg.fields.length ? 'json' : 'form';
      const title = $('configTitle');
      if (title) title.textContent = configFileLabel(name);
      const parseError = $('configParseError');
      if (parseError) {
        parseError.hidden = !data.parseError;
        parseError.textContent = data.parseError ? T('webui.config.parseError', { message: data.parseError }) : '';
      }
      const backup = $('configBackup');
      if (backup) {
        const saved = state.config.lastBackup;
        backup.textContent =
          saved && saved.name === name && saved.path
            ? T('webui.config.savedBackup', { path: saved.path })
            : state.config.backupDir
              ? T('webui.config.backupHint', { dir: state.config.backupDir })
              : '';
      }
      setConfigState('', T('webui.config.loaded'));
      renderConfigList();
      refreshConfigMeta();
      renderConfig();
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function setConfigState(kind, text) {
    const node = $('configState');
    if (!node) return;
    node.dataset.state = kind ?? '';
    node.textContent = text ?? '';
  }

  function configDirtyCount() {
    const cfg = state.config;
    if (!cfg.fields.length || cfg.mode === 'json') return 0;
    let count = 0;
    for (const field of cfg.fields) {
      if (field.secret) {
        // 脱敏字段：值仍是 ******** 就算没改
        const draft = getPath(cfg.draft, field.path);
        if (!same(draft, '********') && !same(draft, getPath(cfg.base, field.path))) count += 1;
        continue;
      }
      if (!same(getPath(cfg.draft, field.path), getPath(cfg.base, field.path))) count += 1;
    }
    return count;
  }

  function refreshConfigState() {
    const cfg = state.config;
    const changed = $('configChanged');
    const save = $('configSave');
    const revert = $('configRevert');
    const json = $('configJson');
    const format = $('configFormat');
    if (json) {
      json.textContent = cfg.mode === 'json' ? T('webui.config.toForm') : T('webui.config.toJson');
      json.setAttribute('aria-pressed', String(cfg.mode === 'json'));
    }
    if (format) format.hidden = cfg.mode !== 'json';
    if (cfg.mode === 'json') {
      const dirty = cfg.jsonText !== cfg.baseText;
      if (changed) {
        changed.hidden = !dirty;
        changed.textContent = dirty ? T('webui.config.jsonChanged') : '';
      }
      if (save) save.disabled = cfg.saving || !cfg.current || Boolean(cfg.jsonError) || !dirty;
      if (revert) revert.disabled = cfg.saving || !dirty;
      if (cfg.jsonError) setConfigState('error', T('webui.config.jsonInvalid', { message: cfg.jsonError }));
      else if (dirty) setConfigState('dirty', T('webui.config.dirtyJson'));
      return;
    }
    const count = configDirtyCount();
    if (changed) {
      changed.hidden = count === 0;
      changed.textContent = count ? T('webui.config.changed', { count }) : '';
    }
    if (save) save.disabled = cfg.saving || !cfg.current || !count;
    if (revert) revert.disabled = cfg.saving || !count;
  }

  function renderConfig() {
    const cfg = state.config;
    const form = $('configForm');
    const editor = $('editorWrap');
    const jsonMode = cfg.mode === 'json';
    if (editor) editor.hidden = !jsonMode;
    if (form) form.hidden = jsonMode;
    if (jsonMode) {
      const input = $('editorInput');
      if (input) {
        input.value = cfg.jsonText;
        input.disabled = !cfg.current;
      }
      renderBackdrop(cfg.jsonText, cfg.jsonError ? errorLineOf(cfg.jsonText, cfg.jsonError) : null);
    } else if (form) {
      renderConfigForm(form);
    }
    refreshConfigState();
  }

  /** 分组名：服务端可能给键（web.config.group.xxx）、给现成的名字，或者用 other 表示「其它」。 */
  function groupLabel(group) {
    const name = String(group ?? '').trim();
    if (!name || name.toLowerCase() === 'other') return T('webui.config.group.other');
    return RH.has(name) ? T(name) : name;
  }

  function groupFields(fields) {
    const groups = new Map();
    for (const field of fields) {
      const name = String(field.group ?? '').trim();
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(field);
    }
    return groups;
  }

  function renderConfigForm(host) {
    host.textContent = '';
    const cfg = state.config;
    if (!cfg.current) {
      host.append(emptyNote(T('webui.config.pickFile')));
      return;
    }
    if (!cfg.fields.length) {
      host.append(emptyNote(T('webui.config.noFields')));
      return;
    }
    const groups = groupFields(cfg.fields);
    let index = 0;
    for (const [name, fields] of groups) {
      const box = el('details', 'group');
      box.open = index < 3;
      index += 1;
      const summary = el('summary');
      summary.append(el('span', 'group-name', groupLabel(name)));
      summary.append(el('span', 'group-count', String(fields.length)));
      box.append(summary);
      const body = el('div', 'group-body');
      for (const field of fields) body.append(fieldRow(field));
      box.append(body);
      host.append(box);
    }
  }

  function fieldRow(field) {
    const row = el('div', 'field-row');
    row.dataset.path = field.path;
    const head = el('div', 'field-head');
    head.append(el('span', 'field-label', T(field.labelKey)));
    row.append(head);

    const control = el('div', 'field-control');
    const type = field.secret ? 'secret' : field.type || 'text';
    const commit = (value) => {
      setPath(state.config.draft, field.path, value);
      refreshConfigState();
    };

    if (type === 'boolean') {
      const label = el('label', 'switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(getPath(state.config.draft, field.path));
      const text = el('span', null, input.checked ? T('webui.value.on') : T('webui.value.off'));
      input.addEventListener('change', () => {
        text.textContent = input.checked ? T('webui.value.on') : T('webui.value.off');
        commit(input.checked);
      });
      label.append(input, text);
      control.append(label);
    } else if (type === 'number') {
      const input = el('input', 'input');
      input.type = 'number';
      input.step = 'any';
      const value = getPath(state.config.draft, field.path);
      input.value = value === undefined || value === null ? '' : String(value);
      input.addEventListener('input', () => {
        const raw = input.value.trim();
        commit(raw === '' ? null : Number(raw));
      });
      control.append(input);
    } else if (type === 'enum') {
      const select = el('select', 'input');
      const current = getPath(state.config.draft, field.path);
      for (const option of field.options ?? []) {
        const item = el('option');
        if (option !== null && typeof option === 'object') {
          item.value = String(option.value ?? '');
          item.textContent = option.labelKey ? T(option.labelKey) : String(option.label ?? option.value ?? '');
        } else {
          item.value = String(option);
          item.textContent = String(option);
        }
        select.append(item);
      }
      select.value = current === undefined || current === null ? '' : String(current);
      select.addEventListener('change', () => commit(select.value));
      control.append(select);
    } else if (type === 'textarea') {
      const area = el('textarea', 'input');
      area.rows = 3;
      area.value = String(getPath(state.config.draft, field.path) ?? '');
      RH.autoGrow(area);
      area.addEventListener('input', () => commit(area.value));
      control.append(area);
    } else if (type === 'list') {
      const sample = getPath(state.config.draft, field.path);
      const numeric = Array.isArray(sample) && sample.length > 0 && sample.every((item) => typeof item === 'number');
      const area = el('textarea', 'input');
      area.rows = 3;
      area.value = Array.isArray(sample) ? sample.join('\n') : '';
      RH.autoGrow(area);
      const error = el('p', 'field-error');
      error.hidden = true;
      area.addEventListener('input', () => {
        commit(
          area.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .map((line) => (numeric && line !== '' && Number.isFinite(Number(line)) ? Number(line) : line)),
        );
      });
      control.append(area, error);
    } else if (type === 'json') {
      const area = el('textarea', 'input code');
      area.rows = 6;
      area.value = pretty(getPath(state.config.draft, field.path) ?? null);
      RH.autoGrow(area, 420);
      const error = el('p', 'field-error');
      error.hidden = true;
      area.addEventListener('input', () => {
        try {
          const parsed = JSON.parse(area.value);
          error.hidden = true;
          commit(parsed);
        } catch (failure) {
          error.hidden = false;
          error.textContent = T('webui.config.jsonInvalid', { message: failure.message });
        }
      });
      control.append(area, error);
    } else if (type === 'secret') {
      const wrap = el('div', 'secret-wrap');
      const input = el('input', 'input');
      input.type = 'password';
      input.value = String(getPath(state.config.draft, field.path) ?? '');
      input.addEventListener('input', () => commit(input.value));
      const toggle = el('button', 'btn btn-ghost eye', T('webui.action.showValue'));
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        const hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        toggle.textContent = hidden ? T('webui.action.hideValue') : T('webui.action.showValue');
      });
      wrap.append(input, toggle);
      control.append(wrap);
    } else {
      const input = el('input', 'input');
      input.type = 'text';
      input.value = String(getPath(state.config.draft, field.path) ?? '');
      input.addEventListener('input', () => commit(input.value));
      control.append(input);
    }

    row.append(control);
    if (field.descKey) row.append(el('p', 'field-desc', T(field.descKey)));
    if (field.secret) row.append(el('p', 'field-desc', T('webui.config.secretHint')));
    return row;
  }

  function errorLineOf(text, message) {
    const lineMatch = /line (\d+)/i.exec(String(message ?? ''));
    if (lineMatch) return Number(lineMatch[1]);
    const positionMatch = /position (\d+)/i.exec(String(message ?? ''));
    if (positionMatch) {
      const position = Number(positionMatch[1]);
      return String(text ?? '').slice(0, position).split('\n').length;
    }
    return null;
  }

  function renderBackdrop(text, errorLine) {
    const backdrop = $('editorBackdrop');
    if (!backdrop) return;
    backdrop.textContent = '';
    const lines = String(text ?? '').split('\n');
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lines.length; index += 1) {
      const number = index + 1;
      const span = el('span', number === errorLine ? 'ln err-line' : 'ln', lines[index] === '' ? ' ' : lines[index]);
      fragment.append(span);
    }
    backdrop.append(fragment);
    const input = $('editorInput');
    backdrop.scrollTop = input?.scrollTop ?? 0;
    backdrop.scrollLeft = input?.scrollLeft ?? 0;
  }

  function validateJsonText() {
    const cfg = state.config;
    const text = cfg.jsonText;
    if (!text.trim()) {
      cfg.jsonError = T('webui.config.emptyJson');
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        cfg.jsonError = T('webui.config.jsonMustBeObject');
        return;
      }
      cfg.jsonError = null;
    } catch (error) {
      cfg.jsonError = error.message;
    }
  }

  function initConfig() {
    const input = $('editorInput');
    input?.addEventListener('input', () => {
      state.config.jsonText = input.value;
      validateJsonText();
      renderBackdrop(state.config.jsonText, state.config.jsonError ? errorLineOf(state.config.jsonText, state.config.jsonError) : null);
      refreshConfigState();
    });
    input?.addEventListener('scroll', () => {
      const backdrop = $('editorBackdrop');
      if (backdrop) {
        backdrop.scrollTop = input.scrollTop;
        backdrop.scrollLeft = input.scrollLeft;
      }
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = `${input.value.slice(0, start)}  ${input.value.slice(end)}`;
        input.selectionStart = start + 2;
        input.selectionEnd = start + 2;
        state.config.jsonText = input.value;
        validateJsonText();
        refreshConfigState();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveConfig();
      }
    });

    $('configSave')?.addEventListener('click', () => saveConfig());
    $('configRevert')?.addEventListener('click', () => {
      const cfg = state.config;
      if (cfg.mode === 'json') {
        cfg.jsonText = cfg.baseText;
        validateJsonText();
        renderConfig();
        setConfigState('', T('webui.config.reverted'));
        return;
      }
      cfg.draft = clone(cfg.base ?? {});
      renderConfigForm($('configForm'));
      refreshConfigState();
      setConfigState('', T('webui.config.reverted'));
    });
    $('configFormat')?.addEventListener('click', () => {
      const cfg = state.config;
      try {
        cfg.jsonText = `${JSON.stringify(JSON.parse(cfg.jsonText), null, 2)}\n`;
        cfg.jsonError = null;
        renderConfig();
        setConfigState('dirty', T('webui.config.formatted'));
      } catch (error) {
        toast(T('webui.config.jsonInvalid', { message: error.message }), 'error');
      }
    });
    $('configJson')?.addEventListener('click', () => {
      const cfg = state.config;
      if (!cfg.current) return;
      if (cfg.mode === 'form') {
        cfg.mode = 'json';
        cfg.jsonText = cfg.baseText;
        validateJsonText();
      } else if (cfg.fields.length) {
        cfg.mode = 'form';
      } else {
        toast(T('webui.config.noFields'), 'warn');
        return;
      }
      renderConfig();
    });
    $('configReload')?.addEventListener('click', () => {
      loadConfigList()
        .then(() => {
          toast(T('webui.toast.configReloaded'), 'ok');
          if (state.config.current) return selectConfig(state.config.current);
          return null;
        })
        .catch((error) => toast(errorText(error), 'error'));
    });
  }

  async function saveConfig() {
    const cfg = state.config;
    if (!cfg.current || cfg.saving) return;
    let body = null;
    if (cfg.mode === 'json') {
      validateJsonText();
      if (cfg.jsonError) {
        toast(T('webui.config.jsonInvalid', { message: cfg.jsonError }), 'error');
        return;
      }
      body = JSON.parse(cfg.jsonText);
    } else {
      body = cfg.draft;
    }
    cfg.saving = true;
    refreshConfigState();
    busyButton($('configSave'), true);
    try {
      const data = await api(`/api/config/${encodeURIComponent(cfg.current)}`, { method: 'PUT', body });
      const backup = data.backupRelative ?? data.backup ?? '';
      cfg.lastBackup = { name: cfg.current, path: backup };
      setConfigState('ok', T('webui.config.saved', { file: data.file ?? cfg.current, size: formatBytes(data.bytes) }));
      const backupNode = $('configBackup');
      if (backupNode) backupNode.textContent = backup ? T('webui.config.savedBackup', { path: backup }) : '';
      toast(data.levelChanged ? T('webui.config.savedLevel', { level: data.levelChanged }) : T('webui.toast.saved'), 'ok');
      cfg.saving = false;
      busyButton($('configSave'), false);
      await loadConfigList();
      await selectConfig(cfg.current);
    } catch (error) {
      setConfigState('error', T('webui.config.saveFailed', { message: errorText(error) }));
      toast(T('webui.config.saveFailed', { message: errorText(error) }), 'error');
    } finally {
      cfg.saving = false;
      busyButton($('configSave'), false);
      refreshConfigState();
    }
  }

  // ————————————————— ③ 环境变量 —————————————————

  function fieldType(field) {
    if (field.type === 'boolean' || field.type === 'number') return field.type;
    return 'text';
  }

  function coerceEnv(field, value) {
    if (fieldType(field) === 'boolean') {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
    }
    if (fieldType(field) === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : String(value ?? '');
    }
    return value === undefined || value === null ? '' : String(value);
  }

  async function loadEnv() {
    try {
      const data = await api('/api/env');
      const env = state.env;
      env.file = data.file ?? '';
      env.exists = Boolean(data.exists);
      env.groups = Array.isArray(data.groups) ? data.groups : [];
      env.base = {};
      env.types = {};
      for (const group of env.groups) {
        for (const field of group.fields ?? []) {
          env.base[field.key] = coerceEnv(field, field.value);
          env.types[field.key] = field;
        }
      }
      env.draft = clone(env.base);
      env.loaded = true;
      env.unknown = [];
      env.text = envToText();
      const meta = $('envMeta');
      if (meta) {
        const line = T('webui.env.meta', { file: env.file, exist: env.exists ? T('webui.env.exists') : T('webui.env.missing') });
        meta.textContent = data.note ? `${line} ${data.note}` : line;
      }
      renderEnv();
    } catch (error) {
      const form = $('envForm');
      if (form) {
        form.textContent = '';
        form.append(emptyNote(errorText(error)));
      }
      const meta = $('envMeta');
      if (meta) meta.textContent = '';
    }
  }

  function renderEnv() {
    const env = state.env;
    const host = $('envForm');
    const textWrap = $('envTextWrap');
    const textMode = env.textMode;
    if (textWrap) textWrap.hidden = !textMode;
    if (host) host.hidden = textMode;
    const button = $('envText');
    if (button) {
      button.textContent = textMode ? T('webui.env.toForm') : T('webui.env.toText');
      button.setAttribute('aria-pressed', String(textMode));
    }
    if (textMode) {
      const area = $('envTextArea');
      if (area) area.value = env.text;
      const unknown = $('envUnknown');
      if (unknown) {
        unknown.hidden = !env.unknown.length;
        unknown.textContent = env.unknown.length ? T('webui.env.unknownKeys', { keys: env.unknown.join(', ') }) : '';
      }
      refreshEnvState();
      return;
    }
    if (!host) return;
    host.textContent = '';
    if (!env.groups.length) {
      host.append(emptyNote(T('webui.env.noGroups')));
      return;
    }
    let index = 0;
    for (const group of env.groups) {
      const box = el('details', 'group');
      box.open = index < 4;
      index += 1;
      const summary = el('summary');
      summary.append(el('span', 'group-name', group.titleKey ? T(group.titleKey) : String(group.key ?? '')));
      summary.append(el('span', 'group-count', String((group.fields ?? []).length)));
      box.append(summary);
      const body = el('div', 'group-body');
      for (const field of group.fields ?? []) body.append(envRow(field));
      box.append(body);
      host.append(box);
    }
    refreshEnvState();
  }

  function envRow(field) {
    const row = el('div', 'field-row');
    row.dataset.key = field.key;
    const head = el('div', 'field-head');
    head.append(el('span', 'field-label', field.labelKey ? T(field.labelKey) : field.key));
    if (field.set === false) head.append(RH.pill(T('webui.env.notSet'), 'muted'));
    row.append(head);

    const control = el('div', 'field-control');
    const commit = (value) => {
      state.env.draft[field.key] = value;
      state.env.text = envToText();
      refreshEnvState();
    };
    const type = fieldType(field);

    if (type === 'boolean') {
      const label = el('label', 'switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(state.env.draft[field.key]);
      const text = el('span', null, input.checked ? T('webui.value.on') : T('webui.value.off'));
      input.addEventListener('change', () => {
        text.textContent = input.checked ? T('webui.value.on') : T('webui.value.off');
        commit(input.checked);
      });
      label.append(input, text);
      control.append(label);
    } else if (field.secret) {
      const wrap = el('div', 'secret-wrap');
      const input = el('input', 'input');
      input.type = 'password';
      input.value = String(state.env.draft[field.key] ?? '');
      if (field.example) input.placeholder = String(field.example);
      input.addEventListener('input', () => commit(input.value));
      const toggle = el('button', 'btn btn-ghost eye', T('webui.action.showValue'));
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        const hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        toggle.textContent = hidden ? T('webui.action.hideValue') : T('webui.action.showValue');
      });
      wrap.append(input, toggle);
      control.append(wrap);
    } else {
      const input = el('input', 'input');
      input.type = type === 'number' ? 'number' : 'text';
      if (type === 'number') input.step = 'any';
      input.value = state.env.draft[field.key] === undefined || state.env.draft[field.key] === null ? '' : String(state.env.draft[field.key]);
      if (field.example) input.placeholder = String(field.example);
      input.addEventListener('input', () => commit(type === 'number' ? Number(input.value) : input.value));
      control.append(input);
    }

    row.append(control);
    if (field.descKey) row.append(el('p', 'field-desc', T(field.descKey)));
    if (field.secret) row.append(el('p', 'field-desc', T('webui.env.secretHint')));
    return row;
  }

  function envToText() {
    const lines = [];
    for (const group of state.env.groups) {
      for (const field of group.fields ?? []) {
        const value = state.env.draft[field.key];
        lines.push(`${field.key}=${envValueText(value)}`);
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  function envValueText(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function parseEnvText(text) {
    const values = {};
    const unknown = [];
    for (const rawLine of String(text ?? '').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf('=');
      if (at < 0) {
        unknown.push(line);
        continue;
      }
      const key = line.slice(0, at).trim();
      let value = line.slice(at + 1).trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      if (!Object.prototype.hasOwnProperty.call(state.env.types, key)) {
        unknown.push(key);
        continue;
      }
      values[key] = coerceEnv(state.env.types[key], value);
    }
    return { values, unknown };
  }

  function envChangedKeys() {
    const env = state.env;
    return Object.keys(env.base).filter((key) => !same(env.draft[key], env.base[key]));
  }

  function refreshEnvState() {
    const env = state.env;
    const changed = envChangedKeys();
    const badge = $('envChanged');
    if (badge) {
      badge.hidden = changed.length === 0;
      badge.textContent = changed.length ? T('webui.env.changed', { count: changed.length }) : '';
    }
    const save = $('envSave');
    if (save) save.disabled = env.saving || changed.length === 0 || env.unknown.length > 0;
    const revert = $('envRevert');
    if (revert) revert.disabled = env.saving || changed.length === 0;
  }

  function initEnv() {
    $('envSave')?.addEventListener('click', () => saveEnv());
    $('envRevert')?.addEventListener('click', () => {
      state.env.draft = clone(state.env.base);
      state.env.text = envToText();
      state.env.unknown = [];
      renderEnv();
    });
    $('envText')?.addEventListener('click', () => {
      const env = state.env;
      if (!env.textMode) {
        env.text = envToText();
        env.unknown = [];
        env.textMode = true;
      } else {
        env.textMode = false;
      }
      renderEnv();
    });
    $('envTextArea')?.addEventListener('input', () => {
      const area = $('envTextArea');
      const env = state.env;
      env.text = area.value;
      const parsed = parseEnvText(env.text);
      env.unknown = parsed.unknown;
      env.draft = { ...env.draft, ...parsed.values };
      renderEnv();
    });
  }

  async function saveEnv() {
    const env = state.env;
    if (env.saving) return;
    if (env.textMode) {
      const parsed = parseEnvText(env.text);
      env.unknown = parsed.unknown;
      env.draft = { ...env.draft, ...parsed.values };
      if (env.unknown.length) {
        toast(T('webui.env.unknownKeys', { keys: env.unknown.join(', ') }), 'error');
        renderEnv();
        return;
      }
    }
    const changed = envChangedKeys();
    if (!changed.length) {
      toast(T('webui.env.nothingChanged'), 'warn');
      return;
    }
    const values = {};
    for (const key of changed) values[key] = env.draft[key];
    env.saving = true;
    refreshEnvState();
    busyButton($('envSave'), true);
    try {
      const data = await api('/api/env', { method: 'PUT', body: { values } });
      const list = Array.isArray(data.changed) ? data.changed : changed;
      toast(T('webui.env.saved', { count: list.length, keys: list.join(', ') }), 'ok');
      const backup = data.backup ?? data.backupRelative ?? '';
      const backupNode = $('envBackup');
      if (backupNode) backupNode.textContent = backup ? T('webui.env.savedBackup', { path: backup }) : '';
      setEnvState('ok', T('webui.env.savedState', { file: data.file ?? env.file }));
      await loadEnv();
    } catch (error) {
      setEnvState('error', T('webui.config.saveFailed', { message: errorText(error) }));
      toast(errorText(error), 'error');
    } finally {
      env.saving = false;
      busyButton($('envSave'), false);
      refreshEnvState();
    }
  }

  function setEnvState(kind, text) {
    const node = $('envState');
    if (!node) return;
    node.dataset.state = kind ?? '';
    node.textContent = text ?? '';
  }

  // ————————————————— ④ 本地化键 —————————————————

  async function loadI18n() {
    const data = await api('/api/i18n');
    const box = state.i18n;
    box.values = data.values ?? {};
    box.defaults = data.defaults ?? {};
    box.overrides = data.overrides ?? {};
    box.keys = Array.isArray(data.keys) && data.keys.length ? data.keys : Object.keys(box.values);
    box.file = data.file ?? data.overrideFile ?? '';
    box.loaded = true;
    box.draft = { ...box.values };
    RH.setTable(box.values);
    RH.applyI18nDom();
    rerender();
    const meta = $('i18nMeta');
    if (meta) meta.textContent = T('webui.i18n.meta', { locale: data.locale ?? '', count: box.keys.length });
    const fileNode = $('i18nFile');
    if (fileNode) fileNode.textContent = box.file ? T('webui.i18n.fileHint', { file: box.file }) : T('webui.i18n.noFileHint');
    if (state.page === 'i18n') renderI18nList();
    return data;
  }

  function namespaceOf(key) {
    const parts = String(key).split('.');
    return parts.length > 2 ? parts.slice(0, 2).join('.') : parts[0];
  }

  function i18nChangedKeys() {
    return state.i18n.keys.filter((key) => !same(state.i18n.draft[key], state.i18n.defaults[key]));
  }

  function visibleKeys() {
    const box = state.i18n;
    const filter = box.filter.trim().toLowerCase();
    return box.keys.filter((key) => {
      if (box.onlyChanged && same(box.draft[key], box.defaults[key])) return false;
      if (!filter) return true;
      if (key.toLowerCase().includes(filter)) return true;
      return String(box.draft[key] ?? '').toLowerCase().includes(filter);
    });
  }

  function renderI18nList() {
    const list = $('i18nList');
    if (!list) return;
    list.textContent = '';
    const keys = visibleKeys();
    const changed = i18nChangedKeys();
    const badge = $('i18nChanged');
    if (badge) {
      badge.hidden = changed.length === 0;
      badge.textContent = changed.length ? T('webui.i18n.changed', { count: changed.length }) : '';
    }
    const stat = $('i18nStat');
    if (stat) stat.textContent = T('webui.i18n.stat', { shown: Math.min(keys.length, I18N_ROW_LIMIT), total: state.i18n.keys.length });

    if (!keys.length) {
      list.append(emptyNote(state.i18n.keys.length ? T('webui.i18n.noMatch') : T('webui.i18n.emptyTable')));
      return;
    }
    const groups = new Map();
    for (const key of keys.slice(0, I18N_ROW_LIMIT)) {
      const ns = namespaceOf(key);
      if (!groups.has(ns)) groups.set(ns, []);
      groups.get(ns).push(key);
    }
    for (const [ns, groupKeys] of groups) {
      const box = el('details', 'group i18n-group');
      // 搜过就全部展开；只搜到几组也展开；本面板自己的文字默认展开
      box.open = Boolean(state.i18n.filter.trim()) || groups.size <= 12 || ns.startsWith('webui');
      const summary = el('summary');
      summary.append(el('span', 'group-name', ns));
      summary.append(el('span', 'group-count', String(groupKeys.length)));
      box.append(summary);
      const body = el('div', 'group-body');
      for (const key of groupKeys) body.append(i18nRow(key));
      box.append(body);
      list.append(box);
    }
    if (keys.length > I18N_ROW_LIMIT) list.append(emptyNote(T('webui.i18n.truncated', { limit: I18N_ROW_LIMIT })));
  }

  function i18nRow(key) {
    const box = state.i18n;
    const row = el('div', 'i18n-row');
    row.dataset.key = key;
    row.append(el('code', 'i18n-key', key));

    const value = el('textarea', 'input i18n-value');
    value.rows = 1;
    value.value = String(box.draft[key] ?? '');
    RH.autoGrow(value, 200);
    value.addEventListener('input', () => {
      box.draft[key] = value.value;
      decorateRow(row, key);
      refreshI18nState();
    });
    row.append(value);

    const def = el('div', 'i18n-default');
    const hasDefault = Object.prototype.hasOwnProperty.call(box.defaults, key);
    def.textContent = hasDefault ? String(box.defaults[key]) : T('webui.i18n.noDefault');
    if (!hasDefault) def.dataset.missing = 'true';
    def.title = T('webui.i18n.defaultValue');
    def.addEventListener('click', () => {
      box.draft[key] = box.defaults[key] ?? '';
      value.value = String(box.draft[key] ?? '');
      decorateRow(row, key);
      refreshI18nState();
    });
    row.append(def);

    const reset = el('button', 'btn btn-ghost i18n-reset', T('webui.i18n.reset'));
    reset.type = 'button';
    reset.title = T('webui.i18n.resetHint');
    reset.addEventListener('click', () => {
      box.draft[key] = box.defaults[key] ?? '';
      value.value = String(box.draft[key] ?? '');
      value.dispatchEvent(new Event('input'));
    });
    row.append(reset);

    decorateRow(row, key);
    return row;
  }

  function decorateRow(row, key) {
    const box = state.i18n;
    const changed = !same(box.draft[key], box.defaults[key]);
    const missing = !Object.prototype.hasOwnProperty.call(box.defaults, key);
    row.dataset.changed = String(changed || missing);
    const reset = row.querySelector('.i18n-reset');
    if (reset) reset.disabled = !changed;
    const value = row.querySelector('.i18n-value');
    if (value) value.title = changed ? T('webui.i18n.changedHint') : T('webui.i18n.sameHint');
  }

  function refreshI18nState() {
    const changed = i18nChangedKeys();
    const badge = $('i18nChanged');
    if (badge) {
      badge.hidden = changed.length === 0;
      badge.textContent = changed.length ? T('webui.i18n.changed', { count: changed.length }) : '';
    }
    const save = $('i18nSave');
    if (save) save.disabled = state.i18n.saving || changed.length === 0;
  }

  function initI18nPage() {
    $('i18nSearch')?.addEventListener('input', () => {
      state.i18n.filter = $('i18nSearch').value;
      renderI18nList();
    });
    $('i18nOnlyChanged')?.addEventListener('change', () => {
      state.i18n.onlyChanged = $('i18nOnlyChanged').checked;
      renderI18nList();
    });
    $('i18nResetAll')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      armAction(button, () => {
        for (const key of state.i18n.keys) state.i18n.draft[key] = state.i18n.defaults[key] ?? '';
        renderI18nList();
        refreshI18nState();
        setI18nState('dirty', T('webui.i18n.resetAllArmed'));
      });
    });
    $('i18nReload')?.addEventListener('click', () => {
      loadI18n()
        .then(() => toast(T('webui.toast.i18nReloaded'), 'ok'))
        .catch((error) => toast(errorText(error), 'error'));
    });
    $('i18nSave')?.addEventListener('click', () => saveI18n());
  }

  function setI18nState(kind, text) {
    const node = $('i18nState');
    if (!node) return;
    node.dataset.state = kind ?? '';
    node.textContent = text ?? '';
  }

  async function saveI18n() {
    const box = state.i18n;
    if (box.saving) return;
    const values = {};
    const reset = [];
    for (const key of box.keys) {
      if (same(box.draft[key], box.values[key])) continue;
      if (same(box.draft[key], box.defaults[key])) reset.push(key);
      else values[key] = box.draft[key];
    }
    if (!Object.keys(values).length && !reset.length) {
      toast(T('webui.i18n.nothingToSave'), 'warn');
      return;
    }
    box.saving = true;
    refreshI18nState();
    busyButton($('i18nSave'), true);
    try {
      const data = await api('/api/i18n', { method: 'PUT', body: { values, reset } });
      // 后端的 saved 可能是数字，也可能是 { file, count, bytes }
      const count =
        typeof data.saved === 'number'
          ? data.saved
          : Number(data.saved?.count ?? Object.keys(values).length);
      const file = data.file ?? data.saved?.file ?? data.overrideFile ?? box.file;
      toast(file ? T('webui.i18n.saved', { count, file }) : T('webui.i18n.savedCount', { count }), 'ok');
      setI18nState('ok', T('webui.i18n.savedState', { count, reset: reset.length }));
      await loadI18n();
    } catch (error) {
      setI18nState('error', T('webui.config.saveFailed', { message: errorText(error) }));
      toast(errorText(error), 'error');
    } finally {
      box.saving = false;
      busyButton($('i18nSave'), false);
      refreshI18nState();
    }
  }

  /** 本地化键换了：静态 HTML 与动态区块都要重画一遍。 */
  function rerender() {
    RH.applyI18nDom();
    renderChips();
    renderMode();
    renderServices();
    renderConfigList();
    refreshConfigMeta();
    if (state.config.current) renderConfig();
    if (state.env.loaded) {
      $('envText')?.replaceChildren(document.createTextNode(state.env.textMode ? T('webui.env.toForm') : T('webui.env.toText')));
      renderEnv();
    }
    if (state.stickers.loaded) renderStickers();
    updateLogNote(currentLogVisible());
    renderDebugBanner();
    renderResult(state.debug.tool, state.debug.last[state.debug.tool]);
  }

  // ————————————————— ⑤ 表情包 —————————————————

  const STICKER_PAGE_SIZE = 60;

  function stickerTagList(stats) {
    const byTag = stats?.byTag;
    const tags = [];
    if (Array.isArray(byTag)) {
      for (const item of byTag) {
        if (item && typeof item === 'object') tags.push(String(item.tag ?? item.name ?? ''));
        else tags.push(String(item));
      }
    } else if (byTag && typeof byTag === 'object') {
      tags.push(...Object.keys(byTag));
    }
    return tags.filter(Boolean).sort();
  }

  async function loadStickers(options) {
    const box = state.stickers;
    const append = Boolean(options?.append);
    if (box.loading) return;
    box.loading = true;
    const params = new URLSearchParams();
    if (box.keyword) params.set('keyword', box.keyword);
    if (box.tag) params.set('tag', box.tag);
    params.set('limit', String(STICKER_PAGE_SIZE));
    params.set('offset', String(append ? box.items.length : 0));
    try {
      const data = await api(`/api/stickers?${params.toString()}`);
      const items = Array.isArray(data.items) ? data.items : [];
      box.items = append ? [...box.items, ...items] : items;
      box.total = Number(data.total ?? box.items.length);
      box.stats = data.stats ?? null;
      box.notes = Array.isArray(data.notes) ? data.notes : [];
      box.note = data.note ?? '';
      box.error = null;
      box.loaded = true;
      if (box.current) {
        const found = box.items.find((item) => String(item.id) === String(box.current));
        if (found) box.current = found.id;
        else closeStickerDetail();
      }
    } catch (error) {
      box.error = errorText(error);
      if (!append) box.items = [];
      box.total = 0;
    } finally {
      box.loading = false;
      renderStickers();
    }
  }

  function renderStickers() {
    const box = state.stickers;
    if (!box.loaded && !box.error) return;
    renderStickerTags();
    const stat = $('stickerStat');
    if (stat) {
      const stats = box.stats ?? {};
      stat.textContent = box.error
        ? ''
        : T('webui.stickers.stat', {
            total: Number(stats.total ?? box.total ?? 0),
            learned: Number(stats.learned ?? 0),
            sent: Number(stats.sent ?? 0),
          });
    }
    const note = $('stickerNote');
    if (note) {
      const text = box.error ? T('webui.stickers.loadFailed', { message: box.error }) : box.note;
      note.hidden = !text;
      note.textContent = text ?? '';
      note.classList.toggle('banner-warn', !box.error);
    }
    const count = $('stickerCount');
    if (count) count.textContent = T('webui.stickers.count', { shown: box.items.length, total: box.total });

    const grid = $('stickerGrid');
    if (grid) {
      grid.textContent = '';
      if (box.error) {
        grid.append(emptyNote(box.error));
      } else if (!box.items.length && !box.loading) {
        grid.append(emptyNote(box.keyword || box.tag ? T('webui.stickers.emptyFiltered') : T('webui.stickers.empty')));
      } else {
        for (const item of box.items) grid.append(stickerCard(item));
      }
    }

    const more = $('stickerMore');
    if (more) {
      const remaining = box.total - box.items.length;
      more.hidden = box.error || remaining <= 0 || !box.items.length;
      const button = $('stickerMoreBtn');
      if (button) button.textContent = T('webui.stickers.loadMore', { count: Math.min(STICKER_PAGE_SIZE, remaining) });
    }

    renderStickerNotes();
    renderStickerDetail();
  }

  function renderStickerTags() {
    const select = $('stickerTag');
    if (!select) return;
    const tags = stickerTagList(state.stickers.stats);
    const current = state.stickers.tag;
    select.textContent = '';
    const all = el('option', null, T('webui.stickers.tagAll'));
    all.value = '';
    select.append(all);
    for (const tag of tags) {
      const option = el('option', null, tag);
      option.value = tag;
      select.append(option);
    }
    select.value = tags.includes(current) ? current : '';
    if (select.value !== current) state.stickers.tag = select.value;
  }

  function stickerCard(item) {
    const card = el('button', 'sticker-card');
    card.type = 'button';
    card.dataset.id = String(item.id);
    if (String(state.stickers.current?.id ?? state.stickers.currentId ?? '') === String(item.id)) card.dataset.open = 'true';
    card.append(stickerMedia(item, 'sticker-thumb'));
    if (item.title) card.append(el('span', 'sticker-title', String(item.title)));
    card.append(el('span', 'sticker-meaning', item.meaning ? String(item.meaning) : T('webui.stickers.noMeaning')));
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if (tags.length) {
      const row = el('span', 'sticker-tags');
      for (const tag of tags) row.append(el('span', 'tag-chip', String(tag)));
      card.append(row);
    }
    const used = Number(item.usedCount ?? 0);
    const meta = el('span', 'sticker-meta');
    meta.append(el('span', null, used ? T('webui.stickers.used', { count: used }) : T('webui.stickers.neverUsed')));
    meta.append(el('span', null, item.addedBy ? T('webui.stickers.addedBy', { name: item.addedBy }) : T('webui.stickers.addedByUnknown')));
    card.append(meta);
    card.addEventListener('click', () => openStickerDetail(item.id));
    return card;
  }

  /** 图片 + 加载失败占位。 */
  function stickerMedia(item, className) {
    const media = el('span', className);
    const image = el('img');
    image.loading = 'lazy';
    image.alt = item.meaning ? String(item.meaning) : '';
    const fallback = el('span', 'sticker-fallback', T('webui.stickers.imageFailed'));
    fallback.hidden = true;
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    image.addEventListener('load', () => {
      image.hidden = false;
      fallback.hidden = true;
    });
    if (item.url) image.src = String(item.url);
    else {
      image.hidden = true;
      fallback.hidden = false;
    }
    media.append(image, fallback);
    return media;
  }

  function renderStickerNotes() {
    const boxEl = $('stickerNotesBox');
    const list = $('stickerNotes');
    if (!boxEl || !list) return;
    const notes = state.stickers.notes;
    boxEl.hidden = !notes.length;
    list.textContent = '';
    for (const row of notes) {
      list.append(el('p', 'note-line', T('webui.stickers.noteRow', { userId: row.userId ?? '—', count: Number(row.count ?? 0) })));
    }
    const count = $('stickerNotesCount');
    if (count) count.textContent = String(notes.length);
  }

  async function openStickerDetail(id) {
    const local = state.stickers.items.find((item) => String(item.id) === String(id));
    if (local) {
      state.stickers.currentId = local.id;
      state.stickers.current = local;
      renderStickerDetail();
      renderStickers();
    }
    try {
      const data = await api(`/api/stickers/${encodeURIComponent(id)}`);
      if (data.item) {
        state.stickers.current = { ...(local ?? {}), ...data.item, url: data.url ?? data.item.url ?? local?.url };
        state.stickers.currentId = state.stickers.current.id ?? id;
        renderStickerDetail();
      }
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function closeStickerDetail() {
    state.stickers.current = null;
    state.stickers.currentId = null;
    renderStickerDetail();
    renderStickers();
  }

  function renderStickerDetail() {
    const panel = $('stickerDetail');
    if (!panel) return;
    const item = state.stickers.current;
    panel.hidden = !item;
    if (!item) return;
    const image = $('stickerDetailImage');
    const fallback = $('stickerDetailFallback');
    if (image) {
      image.hidden = false;
      image.alt = item.title ? String(item.title) : item.meaning ? String(item.meaning) : '';
      image.src = item.url ? String(item.url) : '';
      if (!item.url) image.hidden = true;
    }
    if (fallback) fallback.hidden = Boolean(item.url);
    const used = Number(item.usedCount ?? 0);
    const meta = $('stickerDetailMeta');
    if (meta) {
      meta.textContent = T('webui.stickers.meta', {
        used,
        addedAt: formatTime(item.addedAt),
        lastUsedAt: item.lastUsedAt ? formatTime(item.lastUsedAt) : T('webui.stickers.neverUsed'),
        size: item.bytes ? formatBytes(item.bytes) : T('webui.status.empty'),
      });
    }
    const title = $('stickerTitle');
    if (title) title.value = item.title ? String(item.title) : '';
    const meaning = $('stickerMeaning');
    if (meaning) meaning.value = item.meaning ? String(item.meaning) : '';
    const tags = $('stickerTags');
    if (tags) tags.value = Array.isArray(item.tags) ? item.tags.join(', ') : '';
    setStickerState('', item.file ?? '');
  }

  function setStickerState(kind, text) {
    const node = $('stickerState');
    if (node) {
      node.dataset.state = kind ?? '';
      node.textContent = kind === 'ok' ? T('webui.stickers.saved') : '';
    }
    const hint = $('stickerHint');
    if (hint) hint.textContent = text ?? '';
  }

  /**
   * 让模型看图，把标题 / 内容描述 / 时机标签填进表单（不写库：看过再保存）。
   * @param {{ silent?: boolean }} options silent = 保存前的自动识别，不弹成功提示
   */
  async function describeSticker({ silent = false } = {}) {
    const item = state.stickers.current;
    if (!item) return false;
    busyButton($('stickerDescribe'), true);
    setStickerState('', T('webui.stickers.describing'));
    try {
      const data = await api(`/api/stickers/${encodeURIComponent(item.id)}/describe`, { method: 'POST' });
      const suggestion = data.suggestion ?? {};
      const title = $('stickerTitle');
      const meaning = $('stickerMeaning');
      const tags = $('stickerTags');
      if (title && suggestion.title) title.value = String(suggestion.title);
      if (meaning && suggestion.meaning) meaning.value = String(suggestion.meaning);
      if (tags && Array.isArray(suggestion.tags) && suggestion.tags.length) tags.value = suggestion.tags.join(', ');
      setStickerState('ok', '');
      if (!silent) toast(T('webui.stickers.described'), 'ok');
      return Boolean(suggestion.title || suggestion.meaning);
    } catch (error) {
      setStickerState('error', '');
      toast(T('webui.stickers.describeFailed', { message: errorText(error) }), 'error');
      return false;
    } finally {
      busyButton($('stickerDescribe'), false);
    }
  }

  async function saveSticker() {
    const item = state.stickers.current;
    if (!item) return;
    // 标题与内容描述都还空着就先自动认一次：认不出也照存，别把人卡在这儿
    if (!$('stickerTitle')?.value.trim() && !$('stickerMeaning')?.value.trim()) {
      await describeSticker({ silent: true });
    }
    const title = $('stickerTitle')?.value.trim() ?? '';
    const meaning = $('stickerMeaning')?.value.trim() ?? '';
    const tags = ($('stickerTags')?.value ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    busyButton($('stickerSave'), true);
    try {
      const data = await api(`/api/stickers/${encodeURIComponent(item.id)}`, { method: 'PUT', body: { title, meaning, tags } });
      const next = { ...item, ...(data.item ?? {}), title, meaning, tags };
      state.stickers.current = next;
      state.stickers.items = state.stickers.items.map((row) => (String(row.id) === String(item.id) ? { ...row, ...next } : row));
      renderStickerDetail();
      renderStickers();
      toast(T('webui.stickers.saved'), 'ok');
    } catch (error) {
      setStickerState('error', '');
      toast(T('webui.stickers.saveFailed', { message: errorText(error) }), 'error');
    } finally {
      busyButton($('stickerSave'), false);
    }
  }

  /** 删掉当前这张：索引与文件一起删（后端 library.remove 干的）。 */
  async function deleteSticker() {
    const item = state.stickers.current;
    if (!item) return;
    busyButton($('stickerDelete'), true);
    try {
      await api(`/api/stickers/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      state.stickers.items = state.stickers.items.filter((row) => String(row.id) !== String(item.id));
      state.stickers.total = Math.max(0, Number(state.stickers.total ?? 0) - 1);
      closeStickerDetail();
      toast(T('webui.stickers.deleted'), 'ok');
      loadStickers();
    } catch (error) {
      toast(T('webui.stickers.deleteFailed', { message: errorText(error) }), 'error');
    } finally {
      busyButton($('stickerDelete'), false);
    }
  }

  function initStickers() {
    $('stickerSearch')?.addEventListener('input', () => {
      state.stickers.keyword = $('stickerSearch').value.trim();
      clearTimeout(state.timers.stickers);
      state.timers.stickers = setTimeout(() => loadStickers(), 300);
    });
    $('stickerTag')?.addEventListener('change', () => {
      state.stickers.tag = $('stickerTag').value;
      loadStickers();
    });
    $('stickerReload')?.addEventListener('click', () => loadStickers());
    $('stickerMoreBtn')?.addEventListener('click', () => loadStickers({ append: true }));
    $('stickerSave')?.addEventListener('click', () => saveSticker());
    $('stickerDescribe')?.addEventListener('click', () => describeSticker());
    // 删图是不可逆的：点第一下上膛、第二下才真删（按钮会整块变红）
    $('stickerDelete')?.addEventListener('click', (event) => armAction(event.currentTarget, deleteSticker));
    $('stickerClose')?.addEventListener('click', () => closeStickerDetail());
  }

  // ————————————————— ⑥ 监视终端 —————————————————

  function matchEntry(entry, filter) {
    const rank = LEVEL_RANK[entry.level] ?? LEVEL_RANK.info;
    if (rank < (LEVEL_RANK[filter.level] ?? LEVEL_RANK.debug)) return false;
    if (filter.channel !== 'all' && entry.channel !== filter.channel) return false;
    if (filter.keyword) {
      const haystack = `${entry.name ?? ''} ${entry.message ?? ''} ${entry.meta ? JSON.stringify(entry.meta) : ''}`.toLowerCase();
      if (!haystack.includes(filter.keyword)) return false;
    }
    return true;
  }

  function logRow(entry) {
    const row = el('article', 'log-row');
    row.dataset.level = entry.level ?? 'info';
    const line = el('div', 'log-line');
    line.append(el('time', 'log-time', formatClock(entry.ts)));
    line.append(el('span', 'log-badge', String(entry.level ?? 'info').toUpperCase()));
    line.append(el('span', 'log-source', entry.name ?? 'ruohua'));
    const channel = entry.channel && entry.channel !== 'app' ? `[${entry.channel}] ` : '';
    line.append(el('span', 'log-msg', `${channel}${entry.message ?? ''}`));
    row.append(line);
    if (entry.meta) {
      row.classList.add('has-meta');
      row.title = T('webui.log.metaHint');
      const meta = el('pre', 'log-meta', pretty(entry.meta));
      meta.hidden = !state.monitor.expanded.has(entry.id);
      row.append(meta);
      row.addEventListener('click', () => {
        if (state.monitor.expanded.has(entry.id)) state.monitor.expanded.delete(entry.id);
        else state.monitor.expanded.add(entry.id);
        meta.hidden = !meta.hidden;
      });
    }
    return row;
  }

  function currentLogVisible() {
    return state.monitor.entries.filter((entry) => matchEntry(entry, state.monitor.filter)).length;
  }

  function renderLogs() {
    const list = $('logList');
    if (!list) return;
    const rows = state.monitor.entries.filter((entry) => matchEntry(entry, state.monitor.filter));
    list.textContent = '';
    if (!rows.length) {
      list.append(emptyNote(state.monitor.entries.length ? T('webui.log.noMatch') : T('webui.log.empty')));
    } else {
      const fragment = document.createDocumentFragment();
      for (const entry of rows) fragment.append(logRow(entry));
      list.append(fragment);
    }
    if (state.monitor.pinned) list.scrollTop = list.scrollHeight;
    updateLogNote(rows.length);
  }

  function appendLogs(entries) {
    const list = $('logList');
    if (!list) return;
    if (list.querySelector('.empty')) list.textContent = '';
    const visible = entries.filter((entry) => matchEntry(entry, state.monitor.filter));
    const fragment = document.createDocumentFragment();
    for (const entry of visible) fragment.append(logRow(entry));
    list.append(fragment);
    while (list.childElementCount > LOG_LIMIT) list.firstElementChild.remove();
    if (state.monitor.pinned) list.scrollTop = list.scrollHeight;
    updateLogNote(currentLogVisible());
  }

  function updateLogNote(visibleCount) {
    const note = $('logNote');
    if (note) {
      const parts = [T('webui.log.showing', { visible: visibleCount, total: state.monitor.entries.length })];
      if (state.monitor.paused) parts.push(T('webui.log.pausedNote', { pending: state.monitor.pending }));
      parts.push(state.mode === 'standalone' ? T('webui.log.source.standalone') : T('webui.log.source.live'));
      note.textContent = parts.join(' · ');
    }
    const count = $('logCount');
    if (count) count.textContent = T('webui.log.count', { count: state.monitor.entries.length });
  }

  function pushEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    state.monitor.entries.push(...entries);
    if (state.monitor.entries.length > LOG_LIMIT) state.monitor.entries.splice(0, state.monitor.entries.length - LOG_LIMIT);
    if (state.monitor.paused) {
      state.monitor.pending += entries.length;
      updateLogNote(currentLogVisible());
      return;
    }
    appendLogs(entries);
  }

  function initMonitor() {
    const list = $('logList');
    list?.addEventListener('scroll', () => {
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      state.monitor.pinned = atBottom;
      const follow = $('logFollow');
      if (follow) follow.checked = atBottom;
    });
    $('logFollow')?.addEventListener('change', () => {
      state.monitor.pinned = $('logFollow').checked;
      if (state.monitor.pinned && list) list.scrollTop = list.scrollHeight;
    });
    $('logPause')?.addEventListener('click', () => {
      state.monitor.paused = !state.monitor.paused;
      const button = $('logPause');
      button.textContent = state.monitor.paused ? T('webui.log.resume') : T('webui.log.pause');
      if (!state.monitor.paused) {
        const pending = state.monitor.pending;
        state.monitor.pending = 0;
        renderLogs();
        toast(T('webui.log.resumeBacklog', { count: pending }));
      }
      updateLogNote(currentLogVisible());
    });
    $('logClear')?.addEventListener('click', () => {
      state.monitor.entries = [];
      state.monitor.expanded.clear();
      state.monitor.pending = 0;
      renderLogs();
    });

    const onFilterChange = () => {
      state.monitor.filter = {
        level: $('logLevel').value,
        channel: $('logChannel').value,
        keyword: $('logKeyword').value.trim().toLowerCase(),
      };
      renderLogs();
      scheduleFilterPush();
    };
    $('logLevel')?.addEventListener('change', onFilterChange);
    $('logChannel')?.addEventListener('change', onFilterChange);
    $('logKeyword')?.addEventListener('input', () => {
      clearTimeout(state.timers.filter);
      state.timers.filter = setTimeout(onFilterChange, 250);
    });
    renderLogs();
  }

  function scheduleFilterPush() {
    const socket = state.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'filter', ...state.monitor.filter }));
    } catch (error) {
      /* 忽略 */
    }
  }

  function setConn(name, note) {
    const dot = $('connDot');
    if (!dot) return;
    dot.dataset.state = name;
    if (note) dot.title = note;
  }

  function connectLogs() {
    if (state.ws) {
      try {
        state.ws.close();
      } catch (error) {
        /* 忽略 */
      }
      state.ws = null;
    }
    if (state.timers.ws) clearTimeout(state.timers.ws);
    if (RH.viaFile()) {
      setConn('offline', T('webui.top.conn.file'));
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ ...state.monitor.filter });
    if (RH.getToken()) params.set('token', RH.getToken());
    const url = `${protocol}//${location.host}/ws/logs?${params.toString()}`;
    setConn('connecting', T('webui.top.conn.connecting'));

    let socket = null;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      setConn('offline', T('webui.top.conn.error'));
      return;
    }
    state.ws = socket;

    socket.addEventListener('open', () => {
      state.wsRetry = 0;
      setConn('online', T('webui.top.conn.online'));
      if (state.timers.ping) clearInterval(state.timers.ping);
      state.timers.ping = setInterval(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          try {
            state.ws.send(JSON.stringify({ type: 'ping' }));
          } catch (error) {
            /* 忽略 */
          }
        }
      }, 25000);
    });

    socket.addEventListener('message', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (payload.type === 'hello') {
        if ((payload.mode ?? null) !== state.mode) {
          state.mode = payload.mode ?? state.mode;
          renderChips();
          renderMode();
          renderDebugBanner();
          updateLogNote(currentLogVisible());
        }
        return;
      }
      if (payload.type === 'logs') pushEntries(payload.entries);
    });

    socket.addEventListener('close', () => {
      if (state.timers.ping) clearInterval(state.timers.ping);
      setConn('offline', T('webui.top.conn.closed'));
      state.wsRetry += 1;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(state.wsRetry - 1, 4));
      state.timers.ws = setTimeout(connectLogs, delay);
    });

    socket.addEventListener('error', () => {
      setConn('offline', T('webui.top.conn.error'));
    });
  }

  // ————————————————— ⑥ 实时调试 —————————————————

  function renderDebugBanner() {
    const banner = $('debugBanner');
    if (!banner) return;
    const standalone = state.mode === 'standalone';
    banner.hidden = !standalone;
    banner.textContent = standalone ? T('webui.debug.standalone') : '';
    for (const button of document.querySelectorAll('[data-action="run"]')) button.disabled = standalone;
  }

  function initDebug() {
    for (const tab of document.querySelectorAll('.subtab')) {
      tab.addEventListener('click', () => selectDebugTool(tab.dataset.tool));
    }
    $('msgScene')?.addEventListener('change', () => {
      $('msgGroupField').hidden = $('msgScene').value !== 'group';
    });
    $('toolName')?.addEventListener('change', () => {
      const tool = state.debug.tools.find((item) => item.name === $('toolName').value);
      $('toolDesc').textContent = tool ? `${tool.description}${tool.sensitive ? T('webui.debug.toolSensitive') : ''}` : '';
    });
    for (const button of document.querySelectorAll('[data-action="run"]')) button.addEventListener('click', runDebug);
    for (const button of document.querySelectorAll('[data-action="copy"]')) {
      button.addEventListener('click', () => {
        const text = state.debug.last[state.debug.tool];
        if (!text) {
          toast(T('webui.debug.noResult'), 'error');
          return;
        }
        RH.copyText(text);
      });
    }
    for (const button of document.querySelectorAll('[data-action="clear"]')) {
      button.addEventListener('click', () => {
        state.debug.last[state.debug.tool] = '';
        renderResult(state.debug.tool, '');
        $('runState').textContent = '';
      });
    }
  }

  function selectDebugTool(tool) {
    state.debug.tool = tool;
    for (const tab of document.querySelectorAll('.subtab')) tab.setAttribute('aria-selected', String(tab.dataset.tool === tool));
    for (const form of document.querySelectorAll('.tool-form')) form.hidden = form.dataset.tool !== tool;
    renderResult(tool, state.debug.last[tool]);
  }

  async function loadTools() {
    const select = $('toolName');
    try {
      const data = await api('/api/tools');
      state.debug.tools = Array.isArray(data.tools) ? data.tools : [];
      state.debug.note = data.note ?? '';
      if (!select) return;
      select.textContent = '';
      if (!state.debug.tools.length) {
        select.append(new Option(state.debug.note ? T('webui.debug.noToolsStandalone') : T('webui.debug.noTools'), ''));
        $('toolDesc').textContent = state.debug.note ?? '';
        return;
      }
      for (const tool of state.debug.tools) {
        select.append(new Option(`${tool.name}${tool.sensitive ? T('webui.debug.toolSensitive') : ''}`, tool.name));
      }
      $('toolDesc').textContent = state.debug.tools[0]?.description ?? '';
    } catch (error) {
      if (select) {
        select.textContent = '';
        select.append(new Option(T('webui.debug.noTools'), ''));
      }
      $('toolDesc').textContent = errorText(error);
    }
  }

  function jsonArgs(raw, label) {
    const text = String(raw ?? '').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(T('webui.debug.notJson', { label, message: error.message }));
    }
  }

  async function runDebug() {
    const tool = state.debug.tool;
    if (state.mode === 'standalone') {
      toast(T('webui.debug.standaloneToast'), 'error');
      return;
    }
    let request = null;
    try {
      request = buildRequest(tool);
    } catch (error) {
      toast(errorText(error), 'error');
      $('runState').textContent = '';
      return;
    }
    for (const button of document.querySelectorAll('[data-action="run"]')) button.disabled = true;
    $('runState').textContent = T('webui.state.running');
    try {
      const data = await api(request.path, { method: 'POST', body: request.body });
      state.debug.last[tool] = pretty(data);
      renderResult(tool, data, request);
      $('runState').textContent = T('webui.debug.doneMs', { ms: data.elapsedMs ?? '—' });
    } catch (error) {
      const payload = error.payload ?? null;
      state.debug.last[tool] = pretty(payload ?? { ok: false, error: error.message });
      renderResult(tool, payload, request, error);
      $('runState').textContent = T('webui.debug.failed');
    } finally {
      const standalone = state.mode === 'standalone';
      for (const button of document.querySelectorAll('[data-action="run"]')) button.disabled = standalone;
    }
  }

  function toolsRequestPath(tool) {
    const map = {
      message: '/api/debug/message',
      llm: '/api/debug/llm',
      tool: '/api/debug/tool',
      sidecar: '/api/debug/sidecar',
    };
    return map[tool];
  }

  function buildRequest(tool) {
    if (tool === 'message') {
      const scene = $('msgScene').value;
      return {
        path: toolsRequestPath(tool),
        body: {
          scene,
          userId: Number($('msgUserId').value) || 0,
          nickname: $('msgNickname').value.trim() || undefined,
          groupId: scene === 'group' ? Number($('msgGroupId').value) || 0 : undefined,
          text: $('msgText').value,
          images: $('msgImages')
            .value.split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          at: $('msgAt').checked,
          dryRun: $('msgDryRun').checked,
        },
      };
    }
    if (tool === 'llm') {
      const body = { role: $('llmRole').value, json: $('llmJson').checked };
      const model = $('llmModel').value.trim();
      if (model) body.model = model;
      const maxTokens = $('llmMaxTokens').value.trim();
      if (maxTokens) body.maxTokens = Number(maxTokens);
      const temperature = $('llmTemperature').value.trim();
      if (temperature) body.temperature = Number(temperature);
      const messages = $('llmMessages').value.trim();
      if (messages) body.messages = jsonArgs(messages, 'messages');
      else body.prompt = $('llmPrompt').value;
      return { path: toolsRequestPath(tool), body };
    }
    if (tool === 'tool') {
      const name = $('toolName').value;
      if (!name) throw new Error(T('webui.debug.pickTool'));
      return { path: toolsRequestPath(tool), body: { name, args: jsonArgs($('toolArgs').value, T('webui.debug.args')) } };
    }
    return {
      path: toolsRequestPath(tool),
      body: { method: $('sidecarMethod').value, params: jsonArgs($('sidecarArgs').value, T('webui.debug.args')) },
    };
  }

  function resultBlock(title, extra) {
    const wrapper = el('section', 'result-block');
    const head = el('header');
    head.append(el('span', null, title));
    if (extra) head.append(extra);
    wrapper.append(head);
    return wrapper;
  }

  function noteBlock(text, kind) {
    const wrapper = el('section', 'result-block');
    wrapper.append(el('p', `result-note ${kind ?? ''}`.trim(), text));
    return wrapper;
  }

  function preBlock(title, text, extra) {
    const wrapper = resultBlock(title, extra);
    wrapper.append(el('pre', null, text));
    return wrapper;
  }

  function renderResult(tool, data, request, error) {
    const body = $('resultBody');
    if (!body) return;
    body.textContent = '';
    if (!data && !error) {
      body.append(emptyNote(T('webui.debug.resultEmpty')));
      return;
    }
    if (error) body.append(noteBlock(T('webui.debug.failedWith', { message: errorText(error) }), 'error'));
    if (typeof data === 'string') {
      body.append(preBlock(T('webui.debug.lastResult', { tool }), data));
      return;
    }
    if (data) {
      if (tool === 'message') renderMessageResult(body, data);
      else if (tool === 'llm') renderLlmResult(body, data);
      else renderGenericResult(body, tool, data);
    }
    if (request && tool === 'message') body.append(preBlock(T('webui.debug.requestSent'), pretty(request.body)));
  }

  function renderMessageResult(body, data) {
    body.append(
      RH.kv([
        [T('webui.debug.elapsed'), T('webui.debug.ms', { ms: data.elapsedMs ?? '—' })],
        [T('webui.debug.mode'), data.dryRun ? T('webui.debug.modeDry') : T('webui.debug.modeLive')],
        [
          T('webui.debug.normalized'),
          T('webui.debug.normalizedValue', {
            scene: data.message?.scene ?? '—',
            userId: data.message?.userId ?? '—',
            at: data.message?.isAt ? T('webui.value.yes') : T('webui.value.no'),
          }),
        ],
        [T('webui.debug.inPipeline'), data.skipped ? T('webui.debug.inPipelineNo') : T('webui.debug.inPipelineYes')],
      ]),
    );
    if (data.note) body.append(noteBlock(data.note, 'warn'));

    if (data.replyState) {
      const before = data.replyState.before ?? {};
      const after = data.replyState.after ?? {};
      const delta = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const diff = (after[key] ?? 0) - (before[key] ?? 0);
        if (diff) delta[key] = diff;
      }
      body.append(
        preBlock(T('webui.debug.replyCounters'), `${pretty(before)}\n→ ${pretty(after)}\n\n${T('webui.debug.delta')}\n${pretty(delta)}`),
      );
    }

    const outbound = data.outbound ?? [];
    const outBlock = resultBlock(T('webui.debug.outbound', { count: outbound.length }));
    if (!outbound.length) outBlock.append(el('p', 'result-note', T('webui.debug.outboundEmpty')));
    for (const record of outbound) {
      const item = el('div', 'out-item');
      const target =
        record.scene === 'group'
          ? T('webui.debug.targetGroup', { groupId: record.groupId })
          : T('webui.debug.targetPrivate', { userId: record.userId });
      item.append(el('div', 'out-head', `${target} · ${formatClock(record.at)}`));
      item.append(el('div', null, record.text || T('webui.debug.noText')));
      item.append(el('pre', null, pretty(record.segments)));
      outBlock.append(item);
    }
    body.append(outBlock);

    const logs = data.logs ?? [];
    const logBlock = resultBlock(T('webui.debug.logsDuring', { count: logs.length }));
    const list = el('div', 'log-mini');
    if (!logs.length) list.append(el('p', 'result-note', T('webui.debug.logsEmpty')));
    for (const entry of logs) {
      const row = el('div', 'log-row');
      row.dataset.level = entry.level ?? 'info';
      const line = el('div', 'log-line');
      line.append(el('time', 'log-time', formatClock(entry.ts)));
      line.append(el('span', 'log-badge', String(entry.level ?? 'info').toUpperCase()));
      line.append(el('span', 'log-source', entry.name ?? 'ruohua'));
      line.append(el('span', 'log-msg', entry.message ?? ''));
      row.append(line);
      if (entry.meta) row.append(el('pre', 'log-meta', pretty(entry.meta)));
      list.append(row);
    }
    logBlock.append(list);
    body.append(logBlock);

    if (data.result) body.append(preBlock(T('webui.debug.pipelineResult'), pretty(data.result)));
  }

  function renderLlmResult(body, data) {
    const truncated = data.finishReason === 'length' || data.truncated;
    const flag = RH.pill(
      truncated ? T('webui.debug.truncated') : T('webui.debug.finishReason', { reason: data.finishReason ?? T('webui.debug.finishNone') }),
      truncated ? 'error' : 'ok',
    );
    body.append(
      RH.kv([
        [T('webui.debug.elapsed'), T('webui.debug.ms', { ms: data.elapsedMs ?? '—' })],
        [T('webui.debug.textLength'), T('webui.debug.chars', { count: data.contentLength ?? 0 })],
        [T('webui.debug.model'), data.model ?? '—'],
        [T('webui.debug.role'), data.role ?? '—'],
        [
          T('webui.debug.usage'),
          data.usage
            ? T('webui.debug.usageValue', {
                prompt: data.usage.promptTokens ?? 0,
                completion: data.usage.completionTokens ?? 0,
                total: data.usage.totalTokens ?? 0,
              })
            : T('webui.debug.usageNone'),
        ],
      ]),
    );
    if (truncated) body.append(noteBlock(T('webui.debug.truncatedHint'), 'warn'));
    body.append(preBlock(T('webui.debug.contentRaw'), data.content || T('webui.debug.empty'), flag));
    if (data.json) body.append(preBlock(T('webui.debug.jsonParsed'), pretty(data.json)));
    if (data.toolCalls?.length) body.append(preBlock(T('webui.debug.toolCalls'), pretty(data.toolCalls)));
  }

  function renderGenericResult(body, tool, data) {
    const rows = [
      [T('webui.debug.elapsed'), T('webui.debug.ms', { ms: data.elapsedMs ?? '—' })],
      [T('webui.debug.target'), data.name ?? data.method ?? '—'],
    ];
    if (typeof data.sensitive === 'boolean') rows.push([T('webui.debug.toolSensitive'), data.sensitive ? T('webui.value.yes') : T('webui.value.no')]);
    if (data.available !== undefined) {
      rows.push([
        T('webui.debug.sidecarAvailable'),
        data.available === true ? T('webui.chip.sidecar.available') : data.available === false ? T('webui.chip.sidecar.unavailable') : T('webui.chip.sidecar.unknown'),
      ]);
    }
    body.append(RH.kv(rows));
    if (data.error) body.append(noteBlock(data.error, 'error'));
    body.append(preBlock(tool === 'tool' ? T('webui.debug.toolResult') : T('webui.debug.sidecarResult'), pretty(data.result ?? data)));
  }

  // ————————————————— 启动 —————————————————

  async function boot() {
    RH.initTheme();
    initToken();
    initTabs();
    initChips();
    initHome();
    initConfig();
    initEnv();
    initI18nPage();
    initStickers();
    initMonitor();
    initDebug();

    try {
      await loadI18n();
    } catch (error) {
      RH.applyI18nDom();
      toast(errorText(error), 'error');
    }

    const initial = String(location.hash ?? '').replace('#', '');
    showPage(PAGES.includes(initial) ? initial : 'home', { updateHash: false });
    window.addEventListener('hashchange', () => showPage(String(location.hash).replace('#', ''), { updateHash: false }));

    connectLogs();
    startStatusPolling();
    startPeersPolling();
    loadServices().catch(() => {});
    loadConfigList().catch((error) => {
      const list = $('configList');
      if (list) {
        list.textContent = '';
        list.append(emptyNote(T('webui.config.listFailed', { message: errorText(error) })));
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
