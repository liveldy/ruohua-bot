/**
 * 协议端缓存里的图：NapCat 只给裸文件名，真身在 `nt_data/Emoji/emoji-recv/<年月>/Ori/<hash>.jpg`。
 * 这条链路要能一路走通——解析名字 → 允许目录放行 → 入库；没装解析器时保持原样（不入库、不抛）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createHash } from 'node:crypto';
import { createStickers } from '../../src/sticker/index.js';
import { createImageSourceResolver } from '../../src/perception/image-source.js';
import { stubLogger } from '../dev/harness.js';

const ADMIN_ID = 10001;
const NAME_LOWER = '3147a15d4bc3715ff840424d59589115.jpg';
const NAME_UPPER = '3147A15D4BC3715FF840424D59589115.jpg';
const BYTES = Buffer.from('napcat-cache-sticker-bytes');

const UIN = '3244750966';

let root = null;
let seq = 0;

function makeBase() {
  seq += 1;
  return path.join(root, `case-${seq}`);
}

/** 假的协议端缓存：<base>/home/Documents/Tencent Files/<QQ号>/nt_qq/nt_data/... */
async function writeCache(base, name = NAME_LOWER) {
  const home = path.join(base, 'home');
  const cache = path.join(home, 'Documents', 'Tencent Files', UIN, 'nt_qq', 'nt_data', 'Emoji', 'emoji-recv', '2026-10', 'Ori');
  await fs.mkdir(cache, { recursive: true });
  const file = path.join(cache, name);
  await fs.writeFile(file, BYTES);
  return { home, file };
}

function makeConfig(base) {
  return {
    rootDir: base,
    dataDir: path.join(base, 'data'),
    security: { admins: [ADMIN_ID] },
    sticker: {
      enabled: true,
      dir: 'stickers',
      indexFile: path.join('data', 'stickers', 'index.json'),
      learnFromAdmins: true,
      learnFromOthers: false,
      autoMeaning: false,
      maxItems: 50,
      maxFileBytes: 1024 * 1024,
    },
  };
}

function imageMessage(file, url = null) {
  return {
    userId: ADMIN_ID,
    scene: 'private',
    segments: [{ type: 'image', data: { ...(file ? { file } : {}), ...(url ? { url } : {}) } }],
    text: '',
  };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-sticker-protocol-'));
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('管理员发的裸文件名：解析到协议端缓存、入库，字节与缓存里的一致', async () => {
  const base = makeBase();
  const { home, file } = await writeCache(base);
  const imageSource = createImageSourceResolver({ home, logger: stubLogger() });
  const sticker = await createStickers({ config: makeConfig(base), logger: stubLogger(), imageSource });

  const result = await sticker.observe(imageMessage(NAME_UPPER));
  assert.equal(result.saved, 1, '裸文件名不再是「读不进来」');
  assert.equal(result.items[0].sourceHash, createHash('sha256').update(BYTES).digest('hex'));
  assert.equal(await fs.readFile(result.items[0].path, 'utf8'), BYTES.toString('utf8'), '图真的存进了 stickers/');
  assert.equal(sticker.stats().unreadable ?? 0, 0);

  // 同一张再来一次：内容一样，只算重复，不再新增
  const again = await sticker.observe(imageMessage(NAME_LOWER));
  assert.equal(again.saved, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(await fs.stat(file).then(() => true), true, '缓存里的原图不动');
});

test('同一条消息里裸文件名 + url：本地那张先成了，就不再去下载 url', async () => {
  const base = makeBase();
  const { home } = await writeCache(base);
  const imageSource = createImageSourceResolver({ home, logger: stubLogger() });
  const sticker = await createStickers({ config: makeConfig(base), logger: stubLogger(), imageSource });
  // url 那条故意给一个连不上的地址：本地这张能成，就不该走到它（走到了就会 saved=0）
  const result = await sticker.observe(imageMessage(NAME_LOWER, 'http://127.0.0.1:1/should-not-be-fetched.gif'));
  assert.equal(result.saved, 1);
  assert.equal(await fs.readFile(result.items[0].path, 'utf8'), BYTES.toString('utf8'));
});

test('没装解析器：裸文件名照旧不入库，但不抛错', async () => {
  const base = makeBase();
  await writeCache(base);
  const sticker = await createStickers({ config: makeConfig(base), logger: stubLogger() });
  const result = await sticker.observe(imageMessage(NAME_LOWER));
  assert.equal(result.saved, 0);
  assert.equal(sticker.stats().total, 0);
});

test('协议端把图放在别处（allowedRoots 指到那）：解析器不认识，库也不放行——如实不入库', async () => {
  const base = makeBase();
  const elsewhere = path.join(base, 'somewhere', 'Ori');
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.writeFile(path.join(elsewhere, NAME_LOWER), BYTES);
  const imageSource = createImageSourceResolver({ home: path.join(base, 'no-home'), logger: stubLogger() });
  const sticker = await createStickers({ config: makeConfig(base), logger: stubLogger(), imageSource });
  assert.equal((await sticker.observe(imageMessage(NAME_LOWER))).saved, 0);
});
