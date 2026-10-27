/** 文本处理：去 Markdown、标点规整、切句、token 估算、子进程输出解码。 */

const MARKDOWN_PATTERNS = [
  [/```[a-zA-Z0-9_-]*\n?/g, ''],
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\(([^)]*)\)/g, '$1'],
  [/^\s{0,3}#{1,6}\s*/gm, ''],
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?\uFF0C\u3002\uFF01\uFF1F]|$)/g, '$1$2'],
  [/(^|[\s(])_([^_\n]+)_(?=[\s).,!?\uFF0C\u3002\uFF01\uFF1F]|$)/g, '$1$2'],
  [/~~([^~]+)~~/g, '$1'],
  [/`([^`]+)`/g, '$1'],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}[-*+]\s+/gm, ''],
  [/^\s{0,3}\d+[.)]\s+/gm, ''],
  [/^\s*\|.*\|\s*$/gm, (line) => line.replace(/\|/g, ' ').trim()],
  [/^\s*[-:| ]{3,}\s*$/gm, ''],
  [/^\s*[-=*_]{3,}\s*$/gm, ''],
  [/^\s*={3,}\s*$/gm, ''],
];

export function stripMarkdown(input) {
  let text = String(input ?? '');
  for (const [pattern, replacement] of MARKDOWN_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 标点规整：聊天软件里的人类很少打句号，多用逗号断句。
 * 默认把结尾句号去掉，把分号、冒号降级成逗号，去掉多余的省略号与括号旁的空格。
 */
export function normalizePunctuation(input, opts = {}) {
  const {
    dropTrailingPeriod = true,
    demote = ['\uFF1B', '\uFF1A', ';', ':'],
    collapseRepeats = true,
  } = opts;
  let text = String(input ?? '');
  for (const mark of demote) {
    text = text.split(mark).join('\uFF0C');
  }
  text = text
    .replace(/[ \t]+([\uFF0C\u3002\uFF01\uFF1F\u3001\u2026])/g, '$1')
    .replace(/([\uFF0C\u3002\uFF01\uFF1F\u3001\u2026])[ \t]+/g, '$1');
  text = text.replace(/\uFF0C{2,}/g, '\uFF0C');
  if (collapseRepeats) {
    // 三连以上的省略号收成两个：……」；感叹号最多留两个
    text = text.replace(/\u2026{3,}/g, '\u2026\u2026').replace(/\u3002{2,}/g, '\u3002');
    text = text.replace(/!{3,}/g, '\uFF01\uFF01').replace(/\uFF01{3,}/g, '\uFF01\uFF01');
    text = text.replace(/\?{3,}/g, '\uFF1F\uFF1F').replace(/\uFF1F{3,}/g, '\uFF1F\uFF1F');
  }
  if (dropTrailingPeriod) {
    text = text.replace(/[\u3002.]+$/u, '');
  }
  return text.trim();
}

/** 中文按字数算，英文按单词折算，粗略表示「读起来有多长」。 */
export function charLength(input) {
  const text = String(input ?? '');
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length;
  const rest = text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ');
  const words = (rest.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return cjk + words;
}

export function truncate(input, max, suffix = '…') {
  const text = String(input ?? '');
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** 按中英文标点和换行切句，保留标点。 */
export function splitSentences(input) {
  const text = String(input ?? '').trim();
  if (!text) return [];
  const parts = text
    .split(/(?<=[\u3002\uFF01\uFF1F!?\u2026\n])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = [];
  for (const part of parts) {
    // 「好的，」这种太短的尾巴并到上一句
    if (merged.length && charLength(part) <= 2 && !/[\u3002\uFF01\uFF1F!?]$/.test(part)) {
      merged[merged.length - 1] += part;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

/** 估算 token 数：中文约 1 字 1 token，英文约 4 字符 1 token。 */
export function estimateTokens(input) {
  if (Array.isArray(input)) {
    return input.reduce((sum, item) => sum + estimateTokens(item), 0);
  }
  if (input && typeof input === 'object') {
    return estimateTokens(input.content ?? '') + 8;
  }
  const text = String(input ?? '');
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.05 + other / 3.6);
}

/** 中文数字优先的分段：按长度上限切，尽量在标点处断。 */
export function chunkByLength(input, maxChars) {
  const text = String(input ?? '').trim();
  if (!text) return [];
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cut = -1;
    for (const mark of ['\u3002', '\uFF01', '\uFF1F', '\u2026', '\uFF0C', '\u3001', '\n', ' ']) {
      const idx = window.lastIndexOf(mark, maxChars);
      if (idx > cut) cut = idx;
    }
    if (cut <= Math.floor(maxChars * 0.4)) cut = maxChars;
    else cut += 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function countReplacement(text) {
  let count = 0;
  for (const ch of text) if (ch === '\uFFFD') count += 1;
  return count;
}

/**
 * 解码子进程吐出来的字节。
 *
 * Windows 上 cmd 的中文报错是 GBK 字节，拿 UTF-8 硬解会得到一串 U+FFFD，再存进 JSON
 * 就变成永久的乱码（「锟斤拷」）。所以：先按严格 UTF-8 解，解不动再试本地代码页（默认 GBK），
 * 谁丢的字符少用谁。
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {{ codepage?: string }} [options] 本地代码页，默认 gbk（zh-CN Windows）
 */
export function decodeProcessOutput(input, { codepage = 'gbk' } = {}) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!bytes.length) return '';
  let utf8 = new TextDecoder('utf-8').decode(bytes);
  if (utf8.charCodeAt(0) === 0xfeff) utf8 = utf8.slice(1);
  if (!utf8.includes('\uFFFD')) return utf8;
  let local = null;
  try {
    local = new TextDecoder(codepage).decode(bytes);
  } catch {
    local = null;
  }
  if (local && countReplacement(local) < countReplacement(utf8)) return local;
  return utf8;
}
