/** 日志：控制台 + 操作日志 + 对话日志（JSONL 按天切）。 */

import path from 'node:path';
import { appendJsonl, ensureDir, writeJsonAtomic } from '../util/io.js';
import { formatTime } from '../util/time.js';
import { t } from '../i18n/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function dayStamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatMeta(meta) {
  if (meta == null) return '';
  if (meta instanceof Error) return ` ${meta.message}`;
  if (typeof meta !== 'object') return ` ${String(meta)}`;
  try {
    const text = JSON.stringify(meta);
    return text === '{}' ? '' : ` ${text.length > 800 ? `${text.slice(0, 800)}…` : text}`;
  } catch {
    return '';
  }
}

export function createLogger({ level = 'info', dir = null, name = 'ruohua', console: useConsole = true, bus = new Set() } = {}) {
  let threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const baseName = name;
  let logDir = dir;
  const queue = [];
  const listeners = bus;

  if (logDir) ensureDir(logDir).catch(() => {});

  const write = (file, obj) => {
    if (!logDir) return;
    const target = path.join(logDir, file);
    const task = appendJsonl(target, obj).catch(() => {});
    queue.push(task);
  };

  const emit = (levelName, message, meta, extra = {}) => {
    const ts = Date.now();
    if (useConsole && LEVELS[levelName] >= threshold) {
      const line = `[${formatTime(ts)}] ${levelName.toUpperCase().padEnd(5)} ${baseName} · ${message}${formatMeta(meta)}`;
      if (levelName === 'error') console.error(line);
      else if (levelName === 'warn') console.warn(line);
      else console.log(line);
    }
    if (logDir && LEVELS[levelName] >= Math.max(LEVELS.info, threshold - 10)) {
      write(`app-${dayStamp(ts)}.jsonl`, { ts, level: levelName, name: baseName, message, meta: safeMeta(meta), ...extra });
    }
    // 订阅者（控制面板等）：控制台关掉、级别调高都照收，只保证不掉链路
    for (const listener of listeners) {
      try {
        listener({ ts, level: levelName, name: baseName, message: String(message ?? ''), meta: safeMeta(meta) });
      } catch {
        /* 订阅者自己的错不该影响日志 */
      }
    }
  };

  const logger = {
    name: baseName,
    level: level,
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child(childName) {
      return createLogger({ level, dir: logDir, name: `${baseName}.${childName}`, console: useConsole, bus: listeners });
    },
    /** 订阅日志事件（同一进程内的控制面板用）。返回取消订阅的函数。 */
    onEvent(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLevel(next) {
      threshold = LEVELS[String(next).toLowerCase()] ?? threshold;
    },
    setDir(nextDir) {
      logDir = nextDir;
      threshold = LEVELS[String(level).toLowerCase()] ?? threshold;
      if (logDir) ensureDir(logDir).catch(() => {});
    },
    file() {
      return logDir;
    },
    /** 操作日志：谁、做了什么、结果如何。 */
    operation(entry = {}) {
      const ts = entry.at ?? Date.now();
      const record = {
        ts,
        actor: entry.actor ?? null,
        actorName: entry.actorName ?? null,
        action: entry.action ?? 'unknown',
        target: entry.target === undefined ? null : entry.target,
        ok: entry.ok === undefined ? true : Boolean(entry.ok),
        detail: entry.detail ?? null,
        taskId: entry.taskId ?? null,
        durationMs: entry.durationMs ?? null,
      };
      write(`operation-${dayStamp(ts)}.jsonl`, record);
      emit(
        'info',
        record.ok ? t('app.logger.operation', { action: record.action }) : t('app.logger.operationFailed', { action: record.action }),
        {
          actor: record.actor,
          target: record.target,
          detail: record.detail,
        },
      );
      return record;
    },
    /** 对话日志：收发原始文本。 */
    conversation(entry = {}) {
      const ts = entry.at ?? Date.now();
      const record = {
        ts,
        scene: entry.scene ?? 'unknown',
        userId: entry.userId ?? null,
        groupId: entry.groupId ?? null,
        direction: entry.direction === 'out' ? 'out' : 'in',
        name: entry.name ?? null,
        text: entry.text ?? '',
        meta: entry.meta ?? null,
      };
      write(`conversation-${dayStamp(ts)}.jsonl`, record);
      emit('debug', `${record.direction === 'out' ? '→' : '←'} ${String(record.text).slice(0, 120)}`, {
        userId: record.userId,
        groupId: record.groupId,
      });
      return record;
    },
    async flush() {
      await Promise.allSettled(queue.splice(0, queue.length));
    },
    async writeSnapshot(name, data) {
      if (!logDir) return null;
      return writeJsonAtomic(path.join(logDir, name), data);
    },
  };

  return logger;
}

function safeMeta(meta) {
  if (meta == null) return null;
  if (meta instanceof Error) return { name: meta.name, message: meta.message, stack: String(meta.stack).split('\n').slice(0, 4).join('\n') };
  if (typeof meta !== 'object') return meta;
  try {
    return JSON.parse(JSON.stringify(meta, (key, value) => (typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…` : value)));
  } catch {
    return String(meta);
  }
}

export function childLogger(logger, name) {
  return logger?.child ? logger.child(name) : createLogger({ name: `${logger?.name ?? 'ruohua'}.${name}`, console: false });
}

/** 给测试用的哑日志：吞掉一切。 */
export function createNullLogger() {
  const logger = createLogger({ level: 'silent', dir: null, name: 'null', console: false });
  logger.operation = (entry) => entry ?? {};
  logger.conversation = (entry) => entry ?? {};
  logger.flush = async () => {};
  return logger;
}
