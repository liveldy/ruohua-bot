/**
 * 记忆存储层：按用户分文件 data/memory/<userId>.jsonl（每行一条记录）。
 *
 * 设计要点：
 * - 内存视图是事实来源：load() 只在首次读盘，之后不再回读，避免「刚删掉的记录
 *   被下一次读盘复活」；写盘前再把内存里该用户的记录合并去重后整文件重写。
 * - 同一用户的写入走串行队列（一个 Promise 链），保证顺序写、不会并发写坏文件。
 * - 所有对外方法内部 try/catch，出错只 warn 并返回安全值，绝不把主流程带崩。
 */

import fs from 'node:fs';
import path from 'node:path';

import { t } from '../i18n/index.js';
import { clamp, shortId } from '../util/common.js';
import { listFiles, readJsonl, rewriteJsonl } from '../util/io.js';

const KINDS = new Set(['temporary', 'permanent']);
const JSONL_EXT = '.jsonl';

/** 用户号直接做文件名不安全，先规整成安全字符集。 */
export function safeMemoryUserId(userId) {
  const text = String(userId ?? '').trim();
  return text.replace(/[^0-9A-Za-z_.-]/g, '_').slice(0, 64) || 'unknown';
}

function toPositiveNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function createMemoryStore({ config, logger, dir } = {}) {
  const log = logger ?? null;
  const baseDir = dir
    ?? config?.memoryDir
    ?? path.join(config?.dataDir ?? path.resolve(process.cwd(), 'data'), 'memory');

  const users = new Map(); // key -> { loaded, records: Map<id, record> }
  const queue = new Map(); // key -> Promise 链尾（串行写）

  const warn = (message, error) => {
    log?.warn?.(message, error instanceof Error ? error : undefined);
  };

  function stateOf(key) {
    let state = users.get(key);
    if (!state) {
      state = { loaded: false, records: new Map() };
      users.set(key, state);
    }
    return state;
  }

  function fileOf(userId) {
    return path.join(baseDir, `${safeMemoryUserId(userId)}${JSONL_EXT}`);
  }

  function clone(record) {
    return {
      ...record,
      tags: [...(record.tags ?? [])],
      vector: Array.isArray(record.vector) ? [...record.vector] : null,
    };
  }

  /** 补齐字段、纠正类型；坏数据不许污染内存。 */
  function normalizeRecord(raw = {}) {
    const now = Date.now();
    const importance = Number(raw.importance);
    const createdAt = toPositiveNumber(raw.createdAt, now);
    const updatedAt = toPositiveNumber(raw.updatedAt, createdAt);
    return {
      id: raw.id ? String(raw.id) : shortId('mem'),
      userId: raw.userId ?? null,
      scene: raw.scene ?? null,
      kind: KINDS.has(raw.kind) ? raw.kind : 'temporary',
      content: String(raw.content ?? ''),
      importance: Number.isFinite(importance) ? clamp(importance, 0, 1) : 0.5,
      tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)) : [],
      createdAt,
      updatedAt,
      accessCount: Math.max(0, Math.trunc(Number(raw.accessCount)) || 0),
      lastAccessAt: toPositiveNumber(raw.lastAccessAt, null),
      source: raw.source ?? null,
      vector: Array.isArray(raw.vector) ? raw.vector : null,
    };
  }

  function parseJsonlText(text) {
    return String(text ?? '')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** 合并磁盘行：内存里已有同 id 的以内存为准（内存里才是最新的状态）。 */
  function mergeRows(state, rows) {
    let added = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !row.id) continue;
      const id = String(row.id);
      if (state.records.has(id)) continue;
      state.records.set(id, normalizeRecord(row));
      added += 1;
    }
    return added;
  }

  /** 同一用户的写操作排队执行，避免并发重写同一个文件。 */
  function enqueue(key, task) {
    const previous = queue.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    queue.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  function recordsOfAll() {
    const out = [];
    for (const state of users.values()) {
      for (const record of state.records.values()) out.push(clone(record));
    }
    return out;
  }

  /** 读盘并合并进内存（每个用户只读一次）。 */
  async function load(userId) {
    const key = safeMemoryUserId(userId);
    const state = stateOf(key);
    if (state.loaded) return list(key, {});
    try {
      mergeRows(state, await readJsonl(fileOf(key)));
    } catch (error) {
      warn(t('memory.store.loadFailed', { key, message: error.message }), error);
    }
    state.loaded = true;
    return list(key, {});
  }

  async function loadAll() {
    try {
      const files = await listFiles(baseDir, { filter: (file) => file.endsWith(JSONL_EXT) });
      for (const file of files) {
        const key = path.basename(file, JSONL_EXT);
        if (users.get(key)?.loaded) continue;
        await load(key);
      }
    } catch (error) {
      warn(t('memory.store.dirReadFailed', { message: error.message }), error);
    }
    return recordsOfAll();
  }

  /** 同步预装载：让 list()/stats()/personaFacts() 这类同步方法一上来就能看到数据。 */
  function loadAllSync() {
    let count = 0;
    try {
      for (const name of fs.readdirSync(baseDir)) {
        if (!name.endsWith(JSONL_EXT)) continue;
        const key = name.slice(0, -JSONL_EXT.length);
        const state = stateOf(key);
        if (state.loaded) continue;
        try {
          mergeRows(state, parseJsonlText(fs.readFileSync(path.join(baseDir, name), 'utf8')));
        } catch (error) {
          warn(t('memory.store.loadSyncFailed', { name, message: error.message }), error);
        }
        state.loaded = true;
        count += 1;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') warn(t('memory.store.dirReadSyncFailed', { message: error.message }), error);
    }
    return count;
  }

  /** 重写该用户的文件；写前合并内存里同一 userId 的记录。 */
  function save(userId) {
    const key = safeMemoryUserId(userId);
    return enqueue(key, async () => {
      try {
        const state = stateOf(key);
        if (!state.loaded) await load(key); // 没读过盘就先合并，免得把已有记录覆盖掉
        const rows = [...state.records.values()];
        await rewriteJsonl(fileOf(key), rows);
        return rows.length;
      } catch (error) {
        warn(t('memory.store.saveFailed', { key, message: error.message }), error);
        return 0;
      }
    });
  }

  function list(userId, { kind = null } = {}) {
    try {
      const state = users.get(safeMemoryUserId(userId));
      if (!state) return [];
      const out = [];
      for (const record of state.records.values()) {
        if (kind && record.kind !== kind) continue;
        out.push(clone(record));
      }
      return out;
    } catch (error) {
      warn(t('memory.store.listFailed', { message: error.message }), error);
      return [];
    }
  }

  function get(userId, id) {
    try {
      const record = users.get(safeMemoryUserId(userId))?.records.get(String(id));
      return record ? clone(record) : null;
    } catch (error) {
      warn(t('memory.store.getFailed', { message: error.message }), error);
      return null;
    }
  }

  function has(userId, id) {
    try {
      return users.get(safeMemoryUserId(userId))?.records.has(String(id)) ?? false;
    } catch {
      return false;
    }
  }

  async function insert(userId, record = {}) {
    try {
      const key = safeMemoryUserId(userId);
      const state = stateOf(key);
      const entry = normalizeRecord({ ...record, userId: record.userId ?? userId });
      state.records.set(entry.id, entry);
      return clone(entry);
    } catch (error) {
      warn(t('memory.store.insertFailed', { message: error.message }), error);
      return null;
    }
  }

  async function update(userId, id, patch = {}) {
    try {
      const key = safeMemoryUserId(userId);
      const state = stateOf(key);
      const current = state.records.get(String(id));
      if (!current) return null;
      const next = normalizeRecord({
        ...current,
        ...patch,
        id: current.id,
        userId: current.userId ?? userId,
        updatedAt: patch.updatedAt ?? Date.now(),
      });
      state.records.set(next.id, next);
      return clone(next);
    } catch (error) {
      warn(t('memory.store.updateFailed', { message: error.message }), error);
      return null;
    }
  }

  async function remove(userId, id) {
    try {
      const state = users.get(safeMemoryUserId(userId));
      if (!state) return false;
      return state.records.delete(String(id));
    } catch (error) {
      warn(t('memory.store.removeFailed', { message: error.message }), error);
      return false;
    }
  }

  /** 所有用户的记录（巩固用）。 */
  async function all() {
    await loadAll();
    return recordsOfAll();
  }

  function stats() {
    try {
      let temporary = 0;
      let permanent = 0;
      let userCount = 0;
      for (const state of users.values()) {
        if (!state.records.size) continue;
        userCount += 1;
        for (const record of state.records.values()) {
          if (record.kind === 'permanent') permanent += 1;
          else temporary += 1;
        }
      }
      return { temporary, permanent, users: userCount };
    } catch (error) {
      warn(t('memory.store.statsFailed', { message: error.message }), error);
      return { temporary: 0, permanent: 0, users: 0 };
    }
  }

  return {
    dir: baseDir,
    config,
    logger: log,
    fileOf,
    load,
    loadAll,
    loadAllSync,
    save,
    list,
    get,
    has,
    insert,
    update,
    remove,
    all,
    stats,
  };
}
