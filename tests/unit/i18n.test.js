/**
 * 本地化守卫。
 *
 * 规矩：程序文件（src/、web/）里不出现任何面向用户的文字，一律 t('命名空间.键')；
 * 文字落在 src/i18n/locales/zh-CN/<命名空间>.json；管理员改的本地化键覆盖在 data/locales/zh-CN.json。
 * 这个文件把规矩钉成可执行的检查 —— 写死中文、用了不存在的键，直接红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, loadDefaultTable, scanLiterals, stripComments, collectLiteralKeys, scanHtml } from '../../tools/dev/check-i18n.mjs';
import { createI18n, configureI18n, i18n, t, has, keys, localeOverridePath, DEFAULT_LOCALE } from '../../src/i18n/index.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ruohua-i18n-${name}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响结论 */
  }
}

test('程序文件里没有写死的中文', () => {
  const result = check(ROOT);
  const detail = result.hardcoded.map((row) => `${row.file}:${row.line} ${row.text}`).join('\n');
  assert.equal(
    result.hardcoded.length,
    0,
    `有 ${result.hardcoded.length} 处写死的中文，改成 t('键') 并写进 src/i18n/locales/zh-CN/：\n${detail}`,
  );
});

test('代码里用到的本地化键都有文字', () => {
  const result = check(ROOT);
  const detail = result.missingKeys.map((row) => `${row.file}:${row.line} ${row.key}`).join('\n');
  assert.equal(result.missingKeys.length, 0, `有 ${result.missingKeys.length} 个键没有对应文字：\n${detail}`);
});

test('本地化键表结构：文件名即命名空间，值是字符串', () => {
  const table = loadDefaultTable(ROOT);
  assert.ok(table.size > 100, `默认文字太少（${table.size} 条），确认扫描的是 src/i18n/locales/zh-CN`);
  const broken = [...table.keys()].filter((key) => key.startsWith('!'));
  assert.deepEqual(broken, [], `这些键的命名空间不对：${broken.join('、')}`);
  const empty = [...table.entries()].filter(([, value]) => !String(value).trim());
  assert.deepEqual(empty.map(([key]) => key), [], '文字里有空字符串');
});

test('t() 会插值、找不到的键返回键本身并记账', () => {
  const dir = tempDir('core');
  const localeDir = path.join(dir, 'zh-CN');
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(path.join(localeDir, 'demo.json'), JSON.stringify({ 'demo.hi': '你好 {name}', 'demo.plain': '在' }), 'utf8');
  const instance = createI18n({ locale: 'zh-CN', localeDir: dir });
  try {
    assert.equal(instance.t('demo.hi', { name: '张三' }), '你好 张三');
    assert.equal(instance.t('demo.hi'), '你好 {name}');
    assert.equal(instance.t('demo.plain'), '在');
    assert.equal(instance.t('demo.缺失'), 'demo.缺失');
    assert.deepEqual(instance.missingKeys(), ['demo.缺失']);
    assert.equal(instance.has('demo.plain'), true);
    assert.equal(instance.has('demo.nope'), false);
    assert.deepEqual(instance.keys(), ['demo.hi', 'demo.plain']);
  } finally {
    cleanup(dir);
  }
});

test('覆盖文件优先于默认文字，保存只写与默认不同的键', () => {
  const dir = tempDir('override');
  const localeDir = path.join(dir, 'zh-CN');
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(
    path.join(localeDir, 'demo.json'),
    JSON.stringify({ 'demo.hi': '默认', 'demo.bye': '默认再见' }),
    'utf8',
  );
  const overrideFile = path.join(dir, 'data', 'locales', 'zh-CN.json');
  const instance = createI18n({ locale: 'zh-CN', localeDir: dir, overrideFile });
  try {
    assert.equal(instance.t('demo.hi'), '默认');
    instance.set('demo.hi', '改过的');
    instance.set('demo.bye', '默认再见'); // 与默认一样，不该写进覆盖文件
    assert.equal(instance.t('demo.hi'), '改过的');
    const saved = instance.save();
    assert.equal(saved.count, 1);
    const written = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
    assert.deepEqual(written, { 'demo.hi': '改过的' });

    // 另一个实例读同一份覆盖文件，拿到的是改过的文字
    const other = createI18n({ locale: 'zh-CN', localeDir: dir, overrideFile });
    assert.equal(other.t('demo.hi'), '改过的');
    other.reset('demo.hi');
    assert.equal(other.t('demo.hi'), '默认');
    assert.deepEqual(other.changedKeys(), []);
  } finally {
    cleanup(dir);
  }
});

test('模块级 t() 默认是中文，configureI18n 能挂上覆盖文件', () => {
  const dir = tempDir('singleton');
  const overrideFile = path.join(dir, 'zh-CN.json');
  fs.writeFileSync(overrideFile, JSON.stringify({ 'i18n.test.sample': '改过的样例' }), 'utf8');
  const original = i18n();
  try {
    assert.equal(DEFAULT_LOCALE, 'zh-CN');
    assert.ok(keys().length > 100);
    configureI18n({ locale: 'zh-CN', overrideFile });
    // 覆盖文件里没有的键，仍然走代码自带的默认文字
    assert.equal(typeof t('i18n.test.missingKey'), 'string');
    assert.equal(has('i18n.test.sample'), true);
    assert.equal(t('i18n.test.sample'), '改过的样例');
    assert.equal(i18n().overrideFile(), overrideFile);
    assert.ok(localeOverridePath('D:/x').replace(/\\/g, '/').endsWith('data/locales/zh-CN.json'));
  } finally {
    configureI18n({ locale: DEFAULT_LOCALE });
    assert.notEqual(i18n(), original);
    cleanup(dir);
  }
});

test('扫描器认得出字符串、模板串与面板页面里的写死中文', () => {
  const source = [
    "const a = '你好';", // 行注释里的中文不算
    '// 注释里的中文不算',
    '/* 块注释里的中文也不算 */',
    'const b = `共 ${n} 条，中文在里面`;',
    "const c = t('demo.hi', { name: '张三' });",
    'const re = /abc/g;',
  ].join('\n');
  const stripped = stripComments(source);
  assert.equal(/块注释/.test(stripped), false);
  const items = scanLiterals(source).items.filter((item) => /[\u4e00-\u9fff]/.test(item.text));
  assert.equal(items.length, 3, JSON.stringify(items));
  assert.deepEqual(
    items.map((item) => item.kind).sort(),
    ['string', 'string', 'template'],
  );
  const literalKeys = [...collectLiteralKeys(source).keys()];
  assert.deepEqual(literalKeys, ['demo.hi']);

  // 页面里连 data-i18n 元素的文字节点也要留空（启动时由 app.js 填），所以两行都算写死
  const html = [
    '<title data-i18n="webui.title"></title>',
    '<p data-i18n="webui.hello">你好</p>',
    '<p>没走键的文字</p>',
    '<!-- 注释里的中文不算 -->',
  ].join('\n');
  const scanned = scanHtml(html);
  assert.deepEqual(scanned.keys, ['webui.title', 'webui.hello']);
  assert.equal(scanned.hardcoded.length, 2, JSON.stringify(scanned.hardcoded));
  assert.deepEqual(scanned.hardcoded.map((row) => row.line), [2, 3]);
});
