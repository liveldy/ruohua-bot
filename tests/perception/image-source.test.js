/**
 * 协议端图片来源解析：NapCat 的 image 段只给裸文件名（`picElement.fileName`），
 * 真身在它自己的缓存目录里（`nt_data/Emoji/emoji-recv/<年月>/Ori/<名字>`，且是小写 hash）。
 * 真机日志里这张图一直被当成「本地文件读不进来」——识图报 ENOENT、表情包整张跳过。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createImageSourceResolver, protocolImageRoots } from '../../src/perception/image-source.js';
import { createNullLogger } from '../../src/logging/logger.js';

const NAME_LOWER = '3147a15d4bc3715ff840424d59589115.jpg';
const NAME_UPPER = '3147A15D4BC3715FF840424D59589115.jpg';

let root = null;
let seq = 0;

function makeRoot() {
  seq += 1;
  return path.join(root, `cache-${seq}`);
}

/** 照 NTQQ 的目录形状写一个文件：<根>/Emoji/emoji-recv/<年月>/Ori/<名字>。 */
async function writeCached(base, name, content, month = '2026-10', sub = 'Emoji/emoji-recv') {
  const file = path.join(base, ...sub.split('/'), month, 'Ori', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-image-source-'));
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('裸文件名：按缓存目录形状找到真身（大小写不一致也算）', async () => {
  const base = makeRoot();
  const expected = await writeCached(base, NAME_LOWER, 'cat-bytes');
  const resolver = createImageSourceResolver({ roots: [base], logger: createNullLogger() });

  assert.equal(await resolver.resolve(NAME_UPPER), expected, '协议端给大写 hash，盘上是小写，也要认');
  assert.equal(await resolver.resolve(NAME_LOWER), expected);
  assert.deepEqual(await resolver.roots(), [path.resolve(base)]);
});

test('远端地址、base64、真正的路径都原样放行，不去扫缓存', async () => {
  const base = makeRoot();
  const resolver = createImageSourceResolver({ roots: [base], logger: createNullLogger() });
  const cases = [
    'https://gchat.qpic.cn/gchatpic_new/1/2-3-4/0?term=2',
    'http://127.0.0.1:8787/x.png',
    'data:image/png;base64,AAAA',
    'base64://AAAA',
    'file:///D:/Desktop/NapCat/shot.png',
    'D:/Desktop/NapCat/shot.png',
    'D:\\Desktop\\NapCat\\shot.png',
  ];
  for (const item of cases) assert.equal(await resolver.resolve(item), item);
  assert.equal(resolver.stats().scans, 0, '这些来源不该触发缓存扫描');
});

test('多份同名文件取最新那张；找不到就是 null，且短时间里不重复扫', async () => {
  const base = makeRoot();
  await writeCached(base, NAME_LOWER, 'old', '2026-09');
  const newest = await writeCached(base, NAME_LOWER, 'new', '2026-10');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(newest, future, future);
  const resolver = createImageSourceResolver({ roots: [base], logger: createNullLogger() });

  assert.equal((await resolver.resolve(NAME_LOWER)), newest);
  const scansAfterHit = resolver.stats().scans;

  const missing = 'ffffffffffffffffffffffffffffffff.jpg';
  assert.equal(await resolver.resolve(missing), null);
  assert.equal(await resolver.resolve(missing), null);
  assert.equal(resolver.stats().scans, scansAfterHit + 1, '没找到的记着，短时间内别再扫一遍');
  assert.equal(resolver.stats().missing, 1);
  assert.equal(resolver.stats().found, 1);
});

test('命中的结果留住：文件后来不在了也还认这个名字（读不到由上层如实报）', async () => {
  const base = makeRoot();
  const file = await writeCached(base, NAME_LOWER, 'cat-bytes');
  const resolver = createImageSourceResolver({ roots: [base], logger: createNullLogger() });
  assert.equal(await resolver.resolve(NAME_LOWER), file);
  await fs.rm(file);
  assert.equal(await resolver.resolve(NAME_LOWER), file);
});

test('resolveAll：顺序保留、去重、丢掉找不出来的裸名字', async () => {
  const base = makeRoot();
  const file = await writeCached(base, NAME_LOWER, 'cat-bytes');
  const resolver = createImageSourceResolver({ roots: [base], logger: createNullLogger() });
  const url = 'https://gchat.qpic.cn/x/1-2/0?term=2';
  assert.deepEqual(await resolver.resolveAll([NAME_UPPER, url, 'not-there.png', url]), [file, url]);
});

test('缓存目录不存在 / 是个文件：安静跳过，不抛', async () => {
  const base = makeRoot();
  const filePath = path.join(base, 'not-a-dir');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(filePath, 'x');
  const resolver = createImageSourceResolver({ roots: [filePath, path.join(base, 'nope')], logger: createNullLogger() });
  assert.equal(await resolver.resolve(NAME_LOWER), null);
});

test('protocolImageRoots：从文档目录探到 <Tencent Files>/<QQ号>/nt_qq/nt_data，也接受配置里的额外目录', async () => {
  const home = makeRoot();
  const uin = path.join(home, 'Documents', 'Tencent Files', '3244750966');
  const data = path.join(uin, 'nt_qq', 'nt_data');
  await fs.mkdir(data, { recursive: true });
  // 没有 nt_qq 的账号目录要跳过
  await fs.mkdir(path.join(home, 'Documents', 'Tencent Files', '1599622584'), { recursive: true });
  const extraDir = path.join(home, 'elsewhere');
  await fs.mkdir(extraDir, { recursive: true });

  const found = await protocolImageRoots({ home, extra: [extraDir, path.join(home, 'missing')] });
  assert.deepEqual(found, [path.resolve(data), path.resolve(extraDir)]);

  const empty = await protocolImageRoots({ home: path.join(home, 'nothing-here') });
  assert.deepEqual(empty, []);
});

test('没配置缓存目录时，自己从 home 探出来（装到真机上就该这么用）', async () => {
  const home = makeRoot();
  const data = path.join(home, 'Documents', 'Tencent Files', '3244750966', 'nt_qq', 'nt_data');
  const expected = await writeCached(data, NAME_LOWER, 'cat-bytes');
  const resolver = createImageSourceResolver({ home, logger: createNullLogger() });
  assert.deepEqual(await resolver.roots(), [path.resolve(data)]);
  assert.equal(await resolver.resolve(NAME_UPPER), expected);
});
