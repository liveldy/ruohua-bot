/** 语言风格：去 Markdown、标点规整、禁语过滤、切成短消息、长文本转文件。 */

import { t } from '../i18n/index.js';
import { charLength, chunkByLength, normalizePunctuation, splitSentences, stripMarkdown } from '../util/text.js';
import { formatTime } from '../util/time.js';
import { removeDanglingPunctuation, resolveEmoji, tidyText } from './expressions.js';

const DEFAULT_MAX_CHARS = 26;
const DEFAULT_MAX_SEGMENTS = 5;
const DEFAULT_MIN_CHARS = 1;
const DEFAULT_MAX_CHARS_BEFORE_FILE = 800;

const COMMA_LIKE_RE = /^[\uFF1B;\uFF1A:\u2014\uFF0D]+$/;
const BRACKET_LIKE_RE = /^[\uFF08(\uFF09)\u3010\u3011\[\]\u300C\u300D\u300E\u300F\u300A\u300B<>\uFF5E~]+$/;

function segmentConfig(persona) {
  const segments = persona?.style?.segments ?? {};
  const maxChars = Math.max(1, Math.trunc(Number(segments.maxChars)) || DEFAULT_MAX_CHARS);
  const minChars = Math.max(1, Math.trunc(Number(segments.minChars)) || DEFAULT_MIN_CHARS);
  const maxSegments = Math.max(1, Math.trunc(Number(segments.maxSegments)) || DEFAULT_MAX_SEGMENTS);
  return { maxChars, minChars, maxSegments };
}

/** 按人设的标点偏好规整：句号收尾去掉、分号冒号降成逗号、括号类符号去掉。 */
function normalizeByPersona(text, persona) {
  const avoid = Array.isArray(persona?.style?.punctuation?.avoid) ? persona.style.punctuation.avoid : [];
  const demote = new Set(['\uFF1B', '\uFF1A', ';', ':']);
  const strip = new Set();
  for (const mark of avoid) {
    if (typeof mark !== 'string' || !mark) continue;
    if (COMMA_LIKE_RE.test(mark)) demote.add(mark);
    else if (BRACKET_LIKE_RE.test(mark)) for (const char of mark) strip.add(char);
  }
  let out = normalizePunctuation(text, { demote: [...demote] });
  if (strip.size) {
    out = [...out].filter((char) => !strip.has(char)).join('');
  }
  return out;
}

/** 去掉禁语：只删禁语短语本身；整行只剩禁语时整行删掉。 */
function removeForbidden(text, forbidden) {
  const list = (Array.isArray(forbidden) ? forbidden : []).filter(
    (item) => typeof item === 'string' && item.trim(),
  );
  if (!list.length) return String(text ?? '');
  let out = String(text ?? '');
  for (const phrase of list) {
    if (!out.includes(phrase)) continue;
    out = out
      .split('\n')
      .map((line) => {
        if (!line.includes(phrase)) return line;
        const rest = line.split(phrase).join('');
        return /[\p{L}\p{N}]/u.test(rest) ? rest : '';
      })
      .join('\n');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

/** 去掉残留的列表符号与多余空行。 */
function cleanupLayout(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^[ \t]*[\u30FB\u2022\u00B7\u25E6\u25CF\u25CB*+][ \t]+/, '')
        .replace(/^[ \t]*[-\u2013][ \t]+/, '')
        .replace(/^[ \t]*\d+[.)\u3001][ \t]+/, '')
        .replace(/[ \t]+$/, '')
        .trim(),
    );
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  out = removeDanglingPunctuation(out);
  return out.replace(/^\n+|\n+$/g, '').trim();
}

/**
 * 把模型输出改造成聊天软件里的说法：去 Markdown、标点规整、删禁语、去 emoji。
 * 只删标记与禁语短语本身，不吞内容。
 */
export function restyle(input, { persona } = {}) {
  const raw = String(input ?? '');
  if (!raw.trim()) return '';
  let text = stripMarkdown(raw);
  text = removeForbidden(text, persona?.style?.forbidden);
  text = resolveEmoji(text, persona).text;
  text = normalizeByPersona(text, persona);
  text = cleanupLayout(text);
  text = tidyText(text);
  return text.trim();
}

function joinParts(left, right) {
  if (!left) return right ?? '';
  if (!right) return left;
  const needsSpace = /[A-Za-z0-9)\]}"']$/.test(left) && /^[A-Za-z0-9(\["']/.test(right);
  return `${left}${needsSpace ? ' ' : ''}${right}`;
}

function splitBlock(block, maxChars, minChars) {
  // 一行一行看，行内先切句：太长的句子交给 chunkByLength 硬切，短句再合并回去
  const parts = [];
  for (const line of block.split('\n').map((item) => item.trim()).filter(Boolean)) {
    for (const sentence of splitSentences(line)) {
      if (charLength(sentence) <= maxChars) parts.push(sentence);
      else parts.push(...chunkByLength(sentence, maxChars));
    }
  }

  const out = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && charLength(joinParts(last, part)) <= maxChars) out[out.length - 1] = joinParts(last, part);
    else out.push(part);
  }

  const merged = [];
  for (const part of out) {
    const last = merged[merged.length - 1];
    if (last && charLength(part) < minChars) merged[merged.length - 1] = joinParts(last, part);
    else merged.push(part);
  }
  return merged.filter(Boolean);
}

/** 超出上限时把多出来的部分并进最后一两条，不要丢内容，也不要堆成一大坨。 */
function trimToMaxSegments(list, maxSegments) {
  if (list.length <= maxSegments) return list;
  const join = (items) => items.reduce((acc, item) => joinParts(acc, item), '');
  if (maxSegments <= 1) return [join(list)].filter(Boolean);

  const headCount = Math.max(0, maxSegments - 2);
  const head = list.slice(0, headCount);
  const rest = list.slice(headCount);
  const total = rest.reduce((sum, item) => sum + charLength(item), 0);
  const target = Math.ceil(total / 2);
  const tail = [];
  let acc = 0;
  for (const item of rest) {
    if (acc >= target && tail.length) break;
    tail.push(item);
    acc += charLength(item);
  }
  const groups = [tail, rest.slice(tail.length)]
    .map(join)
    .filter(Boolean);
  return [...head, ...groups];
}

/** 按各段的条数分配消息上限；每段至少留一条，空行分段不合并。 */
function partitionBudget(counts, budget) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= budget) return counts.slice();
  const exact = counts.map((count) => (budget * count) / total);
  const allowed = exact.map((value, index) => Math.max(1, Math.min(counts[index], Math.floor(value))));
  let sum = allowed.reduce((acc, value) => acc + value, 0);
  const order = counts
    .map((count, index) => ({ index, frac: exact[index] - Math.floor(exact[index]) }))
    .sort((a, b) => b.frac - a.frac);
  let guard = 0;
  while (sum < budget && guard < 1000) {
    let progressed = false;
    for (const item of order) {
      if (sum >= budget) break;
      if (allowed[item.index] < counts[item.index]) {
        allowed[item.index] += 1;
        sum += 1;
        progressed = true;
      }
    }
    if (!progressed) break;
    guard += 1;
  }
  return allowed;
}

/**
 * 切成若干条短消息：空行分段必须尊重，句太长要切开，超出上限的部分并进最后一两条。
 */
export function splitMessages(input, { persona, emotion } = {}) {
  const { maxChars, minChars, maxSegments: baseMaxSegments } = segmentConfig(persona);
  const hintMax = Number(emotion?.hints?.maxSegments);
  const maxSegments = Number.isFinite(hintMax) && hintMax >= 1 ? Math.trunc(hintMax) : baseMaxSegments;

  const text = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  const blocks = text
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  const grouped = blocks.map((block) => splitBlock(block, maxChars, minChars)).filter((items) => items.length);
  if (!grouped.length) return [];

  const budget = partitionBudget(
    grouped.map((items) => items.length),
    maxSegments,
  );
  return grouped.flatMap((items, index) => trimToMaxSegments(items, budget[index])).filter(Boolean);
}

/** 工作性长文本改发文件。 */
export function shouldSendAsFile(input, { persona } = {}) {
  const limit = Number(persona?.style?.maxCharsBeforeFile);
  const max = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_CHARS_BEFORE_FILE;
  return charLength(String(input ?? '')) > max;
}

/** 长文本工作结果的文件正文：保留 Markdown，加标题与时间戳，UTF-8。 */
export function toFileContent(input, { title = t('persona.style.file.defaultTitle'), at = Date.now() } = {}) {
  const body = String(input ?? '').trim();
  const head = `# ${title}`;
  const stamp = t('persona.style.file.stamp', { time: formatTime(at) });
  return body ? `${head}\n\n${stamp}\n\n${body}\n` : `${head}\n\n${stamp}\n`;
}
