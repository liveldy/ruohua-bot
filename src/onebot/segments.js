/**
 * OneBot 11 消息段：解析、构造、提取。
 * 兼容 message 为「消息段数组」与「CQ 码字符串」两种上报格式。
 */

import { truncate } from '../util/text.js';
import { t } from '../i18n/index.js';

const CQ_PATTERN = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;

/** 引用内容进提示词时的长度上限，别让一条长引用把上下文顶掉。 */
const QUOTED_TEXT_LIMIT = 200;

function parseCqParams(text) {
  const out = {};
  if (!text) return out;
  for (const pair of text.replace(/^,/, '').split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx);
    out[key] = pair
      .slice(idx + 1)
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&');
  }
  return out;
}

function parseCqMessage(raw) {
  const segments = [];
  let lastIndex = 0;
  const text = String(raw ?? '');
  CQ_PATTERN.lastIndex = 0;
  let match = CQ_PATTERN.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) segments.push({ type: 'text', data: { text: plain } });
    }
    segments.push({ type: match[1], data: parseCqParams(match[2]) });
    lastIndex = match.index + match[0].length;
    match = CQ_PATTERN.exec(text);
  }
  if (lastIndex < text.length) {
    const plain = text.slice(lastIndex);
    if (plain) segments.push({ type: 'text', data: { text: plain } });
  }
  return segments;
}

function normalizeSegmentList(message) {
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment && typeof segment === 'object' && segment.type)
      .map((segment) => ({ type: String(segment.type), data: { ...(segment.data ?? {}) } }));
  }
  if (typeof message === 'string') return parseCqMessage(message);
  if (message && typeof message === 'object' && message.type) return [{ type: String(message.type), data: { ...(message.data ?? {}) } }];
  return [];
}

export function textSegment(text) {
  return { type: 'text', data: { text: String(text ?? '') } };
}

export function atSegment(qq) {
  return { type: 'at', data: { qq: String(qq) } };
}

export function faceSegment(id) {
  return { type: 'face', data: { id: String(id) } };
}

export function imageSegment(file) {
  return { type: 'image', data: { file: String(file) } };
}

export function replySegment(id) {
  return { type: 'reply', data: { id: String(id) } };
}

export function fileSegment(file, name = null) {
  return { type: 'file', data: name ? { file: String(file), name: String(name) } : { file: String(file) } };
}

export function extractText(segments = []) {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.data?.text ?? '')
    .join('');
}

export function extractImages(segments = []) {
  return segments
    .filter((segment) => segment.type === 'image')
    .map((segment) => ({ file: segment.data?.file ?? '', url: segment.data?.url ?? null }));
}

export function extractFaces(segments = []) {
  return segments.filter((segment) => segment.type === 'face').map((segment) => String(segment.data?.id ?? ''));
}

export function extractFiles(segments = []) {
  return segments
    .filter((segment) => segment.type === 'file')
    .map((segment) => ({
      file: segment.data?.file ?? '',
      url: segment.data?.url ?? null,
      name: segment.data?.name ?? segment.data?.file ?? '',
      size: segment.data?.size ?? null,
    }));
}

export function extractRecords(segments = []) {
  return segments
    .filter((segment) => segment.type === 'record')
    .map((segment) => ({ file: segment.data?.file ?? '', url: segment.data?.url ?? null, text: segment.data?.text ?? null }));
}

export function hasAt(segments = [], selfId) {
  const self = String(selfId ?? '');
  return segments.some((segment) => segment.type === 'at' && (segment.data?.qq === self || segment.data?.qq === 'all'));
}

/** 给模型看的人类可读文本：图片、语音、文件都变成占位词。 */
export function segmentsToPlain(segments = []) {
  const parts = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        parts.push(segment.data?.text ?? '');
        break;
      case 'image':
        parts.push(
          segment.data?.summary
            ? t('onebot.segments.imageSummary', { summary: segment.data.summary })
            : t('onebot.segments.image'),
        );
        break;
      case 'face':
        parts.push(t('onebot.segments.face', { id: segment.data?.id ?? '' }));
        break;
      case 'at':
        parts.push(segment.data?.qq === 'all' ? t('onebot.segments.atAll') : `@${segment.data?.name ?? segment.data?.qq ?? ''}`);
        break;
      case 'reply':
        parts.push(t('onebot.segments.reply'));
        break;
      case 'file':
        parts.push(t('onebot.segments.file', { name: segment.data?.name ?? segment.data?.file ?? '' }));
        break;
      case 'record':
        parts.push(t('onebot.segments.record'));
        break;
      case 'video':
        parts.push(t('onebot.segments.video'));
        break;
      case 'json':
      case 'xml':
        parts.push(t('onebot.segments.card'));
        break;
      case 'poke':
        parts.push(t('onebot.segments.poke'));
        break;
      default:
        parts.push('');
    }
  }
  return parts.join('').trim();
}

export function toMessageContent(input, { replyTo = null } = {}) {
  const segments = [];
  if (replyTo) segments.push(replySegment(replyTo));
  if (Array.isArray(input)) segments.push(...input);
  else if (input != null) segments.push(textSegment(String(input)));
  return segments;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 秒 / 毫秒都认，统一成毫秒（协议端给引用时间时用秒，有些版本给毫秒）。 */
export function toTimestampMs(value) {
  const num = toNumberOrNull(value);
  if (num === null || num <= 0) return null;
  return Math.trunc(num > 1e12 ? num : num * 1000);
}

/** 取出消息里的 reply 段数据（没有则 null）。 */
export function extractReply(segments = []) {
  const segment = segments.find((item) => item?.type === 'reply');
  return segment ? { ...(segment.data ?? {}) } : null;
}

/**
 * 只按 reply 段自带的字段解析引用（同步，不查缓存）。
 * NapCat 会带 id，较新版本还带 user_id / nickname / time，有的版本带 text；
 * 只有 message_id 时 resolved 为 false，剩下的交给上层去缓存 / get_msg 里补。
 * @returns {{ messageId: string|null, userId: number|null, nickname: string|null, text: string|null, time: number|null, resolved: boolean } | null}
 */
export function quotedFromSegments(segments = []) {
  const data = extractReply(segments);
  if (!data) return null;
  const rawId = data.id ?? data.message_id;
  const messageId = rawId === null || rawId === undefined || rawId === '' ? null : String(rawId);
  const userId = toNumberOrNull(data.user_id);
  const nicknameRaw = data.nickname ?? data.card;
  const nickname = nicknameRaw === null || nicknameRaw === undefined || String(nicknameRaw).trim() === '' ? null : String(nicknameRaw).trim();
  const textRaw = data.text ?? data.content ?? data.raw_message;
  const text = textRaw === null || textRaw === undefined || String(textRaw).trim() === '' ? null : String(textRaw).trim();
  const time = toTimestampMs(data.time);
  return { messageId, userId, nickname, text, time, resolved: Boolean(text) || userId !== null || Boolean(nickname) };
}

/** 这条消息引用的是不是 selfId 自己发的消息（拿不到对方 id 时不算）。 */
export function quotesSelf(quoted, selfId) {
  if (!quoted) return false;
  const self = String(selfId ?? '').trim();
  if (!self || self === '0') return false;
  return quoted.userId !== null && quoted.userId !== undefined && String(quoted.userId) === self;
}

/**
 * 把引用信息写成给模型看的一行提示，例如：（在回复 张三 的消息：「晚上开会」）。
 * 只用于提示词，不要塞进 message.display。
 */
export function describeQuoted(quoted) {
  if (!quoted) return null;
  const nickname = quoted.nickname ? String(quoted.nickname) : '';
  const userId = quoted.userId === null || quoted.userId === undefined ? '' : String(quoted.userId);
  const who = nickname || userId;
  const text = quoted.text ? truncate(String(quoted.text), QUOTED_TEXT_LIMIT) : '';
  if (text) return who ? t('onebot.segments.quotedWithText', { who, text }) : t('onebot.segments.quotedAnonymousWithText', { text });
  if (who) return t('onebot.segments.quotedWithWho', { who });
  return t('onebot.segments.quotedUnknown');
}

export function normalizeMessage(raw = {}) {
  const segments = normalizeSegmentList(raw.message ?? raw.raw_message ?? []);
  const scene = raw.message_type === 'group' ? 'group' : 'private';
  const selfId = Number(raw.self_id ?? 0);
  const sender = raw.sender ?? {};
  const userId = Number(scene === 'group' ? sender.user_id ?? raw.user_id : raw.user_id ?? sender.user_id);
  const groupId = scene === 'group' ? Number(raw.group_id) : null;
  const text = extractText(segments);
  return {
    messageId: raw.message_id ?? null,
    time: Number(raw.time ?? Math.floor(Date.now() / 1000)) * 1000,
    selfId,
    scene,
    subType: raw.sub_type ?? null,
    userId: Number.isFinite(userId) ? userId : null,
    groupId: Number.isFinite(groupId) ? groupId : null,
    sender: {
      userId: Number.isFinite(userId) ? userId : null,
      nickname: sender.nickname ?? sender.card ?? String(userId ?? ''),
      card: sender.card ?? null,
      role: sender.role ?? null,
    },
    role: null,
    segments,
    text,
    quoted: quotedFromSegments(segments),
    display: segmentsToPlain(segments),
    images: extractImages(segments),
    faces: extractFaces(segments),
    files: extractFiles(segments),
    records: extractRecords(segments),
    isAt: hasAt(segments, selfId),
    raw,
  };
}

/** 从消息里剥掉 @机器人 的部分，得到纯粹要对它说的话。 */
export function stripAt(segments = [], selfId) {
  return segments.filter((segment) => !(segment.type === 'at' && (segment.data?.qq === String(selfId) || segment.data?.qq === 'all')));
}

export function conversationKey(message) {
  if (!message) return 'unknown';
  return message.scene === 'group' ? `group_${message.groupId}` : `private_${message.userId}`;
}

/** 与 conversationKey 同一个东西，方便按 { scene, userId, groupId } 直接取键。 */
export function conversationKeyOf(target = {}) {
  if (target.key) return target.key;
  return target.scene === 'group' ? `group_${target.groupId}` : `private_${target.userId}`;
}
