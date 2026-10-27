import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryService } from '../../src/memory/service.js';
import { cleanupTempDirs, makeConfig, makeLlm, makeLogger, makeSidecar, makeTempDir, readMemoryFile } from './_fixtures.js';

// 本文件建的临时目录跑完统一删掉，别在 %TEMP% 里留一地（夹具里统一收集）
after(cleanupTempDirs);

const CONVERSATION = [
  { role: 'user', content: '我特别喜欢喝冰可乐，一天两瓶' },
  { role: 'assistant', content: '那你的胃还好吗' },
];

function makeService(dir, { llm = makeLlm([]), sidecar = null, memory = {}, logger = makeLogger() } = {}) {
  return createMemoryService({ config: makeConfig({ memory }), llm, sidecar, logger, dir });
}

test('ingest：一次 LLM 调用提炼 → 入库 → 落盘 → 重建 service 后仍在', async () => {
  const dir = await makeTempDir();
  const llm = makeLlm([{ content: '用户特别喜欢喝冰可乐', importance: 0.6, tags: ['喜好'] }]);
  const service = makeService(dir, { llm });

  const created = await service.ingest({ userId: 10001, scene: 'private', messages: CONVERSATION });
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'temporary');
  assert.equal(created[0].importance, 0.6);
  assert.deepEqual(created[0].tags, ['喜好']);
  assert.equal(created[0].vector, null);

  assert.equal(llm.calls.length, 1, '只调用一次模型');
  assert.equal(llm.calls[0].role, 'memory');
  assert.equal(llm.calls[0].json, true);
  assert.match(llm.calls[0].messages[0].content, /记忆/);
  assert.match(llm.calls[0].messages[1].content, /冰可乐/);

  const rows = await readMemoryFile(dir, 10001);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '用户特别喜欢喝冰可乐');
  assert.equal(rows[0].userId, 10001);
  assert.deepEqual(rows[0].tags, ['喜好']);

  const again = makeService(dir);
  await again.ready();
  assert.equal(again.list(10001).length, 1, '重建后同步 list 就能看到');

  const hits = await again.recall({ userId: 10001, scene: 'private', query: '可乐' });
  assert.equal(hits.length, 1);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['content', 'createdAt', 'id', 'importance', 'kind', 'score']);
  assert.equal(hits[0].kind, 'temporary');
  assert.ok(hits[0].score > 0);
  assert.ok(hits[0].createdAt > 0);
});

test('解析不了时把模型的原样返回记一笔 debug，事后能查（warn 只有一句，不放大）', async () => {
  const dir = await makeTempDir();
  const records = { debug: [], warn: [] };
  const logger = {
    records,
    debug: (message) => records.debug.push(String(message)),
    warn: (message) => records.warn.push(String(message)),
    info: () => {},
    error: () => {},
    operation: () => {},
    conversation: () => {},
    file: () => null,
    child: () => logger,
  };
  const service = createMemoryService({
    config: makeConfig(),
    llm: { chat: async () => ({ content: '我想了想，没什么好记的', json: null }) },
    sidecar: null,
    logger,
    dir,
  });

  const created = await service.ingest({ userId: 10010, scene: 'private', messages: CONVERSATION });
  assert.equal(created[0].kind, 'temporary', '照旧退化成一条临时记忆');
  assert.equal(records.warn.filter((line) => /无法解析/.test(line)).length, 1);
  const raw = records.debug.find((line) => /原样返回/.test(line));
  assert.ok(raw, 'debug 里要留下模型返回的原文，不然事后没法判断是模型跑偏还是解析器的锅');
  assert.match(raw, /我想了想，没什么好记的/);

  // 长返回要截断，别让日志被一整篇废话灌满
  const long = createMemoryService({
    config: makeConfig(),
    llm: { chat: async () => ({ content: '啰'.repeat(5000), json: null }) },
    sidecar: null,
    logger,
    dir,
  });
  await long.ingest({ userId: 10011, scene: 'private', messages: CONVERSATION });
  const last = records.debug.filter((line) => /原样返回/.test(line)).at(-1);
  assert.ok(last.length < 800, `debug 那行要截断，实际 ${last.length} 字`);
});

test('kind 判定：关键词只是「理由」，还得 importance 够格才算永久', async () => {
  const dir = await makeTempDir();
  const items = [
    { content: '用户的生日是五月一日', importance: 0.4 }, // 命中关键词（生日）但太轻 → 临时
    { content: '用户把梦想都压在写作上', importance: 0.9 }, // 重要到位，不需要关键词 → 永久
    { content: '用户今天中午吃了面', importance: 0.45 }, // 什么都没沾 → 临时
    { content: '用户约定周末陪她去看电影', importance: 0.6 }, // 关键词（约定）+ 够格 → 永久
    { content: '用户随口说起的约定', importance: 0.5 }, // 关键词 + 正好踩线下限 → 永久
  ];
  const service = makeService(dir, { llm: makeLlm(items), memory: { extract: { maxItemsPerTurn: 5 } } });

  const created = await service.ingest({ userId: 10002, scene: 'private', messages: [{ role: 'user', content: '聊了会儿天' }] });
  assert.deepEqual(
    created.map((record) => record.kind),
    ['temporary', 'permanent', 'temporary', 'permanent', 'permanent'],
  );
  assert.equal(service.list(10002, { kind: 'permanent' }).length, 3);
  assert.deepEqual(service.stats(), { temporary: 2, permanent: 3, users: 1, lastConsolidateAt: null });
});

test('提炼方显式要 permanent 也要过 importance 下限；forceKind 一律照办', async () => {
  const dir = await makeTempDir();
  const items = [
    { content: '用户说过一段很轻的往事', importance: 0.4, kind: 'permanent' }, // 显式要求但太轻 → 临时
    { content: '用户说这段往事他记了很多年', importance: 0.55, kind: 'permanent' }, // 显式要求 + 够格 → 永久
    { content: '用户今天心情不错', importance: 0.9, kind: 'temporary' }, // 明说临时 → 临时
    { content: '这条钉死临时', importance: 0.95, forceKind: 'temporary' }, // forceKind 优先
  ];
  const service = makeService(dir, { llm: makeLlm(items), memory: { extract: { maxItemsPerTurn: 4 } } });

  const created = await service.ingest({ userId: 10003, scene: 'private', messages: [{ role: 'user', content: '说了点旧事' }] });
  assert.deepEqual(
    created.map((record) => record.kind),
    ['temporary', 'permanent', 'temporary', 'temporary'],
  );
});

test('hint.importance 是下界：情感判定认为重要时不许记成低重要性', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { llm: makeLlm([{ content: '用户说了一句很重的话', importance: 0.2 }]) });

  const low = await service.ingest({
    userId: 10003,
    scene: 'private',
    messages: [{ role: 'user', content: '我想说点正经的' }],
    hint: { importance: 0.6 },
  });
  assert.equal(low[0].importance, 0.6);
  assert.equal(low[0].kind, 'temporary');

  const high = await service.ingest({
    userId: 10003,
    scene: 'private',
    messages: [{ role: 'user', content: '这件事我一辈子都忘不了' }],
    hint: { importance: 0.95 },
  });
  assert.equal(high[0].importance, 0.95);
  assert.equal(high[0].kind, 'permanent');
});

test('提炼：太短的内容不入库，超出上限的条目被截断，空结果不抛错', async () => {
  const dir = await makeTempDir();
  const items = [
    { content: '嗯', importance: 0.5 },
    { content: '用户讨厌香菜', importance: 0.5 },
    { content: '用户不爱吃甜食', importance: 0.5 },
    { content: '用户怕黑', importance: 0.5 },
  ];
  const service = makeService(dir, { llm: makeLlm(items), memory: { extract: { maxItemsPerTurn: 2 } } });
  const created = await service.ingest({ userId: 10004, scene: 'private', messages: [{ role: 'user', content: '随便聊了聊吃' }] });
  assert.equal(created.length, 2, '太短的被丢掉，多的被截断');
  assert.deepEqual(
    created.map((record) => record.content),
    ['用户讨厌香菜', '用户不爱吃甜食'],
  );

  const empty = makeService(dir, { llm: makeLlm([]) });
  assert.deepEqual(await empty.ingest({ userId: 10005, scene: 'private', messages: [{ role: 'user', content: '在吗' }] }), []);
  assert.deepEqual(empty.list(10005), []);
  assert.deepEqual(await empty.ingest({ userId: 10005, scene: 'private', messages: [] }), []);
});

test('退化：LLM 抛错或返回非法 JSON 时，把用户这句话记成一条临时记忆', async () => {
  const dir = await makeTempDir();
  const broken = makeService(dir, { llm: makeLlm(new Error('模型接口 500')) });
  const created = await broken.ingest({ userId: 10006, scene: 'private', messages: CONVERSATION });
  assert.equal(created.length, 1);
  assert.equal(created[0].content, '我特别喜欢喝冰可乐，一天两瓶');
  assert.equal(created[0].importance, 0.25);
  assert.equal(created[0].kind, 'temporary');
  assert.equal((await readMemoryFile(dir, 10006)).length, 1);

  const illegalJson = createMemoryService({
    config: makeConfig(),
    llm: { chat: async () => ({ content: '我想了想，没什么好记的', json: null }) },
    sidecar: null,
    logger: makeLogger(),
    dir,
  });
  const degraded = await illegalJson.ingest({ userId: 10007, scene: 'private', messages: CONVERSATION });
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].importance, 0.25);
  assert.equal(degraded[0].kind, 'temporary');

  // 正文里塞着合法 JSON 时仍然能解析，不算退化
  const salvage = createMemoryService({
    config: makeConfig(),
    llm: { chat: async () => ({ content: '好的：[{"content":"用户喜欢冰可乐","importance":0.6}]', json: null }) },
    sidecar: null,
    logger: makeLogger(),
    dir,
  });
  const salvaged = await salvage.ingest({ userId: 10008, scene: 'private', messages: CONVERSATION });
  assert.equal(salvaged[0].content, '用户喜欢冰可乐');
  assert.equal(salvaged[0].importance, 0.6);

  // 用户这句话太短时不入库，也不抛错
  const shortLine = createMemoryService({
    config: makeConfig(),
    llm: { chat: async () => ({ content: '嗯', json: null }) },
    sidecar: null,
    logger: makeLogger(),
    dir,
  });
  assert.deepEqual(await shortLine.ingest({ userId: 10009, scene: 'private', messages: [{ role: 'user', content: '嗯' }] }), []);
});

test('侧车可用时给记忆补向量，侧车失败不影响入库', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { llm: makeLlm([{ content: '用户喜欢喝冰可乐', importance: 0.6 }]), sidecar: makeSidecar() });
  const created = await service.ingest({ userId: 11001, scene: 'private', messages: CONVERSATION });
  assert.ok(Array.isArray(created[0].vector));
  assert.equal(created[0].vector.length, 64);
  const rows = await readMemoryFile(dir, 11001);
  assert.ok(Array.isArray(rows[0].vector), '向量随记录一起落盘');
  assert.equal(rows[0].vector.length, 64);

  const brokenDir = await makeTempDir();
  const broken = createMemoryService({
    config: makeConfig(),
    llm: makeLlm([{ content: '用户一个人走夜路会怕黑', importance: 0.5 }]),
    sidecar: { embed: async () => { throw new Error('侧车挂了'); } },
    logger: makeLogger(),
    dir: brokenDir,
  });
  const fallback = await broken.ingest({ userId: 11002, scene: 'private', messages: [{ role: 'user', content: '我有点怕黑' }] });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].vector, null);
  assert.equal((await readMemoryFile(brokenDir, 11002)).length, 1);
});

test('remember / list / forget / stats / personaFacts', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir);

  const kept = await service.remember({ userId: 12001, scene: 'private', content: '用户的生日是三月三号', importance: 0.9, tags: ['生日'] });
  assert.equal(kept.kind, 'permanent');
  const loose = await service.remember({ userId: 12001, scene: 'private', content: '用户今天喝了冰可乐', importance: 0.4 });
  assert.equal(loose.kind, 'temporary');

  assert.equal(service.list(12001).length, 2);
  assert.equal(service.list(12001, { kind: 'temporary' }).length, 1);
  assert.deepEqual(service.list(12001, { kind: 'permanent' }).map((record) => record.content), ['用户的生日是三月三号']);
  assert.deepEqual(service.personaFacts(12001), ['用户的生日是三月三号']);
  assert.deepEqual(service.stats(), { temporary: 1, permanent: 1, users: 1, lastConsolidateAt: null });

  const byQuery = await service.forget({ userId: 12001, query: '可乐' });
  assert.equal(byQuery.removed, 1);
  assert.equal(service.list(12001).length, 1);

  const byId = await service.forget({ id: kept.id, userId: 12001 });
  assert.equal(byId.removed, 1);
  assert.equal(service.list(12001).length, 0);
  assert.equal((await readMemoryFile(dir, 12001)).length, 0);

  assert.deepEqual(await service.forget({}), { removed: 0, ids: [] });
  assert.equal(await service.remember({ userId: 12001, content: '   ' }), null);
});

test('personaFacts：按重要性排序、截断到 summaryMaxChars、最多 20 条', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { memory: { consolidate: { summaryMaxChars: 40 } } });
  const long = '用户说过一句特别重要的话，要一直记得，永远都别忘';
  for (let i = 0; i < 22; i += 1) {
    await service.remember({
      userId: 13001,
      content: i === 0 ? long : `用户的第${i}件重要的事`,
      importance: 0.99 - i * 0.01,
    });
  }
  const facts = service.personaFacts(13001);
  assert.equal(facts.length, 20);
  assert.ok(facts[0].startsWith('用户说过一句特别重要的话'));
  assert.ok(facts[0].length <= 40);
  assert.deepEqual(service.personaFacts(99999), []);
});

test('召回只返回同一 userId 的记忆，其他人的隐私不外泄', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { llm: makeLlm([{ content: '用户答应了周末一起看电影', importance: 0.6 }]) });
  await service.ingest({ userId: 14001, scene: 'private', messages: [{ role: 'user', content: '周末一起看电影吧' }] });
  await service.ingest({ userId: 14002, scene: 'private', messages: [{ role: 'user', content: '周末一起看电影吧' }] });

  const hits = await service.recall({ userId: 14001, scene: 'group', query: '电影' });
  assert.equal(hits.length, 1);
  assert.equal(service.list(14002).length, 1);
  assert.equal((await readMemoryFile(dir, 14001)).length, 1);
  assert.equal((await readMemoryFile(dir, 14002)).length, 1);
});

test('模型与侧车都缺席时，对外方法仍然给出安全值', async () => {
  const dir = await makeTempDir();
  const service = createMemoryService({ config: makeConfig(), llm: null, sidecar: null, logger: null, dir });

  // 没有模型 → 退化路径：用户这句话直接记成临时记忆
  const created = await service.ingest({ userId: 15001, scene: 'private', messages: [{ role: 'user', content: '我喜欢下雨天' }] });
  assert.equal(created.length, 1);
  assert.equal(created[0].importance, 0.25);

  const hits = await service.recall({ userId: 15001, scene: 'private', query: '下雨' });
  assert.equal(hits.length, 1);
  assert.deepEqual(await service.recall({ userId: null, query: '下雨' }), []);
  assert.deepEqual(await service.consolidate(), { dropped: 0, promoted: 0, merged: 0, scanned: 1 });
  assert.equal(service.stats().users, 1);
  assert.deepEqual(service.personaFacts(15001), []);
  assert.deepEqual(service.list(15001).length, 1);
});

test('记忆功能关闭时所有入口都安全返回', async () => {
  const dir = await makeTempDir();
  const service = makeService(dir, { llm: makeLlm([{ content: '用户喜欢喝冰可乐', importance: 0.6 }]), memory: { enabled: false } });
  assert.deepEqual(await service.ingest({ userId: 16001, scene: 'private', messages: CONVERSATION }), []);
  assert.deepEqual(await service.recall({ userId: 16001, query: '可乐' }), []);
  assert.equal(await service.remember({ userId: 16001, content: '用户喜欢喝冰可乐' }), null);
  assert.deepEqual(await service.forget({ id: 'mem_x' }), { removed: 0, ids: [] });
  assert.deepEqual(service.list(16001), []);
  assert.deepEqual(await service.consolidate(), { dropped: 0, promoted: 0, merged: 0, scanned: 0 });
});
