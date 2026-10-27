import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryService } from '../../src/memory/service.js';
import { cleanupTempDirs, makeConfig, makeLlm, makeLogger, makeTempDir, readMemoryFile } from './_fixtures.js';

// 本文件建的临时目录跑完统一删掉，别在 %TEMP% 里留一地（夹具里统一收集）
after(cleanupTempDirs);

const DAY_MS = 24 * 60 * 60 * 1000;

function makeService(dir, memory = {}) {
  return createMemoryService({ config: makeConfig({ memory }), llm: makeLlm([]), sidecar: null, logger: makeLogger(), dir });
}

test('巩固：遗忘——强度过低且超过 maxAgeDays 的临时记忆被丢掉', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir);
  const now = Date.now();
  const stale = await service.store.insert(20001, {
    userId: 20001,
    kind: 'temporary',
    content: '很久以前随口一提的小事',
    importance: 0.05,
    createdAt: now - 100 * DAY_MS,
  });
  const fresh = await service.store.insert(20001, {
    userId: 20001,
    kind: 'temporary',
    content: '用户喜欢喝冰可乐',
    importance: 0.6,
    createdAt: now,
  });
  const freshButWeak = await service.store.insert(20001, {
    userId: 20001,
    kind: 'temporary',
    content: '用户随口说的一句闲话',
    importance: 0.05,
    createdAt: now,
  });
  await service.store.save(20001);

  const result = await service.consolidate(now);
  assert.equal(result.scanned, 3);
  assert.equal(result.dropped, 1);
  assert.equal(service.store.has(20001, stale.id), false, '又弱又老的被忘掉');
  assert.equal(service.store.has(20001, fresh.id), true);
  assert.equal(service.store.has(20001, freshButWeak.id), true, '只是弱但还新鲜，不算遗忘');
  assert.equal(service.stats().lastConsolidateAt, now);
  assert.equal((await readMemoryFile(dir, 20001)).length, 2);
});

test('巩固：晋升——被反复想起且够重要的临时记忆升为永久', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir);
  const now = Date.now();
  const worthy = await service.store.insert(20002, {
    userId: 20002,
    kind: 'temporary',
    content: '用户说过想念小时候的院子',
    importance: 0.8,
    accessCount: 5,
    createdAt: now - 3 * DAY_MS,
  });
  const fewAccess = await service.store.insert(20002, {
    userId: 20002,
    kind: 'temporary',
    content: '用户喜欢喝冰可乐',
    importance: 0.8,
    accessCount: 2,
    createdAt: now,
  });
  const unimportant = await service.store.insert(20002, {
    userId: 20002,
    kind: 'temporary',
    content: '用户今天晒了被子',
    importance: 0.5,
    accessCount: 9,
    createdAt: now,
  });
  await service.store.save(20002);

  const result = await service.consolidate(now);
  assert.equal(result.promoted, 1);
  assert.equal(service.store.get(20002, worthy.id).kind, 'permanent');
  assert.equal(service.store.get(20002, fewAccess.id).kind, 'temporary', '想起来的次数不够');
  assert.equal(service.store.get(20002, unimportant.id).kind, 'temporary', '重要性不够');
  assert.deepEqual(service.stats(), { temporary: 2, permanent: 1, users: 1, lastConsolidateAt: now });
  const rows = await readMemoryFile(dir, 20002);
  assert.equal(rows.find((row) => row.id === worthy.id).kind, 'permanent', '晋升也要落盘');
});

test('巩固：合并——近似条目并成一条，取更长的内容与更高的重要性', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir);
  const now = Date.now();
  const short = await service.store.insert(20003, {
    userId: 20003,
    kind: 'temporary',
    content: '用户喜欢喝冰可乐',
    importance: 0.4,
    createdAt: now - DAY_MS,
  });
  const long = await service.store.insert(20003, {
    userId: 20003,
    kind: 'temporary',
    content: '用户喜欢喝冰可乐哦',
    importance: 0.7,
    createdAt: now,
  });
  const unrelated = await service.store.insert(20003, {
    userId: 20003,
    kind: 'temporary',
    content: '用户养了一只叫团子的猫',
    importance: 0.6,
    createdAt: now,
  });
  await service.store.save(20003);

  const result = await service.consolidate(now);
  assert.equal(result.merged, 1);
  assert.equal(service.store.has(20003, short.id), false, '旧的被并掉');
  assert.equal(service.store.has(20003, long.id), true);
  assert.equal(service.store.has(20003, unrelated.id), true);
  assert.equal(service.store.get(20003, long.id).content, '用户喜欢喝冰可乐哦', '合并留更长的内容');
  assert.equal(service.store.get(20003, long.id).importance, 0.7, '合并取更高的重要性');
  assert.equal(service.list(20003).length, 2);
  assert.equal((await readMemoryFile(dir, 20003)).length, 2);
});

test('巩固：合并时永久记忆的身份优先，且不会吞掉无关的记忆', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { consolidate: { mergeSimilarity: 0.85 } });
  const now = Date.now();
  const permanent = await service.store.insert(20004, {
    userId: 20004,
    kind: 'permanent',
    content: '用户的生日是五月一日',
    importance: 0.9,
    createdAt: now - 40 * DAY_MS,
  });
  const temporary = await service.store.insert(20004, {
    userId: 20004,
    kind: 'temporary',
    content: '用户的生日是五月一号',
    importance: 0.5,
    createdAt: now,
  });
  await service.store.save(20004);

  const result = await service.consolidate(now);
  assert.equal(result.merged, 1);
  assert.equal(service.store.has(20004, permanent.id), true, '永久记忆留下');
  assert.equal(service.store.get(20004, permanent.id).kind, 'permanent');
  assert.equal(service.store.get(20004, permanent.id).importance, 0.9);
  assert.equal(service.store.get(20004, permanent.id).content, '用户的生日是五月一日', '同长度时保留留下的那条');
  assert.equal(service.store.has(20004, temporary.id), false);
  assert.equal(service.list(20004).length, 1);
});

test('巩固：临时记忆超出容量时按强度淘汰最弱的', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { temporary: { capacity: 3 } });
  const now = Date.now();
  const contents = ['用户提到过楼下那家面馆', '用户提过想学吉他', '用户提过喜欢下雨天', '用户提过讨厌加班', '用户提过想养只猫'];
  const importances = [0.2, 0.3, 0.4, 0.5, 0.6];
  for (let i = 0; i < contents.length; i += 1) {
    await service.store.insert(20005, {
      userId: 20005,
      kind: 'temporary',
      content: contents[i],
      importance: importances[i],
      createdAt: now,
    });
  }
  await service.store.save(20005);

  const result = await service.consolidate(now);
  assert.equal(result.dropped, 2);
  const left = service.list(20005).map((record) => record.importance).sort((a, b) => a - b);
  assert.deepEqual(left, [0.4, 0.5, 0.6]);
  assert.equal((await readMemoryFile(dir, 20005)).length, 3);
});

test('巩固：永久记忆超容量时淘汰重要性最低的，平时一个也不忘', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { permanent: { capacity: 1 } });
  const now = Date.now();
  const top = await service.store.insert(20006, {
    userId: 20006,
    kind: 'permanent',
    content: '用户的生日是五月一日',
    importance: 0.9,
    createdAt: now - 900 * DAY_MS,
  });
  const weak = await service.store.insert(20006, {
    userId: 20006,
    kind: 'permanent',
    content: '用户提过他喜欢蓝色',
    importance: 0.4,
    createdAt: now - 900 * DAY_MS,
  });
  await service.store.save(20006);

  const first = await service.consolidate(now);
  assert.equal(first.dropped, 1);
  assert.equal(service.store.has(20006, top.id), true, '又老又重要的永久记忆不会被遗忘');
  assert.equal(service.store.has(20006, weak.id), false);

  const second = await service.consolidate(now);
  assert.deepEqual(second, { dropped: 0, promoted: 0, merged: 0, scanned: 0 }, '没有临时记忆时什么都不用扫');
  assert.equal(service.store.has(20006, top.id), true);
});

test('巩固：一批只处理 consolidate.batch 条，永久记忆不参与遗忘', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { consolidate: { batch: 2, mergeSimilarity: 0.99 } });
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) {
    await service.store.insert(20007, {
      userId: 20007,
      kind: 'temporary',
      content: `很久以前的小事第${i}回`,
      importance: 0.02,
      createdAt: now - 200 * DAY_MS,
    });
  }
  await service.store.save(20007);

  const result = await service.consolidate(now);
  assert.equal(result.scanned, 2, '一次只看一批');
  assert.equal(result.dropped, 2);
  assert.equal(service.list(20007).length, 2);
});

test('巩固：空库上跑一遍是安全的空操作', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir);
  const now = Date.now();
  assert.deepEqual(await service.consolidate(now), { dropped: 0, promoted: 0, merged: 0, scanned: 0 });
  assert.equal(service.stats().lastConsolidateAt, now);
});

test('巩固：底层存储出错也不抛错，只返回安全值', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir);
  const original = service.store.all;
  service.store.all = async () => {
    throw new Error('磁盘炸了');
  };
  assert.deepEqual(await service.consolidate(Date.now()), { dropped: 0, promoted: 0, merged: 0, scanned: 0 });
  service.store.all = original;
  assert.deepEqual(await service.consolidate(Date.now()), { dropped: 0, promoted: 0, merged: 0, scanned: 0 });
});
