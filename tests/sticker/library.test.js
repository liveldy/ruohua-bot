/**
 * 表情包库（存储层）：入库 / 去重 / 索引落盘再读回 / 删除 / 统计 / 批量查询，
 * 以及两条底线——路径越界拒收、超过大小上限拒收、下载失败不抛。
 *
 * 全部用临时目录，不碰真实网络（只在本地起一个临时 HTTP 服务模拟下载）。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStickerLibrary, sha256 } from '../../src/sticker/library.js';
import { stubLogger } from '../dev/harness.js';

let root = null;
let seq = 0;

/** 每个用例一个独立目录：<tmp>/<case>/stickers 与 <tmp>/<case>/data/stickers/index.json */
function makeOptions(extra = {}) {
  seq += 1;
  const base = path.join(root, `case-${seq}`);
  return {
    base,
    dir: path.join(base, 'stickers'),
    indexFile: path.join(base, 'data', 'stickers', 'index.json'),
    logger: stubLogger(),
    ...extra,
  };
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-sticker-lib-'));
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('表情包库：入库与索引', () => {
  it('buffer 入库：图片落到 stickers/，索引能落盘也能读回', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const item = await library.add({
      sourceBuffer: Buffer.from('fake-sticker-image-1'),
      title: '得意的猫',
      meaning: '得意',
      tags: ['得意', '开心'],
      addedBy: 10001,
      origin: 'admin',
    });

    assert.ok(item, '入库应返回条目');
    assert.match(item.id, /^[A-Za-z0-9_-]+$/);
    assert.equal(item.file, `sticker_${item.id}.png`);
    assert.equal(item.path, path.join(options.dir, item.file));
    assert.equal(item.bytes, Buffer.byteLength('fake-sticker-image-1'));
    assert.equal(item.title, '得意的猫');
    assert.equal(item.meaning, '得意');
    assert.deepEqual(item.tags, ['得意', '开心']);
    assert.equal(item.addedBy, 10001);
    assert.equal(item.usedCount, 0);
    assert.equal(item.sourceHash, sha256(Buffer.from('fake-sticker-image-1')));
    assert.equal(await fs.readFile(item.path, 'utf8'), 'fake-sticker-image-1');

    const raw = JSON.parse(await fs.readFile(options.indexFile, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.items.length, 1);
    assert.equal(raw.items[0].id, item.id);

    // 另一个实例读回：文件 + 含义 + 计数都在
    const reloaded = createStickerLibrary({ ...options, logger: stubLogger() });
    assert.equal(reloaded.loaded, false);
    const loaded = await reloaded.load();
    assert.equal(reloaded.loaded, true);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.items.length, 1);
    assert.equal(reloaded.get(item.id).meaning, '得意');
    assert.equal(reloaded.get(item.id).title, '得意的猫');
    assert.deepEqual(reloaded.get(item.id).tags, ['得意', '开心']);
  });

  it('标题：截到 12 个字、压掉空白，认不出来就是空串', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const long = await library.add({
      sourceBuffer: Buffer.from('title-long'),
      title: '  这是一条  特别特别长的标题超过十二个字了  ',
    });
    assert.equal(long.title, '这是一条 特别特别长的标');

    const blank = await library.add({ sourceBuffer: Buffer.from('title-blank'), title: '   ' });
    assert.equal(blank.title, '', '空白标题当空串');

    const notString = await library.add({ sourceBuffer: Buffer.from('title-number'), title: 12345 });
    assert.equal(notString.title, '', '不是字符串的标题当空串');

    const missing = await library.add({ sourceBuffer: Buffer.from('title-missing') });
    assert.equal(missing.title, '', '没给标题就是空串');
  });

  it('旧索引没有 title 字段：load 补成空串，get / findByHash / list 都带 title', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const item = await library.add({ sourceBuffer: Buffer.from('legacy'), title: '旧图', meaning: '一幅旧图' });

    // 把索引改成老样子：没有 title 字段
    const raw = JSON.parse(await fs.readFile(options.indexFile, 'utf8'));
    for (const row of raw.items) delete row.title;
    await fs.writeFile(options.indexFile, `${JSON.stringify(raw, null, 2)}\n`);

    const reloaded = createStickerLibrary(options);
    await reloaded.load();
    assert.equal(reloaded.get(item.id).title, '');
    assert.ok('title' in reloaded.get(item.id), '读回来的条目要有 title 键');
    assert.equal(reloaded.findByHash(sha256(Buffer.from('legacy'))).title, '');
    assert.equal(reloaded.list({})[0].title, '');
  });

  it('update 能改 title，也照样受同样的整理规则', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const item = await library.add({ sourceBuffer: Buffer.from('update-title'), meaning: '无语' });

    const updated = await library.update(item.id, { title: '  翻白眼的猫  ' });
    assert.equal(updated.title, '翻白眼的猫');
    assert.equal(updated.meaning, '无语', '只改标题不动别的字段');

    const cleared = await library.update(item.id, { title: null });
    assert.equal(cleared.title, '', '清空标题传 null 也认');
    assert.equal(library.get(item.id).title, '', '落盘之后再读回来也是空的');
  });

  it('本地文件入库：只认 data/ 与 stickers/ 下的文件', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const inside = await writeFile(path.join(options.base, 'data', 'cache', 'cat.png'), 'cat-bytes');
    const item = await library.add({ sourceFile: inside, meaning: '一只猫' });
    assert.ok(item);
    assert.equal(await fs.readFile(item.path, 'utf8'), 'cat-bytes');

    const outside = await writeFile(path.join(options.base, 'elsewhere', 'secret.png'), 'secret');
    assert.equal(await library.add({ sourceFile: outside }), null, '越界的文件必须被拒');

    const traversal = path.join(options.dir, '..', '..', 'elsewhere', 'secret.png');
    assert.equal(await library.add({ sourceFile: traversal }), null, '用 .. 绕出去的路径必须被拒');
    assert.equal(await library.add({ sourceFile: path.join(root, 'nowhere', 'x.png') }), null, '不存在的文件返回 null');
    assert.equal(library.stats().total, 1);
  });

  it('readable：本地文件读得到才 true，调用方能靠它别白喂一次识图', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const inside = await writeFile(path.join(options.base, 'data', 'cache', 'ok.png'), 'ok-bytes');

    assert.equal(await library.readable({ sourceFile: inside }), true);
    assert.equal(await library.readable({ sourceFile: '3147A15D4BC3715FF840424D59589115.jpg' }), false, '协议端的裸缓存名读不到');
    assert.equal(await library.readable({ sourceFile: path.join(root, 'nowhere', 'x.png') }), false);
    assert.equal(await library.readable({ sourceFile: path.join(options.base, 'elsewhere', 'secret.png') }), false, '越界也算读不到');
    // url / buffer 提前判不了，交给 add() 自己去下载和校验
    assert.equal(await library.readable({ sourceUrl: 'https://example.test/a.jpg' }), true);
    assert.equal(await library.readable({ sourceBuffer: Buffer.from('x') }), true);
  });

  it('同内容的图重复入库：只更新计数，不再多存一份', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const first = await library.add({ sourceBuffer: Buffer.from('same-bytes'), meaning: '无语' });
    const second = await library.add({ sourceBuffer: Buffer.from('same-bytes'), meaning: '换个说法' });

    assert.equal(second.id, first.id);
    assert.equal(library.stats().total, 1);
    const files = await fs.readdir(options.dir);
    assert.equal(files.length, 1);
    assert.equal(library.get(first.id).usedCount, 1, '重复入库算一次使用');
    assert.equal(library.get(first.id).meaning, '无语', '已有含义不被覆盖');
    assert.ok(library.findByHash(sha256(Buffer.from('same-bytes'))));
    assert.equal(library.findByHash('deadbeef'), null);
  });

  it('update 改含义与标签，remove 连文件一起删', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const item = await library.add({ sourceBuffer: Buffer.from('to-update') });

    const updated = await library.update(item.id, { meaning: '摆烂', tags: ['摆烂', '摆烂', '  '], usedCount: 99 });
    assert.equal(updated.meaning, '摆烂');
    assert.deepEqual(updated.tags, ['摆烂']);
    assert.equal(updated.usedCount, 0, 'usedCount 不由 update 改');
    assert.equal(await library.update('nope', { meaning: 'x' }), null);

    assert.equal(await library.remove(item.id), true);
    assert.equal(await library.remove(item.id), false);
    assert.equal(library.get(item.id), null);
    await assert.rejects(fs.readFile(item.path), /ENOENT/);
    assert.deepEqual(JSON.parse(await fs.readFile(options.indexFile, 'utf8')).items, []);
  });

  it('markUsed 记使用次数与时间，stats 汇总', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const a = await library.add({ sourceBuffer: Buffer.from('a'), tags: ['得意'], meaning: '得意' });
    const b = await library.add({ sourceBuffer: Buffer.from('b'), tags: ['得意', '无语'], meaning: '无语' });
    assert.deepEqual(library.stats(), {
      total: 2,
      byTag: { 得意: 2, 无语: 1 },
      learned: 2,
      sent: 0,
      lastUsedAt: null,
      lastLearnedAt: library.get(b.id).addedAt,
    });

    await library.markUsed(a.id, 1700000000000);
    await library.markUsed(a.id, 1700000001000);
    const stats = library.stats();
    assert.equal(stats.sent, 2);
    assert.equal(stats.lastUsedAt, 1700000001000);
    assert.equal(library.get(a.id).usedCount, 2);
  });

  it('list 支持 tag / keyword / limit / offset', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    await library.add({ sourceBuffer: Buffer.from('one'), meaning: '得意的猫', tags: ['得意'] });
    await library.add({ sourceBuffer: Buffer.from('two'), meaning: '无语的狗', tags: ['无语'] });
    await library.add({ sourceBuffer: Buffer.from('three'), meaning: '摆烂的鱼', tags: ['摆烂'] });

    assert.equal(library.list({}).length, 3);
    assert.equal(library.list({ tag: '得意' }).length, 1);
    assert.equal(library.list({ keyword: '狗' })[0].meaning, '无语的狗');
    assert.equal(library.list({ limit: 2 }).length, 2);
    assert.equal(library.list({ limit: 2, offset: 2 }).length, 1);
    assert.equal(library.list({ limit: 2, offset: 0 })[0].id !== library.list({ limit: 2, offset: 2 })[0].id, true);
  });

  it('超过 maxFileBytes 的图拒收（buffer 与本地文件都一样）', async () => {
    const options = makeOptions({ maxFileBytes: 8 });
    const library = createStickerLibrary(options);
    assert.equal(await library.add({ sourceBuffer: Buffer.from('123456789') }), null);

    const big = await writeFile(path.join(options.base, 'data', 'big.png'), '123456789');
    assert.equal(await library.add({ sourceFile: big }), null);
    assert.equal(library.stats().total, 0);
  });

  it('库满（maxItems）时拒收新图，已有的照旧', async () => {
    const options = makeOptions({ maxItems: 1 });
    const library = createStickerLibrary(options);
    assert.ok(await library.add({ sourceBuffer: Buffer.from('first') }));
    assert.equal(await library.add({ sourceBuffer: Buffer.from('second') }), null);
    assert.equal(library.stats().total, 1);
  });

  it('add 没有来源时抛错（参数明显非法）', async () => {
    const library = createStickerLibrary(makeOptions());
    await assert.rejects(() => library.add({ meaning: 'x' }), /add\(\)/);
    assert.throws(() => createStickerLibrary({ dir: null }), /dir/);
  });

  it('http 下载：能下的入库，太大或连不上都不抛', async () => {
    const options = makeOptions({ maxFileBytes: 1024, downloadTimeoutMs: 1500 });
    const library = createStickerLibrary(options);
    const served = Buffer.from('served-sticker-bytes');
    const server = http.createServer((request, response) => {
      if (request.url === '/big.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.alloc(4096, 1));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'image/gif' });
      response.end(served);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const item = await library.add({ sourceUrl: `http://127.0.0.1:${port}/cat.gif`, meaning: '猫' });
      assert.ok(item);
      assert.equal(item.file.endsWith('.gif'), true, '能从 URL 上认出后缀');
      assert.equal(await fs.readFile(item.path, 'utf8'), served.toString('utf8'));

      assert.equal(await library.add({ sourceUrl: `http://127.0.0.1:${port}/big.png` }), null, '超上限的下载要拒收');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 连不上的地址：返回 null，不抛
    const closed = await library.add({ sourceUrl: 'http://127.0.0.1:1/none.png' });
    assert.equal(closed, null);
    // 不是 http(s) 的来源也拒掉
    assert.equal(await library.add({ sourceUrl: 'ftp://example.com/x.png' }), null);
  });

  it('索引里有文件已经不在时，load 会把那条清掉', async () => {
    const options = makeOptions();
    const library = createStickerLibrary(options);
    const item = await library.add({ sourceBuffer: Buffer.from('gone') });
    await fs.unlink(item.path);

    const reloaded = createStickerLibrary(options);
    const loaded = await reloaded.load();
    assert.equal(loaded.items.length, 0);
  });
});
