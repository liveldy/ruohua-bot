#!/usr/bin/env node
/**
 * 本地化体检：
 *   1. 程序文件里不许出现中文（面向用户的文字一律走本地化键）；
 *   2. 代码里 t('x.y') 用到的键必须在 src/i18n/locales/zh-CN/*.json 里存在；
 *   3. 面板页面 web/index.html 的文字要走 data-i18n / data-i18n-attr。
 *
 * 用法：node tools/dev/check-i18n.mjs [--root <目录>] [--quiet]
 * 退出码：有硬编码或缺失键 → 1。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 汉字、全角标点、常见中文标点。 */
export const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** 只有这些目录能写中文：文字本身。 */
export const ALLOWED_DIRS = ['src/i18n/locales'];

/** 参与体检的程序文件。 */
export const SCAN_DIRS = ['src', 'web'];
export const SCAN_EXT = new Set(['.js', '.mjs']);

/** 面板页面的两个特殊文件。 */
export const HTML_FILES = ['web/index.html'];

function walk(dir, out = [], extensions = SCAN_EXT) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out, extensions);
    } else if (extensions.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 把注释换成空格，行号保持不变。 */
export function stripComments(text) {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  let inString = null;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      else if (c === '\n' && inString !== '`') inString = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function regexAllowedAfter(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

/**
 * 扫一个 JS 源文件里的字符串字面量与模板字面量。
 * @returns {{ items: Array<{ text: string, line: number, kind: string }> }}
 */
export function scanLiterals(text) {
  const items = [];
  let i = 0;
  let line = 1;
  let prevSignificant = '';
  const n = text.length;

  const push = (value, kind) => {
    if (value) items.push({ text: value, line, kind });
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let value = '';
      i += 1;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          value += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === '\n') break;
        value += text[i];
        i += 1;
      }
      i += 1;
      push(value, 'string');
      prevSignificant = 'x';
      continue;
    }
    if (c === '`') {
      i += 1;
      let value = '';
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') {
          value += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '{') {
          // 模板里的表达式：跳到匹配的右花括号，表达式里的字面量单独再扫
          let depth = 1;
          let start = i + 2;
          let j = start;
          while (j < n && depth > 0) {
            if (text[j] === '{') depth += 1;
            else if (text[j] === '}') depth -= 1;
            j += 1;
          }
          const inner = text.slice(start, j - 1);
          for (const found of scanLiterals(inner).items) {
            items.push({ text: found.text, line: line + found.line - 1, kind: found.kind });
          }
          for (const ch of text.slice(i, j)) if (ch === '\n') line += 1;
          i = j;
          continue;
        }
        if (text[i] === '\n') line += 1;
        value += text[i];
        i += 1;
      }
      i += 1;
      push(value, 'template');
      prevSignificant = 'x';
      continue;
    }
    if (c === '/') {
      if (regexAllowedAfter(prevSignificant)) {
        i += 1;
        let inClass = false;
        while (i < n && (inClass || text[i] !== '/')) {
          if (text[i] === '\\') {
            i += 2;
            continue;
          }
          if (text[i] === '[') inClass = true;
          else if (text[i] === ']') inClass = false;
          else if (text[i] === '\n') break;
          i += 1;
        }
        i += 1;
        prevSignificant = 'x';
        continue;
      }
      prevSignificant = '/';
      i += 1;
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }
  return { items };
}

/** 找代码里 t('字面量') 的键。 */
export function collectLiteralKeys(text) {
  const stripped = stripComments(text);
  const out = new Map();
  // t('x.y')（Node 侧）、T('x.y')（面板前端）、selfT('x.y')（i18n 模块自己用的那套）
  const re = /(?:^|[^\w$.])(?:t|T|selfT)\(\s*(['"])([\w.-]+)\1/g;
  let match = null;
  while ((match = re.exec(stripped))) {
    const key = match[2];
    const line = stripped.slice(0, match.index).split('\n').length;
    out.set(key, line);
  }
  return out;
}

/**
 * 扫 Python 源文件里的字符串字面量。
 * 三引号是文档字符串（算注释，放行），`#` 开头的整行是注释（放行）。
 */
export function scanPython(text) {
  const items = [];
  const lines = text.split('\n');
  let inDoc = null;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    let line = raw;
    if (inDoc) {
      const close = line.indexOf(inDoc);
      if (close < 0) return;
      line = line.slice(close + 3);
      inDoc = null;
    }
    // 文档字符串算注释：整行里的三引号段落先抠掉，跨行的进 inDoc 状态
    line = line.replace(/"""[\s\S]*?"""/g, ' ').replace(/'''[\s\S]*?'''/g, ' ');
    for (const delimiter of ['"""', "'''"]) {
      const at = line.indexOf(delimiter);
      if (at < 0) continue;
      const rest = line.slice(at + 3);
      const closes = rest.indexOf(delimiter);
      if (closes < 0) {
        inDoc = delimiter;
        line = line.slice(0, at);
      } else {
        line = `${line.slice(0, at)} ${rest.slice(closes + 3)}`;
      }
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) return;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '#') break; // 行尾注释
      if (c === "'" || c === '"') {
        const quote = c;
        let value = '';
        i += 1;
        while (i < line.length && line[i] !== quote) {
          if (line[i] === '\\') {
            value += line[i + 1] ?? '';
            i += 2;
            continue;
          }
          value += line[i];
          i += 1;
        }
        i += 1;
        if (value) items.push({ text: value, line: lineNo, kind: 'python' });
        continue;
      }
      i += 1;
    }
  });
  return { items };
}

/** 面板页面里的写死文字、以及引用的 data-i18n 键。 */
export function scanHtml(text) {
  const hardcoded = [];
  const keys = new Set();
  const lines = text.split('\n');
  let inComment = false;
  lines.forEach((raw, index) => {
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) return;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open >= 0) {
      line = line.slice(0, open);
      inComment = true;
    }
    const attrs = /data-i18n(?:-attr)?\s*=\s*"([^"]*)"/g;
    let match = null;
    while ((match = attrs.exec(line))) {
      for (const key of match[1].split(',')) {
        const name = key.trim().split(':').pop();
        if (name && /^[\w.-]+$/.test(name)) keys.add(name);
      }
    }
    const withoutAttrs = line.replace(/data-i18n(?:-attr)?\s*=\s*"[^"]*"/g, '');
    if (CJK_RE.test(withoutAttrs)) hardcoded.push({ line: index + 1, text: withoutAttrs.trim().slice(0, 120) });
  });
  return { hardcoded, keys: [...keys] };
}

export function loadDefaultTable(rootDir) {
  const dir = path.join(rootDir, 'src', 'i18n', 'locales', 'zh-CN');
  const table = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return table;
  }
  for (const name of files) {
    let content = null;
    try {
      content = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (error) {
      throw new Error(`${name} 不是合法 JSON：${error.message}`);
    }
    for (const [key, value] of Object.entries(content)) {
      const namespace = name.replace(/\.json$/, '');
      if (!key.startsWith(`${namespace}.`)) {
        table.set(`!错误的命名空间 ${name} → ${key}`, value);
        continue;
      }
      table.set(key, value);
    }
  }
  return table;
}

export function check(rootDir = process.cwd()) {
  const hardcoded = [];
  const missingKeys = [];
  const table = loadDefaultTable(rootDir);
  const usedKeys = new Set();
  const htmlKeys = new Set();

  /** 一个键可以被多个文件用，重复用不算缺键。 */
  const noteKey = (key, file, line) => {
    usedKeys.add(key);
    if (!table.has(key)) missingKeys.push({ file, line, key });
  };

  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(rootDir, dir)));

  for (const file of files) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    if (ALLOWED_DIRS.some((allowed) => rel.startsWith(`${allowed}/`))) continue;
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (CJK_RE.test(stripComments(text))) {
      for (const item of scanLiterals(text).items) {
        if (CJK_RE.test(item.text)) hardcoded.push({ file: rel, line: item.line, kind: item.kind, text: item.text.slice(0, 120) });
      }
      // 注释里也留着中文是允许的，但字面量之外还有中文就说明扫描漏了
      const leftovers = stripComments(text)
        .split('\n')
        .map((line, index) => ({ line: index + 1, text: line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '') }))
        .filter((row) => CJK_RE.test(row.text));
      for (const row of leftovers) hardcoded.push({ file: rel, line: row.line, kind: 'other', text: row.text.trim().slice(0, 120) });
    }
    for (const [key, line] of collectLiteralKeys(text)) noteKey(key, rel, line);
  }

  // Python 侧车也走同一套本地化键（python/i18n.py 读同一批 json）
  for (const file of walk(path.join(rootDir, 'python'), [], new Set(['.py']))) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const item of scanPython(text).items) {
      if (CJK_RE.test(item.text)) hardcoded.push({ file: rel, line: item.line, kind: 'python', text: item.text.slice(0, 120) });
    }
    for (const [key, line] of collectLiteralKeys(text)) noteKey(key, rel, line);
  }

  for (const file of HTML_FILES) {
    const full = path.join(rootDir, file);
    if (!fs.existsSync(full)) continue;
    const scanned = scanHtml(fs.readFileSync(full, 'utf8'));
    for (const row of scanned.hardcoded) hardcoded.push({ file, line: row.line, kind: 'html', text: row.text });
    for (const key of scanned.keys) {
      htmlKeys.add(key);
      noteKey(key, file, 0);
    }
  }

  const unusedKeys = [...table.keys()].filter((key) => !usedKeys.has(key) && !key.startsWith('!')).sort();
  return { hardcoded, missingKeys, unusedKeys, usedKeys: usedKeys.size, tableKeys: table.size };
}

function main() {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : path.resolve(HERE, '..', '..');
  const quiet = argv.includes('--quiet');
  const result = check(root);

  if (result.hardcoded.length) {
    console.error(`✗ 程序文件里还有 ${result.hardcoded.length} 处写死的中文：`);
    for (const row of result.hardcoded.slice(0, 60)) console.error(`   ${row.file}:${row.line} [${row.kind}] ${row.text}`);
    if (result.hardcoded.length > 60) console.error(`   …还有 ${result.hardcoded.length - 60} 处`);
  }
  if (result.missingKeys.length) {
    console.error(`✗ 有 ${result.missingKeys.length} 个本地化键在代码里用了、但本地化键表里没有：`);
    for (const row of result.missingKeys.slice(0, 60)) console.error(`   ${row.file}:${row.line} ${row.key}`);
    if (result.missingKeys.length > 60) console.error(`   …还有 ${result.missingKeys.length - 60} 个`);
  }
  if (!quiet && result.unusedKeys.length) {
    console.log(`· 本地化键里 ${result.unusedKeys.length} 个键没被代码引用（可能只是暂时没用到）：`);
    for (const key of result.unusedKeys.slice(0, 40)) console.log(`   ${key}`);
  }

  if (result.hardcoded.length || result.missingKeys.length) {
    console.error(`\n本地化体检不通过：写死 ${result.hardcoded.length} 处，缺键 ${result.missingKeys.length} 个。`);
    return 1;
  }
  console.log('✓ 本地化体检通过：没有写死的文字，用到的键都有文字。');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = main();
