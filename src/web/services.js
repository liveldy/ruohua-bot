/**
 * 服务管理器：控制面板能管的那几个服务（面板自身 / Node / NapCat / 若华主程序 / 侧车）。
 *
 * 两条铁律：
 *   1. 动作白名单 —— 面板只能调这里定义的动作，永远没有「随便跑一条命令」的口子；
 *   2. 停得准 —— 若华本体 / 侧车只动 data/web/services.json 里记过的 pid，并确认它还是那个进程。
 *      NapCat 例外：协议端常常是用户自己开的，面板的「停止」按占用 OneBot 端口的进程、
 *      记过的 pid、名字像 NapCat 的进程来认，不问是谁起的（认不出才如实报错）。
 *
 * 返回给前端的一律是**键**（web.service.*），文字在 src/i18n/locales/zh-CN/web.json。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { t } from '../i18n/index.js';
import { consoleStart, utf8Env } from '../util/console.js';
import { decodeProcessOutput } from '../util/text.js';
import { formatDuration } from '../util/time.js';

/** 面板自己找兄弟面板时扫的端口区间（attached 默认 8787，standalone 默认 8788）。 */
export const PANEL_PORT_FROM = 8787;
export const PANEL_PORT_TO = 8795;

/** NapCat 的默认位置与启动方式。启动器用 `napcat.bat`：它**不申请管理员权限**。 */
const DEFAULT_NAPCAT = {
  dir: 'D:/Desktop/NapCat/NapCat.52230.Shell',
  launcher: 'napcat.bat',
  webuiUrl: 'http://127.0.0.1:6099',
  onebotPort: 3001,
};

/** 每个服务允许的动作，以及默认的主按钮。 */
const SERVICE_ACTIONS = {
  panel: ['check'],
  node: ['check'],
  napcat: ['check', 'start', 'stop', 'open'],
  ruohua: ['check', 'start', 'stop', 'restart'],
  sidecar: ['check', 'start', 'stop'],
};

/** 服务顺序（前端按这个顺序渲染）。 */
export const SERVICE_IDS = ['panel', 'node', 'napcat', 'ruohua', 'sidecar'];

const ACTION_LABEL_KEYS = {
  check: 'web.service.action.check',
  start: 'web.service.action.start',
  stop: 'web.service.action.stop',
  restart: 'web.service.action.restart',
  open: 'web.service.action.open',
};

function serviceError(code, params = null) {
  const error = new Error(`service error: ${code}`);
  error.code = code;
  error.params = params;
  return error;
}

function detail(labelKey, value, valueKey = null, params = null) {
  return { labelKey, value: value === undefined ? null : value, valueKey, params };
}

function safeRunSync(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

async function safeAsync(fn, fallback = null) {
  try {
    const value = await fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 给一个 Promise 加个上限：到点就按 fallback 结算（探测用，绝不挂住接口）。 */
function withTimeout(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value === undefined ? fallback : value);
    };
    const timer = setTimeout(() => done(fallback), ms);
    timer.unref?.();
    Promise.resolve(promise).then(done, () => done(fallback));
  });
}

/** 起进程（面板自己用的都是短命令 / 分离进程），带超时，失败不抛。 */
function runCommand(spawnImpl, command, args, { timeoutMs = 4000, cwd = undefined, env = undefined } = {}) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawnImpl(command, args, {
        windowsHide: true,
        cwd,
        env: env ?? utf8Env(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    // 按字节收：Windows 的命令（tasklist / where / powershell）中文是 GBK 字节，
    // 直接 String(chunk) 会按 UTF-8 解成乱码；交给 decodeProcessOutput 按代码页判。
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => finish({ code, out: decodeProcessOutput(Buffer.concat(chunks)) }));
  });
}

/** TCP 探端口：能连上就算通。 */
function tcpOpen(port, { host = '127.0.0.1', timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** 带超时地取一个 JSON：拿不到就返回 null（探测用，绝不抛）。 */
export async function fetchJson(fetchImpl, url, timeoutMs = 1500) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 探测某个端口上是不是若华面板；是就回 { url, port, mode, data }。 */
export async function probePanel(port, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const url = `http://127.0.0.1:${port}`;
  const data = await fetchJson(fetchImpl, `${url}/api/status`, timeoutMs);
  if (!data || data.ok !== true) return null;
  if (!data.web || typeof data.web !== 'object') return null;
  if (data.mode !== 'attached' && data.mode !== 'standalone') return null;
  return { url, port, mode: data.mode, data };
}

/**
 * 扫一段端口，找出别的若华面板。
 * @returns {Promise<Array<{ url: string, port: number, mode: string }>>}
 */
export async function probePanels({
  from = PANEL_PORT_FROM,
  to = PANEL_PORT_TO,
  skip = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = 1200,
} = {}) {
  const skipSet = new Set(skip.map((item) => Number(item)).filter((item) => Number.isInteger(item)));
  const ports = [];
  for (let port = from; port <= to; port += 1) {
    if (!skipSet.has(port)) ports.push(port);
  }
  const found = await Promise.all(ports.map((port) => probePanel(port, { fetchImpl, timeoutMs })));
  return found
    .filter(Boolean)
    .map((item) => ({ url: item.url, port: item.port, mode: item.mode }));
}

/** 用系统默认浏览器打开一个地址。 */
export function openInBrowser(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const [command, args] =
    platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * 服务管理器。
 * @param {{
 *   config?: object, logger?: object, services?: object, mode?: 'attached'|'standalone',
 *   panelInfo?: () => object, rootDir?: string, dataDir?: string,
 *   spawnImpl?: Function, fetchImpl?: Function, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>, exists?: (file: string) => boolean,
 *   kill?: (pid: number, signal?: string) => void, processInfo?: (pid: number) => Promise<object|null>,
 *   openUrl?: (url: string) => boolean, platform?: string,
 *   startTimeoutMs?: number, napcatStartTimeoutMs?: number, stopTimeoutMs?: number, pollMs?: number,
 * }} options
 */
export function createServiceManager({
  config = null,
  logger = null,
  services = null,
  mode = 'standalone',
  panelInfo = null,
  rootDir = process.cwd(),
  dataDir = null,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exists = existsSync,
  kill = (pid, signal) => process.kill(pid, signal),
  processInfo = null,
  openUrl = null,
  platform = process.platform,
  startTimeoutMs = 20000,
  // NapCat 冷启动要拉起整个 QQ，第一次登录更慢（真机日志里 01:08 点启动、01:10:43 才就绪），
  // 20 秒的通用超时对它是假失败，单给它一个长的。
  napcatStartTimeoutMs = 180000,
  stopTimeoutMs = 8000,
  pollMs = 500,
  listTtlMs = 2500,
} = {}) {
  const log = logger?.child ? logger.child('web.services') : logger;
  const absoluteRoot = path.resolve(rootDir);
  const absoluteDataDir = path.resolve(dataDir ?? path.join(absoluteRoot, 'data'));
  const servicesFile = path.join(absoluteDataDir, 'web', 'services.json');
  const launcher = openUrl ?? ((url) => openInBrowser(url, { spawnImpl, platform }));

  const settings = config?.web?.napcat ?? {};

  function napcatSettings() {
    const dir = String(settings.dir ?? DEFAULT_NAPCAT.dir);
    const raw = String(settings.launcher ?? DEFAULT_NAPCAT.launcher);
    return {
      dir,
      launcher: path.isAbsolute(raw) ? raw : path.join(dir, raw),
      webuiUrl: String(settings.webuiUrl ?? DEFAULT_NAPCAT.webuiUrl),
      onebotPort: Number(settings.onebotPort ?? DEFAULT_NAPCAT.onebotPort) || DEFAULT_NAPCAT.onebotPort,
    };
  }

  // —— 记住「面板自己起过的进程」——

  async function readState() {
    try {
      const text = await fs.readFile(servicesFile, 'utf8');
      const data = text.trim() ? JSON.parse(text) : {};
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async function writeState(patch = {}) {
    const current = await readState();
    const next = { ...current, ...patch, updatedAt: now() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
    }
    try {
      await fs.mkdir(path.dirname(servicesFile), { recursive: true });
      const tmp = `${servicesFile}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, servicesFile);
    } catch (error) {
      log?.warn?.(t('web.services.stateWriteFailed'), error);
    }
    return next;
  }

  // —— 进程探测 ——

  async function listProcesses() {
    if (platform !== 'win32') return null;
    const result = await runCommand(spawnImpl, 'tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 6000 });
    if (!result?.out) return null;
    return result.out
      .split(/\r?\n/)
      .map((line) => /^"([^"]+)","(\d+)"/.exec(line.trim()))
      .filter(Boolean)
      .map((match) => ({ name: match[1], pid: Number(match[2]) }));
  }

  async function findProcess(pattern) {
    const rows = await listProcesses();
    if (!rows) return null;
    return rows.find((row) => pattern.test(row.name)) ?? null;
  }

  /** 进程表里所有名字匹配的进程（停 NapCat 时要一次认全）。 */
  async function findProcesses(pattern) {
    const rows = await listProcesses();
    if (!rows) return [];
    return rows.filter((row) => pattern.test(row.name));
  }

  /**
   * 现在谁在监听这个端口：`netstat -ano` 的 LISTENING 那一行最后就是 pid。
   * 输出全是数字与 ASCII，不受控制台代码页影响；拿不到就返回 null（调用方退回记过的 pid）。
   */
  async function portOwner(port) {
    const wanted = Number(port);
    if (!Number.isInteger(wanted) || wanted <= 0) return null;
    const args = platform === 'win32' ? ['-ano', '-p', 'TCP'] : ['-ltnp'];
    const result = await runCommand(spawnImpl, 'netstat', args, { timeoutMs: 6000 });
    if (!result?.out) return null;
    for (const line of result.out.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const match = /([0-9a-fA-F:.[\]]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line.trim());
      if (!match) continue;
      if (Number(match[2]) !== wanted) continue;
      const pid = Number(match[3]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  }

  async function pidInfo(pid) {
    const wanted = Number(pid);
    if (!Number.isInteger(wanted) || wanted <= 0) return null;
    if (typeof processInfo === 'function') return processInfo(wanted);
    if (platform === 'win32') {
      const rows = await listProcesses();
      return rows?.find((row) => row.pid === wanted) ?? null;
    }
    const result = await runCommand(spawnImpl, 'ps', ['-p', String(wanted), '-o', 'comm='], { timeoutMs: 4000 });
    if (!result?.out?.trim()) return null;
    return { pid: wanted, name: result.out.trim().split('\n')[0].trim() };
  }

  /** PowerShell 的日期可能是 `\/Date(1770000000000)\/`，也可能是 ISO 串。 */
  function parseCreatedAt(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const text = String(raw);
    const ms = /\/?Date\((\d+)\)/.exec(text);
    if (ms) return Number(ms[1]);
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * 更细的一层进程信息：命令行与创建时间用来确认「这个 pid 还是我们记的那一个」，
   * 免得 pid 被系统回收给别的进程以后误杀。拿不到就退回只有名字的那层。
   */
  async function pidDetails(pid) {
    const wanted = Number(pid);
    if (!Number.isInteger(wanted) || wanted <= 0) return null;
    if (typeof processInfo === 'function') return processInfo(wanted);
    if (platform !== 'win32') {
      const info = await pidInfo(wanted);
      if (!info) return null;
      const result = await runCommand(spawnImpl, 'ps', ['-p', String(wanted), '-o', 'lstart='], { timeoutMs: 4000 });
      const started = result?.out?.trim() ? Date.parse(result.out.trim()) : null;
      return { ...info, createdAt: Number.isFinite(started) ? started : null };
    }
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${wanted}"`,
      'if ($p) { $p | Select-Object ProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress }',
    ].join('; ');
    const result = await runCommand(spawnImpl, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: 8000,
    });
    const text = result?.out?.trim() ?? '';
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        return {
          pid: Number(parsed.ProcessId) || wanted,
          name: parsed.Name ?? null,
          commandLine: parsed.CommandLine ?? null,
          createdAt: parseCreatedAt(parsed.CreationDate),
        };
      } catch {
        /* 解析不了就退回只有名字的那层 */
      }
    }
    return pidInfo(wanted);
  }

  /** 这个 pid 到底还是不是我们记过的那个进程：名字对得上、命令行对得上、启动时间晚于我们记的那一刻。 */
  function isOwnedProcess(id, info, record) {
    if (!info) return false;
    const name = String(info.name ?? '').toLowerCase();
    if (id === 'ruohua' && !name.includes('node')) return false;
    const command = info.commandLine ? String(info.commandLine).toLowerCase() : null;
    if (id === 'ruohua' && command && !command.includes('main.js')) return false;
    const recordedAt = Number(record?.startedAt ?? 0);
    if (recordedAt && info.createdAt && info.createdAt < recordedAt - 60_000) return false;
    return true;
  }

  async function nodeInPath() {
    const command = platform === 'win32' ? 'where' : 'which';
    const result = await runCommand(spawnImpl, command, ['node'], { timeoutMs: 4000 });
    if (!result?.out?.trim()) return null;
    const first = result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? null;
    return { found: Boolean(first), path: first };
  }

  // —— 单个服务 ——

  function makeService({ id, status, detail: rows, note = null }) {
    const healthy = status === 'running' || status === 'ok';
    const allowed = SERVICE_ACTIONS[id] ?? [];
    const actions = allowed.map((action) => ({
      id: action,
      labelKey: ACTION_LABEL_KEYS[action],
      primary: action === (healthy ? 'check' : 'start'),
    }));
    if (!actions.some((action) => action.primary) && actions.length) actions[0].primary = true;
    return {
      id,
      titleKey: `web.service.${id}.title`,
      descKey: `web.service.${id}.desc`,
      status,
      statusKey: `web.service.status.${status}`,
      note,
      detail: rows,
      actions,
    };
  }

  async function panelService() {
    const info = (typeof panelInfo === 'function' ? panelInfo() : panelInfo) ?? {};
    const startedAt = Number(info.startedAt ?? 0);
    const status = info.running === false ? 'stopped' : 'running';
    return makeService({
      id: 'panel',
      status,
      detail: [
        detail(
          'web.service.panel.mode',
          mode,
          mode === 'attached' ? 'web.service.mode.attached' : 'web.service.mode.standalone',
        ),
        detail('web.service.panel.url', info.url ?? null),
        detail('web.service.panel.port', info.port ?? null),
        detail('web.service.panel.clients', info.clients ?? null),
        detail(
          'web.service.panel.uptime',
          startedAt ? safeRunSync(() => formatDuration(now() - startedAt)) : null,
          startedAt ? null : 'web.service.value.unknown',
        ),
        detail('web.service.panel.root', absoluteRoot),
      ],
    });
  }

  let nodeProbe = null;
  async function nodeService() {
    if (!nodeProbe) nodeProbe = await nodeInPath();
    return makeService({
      id: 'node',
      status: 'ok',
      detail: [
        detail('web.service.node.version', process.version),
        detail('web.service.node.execPath', process.execPath),
        detail('web.service.node.platform', `${platform} ${process.arch}`),
        detail('web.service.node.pid', process.pid),
        detail(
          'web.service.node.inPath',
          nodeProbe?.path ?? null,
          nodeProbe?.path ? 'web.service.value.yes' : 'web.service.value.no',
        ),
      ],
    });
  }

  async function napcatState() {
    const { dir, launcher: launcherFile, webuiUrl, onebotPort } = napcatSettings();
    const dirExists = safeRunSync(() => exists(dir), false);
    const launcherExists = safeRunSync(() => exists(launcherFile), false);
    const [portOpen, process_] = await Promise.all([
      tcpOpen(onebotPort),
      findProcess(/napcat|napcatwinboot/i),
    ]);
    const running = Boolean(portOpen || process_);
    let status = 'stopped';
    if (!dirExists || !launcherExists) status = 'unknown';
    else if (running) status = 'running';
    return { dir, launcherFile, webuiUrl, onebotPort, dirExists, launcherExists, portOpen, process: process_, running, status };
  }

  async function napcatService() {
    const state = await napcatState();
    const record = (await readState()).napcat ?? null;
    return makeService({
      id: 'napcat',
      status: state.status,
      detail: [
        detail(
          'web.service.napcat.dir',
          state.dir,
          state.dirExists ? null : 'web.service.value.missing',
          state.dirExists ? null : { path: state.dir },
        ),
        detail(
          'web.service.napcat.launcher',
          state.launcherFile,
          state.launcherExists ? null : 'web.service.value.missing',
          state.launcherExists ? null : { path: state.launcherFile },
        ),
        detail(
          'web.service.napcat.process',
          state.process?.name ?? null,
          state.running ? 'web.service.value.yes' : 'web.service.value.no',
        ),
        detail(
          'web.service.napcat.pid',
          state.process?.pid ?? record?.pid ?? null,
          state.process?.pid ?? record?.pid ? null : 'web.service.value.unknown',
        ),
        detail(
          'web.service.napcat.onebot',
          state.onebotPort,
          state.portOpen ? 'web.service.value.reachable' : 'web.service.value.unreachable',
        ),
        detail('web.service.napcat.webui', state.webuiUrl),
      ],
    });
  }

  /** standalone 下找 attached 面板；attached 直接用自己的数据。 */
  async function findAttachedPanel() {
    const skip = (typeof panelInfo === 'function' ? panelInfo()?.port : null) ?? null;
    const panels = await probePanels({ skip: skip ? [skip] : [], fetchImpl });
    return panels.find((item) => item.mode === 'attached') ?? null;
  }

  async function ruohuaState() {
    if (mode === 'attached') {
      const startedAt = Number(services?.startedAt ?? 0);
      const onebotStatus = await safeAsync(() => services?.onebot?.status?.(), null);
      return {
        status: 'running',
        pid: process.pid,
        startedAt: startedAt || null,
        onebot: onebotStatus?.connected ?? null,
        panelUrl: (typeof panelInfo === 'function' ? panelInfo()?.url : null) ?? null,
        port: (typeof panelInfo === 'function' ? panelInfo()?.port : null) ?? null,
        source: 'self',
      };
    }
    const found = await findAttachedPanel();
    if (!found) {
      return { status: 'stopped', pid: null, startedAt: null, onebot: null, panelUrl: null, port: null, source: null };
    }
    // probePanels 只回 url / port / mode，要看启动时间与 OneBot 状态得单独再问它一次
    const detailData = found.data ?? (await probePanel(found.port, { fetchImpl }))?.data ?? {};
    return {
      status: 'running',
      pid: null,
      startedAt: Number(detailData.bot?.startedAt ?? detailData.web?.startedAt ?? 0) || null,
      onebot: detailData.onebot?.connected ?? null,
      panelUrl: `${found.url}/`,
      port: found.port,
      source: 'probe',
    };
  }

  async function ruohuaService() {
    const state = await ruohuaState();
    const record = (await readState()).ruohua ?? null;
    // 独立模式：对面没告诉启动时间就用面板自己记的（我们起的那个 pid 记着时间）
    const startedAt = state.startedAt ?? (state.status === 'running' ? Number(record?.startedAt ?? 0) || null : null);
    const uptime = startedAt ? safeRunSync(() => formatDuration(now() - startedAt)) : null;
    return makeService({
      id: 'ruohua',
      status: state.status,
      detail: [
        detail('web.service.ruohua.pid', state.pid ?? record?.pid ?? null, state.pid ?? record?.pid ? null : 'web.service.value.unknown'),
        detail(
          'web.service.ruohua.startedAt',
          startedAt ? new Date(startedAt).toISOString() : null,
          startedAt ? null : 'web.service.value.unknown',
        ),
        detail('web.service.ruohua.uptime', uptime, uptime ? null : 'web.service.value.unknown'),
        detail('web.service.ruohua.panel', state.panelUrl ?? null, state.panelUrl ? null : 'web.service.value.unknown'),
        detail(
          'web.service.ruohua.onebot',
          state.onebot,
          state.onebot === true ? 'web.service.value.yes' : state.onebot === false ? 'web.service.value.no' : 'web.service.value.unknown',
        ),
        detail('web.service.ruohua.mode', mode, mode === 'attached' ? 'web.service.mode.attached' : 'web.service.mode.standalone'),
      ],
    });
  }

  let sidecarProbe = null;
  async function sidecarState() {
    const client = services?.sidecar ?? null;
    const url = String(services?.sidecar?.url ?? config?.sidecar?.url ?? 'http://127.0.0.1:8765').replace(/\/+$/, '');
    if (client) {
      const health = await withTimeout(safeAsync(() => (client.probe ? client.probe() : client.health?.()), null), 2500, null);
      const available = health ? health.ok !== false : client.available === true;
      return { url, available, pid: safeRunSync(() => client.pid ?? null), enabled: safeRunSync(() => client.enabled ?? true, true), source: 'attached' };
    }
    const health = await fetchJson(fetchImpl, `${url}/health`, 2000);
    return { url, available: health ? health.ok !== false : false, pid: null, enabled: true, source: 'probe' };
  }

  async function sidecarService() {
    const state = await sidecarState();
    sidecarProbe = state;
    return makeService({
      id: 'sidecar',
      status: state.available ? 'ok' : 'stopped',
      detail: [
        detail('web.service.sidecar.url', state.url),
        detail(
          'web.service.sidecar.available',
          state.available,
          state.available ? 'web.service.value.yes' : 'web.service.value.no',
        ),
        detail('web.service.sidecar.pid', state.pid ?? null, state.pid ? null : 'web.service.value.unknown'),
        detail('web.service.sidecar.enabled', state.enabled, state.enabled ? 'web.service.value.yes' : 'web.service.value.no'),
        detail('web.service.sidecar.source', state.source, state.source === 'attached' ? 'web.service.mode.attached' : 'web.service.mode.standalone'),
      ],
    });
  }

  /** 服务清单：探测有成本（进程表、端口、探活），短缓存一下，动作之后立刻刷新。 */
  let listCache = { at: 0, value: null };
  async function list({ fresh = false } = {}) {
    const ttl = fresh ? 0 : listTtlMs;
    if (ttl > 0 && listCache.value && now() - listCache.at < ttl) return listCache.value;
    const rows = await Promise.all([
      panelService(),
      nodeService(),
      napcatService(),
      ruohuaService(),
      sidecarService(),
    ]);
    const order = new Map(SERVICE_IDS.map((id, index) => [id, index]));
    const sorted = rows.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    listCache = { at: now(), value: sorted };
    return sorted;
  }

  async function overview() {
    const rows = await list();
    return {
      mode,
      count: rows.length,
      running: rows.filter((row) => row.status === 'running' || row.status === 'ok').length,
      stopped: rows.filter((row) => row.status === 'stopped').length,
      unknown: rows.filter((row) => row.status === 'unknown' || row.status === 'warn').length,
      items: rows.map((row) => ({ id: row.id, titleKey: row.titleKey, status: row.status, statusKey: row.statusKey })),
    };
  }

  // —— 动作 ——

  async function waitFor(predicate, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const value = await safeAsync(() => predicate(), null);
      if (value) return value;
      if (now() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  async function napcatStart() {
    const state = await napcatState();
    if (!state.dirExists || !state.launcherExists) {
      throw serviceError('missing_file', { path: state.launcherExists ? state.dir : state.launcherFile });
    }
    if (state.running) return { already: true };
    let child = null;
    let spec = null;
    try {
      // Windows：走一个「新开的、已设成 UTF-8 的控制台」，NapCat 的中文才不是乱码
      // （面板这边是 detached 起的，本身没有控制台，直接跑 launcher.bat 的话代码页根本设不上）。
      // cwd 要同时交给垫片：Windows Terminal 不继承工作目录，napcat.bat 里的
      // `.\NapCatWinBootMain.exe` 会因此在用户主目录里找不到（真机原案）。
      spec = consoleStart({ target: state.launcherFile, dataDir: absoluteDataDir, cwd: state.dir, platform });
      child = spawnImpl(spec.command, spec.args, {
        cwd: state.dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: utf8Env(process.env, spec.env),
      });
    } catch (error) {
      throw serviceError('start_failed', { message: error?.message ?? String(error) });
    }
    child.on?.('error', () => {});
    child.unref?.();
    await writeState({ napcat: { pid: child.pid ?? null, startedAt: now() } });
    const up = await waitFor(() => tcpOpen(state.onebotPort), napcatStartTimeoutMs);
    if (!up) {
      throw serviceError('napcat_timeout', { seconds: Math.round(napcatStartTimeoutMs / 1000), port: state.onebotPort });
    }
    // 记真正的 NapCat 进程：走 start 之后那个 cmd 是短命的，记它就没法停了
    const proc = await findProcess(/napcat|napcatwinboot/i);
    if (proc?.pid) await writeState({ napcat: { pid: proc.pid, startedAt: now() } });
    return { pid: proc?.pid ?? child.pid ?? null, terminal: spec.terminal };
  }

  /**
   * 只杀「面板自己起过」的进程：
   *   - 没记过 pid → 若它还在跑，说明不是我们起的，拒绝（not_ours）；
   *   - 记过 pid 但进程已经没了 → 如实说明「已经不在了」；
   *   - pid 被系统回收给了别的进程（名字 / 命令行 / 启动时间对不上）→ 拒绝（unverifiable）。
   */
  async function stopOwned(id, { isRunning, waitForStop } = {}) {
    const record = (await readState())[id] ?? null;
    const pid = Number(record?.pid ?? 0);
    const running = typeof isRunning === 'function' ? Boolean(await safeAsync(isRunning, true)) : true;
    if (!Number.isInteger(pid) || pid <= 0) {
      if (!running) return { pid: null, killed: false, alreadyStopped: true };
      throw serviceError('not_ours', { id });
    }
    const info = await pidDetails(pid);
    if (!info) {
      await writeState({ [id]: null });
      if (!running) return { pid, killed: false, alreadyStopped: true };
      throw serviceError('not_ours', { id, pid });
    }
    if (!isOwnedProcess(id, info, record)) {
      throw serviceError('unverifiable', { pid, name: info.name ?? null });
    }
    try {
      kill(pid, 'SIGTERM');
    } catch (error) {
      throw serviceError('stop_failed', { pid, message: error?.message ?? String(error) });
    }
    await writeState({ [id]: null });
    if (typeof waitForStop === 'function') {
      const stopped = await waitFor(waitForStop, stopTimeoutMs);
      return { pid, killed: true, stopped: Boolean(stopped) };
    }
    return { pid, killed: true, stopped: true };
  }

  /**
   * 停 NapCat：**不问「是不是面板起的」**——协议端十有八九是用户自己开的，
   * 「停止」按钮就该把它停掉。候选取这几路，一个不多：
   *   1. 占着 OneBot 端口的那个进程（最准：NapCat 跑起来后宿主进程未必叫 napcat）；
   *   2. 面板记过的 pid；
   *   3. 进程名像 NapCat 的（`NapCatWinBootMain.exe` 之类还没退干净时）。
   */
  async function napcatStop() {
    const state = await napcatState();
    const record = (await readState()).napcat ?? null;
    const candidates = new Set();
    const fromPort = await portOwner(state.onebotPort);
    if (fromPort) candidates.add(fromPort);
    const recorded = Number(record?.pid ?? 0);
    if (Number.isInteger(recorded) && recorded > 0) candidates.add(recorded);
    for (const row of await findProcesses(/napcat|napcatwinboot/i)) candidates.add(row.pid);

    if (!candidates.size) {
      if (!state.running) return { pid: null, killed: false, alreadyStopped: true };
      throw serviceError('napcat_not_found', { port: state.onebotPort });
    }

    const killed = [];
    for (const pid of candidates) {
      if (!(await pidDetails(pid))) continue; // 已经不在的跳过
      try {
        kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch {
        /* 刚退 / 动不了：算没杀成，下面按端口结果如实回报 */
      }
    }
    await writeState({ napcat: null });
    const stopped = Boolean(await waitFor(async () => !(await tcpOpen(state.onebotPort)), stopTimeoutMs));
    if (stopped) return { pid: killed[0] ?? null, killed: killed.length > 0, pids: killed, stopped: true };
    // 端口还通着：要么根本没杀成（权限），要么占着它的另有其人 —— 两种都如实说
    throw serviceError(killed.length ? 'napcat_still_listening' : 'napcat_stop_denied', {
      port: state.onebotPort,
      pids: [...candidates].join(', '),
    });
  }

  /**
   * 起若华本体：和用户双击一样跑 `start.bat`（在一个已设成 UTF-8 的新控制台里，看得见窗口），
   * 没有 `start.bat` 才退回直接起 node。成功判定是「冒出一个启动前没有的面板」，
   * 不再拿本来就开着的面板冒充成功；记下的 pid 是**真正监听面板端口的那个 node**。
   */
  async function ruohuaStart() {
    if (mode === 'attached') throw serviceError('already_running', { id: 'ruohua' });
    const existing = await findAttachedPanel();
    if (existing) throw serviceError('already_running', { id: 'ruohua', port: existing.port });
    const bat = path.join(absoluteRoot, 'start.bat');
    const entry = path.join(absoluteRoot, 'src', 'main.js');
    const useBat = safeRunSync(() => exists(bat), false);
    if (!useBat && !safeRunSync(() => exists(entry), false)) {
      throw serviceError('missing_file', { path: useBat ? bat : entry });
    }
    let child = null;
    let spec = null;
    try {
      spec = useBat
        ? consoleStart({ target: bat, dataDir: absoluteDataDir, cwd: absoluteRoot, platform })
        : { command: process.execPath, args: ['src/main.js'], env: null };
      child = spawnImpl(spec.command, spec.args, {
        cwd: absoluteRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: utf8Env(process.env, spec.env),
      });
    } catch (error) {
      throw serviceError('start_failed', { message: error?.message ?? String(error) });
    }
    child.on?.('error', () => {});
    child.unref?.();
    await writeState({ ruohua: { pid: child.pid ?? null, startedAt: now() } });
    const found = await waitFor(() => findAttachedPanel(), startTimeoutMs);
    if (!found) throw serviceError('timeout', { seconds: Math.round(startTimeoutMs / 1000), pid: child.pid ?? null });
    // 记真正在跑的 node（start.bat 里那层 cmd 是短命的），停止时好认
    const owner = await portOwner(found.port);
    await writeState({ ruohua: { pid: owner ?? child.pid ?? null, port: found.port, startedAt: now() } });
    return {
      pid: owner ?? child.pid ?? null,
      url: `${found.url}/`,
      port: found.port,
      launcher: useBat ? 'start.bat' : 'node',
      terminal: spec.terminal ?? null,
    };
  }

  async function ruohuaStop() {
    if (mode === 'attached') throw serviceError('attached_self', { id: 'ruohua' });
    return stopOwned('ruohua', {
      isRunning: async () => Boolean(await findAttachedPanel()),
      waitForStop: async () => !(await findAttachedPanel()),
    });
  }

  async function sidecarStart() {
    const client = services?.sidecar;
    if (!client?.ensureStarted) throw serviceError('unavailable', { id: 'sidecar' });
    const result = await safeAsync(() => client.ensureStarted(), null);
    if (!result?.ok) throw serviceError('start_failed', { message: result?.reason ?? 'unknown' });
    return { pid: result.pid ?? null };
  }

  async function sidecarStop() {
    const client = services?.sidecar;
    if (!client?.stop) throw serviceError('unavailable', { id: 'sidecar' });
    const stopped = await safeAsync(() => client.stop(), false);
    if (!stopped) throw serviceError('not_ours', { id: 'sidecar' });
    return { stopped: true };
  }

  const handlers = {
    panel: { check: async () => ({}) },
    node: {
      check: async () => {
        nodeProbe = await nodeInPath();
        return {};
      },
    },
    napcat: {
      check: async () => ({}),
      start: napcatStart,
      stop: napcatStop,
      open: async () => {
        const { webuiUrl } = napcatSettings();
        const opened = launcher(webuiUrl);
        if (!opened) throw serviceError('open_failed', { url: webuiUrl });
        return { url: webuiUrl };
      },
    },
    ruohua: {
      check: async () => ({}),
      start: ruohuaStart,
      stop: ruohuaStop,
      restart: async () => {
        await ruohuaStop();
        await sleep(500);
        return ruohuaStart();
      },
    },
    sidecar: {
      check: async () => {
        sidecarProbe = await sidecarState();
        return {};
      },
      start: sidecarStart,
      stop: sidecarStop,
    },
  };

  /**
   * 执行一个动作。白名单外的 id / action 直接拒绝。
   * @returns {Promise<{ ok: true, id: string, action: string, status: string, statusKey: string, detail: object[], services: object[], url: string|null }>}
   */
  async function act(id, action) {
    const allowed = SERVICE_ACTIONS[id];
    if (!allowed) throw serviceError('unknown_service', { id });
    if (!allowed.includes(action)) throw serviceError('unknown_action', { id, action });
    let result = null;
    try {
      result = (await handlers[id][action]()) ?? {};
    } catch (error) {
      logger?.operation?.({
        actor: 'web-panel',
        action: `service_${action}`,
        target: id,
        ok: false,
        detail: { code: error?.code ?? null, params: error?.params ?? null },
      });
      throw error;
    }
    const rows = await list({ fresh: true });
    const current = rows.find((row) => row.id === id) ?? null;
    logger?.operation?.({
      actor: 'web-panel',
      action: `service_${action}`,
      target: id,
      ok: true,
      detail: { status: current?.status ?? null, result: result.detail ?? result },
    });
    return {
      ok: true,
      id,
      action,
      status: current?.status ?? 'unknown',
      statusKey: current?.statusKey ?? null,
      detail: current?.detail ?? [],
      result,
      services: rows,
      url: result.url ?? null,
    };
  }

  return {
    list,
    act,
    overview,
    probePanels: (options = {}) => probePanels({ fetchImpl, ...options }),
    servicesFile,
    serviceIds: SERVICE_IDS,
    get mode() {
      return mode;
    },
  };
}

export default { createServiceManager, probePanels, probePanel, openInBrowser, PANEL_PORT_FROM, PANEL_PORT_TO };
