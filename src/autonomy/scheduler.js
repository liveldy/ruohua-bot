/**
 * 定时任务（模块二 · 定时任务 / 模块一 · 自主性）：
 * 按 config.autonomy.scheduler.tickSeconds 轮询 data/schedule.json，到点调用注入的
 * deliver({ target, prompt, task })，把 prompt 当作用户消息送进大脑，结果发到 target。
 *
 * 任务类型（时间描述交给 util/time.js 的 parseTimeSpec / nextRunAt）：
 *  - once：触发一次后 enabled = false 并标记 done
 *  - interval：每 everyMs 触发一次
 *  - daily：每天 time 触发一次
 *
 * create / remove / enable 是同步的（改内存 + 异步落盘，需要确定落盘完成时用 save()），
 * start / stop / runNow / tick 是异步的。deliver 抛错只记进 lastError，不影响别的任务。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from '../i18n/index.js';
import { shortId } from '../util/common.js';
import { readJson, writeJsonAtomic } from '../util/io.js';
import { nextRunAt, parseDuration, parseTimeSpec } from '../util/time.js';

const FILE_VERSION = 1;
const DEFAULT_TARGET = { scene: 'private', userId: null, groupId: null };

function copy(task) {
  return task ? { ...task, target: { ...(task.target ?? DEFAULT_TARGET) } } : null;
}

function hashText(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function toTimestamp(value, now) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
  const spec = parseTimeSpec(String(value), now);
  if (spec?.type === 'once') return spec.at;
  const duration = parseDuration(String(value).trim());
  return duration == null ? null : now + duration;
}

function toDurationMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 ? Math.trunc(numeric) : null;
  const parsed = parseDuration(String(value).trim());
  return parsed && parsed > 0 ? parsed : null;
}

function normalizeClock(value) {
  const match = /^(\d{1,2})[:\uFF1A\u70B9](\d{1,2})?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const TYPE_HINT = t('autonomy.scheduler.typeHint');

/** 新建 / 更新日志的键，按任务是不是已经存在挑一个。 */
const SAVE_LOG_KEYS = {
  created: 'autonomy.scheduler.log.created',
  updated: 'autonomy.scheduler.log.updated',
};

const CN_DIGITS = { \u96F6: 0, \u4E00: 1, \u4E8C: 2, \u4E24: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9 };
const UNIT_BY_WORD = { \u79D2: 's', \u5206\u949F: 'm', \u5206: 'm', \u5C0F\u65F6: 'h', \u949F\u5934: 'h', \u5929: 'd' };

/** 中文数字（含「十」「二十」「二十五」）转阿拉伯数字，认不出来返回 null。 */
function cnToNumber(token) {
  const text = String(token ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (CN_DIGITS[text] !== undefined) return CN_DIGITS[text];
  if (text.startsWith('\u5341')) return 10 + (CN_DIGITS[text[1]] ?? 0);
  if (text.endsWith('\u5341')) return (CN_DIGITS[text[0]] ?? 0) * 10;
  if (text.includes('\u5341')) {
    const [head, tail] = text.split('\u5341');
    return (CN_DIGITS[head] ?? 0) * 10 + (CN_DIGITS[tail] ?? 0);
  }
  return null;
}

/** 「晚上八点」「8：30分」→ '20:00' / '08:30'；认不出来返回 null。 */
function cnClock(text) {
  const match = /^([\d\u4E00\u4E8C\u4E24\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341]+)(?:[\u70B9\u6642\u65F6:\uFF1A])([\d\u4E00\u4E8C\u4E24\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341]+)?(?:\u5206)?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = cnToNumber(match[1]);
  const minute = match[2] ? cnToNumber(match[2]) : 0;
  if (hour == null || minute == null || hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 把中文口语的时间说法改写成 util/time.js 的 parseTimeSpec 认识的形式：
 * 「半小时后」→ '+0.5h'、「每隔十分钟」→ '10m'、「晚上八点」→ '20:00'、「每天八点」→ '每天08:00'。
 * 认不出来就原样返回，交给 parseTimeSpec 判 null。
 */
function normalizeWhen(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return raw;
  // 只在中文说法上动刀，改不了就把原样交出去（'every 30m' 这种别动，空格有用）
  const text = raw.replace(/\s+/g, '').replace(/^(?:\u5728|\u5230|\u5927\u6982|\u5927\u7EA6|\u5DEE\u4E0D\u591A)/, '');

  const after = /^([\d\u4E00\u4E8C\u4E24\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341]+)?(?:\u4E2A)?(\u534A)?(\u5206\u949F|\u5206|\u5C0F\u65F6|\u949F\u5934|\u5929|\u79D2)(?:\u4E4B?\u540E|\u4EE5\u540E)$/.exec(text);
  if (after) {
    const unit = UNIT_BY_WORD[after[3]];
    const base = after[1] ? cnToNumber(after[1]) : null;
    const value = (base ?? 0) + (after[2] ? 0.5 : 0);
    if (unit && value > 0) return `+${value}${unit}`;
  }

  const cycle = /^\u6BCF(?:\u9694)?([\d\u4E00\u4E8C\u4E24\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341]+)?(?:\u4E2A)?(\u5206\u949F|\u5206|\u5C0F\u65F6|\u949F\u5934|\u5929|\u79D2)$/.exec(text);
  if (cycle) {
    const unit = UNIT_BY_WORD[cycle[2]];
    const value = cycle[1] ? cnToNumber(cycle[1]) : 1;
    if (unit && value > 0) return `${value}${unit}`;
  }

  const daily = /^(?:\u6BCF\u5929|\u6BCF\u65E5)(\u65E9\u4E0A|\u65E9\u6668|\u4E0A\u5348|\u4E2D\u5348|\u4E0B\u5348|\u508D\u665A|\u665A\u4E0A|\u591C\u91CC)?(.+)$/.exec(text);
  if (daily) {
    const clock = cnClock(daily[2]);
    if (clock) {
      const hour = Number(clock.slice(0, 2));
      const isAfternoon = ['\u4E0B\u5348', '\u508D\u665A', '\u665A\u4E0A', '\u591C\u91CC'].includes(daily[1]);
      const fixed = isAfternoon && hour < 12 ? `${String(hour + 12).padStart(2, '0')}${clock.slice(2)}` : clock;
      return `\u6BCF\u5929${fixed}`;
    }
    return raw;
  }

  return cnClock(text) ?? raw;
}

/** 把 create 的入参整理成 { type, at, everyMs, time }；解析不了就抛错。 */
function normalizeSpec(input = {}, { now = Date.now() } = {}) {
  const when = input.when ?? input.at_when ?? null;
  if (when != null && String(when).trim() !== '') {
    const original = String(when).trim();
    const spec = parseTimeSpec(normalizeWhen(original), now);
    if (!spec) {
      throw new Error(t('autonomy.scheduler.error.unparsableTime', { value: original }));
    }
    return spec;
  }

  const type = String(input.type ?? '').trim().toLowerCase();
  if (!type) throw new Error(TYPE_HINT);

  if (type === 'once') {
    const at = toTimestamp(input.at, now);
    if (at == null) throw new Error(t('autonomy.scheduler.error.needAt'));
    return { type: 'once', at };
  }
  if (type === 'interval') {
    const everyMs = toDurationMs(input.every ?? input.everyMs);
    if (!everyMs) throw new Error(t('autonomy.scheduler.error.needEvery'));
    return { type: 'interval', everyMs };
  }
  if (type === 'daily') {
    const time = normalizeClock(input.time);
    if (!time) throw new Error(t('autonomy.scheduler.error.needTime'));
    return { type: 'daily', time };
  }
  throw new Error(t('autonomy.scheduler.error.unsupportedType', { type: input.type }));
}

function specOf(task) {
  return { type: task.type, at: task.at, everyMs: task.every, time: task.time, lastRunAt: task.lastRunAt };
}

export function createScheduler({ config, logger, dir, deliver, services } = {}) {
  const cfg = config?.autonomy?.scheduler ?? {};
  const dataDir = dir ?? config?.dataDir ?? path.resolve(process.cwd(), 'data');
  const file = path.join(dataDir, 'schedule.json');
  const maxTasks = Math.max(1, Math.trunc(Number(cfg.maxTasks ?? 200)) || 200);
  const tickMs = Math.max(1, Number(cfg.tickSeconds ?? 20)) * 1000;

  const tasks = new Map();
  const log = logger ?? null;
  let timer = null;
  let started = false;
  let running = false;
  let knownMtimeMs = null;
  let pendingSave = Promise.resolve();
  let writesInFlight = 0;

  function persist() {
    const payload = {
      version: FILE_VERSION,
      updatedAt: new Date().toISOString(),
      tasks: [...tasks.values()].map(copy),
    };
    writesInFlight += 1;
    pendingSave = writeJsonAtomic(file, payload)
      .then(async () => {
        try {
          knownMtimeMs = (await fs.stat(file)).mtimeMs;
        } catch {
          knownMtimeMs = null;
        }
      })
      .catch((error) => {
        knownMtimeMs = null;
        log?.warn?.(t('autonomy.scheduler.log.saveFailed'), error);
      })
      .finally(() => {
        writesInFlight -= 1;
      });
    return pendingSave;
  }

  async function save() {
    await persist();
  }

  function revive(row, prev = null) {
    const id = String(row.id);
    let schedule;
    try {
      schedule = normalizeSpec(row, { now: Date.now() });
    } catch (error) {
      log?.warn?.(t('autonomy.scheduler.log.badTimeSpec', { id, message: error.message }));
      return null;
    }
    const now = Date.now();
    const task = {
      id,
      name: String(row.name ?? row.prompt ?? id).slice(0, 60),
      type: schedule.type,
      at: schedule.type === 'once' ? schedule.at : null,
      every: schedule.type === 'interval' ? schedule.everyMs : null,
      time: schedule.type === 'daily' ? schedule.time : null,
      target: row.target ?? prev?.target ?? { ...DEFAULT_TARGET },
      prompt: String(row.prompt ?? ''),
      enabled: row.enabled === undefined ? true : Boolean(row.enabled),
      done: Boolean(row.done),
      source: row.source ?? prev?.source ?? 'file',
      createdAt: row.createdAt ?? prev?.createdAt ?? new Date(now).toISOString(),
      lastRunAt: row.lastRunAt ?? prev?.lastRunAt ?? null,
      runCount: Number(row.runCount ?? prev?.runCount ?? 0) || 0,
      lastError: row.lastError ?? null,
      nextRunAt: row.nextRunAt ?? null,
    };
    if (task.nextRunAt == null && task.enabled && !task.done) task.nextRunAt = nextRunAt(specOf(task), now);
    return task;
  }

  /** 读 schedule.json；文件没变就跳过（外部改动会在下一个 tick 生效）。 */
  async function loadFile({ force = false } = {}) {
    // 先等手上没写完的落盘，避免刚建的任务被旧的磁盘内容盖掉
    if (writesInFlight > 0) await pendingSave.catch(() => {});
    let mtimeMs = null;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (!force && mtimeMs != null && mtimeMs === knownMtimeMs) return false;
    knownMtimeMs = mtimeMs;
    let data = null;
    try {
      data = await readJson(file, null);
    } catch (error) {
      log?.warn?.(t('autonomy.scheduler.log.loadFailed'), error);
      return false;
    }
    if (!data) return false;
    const rows = Array.isArray(data) ? data : data.tasks ?? [];
    const next = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !row.id) continue;
      const task = revive(row, tasks.get(String(row.id)) ?? null);
      if (task) next.set(task.id, task);
    }
    tasks.clear();
    for (const [id, task] of next) tasks.set(id, task);
    return true;
  }

  /** config/tasks.json 里的静态任务：首次 start 时按 id 去重合并进来。 */
  function mergeStaticTasks() {
    if (config?.tasks?.enabled === false) return 0;
    let added = 0;
    for (const raw of config?.tasks?.tasks ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const id =
        raw.id ?? `cfg_${hashText([raw.name, raw.prompt, raw.when, raw.type, raw.time, raw.every].join('|'))}`;
      if (tasks.has(id)) continue;
      const task = revive({ ...raw, id, source: 'config' }, null);
      if (!task) continue;
      tasks.set(task.id, task);
      added += 1;
    }
    return added;
  }

  function create(spec = {}, { now = Date.now() } = {}) {
    if (!spec || typeof spec !== 'object') throw new Error(TYPE_HINT);
    const schedule = normalizeSpec(spec, { now });
    const id = String(spec.id ?? shortId('task'));
    const existing = tasks.get(id) ?? null;
    if (!existing && tasks.size >= maxTasks) {
      throw new Error(t('autonomy.scheduler.error.tooManyTasks', { max: maxTasks }));
    }
    const task = {
      id,
      name: String(spec.name ?? spec.prompt ?? id).slice(0, 60),
      type: schedule.type,
      at: schedule.type === 'once' ? schedule.at : null,
      every: schedule.type === 'interval' ? schedule.everyMs : null,
      time: schedule.type === 'daily' ? schedule.time : null,
      target: spec.target ?? existing?.target ?? { ...DEFAULT_TARGET },
      prompt: String(spec.prompt ?? ''),
      enabled: spec.enabled === undefined ? true : Boolean(spec.enabled),
      done: false,
      source: spec.source ?? existing?.source ?? 'manual',
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      lastRunAt: existing?.lastRunAt ?? null,
      runCount: existing?.runCount ?? 0,
      lastError: null,
      nextRunAt: null,
    };
    task.nextRunAt = nextRunAt(specOf(task), now);
    tasks.set(id, task);
    persist();
    log?.info?.(t(existing ? SAVE_LOG_KEYS.updated : SAVE_LOG_KEYS.created, { name: task.name }), {
      id,
      type: task.type,
      nextRunAt: task.nextRunAt,
    });
    return copy(task);
  }

  function remove(id) {
    const key = String(id);
    const removed = tasks.delete(key);
    if (removed) persist();
    return removed;
  }

  function enable(id, enabled = true) {
    const task = tasks.get(String(id));
    if (!task) return null;
    task.enabled = Boolean(enabled);
    if (task.enabled) {
      // 重新打开一个已经跑完的一次性任务：按原定时间再排一次
      if (task.type === 'once' && task.done) {
        task.done = false;
        task.nextRunAt = nextRunAt(specOf(task), Date.now());
      } else if (task.nextRunAt == null || task.nextRunAt <= Date.now()) {
        task.nextRunAt = nextRunAt(specOf(task), Date.now());
      }
    }
    persist();
    return copy(task);
  }

  async function fire(task, now) {
    task.lastRunAt = now;
    task.runCount += 1;
    task.lastError = null;
    try {
      if (typeof deliver !== 'function') throw new Error(t('autonomy.scheduler.error.noDeliver'));
      await deliver({ target: { ...(task.target ?? DEFAULT_TARGET) }, prompt: task.prompt, task: copy(task) });
      log?.info?.(t('autonomy.scheduler.log.fired', { name: task.name }), { id: task.id, target: task.target });
    } catch (error) {
      task.lastError = error?.message ?? String(error);
      log?.warn?.(t('autonomy.scheduler.log.fireFailed', { name: task.name, error: task.lastError }));
    }
    if (task.type === 'once') {
      task.enabled = false;
      task.done = true;
      task.nextRunAt = null;
    } else {
      task.nextRunAt = nextRunAt(specOf(task), now);
    }
    return copy(task);
  }

  async function tick(now = Date.now()) {
    if (running) return { at: now, fired: [], skipped: 'busy' };
    running = true;
    const fired = [];
    try {
      await loadFile();
      const due = [...tasks.values()]
        .filter((task) => task.enabled && task.nextRunAt != null && task.nextRunAt <= now)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
      for (const task of due) {
        await fire(task, now);
        fired.push({ id: task.id, name: task.name, ok: !task.lastError, error: task.lastError ?? null });
      }
      if (due.length) await persist();
      return { at: now, fired };
    } catch (error) {
      log?.warn?.(t('autonomy.scheduler.log.tickFailed'), error);
      return { at: now, fired, error: error?.message ?? String(error) };
    } finally {
      running = false;
    }
  }

  async function start() {
    if (started) return list();
    started = true;
    try {
      await loadFile({ force: true });
      const added = mergeStaticTasks();
      if (added) log?.info?.(t('autonomy.scheduler.log.mergedStatic', { count: added }));
      for (const task of tasks.values()) {
        if (task.enabled && task.nextRunAt == null) task.nextRunAt = nextRunAt(specOf(task), Date.now());
      }
      await persist();
    } catch (error) {
      log?.warn?.(t('autonomy.scheduler.log.startFailed'), error);
    }
    if (cfg.enabled === false) {
      log?.info?.(t('autonomy.scheduler.log.disabled'));
      return list();
    }
    await tick(Date.now());
    timer = setInterval(() => {
      void tick(Date.now());
    }, tickMs);
    timer.unref?.();
    log?.info?.(t('autonomy.scheduler.log.started', { seconds: Math.round(tickMs / 1000), count: tasks.size }));
    return list();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    await save();
  }

  async function runNow(id) {
    const task = tasks.get(String(id));
    if (!task) throw new Error(t('autonomy.scheduler.error.unknownTask', { id }));
    await fire(task, Date.now());
    await persist();
    return copy(task);
  }

  function list() {
    return [...tasks.values()]
      .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
      .map(copy);
  }

  function get(id) {
    return copy(tasks.get(String(id)) ?? null);
  }

  function stats() {
    const all = [...tasks.values()];
    const upcoming = all
      .filter((task) => task.enabled && task.nextRunAt != null)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
    return {
      total: all.length,
      enabled: all.filter((task) => task.enabled).length,
      done: all.filter((task) => task.done).length,
      nextRunAt: upcoming[0]?.nextRunAt ?? null,
      nextName: upcoming[0]?.name ?? null,
    };
  }

  return {
    start,
    stop,
    tick,
    save,
    list,
    get,
    create,
    remove,
    enable,
    runNow,
    stats,
    get file() {
      return file;
    },
    get running() {
      return Boolean(timer);
    },
    services,
  };
}
