/**
 * 表情包库：图片文件 + 一份 JSON 索引。
 *
 * 文件放 `config.stickerDir`（默认 `stickers/`），名字 `sticker_<短id>.<ext>`；
 * 索引放 `config.stickerIndexFile`（默认 `data/stickers/index.json`），形状 `{ version: 1, items: [...] }`，
 * 用 `src/util/io.js` 的原子写落盘（临时文件 + rename）。
 *
 * 契约见 docs/STICKERS.md：
 *   createStickerLibrary({ dir, indexFile, logger, maxItems, maxFileBytes })
 *     → { load, save, list, get, findByHash, add, update, remove, stats, markUsed, ... }
 *
 * 两条底线：
 *   1. 只读 `stickers/` 与 `data/` 下的本地文件（或 http(s) 下载）——路径越界一律拒绝；
 *   2. 对外的方法不把异常抛给调用方，内部失败降级 + 记日志（参数明显非法时才抛）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir, readJson, writeTextAtomic } from '../util/io.js';
import { shortId } from '../util/common.js';
import { t } from '../i18n/index.js';

export const INDEX_VERSION = 1;

/** 认得的图片后缀。 */
export const STICKER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.apng'];

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5000;

/** 库里能改的字段（其余字段由存储层维护）。 */
const PATCHABLE_FIELDS = new Set(['title', 'meaning', 'tags', 'origin', 'addedBy']);

/** 标题最多几个字。 */
export const TITLE_MAX_CHARS = 12;

function toPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.trunc(num);
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 从配置里算出表情包目录与索引文件（绝对路径）。
 * `config.stickerDir` / `config.stickerIndexFile` 优先，其次 `config.sticker.dir` / `.indexFile`。
 */
export function resolveStickerPaths({ config = null, dir = null, indexFile = null } = {}) {
  const settings = config?.sticker ?? {};
  const rootDir = config?.rootDir ?? process.cwd();
  return {
    dir: path.resolve(dir ?? config?.stickerDir ?? path.join(rootDir, settings.dir ?? 'stickers')),
    indexFile: path.resolve(
      indexFile ?? config?.stickerIndexFile ?? path.join(rootDir, settings.indexFile ?? path.join('data', 'stickers', 'index.json')),
    ),
  };
}

function sniffExt(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp';
  return null;
}

/** 从文件名或 URL 里取后缀，不认得就返回 null。 */
function extFromName(name) {
  let text = String(name ?? '');
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname;
    } catch {
      /* 用原串兜底 */
    }
  }
  const ext = path.extname(text).toLowerCase();
  if (!STICKER_EXTENSIONS.includes(ext)) return null;
  return ext === '.jpeg' ? '.jpg' : ext;
}

function pickExt({ name, buffer }) {
  return sniffExt(buffer) ?? extFromName(name) ?? '.png';
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '').trim().slice(0, 16);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

/** 短标题：只认字符串，压掉空白，最多 {@link TITLE_MAX_CHARS} 个字（认不出来就是空串）。 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  const text = title.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : text;
}

function safeId(raw, fallback) {
  const text = String(raw ?? '').trim();
  if (/^[A-Za-z0-9_-]{1,32}$/.test(text)) return text;
  return fallback;
}

function normalizeForCompare(target) {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

/** target 是否在 root 里面（含 root 本身）。 */
function isInside(target, root) {
  const rel = path.relative(normalizeForCompare(root), normalizeForCompare(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realOrRaw(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * @param {{
 *   dir: string,
 *   indexFile?: string|null,
 *   logger?: object|null,
 *   maxItems?: number,
 *   maxFileBytes?: number,
 *   rootDir?: string|null,
 *   dataDir?: string|null,
 *   allowedRoots?: string[]|null,
 *   fetchImpl?: Function|null,
 *   downloadTimeoutMs?: number,
 * }} options
 */
export function createStickerLibrary({
  dir,
  indexFile = null,
  logger = null,
  maxItems = DEFAULT_MAX_ITEMS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  rootDir = null,
  dataDir = null,
  allowedRoots = null,
  fetchImpl = null,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (!dir || typeof dir !== 'string') throw new Error(t('sticker.error.dirRequired'));

  const log = logger?.child ? logger.child('library') : logger;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const absoluteDir = path.resolve(dir);
  const absoluteIndexFile = indexFile ? path.resolve(indexFile) : path.join(absoluteDir, 'index.json');
  const maxFileBytesLimit = toPositiveInt(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxItemCount = toPositiveInt(maxItems, DEFAULT_MAX_ITEMS);
  const timeoutMs = toPositiveInt(downloadTimeoutMs, DOWNLOAD_TIMEOUT_MS);

  /**
   * 允许读的本地目录：表情包目录 + 索引所在的 data 目录，再加上额外配置的 allowedRoots。
   * 额外目录不是「覆盖」而是「追加」——协议端缓存（NapCat 的图片目录之类）要单独放进来，
   * 但不能因此把 data/ 与 stickers/ 挤掉。
   */
  const roots = (() => {
    const list = [absoluteDir];
    const data = dataDir
      ? path.resolve(String(dataDir))
      : rootDir
        ? path.join(path.resolve(String(rootDir)), 'data')
        : path.dirname(path.dirname(absoluteIndexFile));
    if (data && !list.includes(data)) list.push(data);
    for (const item of Array.isArray(allowedRoots) ? allowedRoots : []) {
      const resolved = path.resolve(String(item));
      if (resolved && !list.includes(resolved)) list.push(resolved);
    }
    return list;
  })();

  let items = [];
  let loaded = false;

  function withPath(item) {
    return { ...item, path: path.join(absoluteDir, item.file) };
  }

  function toPublic(item) {
    return item ? withPath(item) : null;
  }

  function indexPayload() {
    return { version: INDEX_VERSION, items: items.map((item) => ({ ...item })) };
  }

  /** 解析本地路径：越界、不是文件、太大都返回 null。 */
  async function resolveLocalFile(source) {
    let text = String(source ?? '').trim();
    if (!text) return null;
    if (/^file:\/\//i.test(text)) {
      text = text.replace(/^file:\/\//i, '');
      if (/^\/[A-Za-z]:\//.test(text)) text = text.slice(1);
      try {
        text = decodeURIComponent(text);
      } catch {
        /* 保留原样 */
      }
    }
    const absoluteGiven = path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text);
    let candidate = null;
    if (absoluteGiven) {
      candidate = path.resolve(text);
    } else {
      // 相对路径多半是协议端（NapCat）给的文件名，它是相对自己的缓存目录说的：
      // 先在允许目录里挨个找，找得到就当命中；找不到再退回按工作目录解析（下面会被拒）。
      for (const root of roots) {
        const attempt = path.resolve(root, text);
        try {
          await fs.stat(attempt);
          candidate = attempt;
          break;
        } catch {
          /* 换个根试试 */
        }
      }
      if (!candidate) candidate = path.resolve(text);
    }
    if (!roots.some((root) => isInside(candidate, root))) {
      // 绝对路径越界是真事，要提醒；一个落不下来的相对文件名降一级，别把日志刷满
      if (absoluteGiven) log?.warn?.(t('sticker.log.pathDenied', { path: candidate }));
      else log?.debug?.(t('sticker.log.unresolvedRelative', { name: text }));
      return null;
    }
    // 防软链逃逸：真实路径也得在（真实路径下的）允许目录里
    const real = await realOrRaw(candidate);
    const realRoots = await Promise.all(roots.map((root) => realOrRaw(root)));
    if (!realRoots.some((root) => isInside(real, root))) {
      log?.warn?.(t('sticker.log.pathDenied', { path: candidate }));
      return null;
    }
    let stat = null;
    try {
      stat = await fs.stat(candidate);
    } catch (error) {
      log?.debug?.(t('sticker.log.learnFailed', { source: candidate, reason: error?.message ?? error }));
      return null;
    }
    if (!stat.isFile()) {
      log?.debug?.(t('sticker.log.learnFailed', { source: candidate, reason: 'not_a_file' }));
      return null;
    }
    if (stat.size > maxFileBytesLimit) {
      log?.warn?.(t('sticker.log.tooLarge', { bytes: stat.size, max: maxFileBytesLimit }));
      return null;
    }
    return { path: candidate, stat };
  }

  /**
   * 这个来源读得进来吗：只有本地文件能提前判（越界、不存在、太大），url / buffer 交给 add() 去下载与校验。
   * 调用方（表情包服务）拿它挡在识图前面 —— 读不到的文件喂给视觉模型只会白报一次 ENOENT，
   * 还容易把人引到「是不是模型不支持图片」上去。
   * @returns {Promise<boolean>} false = 库层注定会拒，别再往下走
   */
  async function readable(source) {
    if (source?.sourceFile) return Boolean(await resolveLocalFile(source.sourceFile));
    return true;
  }

  /** 限大小、限时下载；失败返回 null，不抛。 */
  async function downloadBuffer(url) {
    if (typeof doFetch !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.('content-length') ?? 0);
      if (declared && declared > maxFileBytesLimit) throw new Error(`too_large:${declared}`);
      if (!response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxFileBytesLimit) throw new Error(`too_large:${buffer.byteLength}`);
        return buffer;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxFileBytesLimit) throw new Error(`too_large:${size}`);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      const reason = String(error?.message ?? error);
      if (reason.startsWith('too_large')) {
        log?.warn?.(t('sticker.log.tooLarge', { bytes: reason.split(':')[1] ?? '?', max: maxFileBytesLimit }));
      } else {
        log?.debug?.(t('sticker.log.downloadFailed', { url: String(url).slice(0, 200), reason }));
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把三种来源统一成一段字节 + 一个来源标签（不认识 / 失败返回 null）。 */
  async function readSource({ sourceFile = null, sourceBuffer = null, sourceUrl = null } = {}) {
    if (sourceBuffer != null) {
      const buffer = Buffer.isBuffer(sourceBuffer) ? sourceBuffer : Buffer.from(sourceBuffer);
      if (!buffer.length) return null;
      if (buffer.byteLength > maxFileBytesLimit) {
        log?.warn?.(t('sticker.log.tooLarge', { bytes: buffer.byteLength, max: maxFileBytesLimit }));
        return null;
      }
      return { buffer, name: null, origin: 'buffer' };
    }
    if (sourceFile) {
      const resolved = await resolveLocalFile(sourceFile);
      if (!resolved) return null;
      try {
        const buffer = await fs.readFile(resolved.path);
        return { buffer, name: resolved.path, origin: 'file' };
      } catch (error) {
        log?.debug?.(t('sticker.log.learnFailed', { source: String(sourceFile), reason: error?.message ?? error }));
        return null;
      }
    }
    if (sourceUrl) {
      const text = String(sourceUrl).trim();
      if (!/^https?:\/\//i.test(text)) {
        log?.debug?.(t('sticker.log.learnFailed', { source: text.slice(0, 200), reason: 'unsupported_url' }));
        return null;
      }
      const buffer = await downloadBuffer(text);
      if (!buffer) return null;
      return { buffer, name: text, origin: 'url' };
    }
    return undefined;
  }

  function findIndex(id) {
    return items.findIndex((item) => item.id === String(id ?? ''));
  }

  function uniqueId(preferred) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = attempt === 0 ? preferred : shortId();
      if (!items.some((item) => item.id === id)) return id;
    }
    return `${preferred}_${Date.now().toString(36)}`;
  }

  async function load() {
    const data = await readJson(absoluteIndexFile, null).catch((error) => {
      log?.warn?.(t('sticker.log.indexLoadFailed', { reason: error?.message ?? error }));
      return null;
    });
    const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    const seen = new Set();
    const kept = [];
    let missing = 0;
    let dropped = 0;
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') {
        dropped += 1;
        continue;
      }
      const file = String(raw.file ?? '').trim();
      const id = safeId(raw.id, file ? path.basename(file, path.extname(file)) : '');
      if (!file || !id || seen.has(id)) {
        dropped += 1;
        continue;
      }
      const exists = await fs
        .stat(path.join(absoluteDir, file))
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (!exists) {
        missing += 1;
        continue;
      }
      seen.add(id);
      kept.push({
        id,
        file,
        ext: String(raw.ext ?? path.extname(file) ?? '.png').toLowerCase(),
        bytes: Number(raw.bytes ?? 0) || 0,
        title: normalizeTitle(raw.title),
        meaning: String(raw.meaning ?? ''),
        tags: normalizeTags(raw.tags),
        addedBy: raw.addedBy ?? null,
        addedAt: Number(raw.addedAt ?? 0) || 0,
        usedCount: Number(raw.usedCount ?? 0) || 0,
        lastUsedAt: raw.lastUsedAt == null ? null : Number(raw.lastUsedAt) || null,
        sourceHash: raw.sourceHash ? String(raw.sourceHash).toLowerCase() : null,
        origin: String(raw.origin ?? 'manual'),
      });
    }
    items = kept;
    loaded = true;
    if (missing) log?.warn?.(t('sticker.log.dropMissing', { count: missing }));
    if (dropped) log?.debug?.(t('sticker.log.dropInvalid', { count: dropped }));
    log?.debug?.(t('sticker.log.indexLoaded', { count: items.length }));
    return indexPayload();
  }

  async function save() {
    try {
      await writeTextAtomic(absoluteIndexFile, `${JSON.stringify(indexPayload(), null, 2)}\n`);
      return absoluteIndexFile;
    } catch (error) {
      log?.warn?.(t('sticker.log.indexSaveFailed', { reason: error?.message ?? error }));
      return null;
    }
  }

  function list({ tag = null, keyword = null, limit = null, offset = 0 } = {}) {
    let rows = items.slice();
    if (tag) {
      const wanted = String(tag);
      rows = rows.filter((item) => item.tags.includes(wanted));
    }
    if (keyword) {
      const needle = String(keyword).toLowerCase();
      rows = rows.filter(
        (item) =>
          item.meaning.toLowerCase().includes(needle) ||
          item.file.toLowerCase().includes(needle) ||
          item.id.toLowerCase().includes(needle) ||
          item.tags.some((item2) => item2.toLowerCase().includes(needle)),
      );
    }
    rows.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
    const start = Math.max(0, Number(offset) || 0);
    const count = Number(limit);
    const sliced = Number.isFinite(count) && count > 0 ? rows.slice(start, start + Math.trunc(count)) : rows.slice(start);
    return sliced.map(toPublic);
  }

  function get(id) {
    const index = findIndex(id);
    return index >= 0 ? toPublic(items[index]) : null;
  }

  function findByHash(hash) {
    const wanted = String(hash ?? '').toLowerCase();
    if (!wanted) return null;
    const found = items.find((item) => item.sourceHash === wanted);
    return found ? toPublic(found) : null;
  }

  async function add({
    id = null,
    sourceFile = null,
    sourceBuffer = null,
    sourceUrl = null,
    title = '',
    meaning = '',
    tags = [],
    addedBy = null,
    sourceHash = null,
    origin = null,
  } = {}) {
    const source = await readSource({ sourceFile, sourceBuffer, sourceUrl });
    if (source === undefined) throw new Error(t('sticker.error.noSource'));
    if (source === null) return null;

    const hash = sha256(source.buffer);
    const duplicate = items.find((item) => item.sourceHash === hash);
    if (duplicate) {
      duplicate.usedCount = (Number(duplicate.usedCount) ?? 0) + 1;
      duplicate.lastUsedAt = Date.now();
      await save();
      log?.debug?.(t('sticker.log.duplicate', { id: duplicate.id }));
      return toPublic(duplicate);
    }

    if (items.length >= maxItemCount) {
      log?.warn?.(t('sticker.log.libraryFull', { max: maxItemCount }));
      return null;
    }

    const ext = pickExt({ name: source.name, buffer: source.buffer });
    const fallbackId = shortId();
    const finalId = uniqueId(safeId(id, fallbackId));
    const fileName = `sticker_${finalId}${ext}`;
    await ensureDir(absoluteDir);
    try {
      await fs.writeFile(path.join(absoluteDir, fileName), source.buffer);
    } catch (error) {
      log?.warn?.(t('sticker.log.learnFailed', { source: source.name ?? 'buffer', reason: error?.message ?? error }));
      return null;
    }

    const item = {
      id: finalId,
      file: fileName,
      ext,
      bytes: source.buffer.byteLength,
      title: normalizeTitle(title),
      meaning: String(meaning ?? ''),
      tags: normalizeTags(tags),
      addedBy: addedBy ?? null,
      addedAt: Date.now(),
      usedCount: 0,
      lastUsedAt: null,
      sourceHash: hash,
      origin: String(origin ?? source.origin),
    };
    items.push(item);
    await save();
    log?.info?.(t('sticker.log.learned', { id: item.id, meaning: item.meaning }));
    return toPublic(item);
  }

  async function update(id, patch = {}) {
    const index = findIndex(id);
    if (index < 0) return null;
    const item = items[index];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!PATCHABLE_FIELDS.has(key)) continue;
      if (key === 'tags') item.tags = normalizeTags(value);
      else if (key === 'title') item.title = normalizeTitle(value);
      else if (key === 'meaning') item.meaning = String(value ?? '');
      else item[key] = value ?? null;
    }
    await save();
    return toPublic(item);
  }

  async function remove(id) {
    const index = findIndex(id);
    if (index < 0) return false;
    const [item] = items.splice(index, 1);
    const filePath = path.join(absoluteDir, item.file);
    if (isInside(path.resolve(filePath), absoluteDir)) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') log?.debug?.(t('sticker.log.learnFailed', { source: item.file, reason: error?.message ?? error }));
      }
    }
    await save();
    return true;
  }

  /** 记一次「用掉了」：发送成功后调用。 */
  async function markUsed(id, at = Date.now()) {
    const index = findIndex(id);
    if (index < 0) return null;
    const item = items[index];
    item.usedCount = (Number(item.usedCount) ?? 0) + 1;
    item.lastUsedAt = at;
    await save();
    return toPublic(item);
  }

  function stats() {
    const byTag = {};
    let sent = 0;
    let lastUsedAt = null;
    let lastLearnedAt = null;
    for (const item of items) {
      for (const tag of item.tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
      sent += Number(item.usedCount ?? 0) || 0;
      if (item.lastUsedAt && (!lastUsedAt || item.lastUsedAt > lastUsedAt)) lastUsedAt = item.lastUsedAt;
      if (item.addedAt && (!lastLearnedAt || item.addedAt > lastLearnedAt)) lastLearnedAt = item.addedAt;
    }
    return { total: items.length, byTag, learned: items.length, sent, lastUsedAt, lastLearnedAt };
  }

  return {
    load,
    save,
    list,
    get,
    findByHash,
    add,
    update,
    remove,
    markUsed,
    readable,
    stats,
    get dir() {
      return absoluteDir;
    },
    get indexFile() {
      return absoluteIndexFile;
    },
    get loaded() {
      return loaded;
    },
    get allowedRoots() {
      return [...roots];
    },
    limits: { maxItems: maxItemCount, maxFileBytes: maxFileBytesLimit },
  };
}

export default { createStickerLibrary };
