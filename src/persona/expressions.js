/** 表情：emoji / 颜文字抽成 QQ 表情 id，以及表情与表情包的选择。 */

import fs from 'node:fs';
import path from 'node:path';
import { t } from '../i18n/index.js';
import { clamp, pickWeighted } from '../util/common.js';

const STICKER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.apng']);

const EMOJI_CHAR =
  '[\\u{1F000}-\\u{1FAFF}\\u{1F1E6}-\\u{1F1FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}' +
  '\\u{2190}-\\u{21FF}\\u{2900}-\\u{297F}\\u{3030}\\u{303D}\\u{2049}\\u{203C}' +
  '\\u{00A9}\\u{00AE}\\u{2122}\\u{FE0F}\\u{200D}\\u{20E3}\\u{1F3FB}-\\u{1F3FF}]';
const EMOJI_RE = new RegExp(`${EMOJI_CHAR}(?:${EMOJI_CHAR})*`, 'gu');
const BRACKET_RE = /[\uFF08(][^\uFF08\uFF09()\n]{1,16}[\uFF09)]/g;
const KAOMOJI_MARK_RE = /[\uFFE3\u25BD\u03C9\uFF9F\uFF40\u2032\u2200\u309C\u1D17\u2312\u03B5\u0437\u2565\u256F\u2570\u0CA5\u0CA0\u30FB\uFE4F\uFE43\u30CE\u30FD\u30DF]/;
const SYMBOL_FACE_RE = /^[A-Za-z0-9_\-.;:^><~*+\\/|'`,\uFF0C\u3001\s]+$/;
const SYMBOL_FACE_HINT_RE = /[_^><~*]{1,}/;
const BARE_FACE_RE = /(^|[\s])[_^~<>=*\-]{2,6}(?=[\s]|$)/g;

/** 情绪对表情/表情包的偏置：生气几乎不发表情包，开心更爱发。 */
const MOOD_BIAS = {
  [t('persona.expressions.mood.calm')]: { face: 1, sticker: 1 },
  [t('persona.expressions.mood.happy')]: { face: 1.3, sticker: 1.5 },
  [t('persona.expressions.mood.angry')]: { face: 0.5, sticker: 0.15 },
  [t('persona.expressions.mood.wronged')]: { face: 0.9, sticker: 0.5 },
  [t('persona.expressions.mood.tired')]: { face: 0.7, sticker: 0.6 },
  [t('persona.expressions.mood.caring')]: { face: 1.1, sticker: 1 },
};

/** 情绪下想多用/少用的表情（QQ 表情 id）。 */
const MOOD_FACE_PREFERENCE = {
  [t('persona.expressions.mood.happy')]: { promote: [14, 5, 74, 66], demote: [] },
  [t('persona.expressions.mood.angry')]: { promote: [11, 13, 21, 32], demote: [14, 5, 74, 66, 9] },
  [t('persona.expressions.mood.wronged')]: { promote: [9, 8], demote: [5, 74] },
  [t('persona.expressions.mood.tired')]: { promote: [20, 13], demote: [74, 5] },
  [t('persona.expressions.mood.caring')]: { promote: [14, 66], demote: [] },
};

const stickerCache = new Map();

function moodKey(mood) {
  return typeof mood === 'string' && mood ? mood : t('persona.expressions.mood.calm');
}

export function moodBias(mood) {
  return MOOD_BIAS[moodKey(mood)] ?? MOOD_BIAS[t('persona.expressions.mood.calm')];
}

function asFaceMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(value);
    if (key && Number.isFinite(id) && id > 0) out[key] = Math.trunc(id);
  }
  return out;
}

/** 从一段 emoji 里找映射：先整段，再去掉变体选择符，最后退到单个字符。 */
function lookupFace(run, map) {
  if (!run) return null;
  if (map[run] != null) return map[run];
  const stripped = run.replace(/[\uFE0F\u200D]/g, '');
  if (stripped && map[stripped] != null) return map[stripped];
  for (const char of run) {
    if (map[char] != null) return map[char];
  }
  return null;
}

function isKaomojiInner(inner) {
  if (!inner) return false;
  if (KAOMOJI_MARK_RE.test(inner)) return true;
  if (/[\u4e00-\u9fff]/.test(inner)) return false;
  return SYMBOL_FACE_RE.test(inner) && SYMBOL_FACE_HINT_RE.test(inner);
}

/** 去掉行首尾悬空的标点（「，我来了」→「我来了」），但保留单发标点表达情绪。 */
export function removeDanglingPunctuation(input) {
  return String(input ?? '')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^[\uFF0C\u3002\u3001\uFF1B\uFF1A,.;:!?\uFF01\uFF1F\u2026]+$/.test(trimmed)) return trimmed;
      return line
        .replace(/^[ \t]*[\uFF0C\u3001\uFF1B\uFF1A,;:]+[ \t]*/, '')
        .replace(/[ \t]*[\uFF0C\u3001\uFF1B\uFF1A,;:]+[ \t]*$/, '')
        .trim();
    })
    .join('\n');
}

/** 收尾清理：空格、空行、残留的颜文字碎片。 */
export function tidyText(input) {
  let out = String(input ?? '').replace(/\r\n?/g, '\n');
  out = out.replace(BARE_FACE_RE, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([\uFF0C\u3002\uFF01\uFF1F\u3001\u2026\uFF09)])/g, '$1').replace(/([\uFF08(])[ \t]+/g, '$1');
  out = removeDanglingPunctuation(out);
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** 把 emoji 与颜文字换成 QQ 表情 id 并从文本里去掉。 */
export function resolveEmoji(input, persona) {
  let text = String(input ?? '');
  const faces = [];
  const emojiMap = asFaceMap(persona?.expressions?.emojiToFace);
  const kaomojiMap = asFaceMap(persona?.expressions?.kaomojiToFace);

  const kaomojiKeys = Object.keys(kaomojiMap).sort((a, b) => b.length - a.length);
  for (const key of kaomojiKeys) {
    const count = text.split(key).length - 1;
    if (count <= 0) continue;
    for (let i = 0; i < count; i += 1) faces.push(kaomojiMap[key]);
    text = text.split(key).join('');
  }

  text = text.replace(BRACKET_RE, (match) => (isKaomojiInner(match.slice(1, -1)) ? '' : match));

  text = text.replace(EMOJI_RE, (match) => {
    const id = lookupFace(match, emojiMap);
    if (id != null) faces.push(id);
    return '';
  });

  return { text: tidyText(text), faces };
}

/** 按配置偏好排序的表情列表，开心/生气时做偏置。 */
export function expressionPreference(persona, emotion, rng) {
  const preferred = Array.isArray(persona?.expressions?.preferred) ? persona.expressions.preferred : [];
  const ids = [];
  for (const item of preferred) {
    const id = Number(item);
    if (Number.isFinite(id) && id > 0 && !ids.includes(Math.trunc(id))) ids.push(Math.trunc(id));
  }
  const mood = moodKey(emotion?.mood);
  const bias = MOOD_FACE_PREFERENCE[mood] ?? null;
  if (!bias) return ids;

  const promote = bias.promote.filter((id) => Number.isFinite(Number(id))).map((id) => Math.trunc(Number(id)));
  const demote = bias.demote.filter((id) => Number.isFinite(Number(id))).map((id) => Math.trunc(Number(id)));
  const ranked = [
    ...promote,
    ...ids.filter((id) => !promote.includes(id) && !demote.includes(id)),
    ...ids.filter((id) => demote.includes(id) && !promote.includes(id)),
  ];
  const unique = [...new Set(ranked)];

  if (typeof rng === 'function' && promote.length > 1) {
    for (let i = promote.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const a = unique.indexOf(promote[i]);
      const b = unique.indexOf(promote[j]);
      if (a >= 0 && b >= 0) [unique[a], unique[b]] = [unique[b], unique[a]];
    }
  }
  return unique;
}

function resolveStickerDir({ persona, config, stickerDir }) {
  const candidate =
    stickerDir ??
    config?.stickerDir ??
    persona?.expressions?.stickerDir ??
    persona?.stickerDir ??
    null;
  if (!candidate) return null;
  if (path.isAbsolute(candidate)) return candidate;
  const base = config?.rootDir ?? config?.boundaryRoot ?? process.cwd();
  return path.resolve(base, candidate);
}

/** 同步读目录并缓存，目录 mtime 变化时刷新。 */
function listStickers(dir) {
  if (!dir) return [];
  let mtimeMs = null;
  try {
    const stat = fs.statSync(dir);
    mtimeMs = stat.isDirectory() ? stat.mtimeMs : null;
  } catch {
    mtimeMs = null;
  }
  const cached = stickerCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.files;
  let files = [];
  if (mtimeMs != null) {
    try {
      files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && STICKER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(dir, entry.name))
        .sort();
    } catch {
      files = [];
    }
  }
  stickerCache.set(dir, { mtimeMs, files });
  return files;
}

function blockedByHistory(pick, history, maxConsecutiveSame) {
  if (!history?.length || !Number.isFinite(maxConsecutiveSame) || maxConsecutiveSame <= 0) return false;
  const tail = history.slice(-maxConsecutiveSame);
  return tail.length >= maxConsecutiveSame && tail.every((item) => item === pick);
}

/** 概率性地挑一个表情 / 表情包；都没挑中时返回 null。 */
export function pickExpression({ persona, emotion, rng, context, config, stickerDir } = {}) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  const bias = moodBias(emotion?.mood);
  const hintSticker = Number(emotion?.hints?.stickerChance);
  const hasHintSticker = Number.isFinite(hintSticker);
  const baseSticker = hasHintSticker ? hintSticker : Number(persona?.expressions?.stickerChance ?? 0.16);
  const stickerChance = clamp(baseSticker * (hasHintSticker ? 1 : bias.sticker), 0, 1);
  const faceChance = clamp(Number(persona?.expressions?.faceChance ?? 0.35) * bias.face, 0, 1);

  const roll = rand();
  const dir = resolveStickerDir({ persona, config, stickerDir });
  const stickers = listStickers(dir);
  const maxConsecutiveSame = Number(persona?.expressions?.maxConsecutiveSame ?? 3);
  const recentFaces = Array.isArray(context?.recentFaces) ? context.recentFaces.map((id) => Number(id)) : [];
  const recentStickers = Array.isArray(context?.recentStickers) ? context.recentStickers : [];

  if (stickers.length) {
    const available = stickers.filter((file) => !blockedByHistory(file, recentStickers, maxConsecutiveSame));
    const pool = available.length ? available : stickers;
    if (roll < stickerChance) {
      const file = pickWeighted(pool, null, rand);
      return file ? { type: 'sticker', file } : null;
    }
  }
  if (roll < stickerChance + faceChance) {
    const preference = expressionPreference(persona, emotion, null);
    if (!preference.length) return null;
    const available = preference.filter(
      (id) => !(recentFaces.length && blockedByHistory(id, recentFaces, maxConsecutiveSame)),
    );
    const pool = available.length ? available : preference;
    const id = pickWeighted(pool, null, rand);
    return id == null ? null : { type: 'face', id };
  }
  return null;
}

/** 测试用：清空贴纸目录缓存。 */
export function clearStickerCache() {
  stickerCache.clear();
}
