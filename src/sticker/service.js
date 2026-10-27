/**
 * 表情包服务：认识表情包、学下管理员的、在合适的时候挑一张发出去。
 *
 * 契约见 docs/STICKERS.md：
 *   createStickerService({ config, logger, llm, vision, library, dir })
 *     → { enabled, observe, note, pick, send, describe, learn, list, get, remove, stats }
 *
 * 发送语义（关键）：`send()` 只负责表情包那一条消息（`[{ type: 'image', data: { file } }]`）。
 * `config.sticker.standalone !== false`（默认）时，表情包**单独发一条**，绝不跟文字挤在同一条里；
 * 调用方给了 `text` 就按 standalone 分成两条（先文字后图），或者调用方自己先发文字再调 `send()`。
 *
 * 一切都不要抛到调用方：内部失败降级 + 记日志（参数明显非法时才抛）。
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { t } from '../i18n/index.js';
import { clamp } from '../util/common.js';
import { truncate } from '../util/text.js';
import { moodBias } from '../persona/expressions.js';
import { noVisionText } from '../perception/vision.js';
import { createStickerLibrary, normalizeTitle, resolveStickerPaths } from './library.js';

const DEFAULT_SEND_CHANCE = 0.16;
const DEFAULT_COOLDOWN_MS = 120000;
const DEFAULT_MEANING_MAX_CHARS = 60;
const NOTE_CAPACITY = 200;
const NOTE_RECENT_LIMIT = 5;

/**
 * 数据：表情包的来源。一条消息里的每张图一组 —— 组内先试 `file` 再试 `url`，一张成功就够。
 * 协议端（NapCat）给的 `file` 只有裸文件名，真身在它自己的缓存目录里，交给 `resolveImage` 找回来。
 */
function imageSourceGroups(message) {
  const groups = [];
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  const add = (file, url) => {
    const list = [];
    for (const value of [file, url]) {
      const text = String(value ?? '').trim();
      if (text && !list.includes(text)) list.push(text);
    }
    if (list.length) groups.push(list);
  };
  for (const segment of segments) {
    if (segment?.type !== 'image') continue;
    add(segment.data?.file, segment.data?.url);
  }
  if (!groups.length && Array.isArray(message?.images)) {
    for (const image of message.images) {
      if (!image) continue;
      if (typeof image === 'string') add(image, null);
      else add(image.file, image.url);
    }
  }
  return groups;
}

/** 拍平（记印象用，不需要真去找文件）。 */
function imageSourcesOf(message) {
  return imageSourceGroups(message).flat();
}

/** 收到消息里的 QQ 内置表情（face 段）。 */
function faceIdsOf(message) {
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  return segments.filter((segment) => segment?.type === 'face').map((segment) => String(segment.data?.id ?? ''));
}

function fromFileUri(uri) {
  let text = String(uri ?? '').replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:\//.test(text)) text = text.slice(1);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** OneBot 认的本地文件写法：file:// 绝对路径。 */
export function toStickerFileUri(target) {
  const text = String(target ?? '');
  if (/^(?:https?|file|base64|data):/i.test(text)) return text;
  const absolute = path.resolve(text).replace(/\\/g, '/');
  return absolute.startsWith('/') ? `file://${absolute}` : `file:///${absolute}`;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '').trim().slice(0, 16);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 3) break;
  }
  return out;
}

/** 认不出来的那种返回值：三个键都在，值都是空的。 */
function emptyInfo() {
  return { title: '', meaning: '', tags: [] };
}

/**
 * @param {{
 *   config: object,
 *   logger?: object|null,
 *   llm?: object|null,
 *   vision?: object|null,
 *   library?: object|null,
 *   dir?: string|null,
 * }} options
 */
export function createStickerService({
  config,
  logger = null,
  llm = null,
  vision = null,
  library = null,
  dir = null,
  resolveImage = null,
} = {}) {
  const settings = config?.sticker ?? {};
  const log = logger?.child ? logger.child('sticker') : logger;
  const rootDir = config?.rootDir ?? process.cwd();
  const paths = resolveStickerPaths({ config, dir });
  const stickerDir = paths.dir;
  const indexFile = paths.indexFile;
  const store =
    library ??
    createStickerLibrary({
      dir: stickerDir,
      indexFile,
      logger: log,
      maxItems: settings.maxItems,
      maxFileBytes: settings.maxFileBytes,
      rootDir,
      dataDir: config?.dataDir ?? null,
      downloadTimeoutMs: settings.downloadTimeoutMs,
    });

  /** 本次进程发出的时间（冷却判定）；索引里的 usedCount / lastUsedAt 是长期统计。 */
  const sentAt = new Map();
  /** 非管理员的表情包印象：userId → { userId, count, faces, recent, lastAt }。 */
  const notes = new Map();
  let describeCount = 0;
  /** 「本地文件读不到」的提醒只打一次（协议端每发一张图都会命中），但次数一直记着。 */
  let unreadableHinted = false;
  let unreadableSkipped = 0;

  const enabled = settings.enabled !== false;

  async function ensureLoaded() {
    if (!store.loaded) await store.load();
  }

  function isAdminSender(message) {
    if (message?.isAdmin === true || message?.admin === true) return true;
    if (message?.role === 'owner') return true;
    const uid = message?.userId ?? message?.sender?.userId ?? null;
    if (uid === null || uid === undefined) return false;
    const admins = config?.security?.admins ?? [];
    return admins.map(String).includes(String(uid));
  }

  /** 把入参整理成存储层认的来源。 */
  function resolveSource(source) {
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
      const buffer = Buffer.from(source);
      return buffer.length ? { sourceBuffer: buffer } : null;
    }
    const text = String(source ?? '').trim();
    if (!text) return null;
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
      const base64 = text.slice(text.indexOf(';base64,') + ';base64,'.length);
      try {
        const buffer = Buffer.from(base64, 'base64');
        return buffer.length ? { sourceBuffer: buffer } : null;
      } catch {
        return null;
      }
    }
    if (text.startsWith('base64://')) {
      try {
        const buffer = Buffer.from(text.slice('base64://'.length), 'base64');
        return buffer.length ? { sourceBuffer: buffer } : null;
      } catch {
        return null;
      }
    }
    if (/^https?:\/\//i.test(text)) return { sourceUrl: text };
    if (/^file:\/\//i.test(text)) return { sourceFile: fromFileUri(text) };
    return { sourceFile: text };
  }

  /** 先让视觉模型看图，拿到一段描述；没有可用的视觉能力就返回 null。 */
  async function describeImage(target) {
    if (!vision?.describeImages) {
      log?.warn?.(t('sticker.log.visionUnavailable'));
      return null;
    }
    if (vision.visionEnabled === false) {
      log?.warn?.(t('sticker.log.visionUnavailable'));
      return null;
    }
    try {
      const text = await vision.describeImages({ images: [target], prompt: t('sticker.prompt.vision') });
      const trimmed = String(text ?? '').trim();
      // 视觉服务用「没有能看图的模型」这句话表示它没看图，别把它当描述
      if (!trimmed || trimmed === noVisionText()) {
        log?.warn?.(t('sticker.log.visionUnavailable'));
        return null;
      }
      return trimmed;
    } catch (error) {
      log?.warn?.(t('sticker.log.describeFailed', { reason: error?.message ?? error }));
      return null;
    }
  }

  /** 画面描述 → 短标题 + 内容描述 + 时机标签；模型不给就用描述兜底。 */
  async function summarize(description) {
    const fallbackText = truncate(description, Number(settings.meaningMaxChars) || DEFAULT_MEANING_MAX_CHARS);
    const fallback = { title: '', meaning: fallbackText, tags: [] };
    if (!llm?.chat) return fallback;
    try {
      const result = await llm.chat({
        role: 'memory',
        json: true,
        messages: [
          { role: 'system', content: t('sticker.prompt.meaningSystem') },
          { role: 'user', content: t('sticker.prompt.meaningUser', { description }) },
        ],
      });
      const data = result?.json ?? parseJson(result?.content);
      const title = normalizeTitle(data?.title);
      const meaning = typeof data?.meaning === 'string' ? data.meaning.trim() : '';
      const tags = normalizeTags(data?.tags);
      if (!title && !meaning && !tags.length) return fallback;
      // 模型没给描述时，把画面描述截一段顶上，至少挑表情包时能看见「画的是什么」
      return { title, meaning: (meaning || fallbackText).slice(0, 80), tags };
    } catch (error) {
      log?.debug?.(t('sticker.log.describeFailed', { reason: error?.message ?? error }));
      return fallback;
    }
  }

  /**
   * 认一张图是什么表情：短标题 + 内容描述 + 时机标签。
   * 视觉不可用时返回 `{ title: '', meaning: '', tags: [] }`，不抛错。
   */
  async function describe(fileOrUrl) {
    const target = String(fileOrUrl ?? '').trim();
    if (!target) return emptyInfo();
    const description = await describeImage(target);
    if (!description) return emptyInfo();
    describeCount += 1;
    return summarize(description);
  }

  /** 学一张：入库 + （可选）认标题与描述。库满 / 来源取不到就返回 null。 */
  async function learn(source, { addedBy = null, origin = null, title = null, meaning = null, tags = null } = {}) {
    if (!enabled) {
      log?.debug?.(t('sticker.log.disabled'));
      return null;
    }
    await ensureLoaded();
    const resolved = resolveSource(source);
    if (!resolved) {
      log?.debug?.(t('sticker.log.sourceBad', { source: String(source).slice(0, 200) }));
      return null;
    }

    let finalTitle = title;
    let finalMeaning = meaning;
    let finalTags = tags;
    const autoMeaning = settings.autoMeaning !== false;
    // 库层注定读不进来的来源（越界路径、协议端给的裸缓存文件名）在这儿就拦下：
    // 一是别白喂一次视觉模型（原来会报一句 ENOENT，看着像模型不支持图片），
    // 二是这种来源每张图都会命中，日志得克制着打，别刷屏。
    if (typeof store.readable === 'function' && !(await store.readable(resolved))) {
      unreadableSkipped += 1;
      if (!unreadableHinted) {
        unreadableHinted = true;
        log?.warn?.(t('sticker.log.sourceUnreadable'));
      }
      return null;
    }
    // 内容相同的图没必要再认一遍
    const knownHash = resolved.sourceBuffer ? createHash('sha256').update(resolved.sourceBuffer).digest('hex') : null;
    const duplicate = knownHash ? store.findByHash(knownHash) : null;
    // 调用方标题与描述都没给（管理员直接丢一张图过来）时才自动认，认出来的三个值一起填上
    if (autoMeaning && finalTitle == null && finalMeaning == null && !duplicate) {
      // 已经是字节的话，用 base64:// 交给视觉模型，不再指着一个不是路径的字符串
      const target = resolved.sourceBuffer ? `base64://${resolved.sourceBuffer.toString('base64')}` : String(source);
      const info = await describe(target);
      finalTitle = info.title;
      finalMeaning = info.meaning;
      finalTags = info.tags;
    }

    const item = await store.add({
      ...resolved,
      title: finalTitle ?? '',
      meaning: finalMeaning ?? '',
      tags: finalTags ?? [],
      addedBy,
      origin: origin ?? 'manual',
    });
    if (!item) return null;
    if (!item.title && !item.meaning) log?.warn?.(t('sticker.log.noMeaning', { id: item.id }));
    return item;
  }

  /**
   * 看一条收到的消息：管理员发的表情包存下来（同 hash 只更新计数），别人发的只记印象。
   * @returns {Promise<{ saved: number, items: object[], duplicates: number, skipped?: string } | null>} null = 没什么可看的
   */
  async function observe(message, { byAdmin } = {}) {
    if (!enabled) {
      log?.debug?.(t('sticker.log.disabled'));
      return null;
    }
    const groups = imageSourceGroups(message);
    if (!groups.length) return null;
    await ensureLoaded();

    const admin = byAdmin === undefined ? isAdminSender(message) : byAdmin === true;
    const allowed = admin ? settings.learnFromAdmins !== false : settings.learnFromOthers === true;
    if (!allowed) {
      log?.debug?.(t('sticker.log.skipNotAdmin', { userId: message?.userId ?? '?' }));
      return { saved: 0, items: [], duplicates: 0, skipped: admin ? 'learnFromAdmins' : 'learnFromOthers' };
    }

    const before = store.stats().total;
    const items = [];
    // 一张图一组：组内先试本地 file、再试 url，成功了就不再试这一组的其它来源（少烧一次视觉调用）。
    // 协议端给的裸文件名（NapCat 的 file 就是）先交给 resolveImage 换成真路径，否则只会白报一次「读不进来」。
    for (const group of groups) {
      for (const source of group) {
        const target = await resolveOne(source);
        if (!target) continue;
        const item = await learn(target, { addedBy: message?.userId ?? null, origin: admin ? 'admin' : 'others' });
        if (item) {
          items.push(item);
          break;
        }
      }
    }
    const saved = Math.max(0, store.stats().total - before);
    return { saved, items, duplicates: Math.max(0, items.length - saved) };
  }

  /**
   * 交给协议端缓存解析器换成真路径。解析不出来就按原样返回：库自己还会在允许目录里找一遍
   * （目录里确实有同名文件的情况），找不到才由库那边记一句提醒。
   */
  async function resolveOne(source) {
    const text = String(source ?? '').trim();
    if (!text || typeof resolveImage !== 'function') return text || null;
    try {
      const resolved = await resolveImage(text);
      return resolved ? String(resolved) : text;
    } catch (error) {
      log?.debug?.(t('sticker.log.sourceBad', { source: text.slice(0, 200) }));
      return text;
    }
  }

  /** 别人（非管理员）发的表情包：不入库，只记「这个人常用什么表情」这种轻量印象。 */
  function note(message) {
    if (!enabled) return null;
    const images = imageSourcesOf(message);
    const faces = faceIdsOf(message);
    if (!images.length && !faces.length) return null;
    const userId = message?.userId ?? message?.sender?.userId ?? null;
    const key = String(userId ?? 'unknown');
    const entry = notes.get(key) ?? { userId, count: 0, faces: [], recent: [], lastAt: null };
    entry.count += images.length + faces.length;
    const fingerprints = images.map((source) => {
      const text = String(source);
      if (text.startsWith('base64://') || text.startsWith('data:')) return 'base64';
      if (/^https?:\/\//i.test(text)) {
        try {
          return path.basename(new URL(text).pathname) || 'url';
        } catch {
          return 'url';
        }
      }
      return path.basename(text.replace(/\\/g, '/'));
    });
    entry.recent = [...fingerprints, ...entry.recent].slice(0, NOTE_RECENT_LIMIT);
    if (faces.length) entry.faces = [...new Set([...faces.map(String), ...entry.faces])].slice(0, 10);
    entry.lastAt = Date.now();
    notes.set(key, entry);
    if (notes.size > NOTE_CAPACITY) {
      const oldest = [...notes.entries()].sort((a, b) => (a[1].lastAt ?? 0) - (b[1].lastAt ?? 0))[0];
      if (oldest) notes.delete(oldest[0]);
    }
    return { ...entry, recent: [...entry.recent], faces: [...entry.faces] };
  }

  /** 单张的语境得分：标题或标签命中、没用过、用得少的分高。 */
  function scoreItem(item, { text, mood, now }) {
    let score = 1;
    // 关键词池 = 时机标签 + 短标题（标题空着就不算）；内容描述太长，不拿来做子串匹配
    const keywords = item.title ? [...item.tags, item.title] : item.tags;
    const moodText = String(mood ?? '');
    if (moodText && keywords.includes(moodText)) score += 4;
    if (text) {
      const body = String(text);
      for (const keyword of keywords) {
        if (keyword && body.includes(keyword)) score += 3;
      }
    }
    score += 2 / (1 + (Number(item.usedCount) || 0));
    if (!item.lastUsedAt) score += 1.5;
    else score += 1 / (1 + Math.max(0, now - item.lastUsedAt) / 86400000);
    return score;
  }

  function weightedPick(rows, rand) {
    const total = rows.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    if (total <= 0) return rows[0]?.item ?? null;
    let roll = rand() * total;
    for (const row of rows) {
      roll -= Math.max(0, row.weight);
      if (roll <= 0) return row.item;
    }
    return rows[rows.length - 1]?.item ?? null;
  }

  /**
   * 按语境挑一张表情包；挑不动（功能关着、库空、骰子没过、全在冷却）返回 null。
   * 调用方拿到 item 就直接 `send()`，不要再自己掷一次概率。
   */
  async function pick({ text = null, mood = null, affection = null, recentStickers = null, rng = null } = {}) {
    if (!enabled) return null;
    await ensureLoaded();
    const all = store.list({});
    if (!all.length) return null;

    const rand = typeof rng === 'function' ? rng : Math.random;
    const bias = moodBias(mood)?.sticker ?? 1;
    // 好感度高一点就稍微爱发表情包（affection 缺席时不参与）
    const hasAffection = affection !== null && affection !== undefined && affection !== '' && Number.isFinite(Number(affection));
    const affectionFactor = hasAffection ? 1 + clamp((Number(affection) - 50) / 100, -0.3, 0.5) : 1;
    const chance = clamp(Number(settings.sendChance ?? DEFAULT_SEND_CHANCE) * bias * affectionFactor, 0, 1);
    if (rand() >= chance) return null;

    const now = Date.now();
    const cooldownMs = Number(settings.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    const blocked = new Set((Array.isArray(recentStickers) ? recentStickers : []).map(String));
    const candidates = all.filter((item) => {
      if (blocked.has(item.id) || blocked.has(item.file) || blocked.has(item.path)) return false;
      const last = sentAt.get(item.id) ?? null;
      if (cooldownMs > 0 && last !== null && now - last < cooldownMs) return false;
      return true;
    });
    if (!candidates.length) {
      log?.debug?.(t('sticker.log.emptyPool'));
      return null;
    }
    const rows = candidates.map((item) => ({ item, weight: scoreItem(item, { text, mood, now }) }));
    return weightedPick(rows, rand);
  }

  /**
   * 发那一条表情包。standalone（默认 true）时绝不跟文字挤在同一条消息里：
   * 给了 text 就先发文字，再单独发图；standalone=false 才合成一条。
   * @returns {Promise<{ ok: boolean, seg?: object, messageId?: string|null, mode?: string, error?: string }>}
   */
  async function send(onebot, target, item, { text = null } = {}) {
    if (!item) return { ok: false, error: 'no_item' };
    const localFile = item.path ?? path.join(stickerDir, String(item.file ?? ''));
    const seg = { type: 'image', data: { file: toStickerFileUri(localFile) } };
    if (!onebot || typeof onebot.sendTo !== 'function') {
      log?.warn?.(t('sticker.log.sendFailed', { reason: 'no_onebot' }));
      return { ok: false, seg, error: 'no_onebot' };
    }

    const standalone = settings.standalone !== false;
    const textValue = typeof text === 'string' ? text.trim() : '';
    const textSeg = { type: 'text', data: { text: textValue } };
    try {
      let data = null;
      let mode = 'image';
      if (textValue && !standalone) {
        data = await onebot.sendTo(target, [textSeg, seg]);
        mode = 'combined';
      } else if (textValue) {
        await onebot.sendTo(target, [textSeg]);
        data = await onebot.sendTo(target, [seg]);
        mode = 'standalone';
      } else {
        data = await onebot.sendTo(target, [seg]);
      }
      sentAt.set(item.id, Date.now());
      await store.markUsed(item.id);
      log?.debug?.(t('sticker.log.sent', { id: item.id }));
      return { ok: true, seg, messageId: data?.message_id ?? null, mode, standalone: Boolean(standalone) };
    } catch (error) {
      log?.warn?.(t('sticker.log.sendFailed', { reason: error?.message ?? error }));
      return { ok: false, seg, error: String(error?.message ?? error) };
    }
  }

  function list(options = {}) {
    return store.list(options);
  }

  function get(id) {
    return store.get(id);
  }

  async function remove(id) {
    const ok = await store.remove(id);
    if (ok) sentAt.delete(String(id));
    return ok;
  }

  function notesSnapshot(userId = null) {
    if (userId === null || userId === undefined) return [...notes.values()].map((entry) => ({ ...entry }));
    const entry = notes.get(String(userId));
    return entry ? { ...entry } : null;
  }

  function stats() {
    return {
      ...store.stats(),
      notes: notes.size,
      describes: describeCount,
      unreadable: unreadableSkipped,
      enabled,
    };
  }

  return {
    observe,
    note,
    pick,
    send,
    describe,
    learn,
    list,
    get,
    remove,
    stats,
    notes: notesSnapshot,
    load: ensureLoaded,
    get enabled() {
      return enabled;
    },
    get dir() {
      return stickerDir;
    },
    get indexFile() {
      return indexFile;
    },
    get library() {
      return store;
    },
  };
}

export default { createStickerService };
