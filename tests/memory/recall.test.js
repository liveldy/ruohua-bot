import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEIGHTS,
  embedSimilarity,
  keywordSimilarity,
  memoryStrength,
  recall,
  recencyFactor,
  scoreRecord,
} from '../../src/memory/recall.js';
import { createMemoryStore } from '../../src/memory/store.js';
import { cleanupTempDirs, makeConfig, makeLogger, makeSidecar, makeTempDir } from './_fixtures.js';

// 本文件建的临时目录跑完统一删掉，别在 %TEMP% 里留一地（夹具里统一收集）
after(cleanupTempDirs);

const DAY_MS = 24 * 60 * 60 * 1000;

test('关键词相似度：完全一致最高，包含次之，无关接近 0', () => {
  assert.equal(keywordSimilarity('用户喜欢喝冰可乐', '用户喜欢喝冰可乐'), 1);
  assert.equal(keywordSimilarity('用户喜欢喝冰可乐！', '用户喜欢喝冰可乐'), 1);
  const contained = keywordSimilarity('可乐', '用户喜欢喝冰可乐');
  const unrelated = keywordSimilarity('用户喜欢喝冰可乐', '用户养了一只叫团子的猫');
  assert.ok(contained > unrelated);
  assert.ok(contained > 0.5);
  assert.ok(unrelated < 0.2);
  assert.equal(keywordSimilarity('', '随便什么'), 0);
});

test('衰减：越老的临时记忆分数越低；永久记忆不随时间变淡', () => {
  const now = Date.now();
  const base = { id: 'mem_a', kind: 'temporary', content: '用户喜欢喝冰可乐', importance: 0.6, accessCount: 0 };
  const fresh = { ...base, createdAt: now };
  const stale = { ...base, createdAt: now - 30 * DAY_MS };
  const ancient = { ...base, createdAt: now - 400 * DAY_MS };

  const freshScore = scoreRecord(fresh, { query: '可乐', now, weights: DEFAULT_WEIGHTS });
  const staleScore = scoreRecord(stale, { query: '可乐', now, weights: DEFAULT_WEIGHTS });
  const ancientScore = scoreRecord(ancient, { query: '可乐', now, weights: DEFAULT_WEIGHTS });
  assert.ok(freshScore > staleScore, '新鲜的高于放旧的');
  assert.ok(staleScore > ancientScore, '放旧的高于极老的');
  assert.ok(recencyFactor(ancient, { now, halfLifeHours: 72 }) < 0.01);

  const permanentOld = { ...ancient, kind: 'permanent' };
  const permanentFresh = { ...fresh, kind: 'permanent' };
  assert.equal(
    scoreRecord(permanentOld, { query: '可乐', now, weights: DEFAULT_WEIGHTS }),
    scoreRecord(permanentFresh, { query: '可乐', now, weights: DEFAULT_WEIGHTS }),
    '永久记忆的 recency 权重为 0，多老都一样',
  );
  // 永久记忆的分数只剩相关性与重要性两项
  const relevance = keywordSimilarity('可乐', '用户喜欢喝冰可乐');
  assert.ok(
    Math.abs(scoreRecord(permanentOld, { query: '可乐', now, weights: DEFAULT_WEIGHTS }) - (0.5 * relevance + 0.2 * 0.6)) < 1e-9,
  );
  assert.ok(scoreRecord(permanentOld, { query: '可乐', now, weights: DEFAULT_WEIGHTS }) >= ancientScore);
});

test('衰减：被想起过的记忆衰减更慢', () => {
  const now = Date.now();
  const createdAt = now - 7 * DAY_MS;
  const freshRecord = { createdAt, kind: 'temporary', importance: 0.5, accessCount: 0 };
  const usedRecord = { ...freshRecord, accessCount: 10 };
  assert.ok(recencyFactor(usedRecord, { now, halfLifeHours: 72 }) > recencyFactor(freshRecord, { now, halfLifeHours: 72 }));
  assert.ok(memoryStrength(usedRecord, { now, halfLifeHours: 72 }) > memoryStrength(freshRecord, { now, halfLifeHours: 72 }));
});

test('打分：相似度函数优先，出错或返回非数字时退回关键词', () => {
  const now = Date.now();
  const record = { id: 'mem_b', kind: 'temporary', content: '用户养了一只叫团子的猫', importance: 0.5, createdAt: now };
  const withVector = scoreRecord(record, { query: '团子', now, similarity: () => 0.9 });
  const withKeywords = scoreRecord(record, { query: '团子', now });
  assert.ok(withVector > withKeywords);
  assert.equal(scoreRecord(record, { query: '团子', now, similarity: () => { throw new Error('坏函数'); } }), withKeywords);
  assert.equal(scoreRecord(record, { query: '团子', now, similarity: () => null }), withKeywords);
});

test('召回：相关的排前面、topK 生效、命中后 accessCount 增加', async () => {
  const dir = await makeTempDir();
  const config = makeConfig();
  const store = createMemoryStore({ config, logger: makeLogger(), dir });
  await store.insert(3003, { scene: 'private', content: '用户喜欢喝冰可乐', importance: 0.6 });
  await store.insert(3003, { scene: 'private', content: '用户养了一只叫团子的猫', importance: 0.6 });
  await store.insert(3003, { scene: 'private', content: '用户下周要出差', importance: 0.4 });
  await store.save(3003);

  const hits = await recall(store, { userId: 3003, scene: 'private', query: '可乐', topK: 2 });
  assert.equal(hits.length, 2, 'topK 生效');
  assert.match(hits[0].content, /可乐/);
  assert.ok(hits[0].score >= hits[1].score);
  assert.equal(hits[0].kind, 'temporary');

  const touched = store.get(3003, hits[0].id);
  assert.equal(touched.accessCount, 1);
  assert.ok(touched.lastAccessAt > 0);
  const untouched = store.list(3003).find((record) => record.content.includes('出差'));
  assert.equal(untouched.accessCount, 0, '没被召回的不加访问次数');

  const narrow = await recall(store, { userId: 3003, query: '可乐', topK: 1 });
  assert.equal(narrow.length, 1);
  assert.equal(store.get(3003, narrow[0].id).accessCount, 2);

  assert.deepEqual(await recall(store, { userId: 3003, query: '可乐', topK: 0 }), []);
  assert.deepEqual(await recall(store, { userId: 9999, query: '可乐' }), []);
});

test('召回：minScore 以下的记忆不返回', async () => {
  const dir = await makeTempDir();
  const config = makeConfig({ memory: { recall: { minScore: 0.15 } } });
  const store = createMemoryStore({ config, logger: makeLogger(), dir });
  const now = Date.now();
  await store.insert(4004, { content: '很久以前的一句无关紧要的话', importance: 0.02, createdAt: now - 900 * DAY_MS });
  await store.insert(4004, { content: '用户喜欢喝冰可乐', importance: 0.6, createdAt: now });
  await store.save(4004);

  const hits = await recall(store, { userId: 4004, query: '可乐', now });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /可乐/);
});

test('召回：只在该用户自己的记忆里找，不串别人的隐私', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await store.insert(5005, { scene: 'group', content: '甲的私事：搬家', importance: 0.9 });
  await store.insert(6006, { scene: 'group', content: '乙的私事：换工作', importance: 0.9 });
  await store.save(5005);
  await store.save(6006);

  const hits = await recall(store, { userId: 5005, scene: 'private', query: '私事', topK: 12 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, '甲的私事：搬家');
});

test('召回：可注入向量相似度，相关的那条排最前', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await store.insert(7007, { content: '用户把钥匙放在鞋柜上' });
  await store.insert(7007, { content: '用户想去海边看一次日出' });
  await store.save(7007);

  const similarity = (a, b) => (String(b).includes('海边') ? 0.95 : 0.05);
  const hits = await recall(store, { userId: 7007, query: '想去哪儿', topK: 2, similarity });
  assert.equal(hits.length, 2);
  assert.match(hits[0].content, /海边/);
});

test('embedSimilarity：侧车不可用返回 null，可用时按余弦给分', async () => {
  assert.equal(await embedSimilarity(null, ['可乐']), null);
  assert.equal(await embedSimilarity({}, ['可乐']), null);
  assert.equal(await embedSimilarity(makeSidecar({ fail: true }), ['可乐']), null);
  assert.equal(await embedSimilarity({ embed: async () => { throw new Error('侧车挂了'); } }, ['可乐']), null);
  assert.equal(await embedSimilarity(makeSidecar(), []), null);

  const sidecar = makeSidecar();
  const texts = ['可乐', '用户喜欢喝冰可乐', '用户养了一只叫团子的猫'];
  const similarity = await embedSimilarity(sidecar, texts);
  assert.equal(typeof similarity, 'function');
  const near = similarity('可乐', '用户喜欢喝冰可乐');
  const far = similarity('可乐', '用户养了一只叫团子的猫');
  assert.ok(near > far, '字符重合多的余弦更高');
  assert.ok(near >= 0 && near <= 1);
  // 没预置过向量的文本退回关键词比对，不抛错
  const unknown = similarity('可乐', '今天天气不错');
  assert.equal(typeof unknown, 'number');
});

test('召回：注入向量相似度后仍能正常排序与更新访问次数', async () => {
  const dir = await makeTempDir();
  const store = createMemoryStore({ config: makeConfig(), logger: makeLogger(), dir });
  await store.insert(8008, { content: '用户喜欢喝冰可乐', importance: 0.6 });
  await store.insert(8008, { content: '用户养了一只叫团子的猫', importance: 0.6 });
  await store.save(8008);

  const similarity = await embedSimilarity(makeSidecar(), ['可乐', '用户喜欢喝冰可乐', '用户养了一只叫团子的猫']);
  const hits = await recall(store, { userId: 8008, query: '可乐', topK: 1, similarity });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /可乐/);
  assert.equal(store.get(8008, hits[0].id).accessCount, 1);
});
