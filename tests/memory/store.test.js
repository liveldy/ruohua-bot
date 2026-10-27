import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createMemoryStore } from '../../src/memory/store.js';
import { cleanupTempDirs, makeConfig, makeLogger, makeTempDir, readMemoryFile } from './_fixtures.js';

// 本文件建的临时目录跑完统一删掉，别在 %TEMP% 里留一地（夹具里统一收集）
after(cleanupTempDirs);

test('存储：插入 → 落盘 → 重新构造 store 后记录仍在', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });

  const record = await store.insert(1001, { scene: 'private', content: '用户喜欢喝冰可乐', importance: 0.6, tags: ['喜好'] });
  assert.ok(record.id.startsWith('mem'), '自动补全 id');
  assert.equal(record.kind, 'temporary');
  assert.equal(record.accessCount, 0);
  assert.equal(record.lastAccessAt, null);
  assert.equal(record.vector, null);
  assert.ok(record.createdAt > 0 && record.updatedAt >= record.createdAt);

  assert.equal(await store.save(1001), 1);
  const rows = await readMemoryFile(dir, 1001);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '用户喜欢喝冰可乐');
  assert.equal(rows[0].userId, 1001);
  assert.deepEqual(rows[0].tags, ['喜好']);

  const again = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await again.load(1001);
  assert.equal(again.list(1001).length, 1);
  assert.equal(again.get(1001, record.id).content, '用户喜欢喝冰可乐');
  assert.equal(again.has(1001, record.id), true);
  assert.equal(again.has(1001, 'mem_nope'), false);
});

test('存储：同步预装载让 list/stats 一构造就能用', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await store.insert(2002, { content: '用户养了一只叫团子的猫', importance: 0.5 });
  await store.insert(2002, { content: '用户下周要出差', importance: 0.4, kind: 'permanent' });
  await store.save(2002);

  const fresh = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  assert.equal(fresh.loadAllSync(), 1);
  assert.equal(fresh.list(2002).length, 2);
  assert.deepEqual(fresh.stats(), { temporary: 1, permanent: 1, users: 1 });
});

test('存储：按用户分文件，互不干扰', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await store.insert(3001, { content: '甲的记忆' });
  await store.insert(3002, { content: '乙的记忆' });
  await store.save(3001);
  await store.save(3002);

  assert.equal(store.list(3001).length, 1);
  assert.equal(store.list(3002).length, 1);
  assert.equal(store.list(3001)[0].content, '甲的记忆');
  assert.equal((await readMemoryFile(dir, 3001)).length, 1);
  assert.equal((await readMemoryFile(dir, 3002)).length, 1);
  const all = await store.all();
  assert.equal(all.length, 2);
  assert.deepEqual(store.stats(), { temporary: 2, permanent: 0, users: 2 });
});

test('存储：update 打补丁并刷新 updatedAt，remove 删除，未知 id 返回安全值', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  const record = await store.insert(4001, { content: '用户怕黑', importance: 0.4 });

  const patched = await store.update(4001, record.id, { accessCount: 3, lastAccessAt: 12345, importance: 0.9 });
  assert.equal(patched.accessCount, 3);
  assert.equal(patched.lastAccessAt, 12345);
  assert.equal(patched.importance, 0.9);
  assert.ok(patched.updatedAt >= record.updatedAt);

  assert.equal(await store.update(4001, 'mem_missing', { importance: 1 }), null);
  assert.equal(await store.get(4001, 'mem_missing'), null);
  assert.equal(await store.remove(4001, 'mem_missing'), false);
  assert.equal(await store.remove(4001, record.id), true);
  assert.equal(store.list(4001).length, 0);
});

test('存储：返回的是副本，外部改动不影响库内数据', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  const record = await store.insert(5001, { content: '用户不爱吃香菜', tags: ['喜好'] });
  record.tags.push('被污染');
  record.content = '被改写';
  const inside = store.get(5001, record.id);
  assert.deepEqual(inside.tags, ['喜好']);
  assert.equal(inside.content, '用户不爱吃香菜');
});

test('存储：同一用户并发插入 + 并发保存不丢记录、文件不写坏', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await Promise.all(
    Array.from({ length: 30 }, (_, index) => store.insert(6001, { content: `第${index}条记忆`, importance: 0.3 + index / 100 })),
  );
  await Promise.all([store.save(6001), store.save(6001), store.save(6001)]);

  const rows = await readMemoryFile(dir, 6001);
  assert.equal(rows.length, 30);
  const reload = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  assert.equal((await reload.load(6001)).length, 30);
});

test('存储：删除后重新读盘不会让记录复活', async () => {
  const dir = await makeTempDir();
  const first = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  const record = await first.insert(7001, { content: '用户讨厌被叫小朋友' });
  await first.save(7001);

  const second = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await second.load(7001);
  assert.equal(second.list(7001).length, 1);
  await second.remove(7001, record.id);
  await second.save(7001);
  await second.load(7001);
  assert.equal(second.list(7001).length, 0);
  assert.equal((await readMemoryFile(dir, 7001)).length, 0);
});

test('存储：坏文件 / 缺失目录都不抛错', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, '8001.jsonl'), '不是 JSON\n{"id":"mem_ok","content":"好的"}\n', 'utf8');
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });

  const loaded = await store.load(8001);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].content, '好的');
  assert.equal(store.stats().users, 1);

  const missingDir = path.join(dir, '没有这个目录');
  const other = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir: missingDir });
  assert.deepEqual(await other.load(9001), []);
  assert.equal(other.loadAllSync(), 0);
  assert.deepEqual(await other.all(), []);
  assert.deepEqual(other.stats(), { temporary: 0, permanent: 0, users: 0 });
});
