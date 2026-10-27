/**
 * .env 的读写原语：保留注释、空行与顺序，只动给定的键。
 *
 * 这一层只做「文件怎么说、怎么写」，不认哪些键有意义（那是 src/web/env.js 的字段表），
 * 也不做本地化 —— 出错一律抛带 code 的 Error，由调用方翻成人话。
 *
 *   readEnvFile(file)  → { exists, file, entries: [{ key, value, line, comment }], text, eol }
 *   writeEnvFile(file, { KEY: 'value' }, { backupDir }) → { file, backup, changed, text, entries }
 */

import fs from 'node:fs';
import path from 'node:path';

/** KEY=value（允许 `export KEY=value`） */
const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * 拆一行赋值：去掉引号、分出尾随注释（`#` 前面必须是空白才算注释，`A=1#2` 里的 # 是值的一部分）。
 * @returns {{ value: string, comment: string|null, quoted: boolean }}
 */
export function parseAssignValue(raw) {
  const text = String(raw ?? '');
  let value = '';
  let comment = null;
  let quote = null;
  let quoted = false;
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        value += text[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      value += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      comment = text.slice(index + 1).trim();
      break;
    }
    value += char;
  }
  return { value: quoted ? value : value.trim(), comment, quoted };
}

/** 写回去时要不要加引号：含空白、`#`、引号就得包一层。 */
export function formatEnvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '') return '';
  if (!/[\s#'"]/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 文件名安全的时间戳：2026-10-26T19-52-51-123 */
export function envStamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * 读 .env：注释、空行、顺序原样保留在 text 里，只有 `KEY=` 的行进 entries。
 * 文件不存在不算错，返回 exists:false。
 */
export function readEnvFile(file) {
  const absolute = path.resolve(String(file));
  let text = null;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw fail('env_read_failed', `cannot read ${absolute}: ${error.message}`, { file: absolute, cause: error });
    }
    return { exists: false, file: absolute, entries: [], text: '', eol: '\n' };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const entries = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = ASSIGN_RE.exec(line);
    if (!match) return;
    const parsed = parseAssignValue(line.slice(match[0].length));
    entries.push({ key: match[1], value: parsed.value, line: index + 1, comment: parsed.comment, raw: line });
  });
  return { exists: true, file: absolute, entries, text, eol };
}

/** 键 → 值（供需要「环境变量意义上」读取的调用方用）。 */
export function envValues(file) {
  const out = {};
  for (const entry of readEnvFile(file).entries) out[entry.key] = entry.value;
  return out;
}

/**
 * 只改给定键的值：键不在文件里就追加到末尾，其余行（含注释、空行、顺序）一个字不动。
 * 写之前把原文件备份到 backupDir/env-<时间戳>。
 *
 * @param {string} file
 * @param {Record<string, string|number|boolean|null>} values
 * @param {{ backupDir?: string|null, now?: number }} [options]
 * @returns {{ file: string, backup: string|null, changed: string[], applied: string[], text: string }}
 */
export function writeEnvFile(file, values = {}, { backupDir = null, now = Date.now() } = {}) {
  const absolute = path.resolve(String(file));
  const pending = new Map();
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!KEY_RE.test(key)) {
      throw fail('env_bad_key', `invalid env key: ${JSON.stringify(key)}`, { key });
    }
    pending.set(key, value === null || value === undefined ? '' : String(value));
  }

  const current = readEnvFile(absolute);
  const before = new Map(current.entries.map((entry) => [entry.key, entry.value]));
  const changed = [];
  const applied = [];
  if (!pending.size) {
    return { file: absolute, backup: null, changed, applied, text: current.text };
  }

  const lines = current.text ? current.text.split(/\r?\n/) : [];
  const trailing = lines.length && lines[lines.length - 1] === '' ? lines.pop() : null;
  const rewritten = lines.map((line) => {
    const match = ASSIGN_RE.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!pending.has(key)) return line;
    const nextValue = pending.get(key);
    applied.push(key);
    if (before.get(key) !== nextValue) changed.push(key);
    const head = line.slice(0, match[0].length);
    const { comment } = parseAssignValue(line.slice(match[0].length));
    const tail = comment ? ` # ${comment}` : '';
    return `${head}${formatEnvValue(nextValue)}${tail}`;
  });

  for (const [key, value] of pending) {
    if (applied.includes(key)) continue;
    applied.push(key);
    changed.push(key);
    rewritten.push(`${key}=${formatEnvValue(value)}`);
  }
  if (trailing !== null) rewritten.push(trailing);

  let backup = null;
  if (backupDir && current.exists) {
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(path.resolve(String(backupDir)), `env-${envStamp(now)}`);
    fs.copyFileSync(absolute, backup);
  }

  const text = `${rewritten.join(current.eol)}${current.eol}`;
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, absolute);

  return { file: absolute, backup, changed, applied, text };
}
