/**
 * 上下文组装：人设 + 情感 + 记忆 + 近期对话 → 一次模型调用需要的 messages。
 * 近期对话在进程内滚动窗口，可落盘（data/context/<key>.jsonl），重启后还能接上话。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appendJsonl, ensureDir, readJsonl } from '../util/io.js';
import { estimateTokens, truncate } from '../util/text.js';
import { describeQuoted } from '../onebot/segments.js';
import { buildSystemPrompt } from '../persona/prompt.js';
import { noVisionText } from '../perception/vision.js';
import { t } from '../i18n/index.js';

export function conversationKeyOf({ scene, userId, groupId } = {}) {
  return scene === 'group' ? `group_${groupId}` : `private_${userId}`;
}

/**
 * 手头在跑 / 在等的任务，写成一段「系统给的实情」交给提示词。
 * 一件都没有时也要明说，否则模型被问「任务怎么样了」就会自己编。
 * @returns {string|null} null = 没有可用的任务表
 */
export function taskFactsNote({ tasks, userId = null } = {}) {
  if (!tasks || typeof tasks.list !== 'function') return null;
  let rows = [];
  try {
    rows = (tasks.list({ userId, activeOnly: true }) ?? []).filter((task) => task?.status === 'running' || task?.status === 'waiting');
  } catch {
    return null;
  }
  if (!rows.length) return t('brain.context.taskFactsEmpty');
  const items = rows
    .slice(0, 5)
    .map((task) =>
      t('brain.context.taskFactLine', {
        goal: truncate(String(task.goal ?? ''), 40),
        state: task.status === 'running' ? t('brain.context.taskState.running') : t('brain.context.taskState.waiting'),
        steps: Number(task.rounds ?? task.steps?.length ?? 0) || 0,
      }),
    )
    .join('\n');
  return t('brain.context.taskFacts', { items });
}

/** 表情包占位替换的缓存：raw → { owner, item }，同一条消息里同一张图不重复读盘算哈希。 */
const STICKER_CACHE_LIMIT = 200;
const stickerCache = new Map();

/** 识图结果的缓存：raw → { owner, text }，同一张图连着发两次不重复烧一次视觉调用。 */
const IMAGE_CACHE_LIMIT = 100;
const imageCache = new Map();
/** 一条消息里最多认几张图：多图长文（九宫格）不值得逐张烧钱。 */
const MAX_DESCRIBED_IMAGES = 2;
/** 库里的文件名 → item，按表情包服务实例懒建一次。 */
const stickerNameIndexes = new WeakMap();

/** 一个文件名会拿来比对的几种写法。 */
function stickerNameKeys(name) {
  const text = String(name ?? '').trim().toLowerCase();
  if (!text) return [];
  const base = path.basename(text);
  const bare = path.basename(base, path.extname(base));
  return [...new Set([text, base, bare].filter(Boolean))];
}

/** 图片来源的本地绝对路径；http / base64 / 空值拿不到（返回 null）。 */
function stickerLocalPath(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text) || text.startsWith('base64://') || /^data:/i.test(text)) return null;
  if (/^file:\/\//i.test(text)) text = text.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:\//.test(text)) text = text.slice(1);
  try {
    text = decodeURIComponent(text);
  } catch {
    /* 保留原样 */
  }
  return path.resolve(text);
}

function rememberSticker(raw, owner, item) {
  if (stickerCache.size >= STICKER_CACHE_LIMIT) {
    const oldest = stickerCache.keys().next().value;
    if (oldest !== undefined) stickerCache.delete(oldest);
  }
  stickerCache.set(raw, { owner, item });
  return item;
}

/** 文件名对得上也算库里的：NapCat 缓存名与库内 sticker_xxx 常常不同名，所以这只是哈希之外的兜底。 */
function findByStickerName(sticker, raw) {
  if (typeof sticker.list !== 'function') return null;
  let index = stickerNameIndexes.get(sticker);
  if (!index) {
    index = new Map();
    try {
      for (const row of sticker.list({}) ?? []) {
        for (const key of stickerNameKeys(row?.file)) if (!index.has(key)) index.set(key, row);
      }
    } catch {
      return null;
    }
    stickerNameIndexes.set(sticker, index);
  }
  for (const key of stickerNameKeys(raw)) {
    const found = index.get(key);
    if (found) return found;
  }
  return null;
}

/** 这张图是库里的哪一张表情包：先按内容哈希认（比 maxFileBytes 还大的直接放弃），再退回文件名。 */
async function lookupSticker({ sticker, segment, config, logger }) {
  const raw = String(segment?.data?.file ?? '').trim() || String(segment?.data?.url ?? '').trim();
  if (!raw || !sticker) return null;
  const hit = stickerCache.get(raw);
  if (hit && hit.owner === sticker) return hit.item;

  let item = null;
  try {
    const local = stickerLocalPath(raw);
    if (local) {
      const maxBytes = Math.max(0, Number(config?.sticker?.maxFileBytes) || 0);
      const stat = await fs.stat(local).catch(() => null);
      if (stat?.isFile() && (!maxBytes || stat.size <= maxBytes)) {
        const buffer = await fs.readFile(local).catch(() => null);
        if (buffer?.length) item = sticker.library?.findByHash?.(createHash('sha256').update(buffer).digest('hex')) ?? null;
      }
    }
    if (!item) item = findByStickerName(sticker, raw);
  } catch (error) {
    logger?.debug?.(t('brain.context.stickerLookupFailed'), error);
    item = null;
  }
  return rememberSticker(raw, sticker, item);
}

/** image 段在正文里的两种占位（「[图片]」与「[图片：摘要]」）都由 onebot.segments 那两条键产出。 */
let imageMarkRegexCache = null;
function imageMarkRegex() {
  if (!imageMarkRegexCache) {
    const mark = t('onebot.segments.image');
    const head = mark.slice(0, Math.max(0, mark.length - 1));
    imageMarkRegexCache = new RegExp(`${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\]]*\\]`, 'g');
  }
  return imageMarkRegexCache;
}

/**
 * 别人发的表情包在正文里怎么写：优先用短标题（「[表情包：哭笑不得]」），
 * 没标题才退回内容描述 —— 标题短，塞进消息正文里不挤。
 */
function stickerLabelOf(item) {
  const text = String(item?.title ?? '').trim() || String(item?.meaning ?? '').trim();
  const label = truncate(text, 24);
  return label ? t('brain.context.stickerLabel', { meaning: label }) : t('brain.context.stickerPlain');
}

/**
 * 识图服务返回的固定「看不了」说法不是对这张图的描述，别写进正文当图里的内容。
 * @returns {string|null} 装进正文的「[图片：…]」，null = 没认出来
 */
function imageLabelOf(described) {
  const line = truncate(String(described ?? '').replace(/\s+/g, ' ').trim(), 200);
  if (!line) return null;
  const failures = [noVisionText(), t('perception.vision.describeUnknown'), t('perception.vision.emptyAnswer')];
  if (failures.some((text) => line === text || line.startsWith(text.slice(0, 12)))) return null;
  return t('brain.context.imageLabel', { text: line });
}

/**
 * 这张图里是什么：拿视觉服务真的看一眼，返回装进正文的那截文字。
 * 认不出来（没模型、图读不到、调用失败）返回 null，调用方保留原来的「[图片]」。
 */
async function describeImage({ vision, segment, logger, resolveImage = null }) {
  // 协议端已经给了摘要的（imageSummary）直接用，别再多烧一次视觉调用
  if (String(segment?.data?.summary ?? '').trim()) return null;
  let file = String(segment?.data?.file ?? '').trim();
  const url = String(segment?.data?.url ?? '').trim();
  // 协议端（NapCat）给的 file 是裸文件名，真身在它自己的缓存目录里：先换回真路径再去看
  if (file && typeof resolveImage === 'function') {
    try {
      const resolved = await resolveImage(file);
      if (resolved) file = String(resolved);
    } catch (error) {
      logger?.debug?.(t('brain.context.imageDescribeFailed'), error);
    }
  }
  const raw = file || url;
  if (!raw || !vision?.describeImages || vision.visionEnabled === false) return null;
  const cached = imageCache.get(raw);
  if (cached && cached.owner === vision) return cached.text;

  let text = null;
  try {
    const described = await vision.describeImages({
      images: [file ? { file } : { url }],
      prompt: t('brain.context.imageDescribePrompt'),
    });
    text = imageLabelOf(described);
  } catch (error) {
    logger?.debug?.(t('brain.context.imageDescribeFailed'), error);
    text = null;
  }
  if (imageCache.size >= IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(raw, { owner: vision, text });
  return text;
}

/**
 * 消息正文：别人发的表情包认得出来就写「[表情包：含义]」，不再只是干巴巴的「[图片]」。
 * 认不出表情包、但有视觉服务时，还没有「图片」意思的图也都真看一眼：写「[图片：描述]」。
 * 两者都没有（没接服务、图读不到、模型看不了图）→ 保留原来的占位。
 */
export async function renderUserText(
  message,
  { sticker = null, vision = null, config = {}, logger = null, resolveImage = null } = {},
) {
  const display = String(message?.display ?? message?.text ?? '');
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  const imageSegments = segments.filter((segment) => segment?.type === 'image');
  if (!display || !imageSegments.length) return display;

  const labels = [];
  let described = 0;
  for (const segment of imageSegments) {
    const item = sticker ? await lookupSticker({ sticker, segment, config, logger }) : null;
    if (item) {
      labels.push(stickerLabelOf(item));
      continue;
    }
    // 不是库里的表情包 = 对方真的发了张图，她得看得见；一眼看得到的图有个数上限
    if (!vision || described >= MAX_DESCRIBED_IMAGES) {
      labels.push(null);
      continue;
    }
    described += 1;
    labels.push(await describeImage({ vision, segment, logger, resolveImage }));
  }
  if (!labels.some(Boolean)) return display;

  let index = 0;
  return display.replace(imageMarkRegex(), (mark) => {
    const label = labels[index];
    index += 1;
    return label ?? mark;
  });
}

export function createContextBuilder({
  config,
  persona,
  emotion,
  memory,
  logger,
  dir = null,
  vision = null,
  imageSource = null,
} = {}) {
  const childLog = logger?.child ? logger.child('context') : logger;
  // 协议端给的裸文件名交给它换成真路径（见 src/perception/image-source.js），不然识图只会白报一次「读不到」
  const resolveImage =
    typeof imageSource === 'function' ? imageSource : typeof imageSource?.resolve === 'function' ? (s) => imageSource.resolve(s) : null;
  const sessions = new Map();
  const maxMessages = Math.max(4, config.bot.context?.recentMessages ?? 20);
  const maxChars = Math.max(500, config.bot.context?.maxChars ?? 6000);
  const persist = config.bot.context?.persist !== false;
  const baseDir = dir ?? path.join(config.dataDir, 'context');

  function keyOf(input) {
    if (typeof input === 'string') return input;
    if (input?.key) return input.key;
    return conversationKeyOf(input);
  }

  async function ensureSession(key) {
    if (sessions.has(key)) return sessions.get(key);
    const session = { key, messages: [], updatedAt: Date.now(), loaded: false };
    sessions.set(key, session);
    if (persist) {
      try {
        const rows = await readJsonl(path.join(baseDir, `${key}.jsonl`));
        session.messages = rows.map((row) => ({ role: row.role, content: row.content, name: row.name ?? undefined }));
        session.updatedAt = rows.at(-1)?.ts ?? session.updatedAt;
      } catch (error) {
        childLog?.debug?.(t('brain.context.readHistoryFailed', { key }), error);
      }
      session.loaded = true;
    }
    return session;
  }

  function trim(session) {
    let messages = session.messages;
    if (messages.length > maxMessages) messages = messages.slice(-maxMessages);
    let total = estimateTokens(messages);
    while (total > maxChars && messages.length > 2) {
      messages = messages.slice(1);
      total = estimateTokens(messages);
    }
    session.messages = messages;
  }

  async function addTurn({ scene, userId, groupId, role, content, name = null, key = null, at = Date.now() }) {
    const text = typeof content === 'string' ? content : String(content ?? '');
    if (!text.trim()) return null;
    const sessionKey = key ?? conversationKeyOf({ scene, userId, groupId });
    const session = await ensureSession(sessionKey);
    session.messages.push({ role, content: text, name: name ?? undefined });
    session.updatedAt = at;
    trim(session);
    if (persist) {
      try {
        await ensureDir(baseDir);
        await appendJsonl(path.join(baseDir, `${sessionKey}.jsonl`), { ts: at, role, content: text, name });
      } catch (error) {
        childLog?.debug?.(t('brain.context.persistFailed'), error);
      }
    }
    return session.messages;
  }

  /** 最近若干轮对话（不含 system）。 */
  async function recent(input, limit = null) {
    const session = await ensureSession(keyOf(input));
    const messages = session.messages.map((message) => ({ role: message.role, content: message.content, ...(message.name ? { name: message.name } : {}) }));
    return limit && limit < messages.length ? messages.slice(-limit) : messages;
  }

  async function clear(input) {
    const key = keyOf(input);
    sessions.delete(key);
    if (persist) {
      try {
        const file = path.join(baseDir, `${key}.jsonl`);
        const { writeTextAtomic } = await import('../util/io.js');
        await writeTextAtomic(file, '');
      } catch (error) {
        childLog?.debug?.(t('brain.context.clearFailed'), error);
      }
    }
    return key;
  }

  /**
   * 组装一次对话所需的全部输入。
   * @returns {{ system: string, messages: object[], meta: object }}
   */
  async function build({ message, user, scene, mode = 'chat', extraNote = null, includeHistory = true, sticker = null, vision: callVision = null, tools = false }) {
    const key = conversationKeyOf({ scene, userId: user?.userId, groupId: message?.groupId ?? user?.groupId });
    const session = await ensureSession(key);
    // 别人发的表情包认得出来就带上含义；认不出的图看一眼再写进正文；message.display 本身保持原样（日志与记忆都吃它）
    const userText = await renderUserText(message, {
      sticker,
      vision: callVision ?? vision,
      config,
      logger: childLog,
      resolveImage,
    });

    let emotionState = null;
    let hints = null;
    if (emotion) {
      try {
        emotionState = emotion.get(user?.userId);
        hints = emotion.hints(user?.userId);
      } catch (error) {
        childLog?.warn?.(t('brain.context.emotionReadFailed'), error);
      }
    }

    let recalled = [];
    let facts = [];
    if (memory && config.memory?.enabled !== false) {
      try {
        recalled = (await memory.recall({ userId: user?.userId, scene, query: userText, topK: config.memory.recall?.topK ?? 12 })) ?? [];
        facts = (await memory.personaFacts?.(user?.userId)) ?? [];
      } catch (error) {
        childLog?.warn?.(t('brain.context.recallFailed'), error);
      }
    }

    const system = buildSystemPrompt({
      persona,
      emotion: emotionState ? { ...emotionState, hints } : null,
      memory: facts,
      user,
      scene,
      mode,
      tools,
      extra: [
        extraNote,
        recalled.length
          ? t('brain.context.memoryNote', { items: recalled.map((item) => `- ${truncate(item.content, 80)}`).join('\n') })
          : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });

    const history = includeHistory ? session.messages.map((item) => ({ role: item.role, content: item.content, ...(item.name ? { name: item.name } : {}) })) : [];
    // 引用只在提示词里出现一行，message.display 保持干净（日志与记忆都吃它）
    const quotedNote = describeQuoted(message?.quoted);
    const messages = [{ role: 'system', content: system }, ...history];
    const userContent = [quotedNote, userText].filter(Boolean).join('\n');
    if (userContent) messages.push({ role: 'user', content: userContent });

    return {
      system,
      messages,
      meta: {
        key,
        // 渲染过的正文（表情包含义 / 图片描述都写进去了）：写回对话历史时复用它，别再识一次图
        userText,
        affection: emotionState?.affection ?? null,
        mood: emotionState?.mood ?? null,
        hints,
        quoted: message?.quoted ?? null,
        memoryIds: recalled.map((item) => item.id),
        recalled,
        tokens: estimateTokens(messages),
      },
    };
  }

  return {
    build,
    addTurn,
    recent,
    clear,
    keyOf,
    async history(limit = null) {
      const out = {};
      for (const key of sessions.keys()) out[key] = await recent(key, limit);
      return out;
    },
    stats() {
      let total = 0;
      for (const session of sessions.values()) total += estimateTokens(session.messages);
      return { sessions: sessions.size, tokens: total, maxMessages, maxChars };
    },
  };
}
