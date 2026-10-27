/**
 * 编码守卫。
 *
 * 起因：start.bat 存成 UTF-8 后，cmd 按 GBK 读文件、多字节字符吃掉了行偏移，
 * 于是出现「'dp0"' 不是内部或外部命令」这种诡异报错，中文回显也全是乱码。
 * 这里把规矩钉死：
 *   - 所有文本文件：合法 UTF-8、无 BOM、LF 行尾、没有替换字符 U+FFFD（乱码残留）
 *   - .bat/.cmd：纯 ASCII + CRLF（cmd 默认代码页是 GBK，批处理里放中文必然出事）
 * 违反就直接红，不让它进仓库。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, checkTree, fixTree } from '../../tools/dev/check-encoding.mjs';
import { decodeProcessOutput } from '../../src/util/text.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function tempFile(name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruohua-encoding-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return { dir, file };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

test('全项目文本文件编码统一（UTF-8 无 BOM / LF / 批处理纯 ASCII）', () => {
  const { files, problems } = checkTree(ROOT);
  assert.ok(files > 30, `扫描到的文件太少（${files}），检查根目录是否传错：${ROOT}`);
  const detail = problems.map((item) => `${item.file} [${item.rule}] ${item.detail}`).join('\n');
  assert.equal(problems.length, 0, `发现 ${problems.length} 处编码问题：\n${detail}\n修法：node tools/dev/check-encoding.mjs --fix（非 UTF-8 与批处理中文要手工处理）`);
});

test('批处理里出现中文 / LF 会被拦下', () => {
  const { dir, file } = tempFile('bad.bat', Buffer.from('@echo off\necho 中文\n', 'utf8'));
  try {
    const problems = checkFile(file, 'bad.bat');
    const rules = problems.map((item) => item.rule);
    assert.ok(rules.includes('batch-ascii'), `应当报批处理非 ASCII，实际：${JSON.stringify(problems)}`);
    assert.ok(rules.includes('crlf'), `应当报 LF 行尾，实际：${JSON.stringify(problems)}`);
  } finally {
    cleanup(dir);
  }
});

test('带 BOM 的文件会被拦下，--fix 能修好且不动内容', () => {
  const { dir, file } = tempFile('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\n正文\n', 'utf8')]));
  try {
    assert.ok(checkFile(file, 'bom.md').some((item) => item.rule === 'bom'));
    fixTree(dir);
    assert.equal(checkFile(file, 'bom.md').length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '# 标题\n正文\n');
  } finally {
    cleanup(dir);
  }
});

test('GBK 字节会被认出来', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 「中文」的 GBK 编码
  const { dir, file } = tempFile('gbk.txt', gbk);
  try {
    assert.ok(checkFile(file, 'gbk.txt').some((item) => item.rule === 'utf8'));
  } finally {
    cleanup(dir);
  }
});

test('子进程输出解码：UTF-8 照原样，GBK 中文能救回来', () => {
  assert.equal(decodeProcessOutput(Buffer.from('中文测试', 'utf8')), '中文测试');
  assert.equal(decodeProcessOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])), '中文测试');
  assert.equal(decodeProcessOutput('本来就是字符串'), '本来就是字符串');
  assert.equal(decodeProcessOutput(null), '');
  // 混着 ASCII 的 GBK 报错（cmd 的真实形态）
  const mixed = Buffer.concat([Buffer.from("'pwd' ", 'latin1'), Buffer.from([0xb2, 0xbb, 0xca, 0xc7]), Buffer.from(' cmd', 'latin1')]);
  assert.equal(decodeProcessOutput(mixed).includes('不是'), true, decodeProcessOutput(mixed));
});
