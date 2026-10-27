/**
 * 协议端给的图片，找回它的真身（本地文件）。
 *
 * NapCat 收到图片时，image 段的 `file` 只有**裸文件名**（协议端内部的 `picElement.fileName`，
 * 形如 `3147a15d4bc3715ff840424d59589115.jpg`），真身躺在协议端自己的缓存目录里：
 *   <文档>/Tencent Files/<QQ号>/nt_qq/nt_data/Emoji/emoji-recv/<年月>/Ori/<名字>
 *   <文档>/Tencent Files/<QQ号>/nt_qq/nt_data/Pic/<年月>/Ori/<名字>
 * 于是上层拿到这个名字只会「本地文件读不进来」：识图白报一次 ENOENT，表情包整张跳过 ——
 * 真机日志里反复出现。这个模块按缓存的目录形状把裸名字找回来，交给上层当本地文件读。
 *
 * 名字大小写不可靠（协议端给大写 hash，盘上是小写），比较时统一小写。
 * 远端地址、base64 / data URI、真正的路径（含 file://）一律原样放行，不碰。
 *
 * 用法（main.js 装一次，传给表情包与上下文）：
 *   const imageSource = createImageSourceResolver({ logger, extra: config.sticker?.allowedRoots });
 *   await imageSource.roots();                  // 找到了哪些缓存目录
 *   await imageSource.resolve('3147a15d....jpg');   // → 绝对路径，找不到给 null
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n/index.js';

/** 图片可能落在这几个子目录下（相对 nt_data）。 */
export const IMAGE_SUBDIRS = ['Emoji/emoji-recv', 'Emoji', 'Pic', 'File'];

const DEFAULT_MAX_DIRS = 400;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CACHE_LIMIT = 200;
const DEFAULT_MISS_TTL_MS = 30_000;

/**
 * QQ（NTQQ）数据目录的常见落点。
 * 中文系统重定向到 OneDrive 的「文档」目录时认不出来 —— 那种情况把目录写进
 * config/sticker.json 的 allowedRoots，解析器会一起当缓存目录用。
 */
function candidateBases(home) {
  return [path.join(home, 'Documents', 'Tencent Files'), path.join(home, 'OneDrive', 'Documents', 'Tencent Files')];
}

/**
 * 探出协议端的图片缓存根目录（只挑真实存在的）：`<Tencent Files>/<QQ号>/nt_qq/nt_data`。
 * 非 Windows 或没装 QQ 时返回空数组 —— 那种情况下协议端一般直接给真路径，不需要这一步。
 */
export async function protocolImageRoots({ home = os.homedir(), extra = [] } = {}) {
  const found = [];
  const push = (dir) => {
    const resolved = path.resolve(dir);
    if (!found.includes(resolved)) found.push(resolved);
  };
  for (const base of candidateBases(home)) {
    let entries = [];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    const accounts = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
    for (const account of [base, ...accounts]) {
      const root = path.join(account, 'nt_qq', 'nt_data');
      try {
        const stat = await fs.stat(root);
        if (stat.isDirectory()) push(root);
      } catch {
        /* 没有就跳过 */
      }
    }
  }
  for (const item of Array.isArray(extra) ? extra : []) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    try {
      const stat = await fs.stat(text);
      if (stat.isDirectory()) push(text);
    } catch {
      /* 配置里写错的目录不当缓存用 */
    }
  }
  return found;
}

/** 远端 / 内嵌来源：不归这里管。 */
const isRemoteSource = (text) => /^(?:https?|data|base64):/i.test(text);
/** 已经带目录的写法：交给上层自己的边界判定。 */
const looksLikePath = (text) => /^file:\/\//i.test(text) || path.isAbsolute(text) || /[\\/]/.test(text);

/**
 * @param {{ roots?: string[]|null, extra?: string[], logger?: object|null, home?: string,
 *           maxDirs?: number, maxDepth?: number, cacheLimit?: number, missTtlMs?: number,
 *           fsImpl?: object, now?: Function }} [options]
 */
export function createImageSourceResolver({
  roots = null,
  extra = [],
  logger = null,
  home = os.homedir(),
  maxDirs = DEFAULT_MAX_DIRS,
  maxDepth = DEFAULT_MAX_DEPTH,
  cacheLimit = DEFAULT_CACHE_LIMIT,
  missTtlMs = DEFAULT_MISS_TTL_MS,
  fsImpl = fs,
  now = Date.now,
} = {}) {
  const io = fsImpl ?? fs;
  const limit = Math.max(1, Number(maxDirs) || DEFAULT_MAX_DIRS);
  const depthLimit = Math.max(0, Number(maxDepth) || DEFAULT_MAX_DEPTH);
  const cap = Math.max(1, Number(cacheLimit) || DEFAULT_CACHE_LIMIT);
  const ttl = Math.max(0, Number(missTtlMs) || 0);

  const hits = new Map();
  const misses = new Map();
  const counters = { found: 0, missing: 0, scans: 0 };
  let rootsPromise = null;
  let announced = false;

  function rootList() {
    if (!rootsPromise) {
      rootsPromise = Array.isArray(roots)
        ? Promise.resolve(roots.map((item) => path.resolve(String(item))))
        : protocolImageRoots({ home, extra, fsImpl: io });
    }
    return rootsPromise;
  }

  /** 在某个缓存根下按目录形状找一个文件名，返回最新的那个（找不到 null）。 */
  async function searchUnder(root, name) {
    const target = name.toLowerCase();
    const queue = IMAGE_SUBDIRS.map((sub) => ({ dir: path.join(root, sub), depth: 0 }));
    let visited = 0;
    let best = null;
    while (queue.length && visited < limit) {
      const { dir, depth } = queue.shift();
      visited += 1;
      let entries;
      try {
        entries = await io.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < depthLimit) queue.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (entry.name.toLowerCase() !== target) continue;
        let stat = null;
        try {
          stat = await io.stat(full);
        } catch {
          continue;
        }
        if (!stat?.isFile()) continue;
        if (!best || Number(stat.mtimeMs ?? 0) > best.mtimeMs) best = { path: full, mtimeMs: Number(stat.mtimeMs ?? 0) };
      }
    }
    return best;
  }

  async function search(name) {
    counters.scans += 1;
    const list = await rootList();
    let best = null;
    for (const root of list) {
      const found = await searchUnder(root, name);
      if (found && (!best || found.mtimeMs > best.mtimeMs)) best = found;
    }
    return best;
  }

  /**
   * 一个来源 → 能读的东西。远端地址、base64、带目录的路径原样返回；裸文件名去协议端缓存里找，
   * 找不到给 null（调用方自己决定怎么降级）。永远不抛。
   */
  async function resolve(source) {
    const text = String(source ?? '').trim();
    if (!text) return null;
    if (isRemoteSource(text) || looksLikePath(text)) return text;
    const key = text.toLowerCase();
    if (hits.has(key)) return hits.get(key);
    const missedAt = misses.get(key);
    if (missedAt !== undefined && now() - missedAt < ttl) return null;

    let found = null;
    try {
      found = await search(text);
    } catch (error) {
      logger?.debug?.(t('perception.imageSource.searchFailed', { name: text, reason: error?.message ?? error }));
    }
    if (found) {
      counters.found += 1;
      if (!announced) {
        announced = true;
        logger?.info?.(
          t('perception.imageSource.resolved', { name: text, path: found.path, roots: (await rootList()).length }),
        );
      }
      if (hits.size >= cap) hits.delete(hits.keys().next().value);
      hits.set(key, found.path);
      misses.delete(key);
      return found.path;
    }
    counters.missing += 1;
    if (misses.size >= cap) misses.delete(misses.keys().next().value);
    misses.set(key, now());
    return null;
  }

  /** 一串来源挨个解析，保留顺序、去重、丢掉解析不出来的裸名字。 */
  async function resolveAll(sources = []) {
    const out = [];
    for (const source of Array.isArray(sources) ? sources : [sources]) {
      const text = String(source ?? '').trim();
      if (!text || out.includes(text)) continue;
      const resolved = await resolve(text);
      if (resolved && !out.includes(resolved)) out.push(resolved);
    }
    return out;
  }

  return {
    resolve,
    resolveAll,
    roots: rootList,
    stats: () => ({ ...counters, hits: hits.size, misses: misses.size }),
  };
}

export default { createImageSourceResolver, protocolImageRoots, IMAGE_SUBDIRS };
