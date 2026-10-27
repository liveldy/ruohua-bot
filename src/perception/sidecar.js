/**
 * Python 侧车客户端：本地感知能力的入口（向量 / 记忆打分 / 截屏 / 语音 / OCR）。
 *
 * 契约见 docs/INTERFACES.md 第 12 节：createSidecarClient({ config, logger })。
 * 侧车不可用时一律降级（返回 null 或 { ok: false }），绝不抛错；失败只 warn 一次，
 * 免得侧车没起就刷屏。
 *
 * `available` 是属性（getter），三态：null 还没探过、true 上次探测通、false 上次不通。
 * 需要主动探测时调 `probe()`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, fileExists } from '../util/io.js';
import { t } from '../i18n/index.js';

const DEFAULT_TIMEOUT_MS = 8000;
const START_TIMEOUT_MS = 10000;
const START_POLL_MS = 350;

export function createSidecarClient({ config, logger, fetchImpl = null } = {}) {
  const settings = config?.sidecar ?? {};
  const log = logger?.child ? logger.child('sidecar') : logger;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const host = settings.host ?? '127.0.0.1';
  const port = Number(settings.port ?? 8765);
  const baseUrl = String(settings.url ?? `http://${host}:${port}`).replace(/\/+$/, '');
  const timeoutMs = Number(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  /** 最近一次 /health 的原始返回；没探过是 null。 */
  let lastHealth = null;
  /** 三态可用性：null 未知 / true 通 / false 不通。 */
  let reachable = null;
  let warned = false;
  let lastError = null;
  let child = null;
  let childExited = false;

  function noteSuccess() {
    warned = false;
    reachable = true;
    lastError = null;
  }

  function noteFailure(what, error, isHttpError = false) {
    lastError = error;
    // 服务器答了但答的是错误码，说明侧车本身是活的
    if (!isHttpError) reachable = false;
    if (!warned) {
      warned = true;
      log?.warn?.(t('perception.sidecar.unavailable', { what, error: error?.message ?? error }));
    }
  }

  async function request(pathname, { method = 'GET', body = null, timeoutMs: custom = null } = {}) {
    if (settings.enabled === false) {
      if (!warned) {
        warned = true;
        log?.warn?.(t('perception.sidecar.disabled'));
      }
      reachable = false;
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), custom ?? timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${pathname}`, {
        method,
        headers: body == null ? undefined : { 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(
          text
            ? t('perception.sidecar.httpErrorWithBody', { status: response.status, body: text.slice(0, 200) })
            : t('perception.sidecar.httpError', { status: response.status }),
        );
        noteFailure(`${method} ${pathname}`, error, true);
        return null;
      }
      const data = await response.json();
      noteSuccess();
      return data;
    } catch (error) {
      noteFailure(`${method} ${pathname}`, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 探活；通了返回 health 对象，不通返回 null（只 warn 一次）。 */
  async function health() {
    const data = await request('/health');
    if (data && data.ok !== false) {
      lastHealth = data;
      return data;
    }
    lastHealth = data ?? null;
    return null;
  }

  /** 主动探测，永不返回 null，方便调用方直判。 */
  async function probe() {
    const data = await health();
    if (data) return data;
    return { ok: false, error: lastError?.message ?? 'unreachable' };
  }

  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item ?? ''));
    const data = await request('/embed', { method: 'POST', body: { texts: list } });
    return Array.isArray(data?.vectors) ? data.vectors : null;
  }

  /** 扩展接口：两段文本的余弦相似度。 */
  async function similar(a, b) {
    const data = await request('/similar', { method: 'POST', body: { a: String(a ?? ''), b: String(b ?? '') } });
    return typeof data?.score === 'number' ? data.score : null;
  }

  async function screenshot({ path: target = null, monitor = 0 } = {}) {
    const query = new URLSearchParams();
    if (target) query.set('path', String(target));
    query.set('monitor', String(monitor ?? 0));
    const data = await request(`/screenshot?${query.toString()}`, { timeoutMs: Math.max(timeoutMs, 20000) });
    if (!data) return null;
    if (data.ok === false) return { ok: false, error: data.error ?? 'screenshot_failed', detail: data.detail ?? null };
    return { ok: true, path: data.path, width: data.width, height: data.height, method: data.method ?? null };
  }

  /** 语音转文字；不可用（没装 faster-whisper）时返回 null。 */
  async function asr(file) {
    const target = typeof file === 'object' && file !== null ? file.path ?? file.file : file;
    if (!target) return null;
    const data = await request('/asr', {
      method: 'POST',
      body: { path: String(target) },
      timeoutMs: Math.max(timeoutMs, 180000),
    });
    if (data?.ok && typeof data.text === 'string') return data.text;
    return null;
  }

  /** 记忆强度打分，items 里的 createdAt / lastAccessAt 都是毫秒时间戳。 */
  async function score(items, now = Date.now()) {
    const list = Array.isArray(items) ? items : [];
    const halfLifeHours = config?.memory?.temporary?.halfLifeHours;
    const data = await request('/score', { method: 'POST', body: { items: list, now, halfLifeHours } });
    return Array.isArray(data?.scores) ? data.scores : null;
  }

  /** 巩固建议：keep / promote / drop / merge；阈值缺省时用 config.memory 里的值补。 */
  async function consolidate(payload = {}) {
    const memory = config?.memory ?? {};
    const thresholds = {
      halfLifeHours: memory.temporary?.halfLifeHours,
      drop: memory.temporary?.minScore,
      promote: memory.permanent?.minImportance,
      mergeSimilarity: memory.consolidate?.mergeSimilarity,
      ...(payload.thresholds ?? {}),
    };
    for (const key of Object.keys(thresholds)) {
      if (thresholds[key] === undefined || thresholds[key] === null) delete thresholds[key];
    }
    const data = await request('/consolidate', {
      method: 'POST',
      body: { items: payload.items ?? [], thresholds, now: payload.now ?? Date.now() },
    });
    if (!data || data.ok === false) return null;
    return { keep: data.keep ?? [], promote: data.promote ?? [], drop: data.drop ?? [], merge: data.merge ?? [] };
  }

  function spawnScript() {
    const script = settings.script;
    const args = [
      script,
      '--host',
      String(host),
      '--port',
      String(port),
    ];
    if (config?.dataDir) args.push('--data-dir', String(config.dataDir));
    return {
      command: settings.python ?? 'python',
      args,
      options: {
        cwd: config?.rootDir ?? process.cwd(),
        detached: false, // 跟着本进程活，stop() 只关我们起的那个
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
    };
  }

  /**
   * 确保障碍已就绪：先探活，探不到就按配置起一个，最多等 10 秒。
   * @returns {Promise<{ started: boolean, ok: boolean, reason?: string, health?: object, pid?: number }>}
   */
  async function ensureStarted({ startTimeoutMs = START_TIMEOUT_MS, pollMs = START_POLL_MS } = {}) {
    const first = await probe();
    if (first.ok) return { started: false, ok: true, health: first };
    if (settings.enabled === false) return { started: false, ok: false, reason: 'disabled' };
    if (settings.autostart === false) return { started: false, ok: false, reason: 'autostart_disabled' };

    if (!child) {
      const script = settings.script;
      if (!script) return { started: false, ok: false, reason: 'script_missing' };
      if (!(await fileExists(script))) return { started: false, ok: false, reason: 'script_missing', detail: script };

      let logStream = null;
      try {
        const logDir = config?.logDir ?? path.join(config?.dataDir ?? process.cwd(), 'logs');
        await ensureDir(logDir);
        logStream = fs.createWriteStream(path.join(logDir, 'sidecar.log'), { flags: 'a' });
      } catch (error) {
        log?.debug?.(t('perception.sidecar.logFileFailed'), error);
      }

      const { command, args, options } = spawnScript();
      try {
        child = spawn(command, args, options);
      } catch (error) {
        child = null;
        noteFailure('spawn', error);
        return { started: false, ok: false, reason: 'spawn_failed', error: error.message };
      }
      const proc = child;
      childExited = false;
      proc.on('error', (error) => {
        childExited = true;
        noteFailure('spawn', error);
      });
      proc.on('exit', () => {
        childExited = true;
        if (child === proc) child = null;
      });
      if (proc.stdout) proc.stdout.on('data', (chunk) => logStream?.write(chunk));
      if (proc.stderr) proc.stderr.on('data', (chunk) => logStream?.write(chunk));
      proc.on('close', () => logStream?.end());
      log?.info?.(t('perception.sidecar.started', { pid: proc.pid }));
    }

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (childExited) break;
      // 启动期探活失败不刷警告
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 2000));
      try {
        const response = await doFetch(`${baseUrl}/health`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (data?.ok !== false) {
            lastHealth = data;
            noteSuccess();
            return { started: true, ok: true, health: data, pid: child?.pid ?? null };
          }
        }
      } catch {
        /* 还在起，继续等 */
      } finally {
        clearTimeout(timer);
      }
    }
    noteFailure('ensureStarted', new Error(t('perception.sidecar.startTimeout')));
    return { started: true, ok: false, reason: 'timeout', pid: child?.pid ?? null };
  }

  /** 关掉自己起的那个侧车进程；别人起的绝不碰。 */
  async function stop() {
    const proc = child;
    child = null;
    if (!proc) return false;
    try {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill();
    } catch (error) {
      log?.debug?.(t('perception.sidecar.stopFailed'), error);
    }
    return true;
  }

  return {
    health,
    probe,
    embed,
    similar,
    screenshot,
    asr,
    score,
    consolidate,
    ensureStarted,
    stop,
    get available() {
      return reachable;
    },
    get lastHealth() {
      return lastHealth;
    },
    get lastError() {
      return lastError;
    },
    get pid() {
      return child?.pid ?? null;
    },
    get enabled() {
      return settings.enabled !== false;
    },
    get url() {
      return baseUrl;
    },
  };
}
