#!/usr/bin/env node
/**
 * 编码体检：全项目文本文件必须合法 UTF-8、无 BOM、LF 换行；
 * .bat / .cmd 额外要求纯 ASCII + CRLF（cmd 默认代码页是 GBK，UTF-8 中文批处理会乱码、
 * 甚至因为多字节字符吃掉行偏移而报「不是内部或外部命令」）。
 *
 * 用法：
 *   node tools/dev/check-encoding.mjs            体检当前目录
 *   node tools/dev/check-encoding.mjs --json     机器可读输出
 *   node tools/dev/check-encoding.mjs --fix      就把行尾/BOM 修好（不碰内容）
 *   node tools/dev/check-encoding.mjs <目录>     指定目录
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// data/ 是运行数据，work/ 与 reports/ 是机器人干活时产出的东西（含子进程回显，天然是 CRLF），
// 都不是源码，不按源码的行尾/编码规矩要求
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'data',
  'work',
  'reports',
  '.idea',
  '.vscode',
]);
const BINARY_EXT = new Set(['.bmp', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.pdf', '.mp3', '.wav', '.mp4', '.pyc', '.woff', '.woff2', '.ttf', '.otf']);
const CRLF_REQUIRED = new Set(['.bat', '.cmd']);
const BATCH_RULE = '.bat/.cmd 必须是纯 ASCII + CRLF';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function looksBinary(buffer) {
  const head = buffer.subarray(0, 8000);
  return head.includes(0);
}

/** 检查单个文件，返回问题列表（空数组 = 合格）。 */
export function checkFile(filePath, relPath = path.basename(filePath)) {
  const problems = [];
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    return [{ file: relPath, rule: 'read', detail: `读不了：${error.message}` }];
  }
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXT.has(ext) || looksBinary(buffer)) return problems;

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    problems.push({ file: relPath, rule: 'bom', detail: '带 UTF-8 BOM' });
  }
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) {
    problems.push({ file: relPath, rule: 'utf16', detail: 'UTF-16 编码，要存成 UTF-8' });
    return problems;
  }

  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    problems.push({ file: relPath, rule: 'utf8', detail: '不是合法 UTF-8（用 GBK/ANSI 存过？请另存为 UTF-8）' });
    return problems;
  }
  if (text.includes('\uFFFD')) {
    problems.push({ file: relPath, rule: 'mojibake', detail: '含替换字符 U+FFFD：写文件时解码失败过一次，中文已经丢了' });
  }

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareCr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;

  if (CRLF_REQUIRED.has(ext)) {
    if (lfOnly > 0) problems.push({ file: relPath, rule: 'crlf', detail: `批处理文件里混着 ${lfOnly} 处 LF，要统一 CRLF` });
    if (bareCr > 0) problems.push({ file: relPath, rule: 'crlf', detail: `有 ${bareCr} 处裸 CR` });
    const nonAscii = [...text].findIndex((ch) => ch.codePointAt(0) > 0x7f);
    if (nonAscii >= 0) {
      const snippet = text.slice(Math.max(0, nonAscii - 10), nonAscii + 10).replace(/\r?\n/g, '⏎');
      problems.push({ file: relPath, rule: 'batch-ascii', detail: `${BATCH_RULE}，发现非 ASCII 字符：…${snippet}…` });
    }
  } else {
    if (crlf > 0) problems.push({ file: relPath, rule: 'lf', detail: `有 ${crlf} 处 CRLF，项目统一 LF` });
    if (bareCr > 0) problems.push({ file: relPath, rule: 'lf', detail: `有 ${bareCr} 处裸 CR` });
  }
  return problems;
}

/** 扫一个目录，返回所有问题。 */
export function checkTree(rootDir) {
  const problems = [];
  let files = 0;
  for (const file of walk(rootDir)) {
    files += 1;
    problems.push(...checkFile(file, path.relative(rootDir, file).replace(/\\/g, '/')));
  }
  return { files, problems };
}

/**
 * 就地修好能自动修的问题：BOM、行尾（.bat/.cmd → CRLF，其余 → LF）。
 * 内容一个字节都不动；非 UTF-8 与批处理里的非 ASCII 只报告，不猜怎么改。
 */
export function fixTree(rootDir) {
  const fixed = [];
  for (const file of walk(rootDir)) {
    const ext = path.extname(file).toLowerCase();
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (BINARY_EXT.has(ext) || looksBinary(buffer)) continue;
    const before = buffer;
    let text = buffer.toString('utf8');
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) text = text.slice(1);
    let next = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (CRLF_REQUIRED.has(ext)) next = next.replace(/\n/g, '\r\n');
    const out = Buffer.from(next, 'utf8');
    if (!out.equals(before)) {
      fs.writeFileSync(file, out);
      fixed.push(path.relative(rootDir, file).replace(/\\/g, '/'));
    }
  }
  return fixed;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const rootDir = path.resolve(args.find((item) => !item.startsWith('--')) ?? process.cwd());
  if (args.includes('--fix')) {
    const fixed = fixTree(rootDir);
    console.log(fixed.length ? `已修好 ${fixed.length} 个文件的行尾/BOM：\n  ${fixed.join('\n  ')}` : '没有需要修的行尾/BOM 问题');
  }
  const { files, problems } = checkTree(rootDir);
  if (json) {
    console.log(JSON.stringify({ rootDir, files, problems }, null, 2));
  } else if (!problems.length) {
    console.log(`编码体检通过：${files} 个文件全部合法 UTF-8 / 行尾统一`);
  } else {
    console.log(`编码体检不通过：${problems.length} 处问题（共扫 ${files} 个文件）`);
    for (const item of problems) console.log(`  ✗ ${item.file}  [${item.rule}] ${item.detail}`);
  }
  process.exitCode = problems.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) main();
