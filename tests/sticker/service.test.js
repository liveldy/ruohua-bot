/**
 * 表情包服务（业务层）：认含义、学管理员的、别人发的只记印象、
 * 按语境挑一张、发出去时表情包单独一条。
 *
 * 假 vision / 假 llm / 假协议端，全部在临时目录里跑，不联网、不叫真模型。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStickerService, toStickerFileUri } from '../../src/sticker/service.js';
import { NO_VISION_TEXT } from '../../src/perception/vision.js';
import { seededRandom } from '../../src/util/common.js';
import { stubLogger } from '../dev/harness.js';

const ADMIN_ID = 10001;
const MEMBER_ID = 10002;

let root = null;
let seq = 0;

function makeBase() {
  seq += 1;
  return path.join(root, `case-${seq}`);
}

function makeConfig(base, sticker = {}) {
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
      autoMeaning: true,
      sendChance: 0.16,
      cooldownMs: 0,
      standalone: true,
      maxItems: 100,
      maxFileBytes: 1024 * 1024,
      ...sticker,
    },
  };
}

function fakeVision(text, counter = null) {
  return {
    describeImages: async () => {
      if (counter) counter.calls += 1;
      if (typeof text === 'function') return text();
      return text;
    },
  };
}

function fakeLlm(payload, counter = null) {
  return {
    chat: async () => {
      if (counter) counter.calls += 1;
      if (payload instanceof Error) throw payload;
      return { json: payload, content: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}) };
    },
  };
}

function makeService(base, { sticker = {}, vision = null, llm = null, logger = null } = {}) {
  const config = makeConfig(base, sticker);
  return createStickerService({ config, logger: logger ?? stubLogger(), llm, vision });
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

/** 一条带图片 / 表情的入站消息。 */
function imageMessage({ userId = ADMIN_ID, file = null, url = null, face = null } = {}) {
  const segments = [];
  if (file || url) segments.push({ type: 'image', data: { ...(file ? { file } : {}), ...(url ? { url } : {}) } });
  if (face) segments.push({ type: 'face', data: { id: face } });
  return { userId, scene: 'group', groupId: 20000, segments, text: '' };
}

function fakeOnebot() {
  const calls = [];
  return {
    calls,
    sendTo: async (target, segments) => {
      calls.push({ target, segments });
      return { message_id: `m${calls.length}` };
    },
  };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-sticker-svc-'));
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('表情包服务：认识与入库', () => {
  it('管理员发的表情包：存下来 + 认出标题、含义与标签', async () => {
    const base = makeBase();
    const source = await writeFile(path.join(base, 'data', 'cache', 'shot.png'), 'sticker-bytes-a');
    const vision = { calls: 0 };
    const llm = { calls: 0 };
    const service = makeService(base, {
      vision: fakeVision('一只猫得意地翘着尾巴', vision),
      llm: fakeLlm({ title: '得意的猫', meaning: '画的是猫翘着尾巴，适合在自夸的时候发', tags: ['得意', '开心', '得意'] }, llm),
    });

    const result = await service.observe(imageMessage({ file: source }));
    assert.equal(result.saved, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, '得意的猫');
    assert.equal(result.items[0].meaning, '画的是猫翘着尾巴，适合在自夸的时候发');
    assert.deepEqual(result.items[0].tags, ['得意', '开心']);
    assert.equal(result.items[0].origin, 'admin');
    assert.equal(result.items[0].addedBy, ADMIN_ID);
    assert.equal(vision.calls, 1);
    assert.equal(llm.calls, 1);

    const stats = service.stats();
    assert.equal(stats.total, 1);
    assert.equal(stats.learned, 1);
    assert.deepEqual(stats.byTag, { 得意: 1, 开心: 1 });
    // 真落盘了：换一个服务实例照样读得到
    const again = makeService(base);
    await again.load();
    assert.equal(again.get(result.items[0].id).title, '得意的猫');
    assert.equal(again.get(result.items[0].id).meaning, '画的是猫翘着尾巴，适合在自夸的时候发');
    assert.equal((await fs.readdir(path.join(base, 'stickers'))).length, 1);
  });

  it('读不到的本地文件（协议端的裸缓存名）：不叫视觉模型，也不入库', async () => {
    const base = makeBase();
    const warnings = [];
    const vision = { calls: 0 };
    const logger = stubLogger();
    logger.warn = (message) => warnings.push(message);
    logger.child = () => logger;
    const service = makeService(base, {
      vision: fakeVision('一张笑脸', vision),
      llm: fakeLlm({ title: '笑脸', meaning: '', tags: [] }),
      logger,
    });

    // NapCat 发来的 file 是它缓存目录里的裸文件名，不在这儿任何允许目录里
    assert.equal(await service.learn('3147A15D4BC3715FF840424D59589115.jpg'), null);
    assert.equal(vision.calls, 0, '读不到的图别喂给视觉模型（真机上就是这么误报「识图一直失败」的）');
    assert.equal(service.stats().total, 0);
    assert.equal(service.stats().unreadable, 1);
    assert.equal(warnings.filter((text) => /读不进来/.test(text)).length, 1, '这类提醒只打一次，别每张图刷一遍');

    // 再来一张还是读不到的：只累计次数，不再刷日志
    assert.equal(await service.learn('3147A15D4BC3715FF840424D59589116.jpg'), null);
    assert.equal(service.stats().unreadable, 2);
    assert.equal(warnings.filter((text) => /读不进来/.test(text)).length, 1);

    // 同一条消息里再带一个 url：本地那个跳过，url 那一路照样走
    const result = await service.observe(
      imageMessage({ file: '3147A15D4BC3715FF840424D59589115.jpg', url: 'https://example.test/a.jpg' }),
    );
    assert.equal(result.saved, 0, 'url 下载不到（测试里没有这张图），但本地那个不该把它拖成异常');
    assert.equal(service.stats().unreadable, 3);
  });

  it('learn 自己认的时候把 title 一起填上；调用方给了就不认', async () => {
    const base = makeBase();
    const vision = { calls: 0 };
    const service = makeService(base, {
      vision: fakeVision('一只猫在翻白眼', vision),
      llm: fakeLlm({ title: '无语猫', meaning: '画的是猫翻白眼，适合在被问到不想答的问题时发', tags: ['无语'] }),
    });

    const auto = await service.learn(Buffer.from('auto-title'));
    assert.equal(auto.title, '无语猫');
    assert.equal(auto.meaning, '画的是猫翻白眼，适合在被问到不想答的问题时发');
    assert.deepEqual(auto.tags, ['无语']);
    assert.equal(vision.calls, 1);

    // 调用方给了标题（哪怕没给描述），就不再叫模型
    const given = await service.learn(Buffer.from('given-title'), { title: '手写的标题' });
    assert.equal(given.title, '手写的标题');
    assert.equal(given.meaning, '');
    assert.equal(vision.calls, 1, '给了标题就不该再认一遍');

    // 标题和描述都没给，才走自动识别
    assert.equal((await service.learn(Buffer.from('auto-again'))).title, '无语猫');
    assert.equal(vision.calls, 2);
  });

  it('byAdmin=true 时，哪怕不在 admins 名单里也按管理员处理', async () => {
    const base = makeBase();
    const source = await writeFile(path.join(base, 'data', 'cache', 'forced.png'), 'forced-bytes');
    const service = makeService(base);
    const result = await service.observe(imageMessage({ userId: 99999, file: source }), { byAdmin: true });
    assert.equal(result.saved, 1);
    assert.equal(result.items[0].addedBy, 99999);
    assert.equal(result.items[0].origin, 'admin');
  });

  it('非管理员发的：不入库（learnFromOthers=false），只返回跳过原因', async () => {
    const base = makeBase();
    const source = await writeFile(path.join(base, 'data', 'cache', 'member.png'), 'member-bytes');
    const service = makeService(base);
    const result = await service.observe(imageMessage({ userId: MEMBER_ID, file: source }));
    assert.deepEqual(result, { saved: 0, items: [], duplicates: 0, skipped: 'learnFromOthers' });
    assert.equal(service.stats().total, 0);
  });

  it('learnFromOthers=true 时，别人发的也学；learnFromAdmins=false 时管理员的反而不学', async () => {
    const base = makeBase();
    const source = await writeFile(path.join(base, 'data', 'cache', 'a.png'), 'bytes-a');
    const open = makeService(base, { sticker: { learnFromOthers: true } });
    assert.equal((await open.observe(imageMessage({ userId: MEMBER_ID, file: source }))).saved, 1);
    assert.equal(open.get(open.list()[0].id).origin, 'others');

    const closedBase = makeBase();
    const source2 = await writeFile(path.join(closedBase, 'data', 'cache', 'b.png'), 'bytes-b');
    const closed = makeService(closedBase, { sticker: { learnFromAdmins: false } });
    const result = await closed.observe(imageMessage({ file: source2 }));
    assert.deepEqual(result, { saved: 0, items: [], duplicates: 0, skipped: 'learnFromAdmins' });
    assert.equal(closed.stats().total, 0);
  });

  it('本地路径越界就退回 url 下载，照样能存下来；两个都不行时只是不入库，不抛', async () => {
    const base = makeBase();
    const outside = await writeFile(path.join(base, 'outside', 'napcat-cache.png'), 'napcat-bytes');
    const served = Buffer.from('sticker-from-http');
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/gif' });
      response.end(served);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const service = makeService(base);
    try {
      const result = await service.observe(imageMessage({ file: outside, url: `http://127.0.0.1:${port}/cat.gif` }));
      assert.equal(result.saved, 1, '越界的本地路径被拒后，url 那条照样入库');
      assert.equal(await fs.readFile(result.items[0].path, 'utf8'), served.toString('utf8'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 只有越界路径、没有 url：不抛错，也不入库
    const onlyLocal = await service.observe(imageMessage({ file: outside }));
    assert.equal(onlyLocal.saved, 0);
    // 连不上的 url 也一样
    const deadUrl = await service.observe(imageMessage({ url: 'http://127.0.0.1:1/x.png' }));
    assert.equal(deadUrl.saved, 0);
    assert.equal(service.stats().total, 1);
  });

  it('重复的表情包：第二次不再认一遍含义，只更新计数', async () => {
    const base = makeBase();
    const vision = { calls: 0 };
    const service = makeService(base, { vision: fakeVision('一只猫', vision), llm: fakeLlm({ meaning: '猫', tags: ['猫'] }) });
    const first = await service.learn(Buffer.from('same-bytes'));
    const second = await service.learn(Buffer.from('same-bytes'));
    assert.equal(second.id, first.id);
    assert.equal(vision.calls, 1, '重复的图不必再认一遍');
    assert.equal(service.stats().total, 1);
    assert.equal(service.get(first.id).usedCount, 1);
  });

  it('没有可观察的图片时 observe 返回 null；关掉功能后什么都不做', async () => {
    const base = makeBase();
    const service = makeService(base);
    assert.equal(await service.observe({ userId: ADMIN_ID, segments: [{ type: 'text', data: { text: '在吗' } }] }), null);
    assert.equal(await service.observe(null), null);

    const off = makeService(makeBase(), { sticker: { enabled: false } });
    assert.equal(off.enabled, false);
    assert.equal(await off.observe(imageMessage({ file: 'whatever.png' })), null);
    assert.equal(await off.pick({}), null);
  });
});

describe('表情包服务：别人发的只记印象', () => {
  it('note 记下这个人最近发的表情包与 QQ 表情，不进库', async () => {
    const base = makeBase();
    const service = makeService(base);
    const message = imageMessage({ userId: MEMBER_ID, file: 'C:/x/napcat/a-1.png', face: '14' });
    const impression = service.note(message);
    assert.equal(impression.count, 2);
    assert.deepEqual(impression.recent, ['a-1.png']);
    assert.deepEqual(impression.faces, ['14']);
    assert.equal(service.stats().total, 0);
    assert.equal(service.notes(MEMBER_ID).count, 2);

    // 纯文字消息不记
    assert.equal(service.note({ userId: MEMBER_ID, segments: [{ type: 'text', data: { text: '你好' } }] }), null);
    assert.equal(service.notes(12345), null);
  });
});

describe('表情包服务：认含义（describe）', () => {
  it('视觉 + 模型都有：收成短标题、内容描述和标签，正好三个键', async () => {
    const service = makeService(makeBase(), {
      vision: fakeVision('一只猫在翻白眼'),
      llm: fakeLlm({ title: '无语猫', meaning: '画的是猫翻白眼，适合在无语的时候发', tags: ['无语'] }),
    });
    const info = await service.describe('x.png');
    assert.deepEqual(Object.keys(info).sort(), ['meaning', 'tags', 'title']);
    assert.deepEqual(info, { title: '无语猫', meaning: '画的是猫翻白眼，适合在无语的时候发', tags: ['无语'] });
  });

  it('模型给不出标题：标题空着，含义照旧', async () => {
    const service = makeService(makeBase(), {
      vision: fakeVision('一只猫在翻白眼'),
      llm: fakeLlm({ meaning: '翻白眼', tags: ['无语'] }),
    });
    assert.deepEqual(await service.describe('x.png'), { title: '', meaning: '翻白眼', tags: ['无语'] });
  });

  it('视觉不可用：返回三个空值，不抛', async () => {
    const base = makeBase();
    assert.deepEqual(await makeService(base).describe('x.png'), { title: '', meaning: '', tags: [] });
    assert.deepEqual(await makeService(makeBase(), { vision: fakeVision(NO_VISION_TEXT) }).describe('x.png'), {
      title: '',
      meaning: '',
      tags: [],
    });
    const broken = makeService(makeBase(), {
      vision: {
        describeImages: async () => {
          throw new Error('boom');
        },
      },
    });
    assert.deepEqual(await broken.describe('x.png'), { title: '', meaning: '', tags: [] });
    assert.deepEqual(await broken.describe(''), { title: '', meaning: '', tags: [] });
  });

  it('模型不肯给 JSON：退回画面描述，仍然不抛', async () => {
    const service = makeService(makeBase(), { vision: fakeVision('一只猫在翻白眼'), llm: fakeLlm('我说不清楚') });
    const info = await service.describe('x.png');
    assert.equal(info.title, '');
    assert.equal(info.meaning, '一只猫在翻白眼');
    assert.deepEqual(info.tags, []);

    const failing = makeService(makeBase(), {
      vision: fakeVision('一只猫在翻白眼'),
      llm: fakeLlm(new Error('model down')),
    });
    assert.equal((await failing.describe('x.png')).meaning, '一只猫在翻白眼');
  });

  it('模型只给标签：含义用画面描述兜底', async () => {
    const service = makeService(makeBase(), { vision: fakeVision('一只猫在翻白眼'), llm: fakeLlm({ tags: ['无语'] }) });
    const info = await service.describe('x.png');
    assert.equal(info.title, '');
    assert.equal(info.meaning, '一只猫在翻白眼');
    assert.deepEqual(info.tags, ['无语']);
  });

  it('autoMeaning=false 时不叫视觉模型，标题与含义先空着', async () => {
    const base = makeBase();
    const vision = { calls: 0 };
    const service = makeService(base, { sticker: { autoMeaning: false }, vision: fakeVision('一只猫', vision) });
    const item = await service.learn(Buffer.from('no-meaning'));
    assert.equal(item.title, '');
    assert.equal(item.meaning, '');
    assert.deepEqual(item.tags, []);
    assert.equal(vision.calls, 0);
  });
});

describe('表情包服务：挑一张', () => {
  async function seededService(base, files, sticker = {}) {
    const service = makeService(base, { sticker });
    for (const file of files) {
      await service.learn(Buffer.from(file.bytes), { title: file.title ?? null, meaning: file.meaning, tags: file.tags });
    }
    return service;
  }

  /** 反复挑同一批：返回每个 id 被挑中的次数（同一种子，结果可复现）。 */
  async function pickCounts(service, options, rounds = 300, seed = 20261027) {
    const rand = seededRandom(seed);
    const counts = {};
    for (let i = 0; i < rounds; i += 1) {
      const item = await service.pick({ ...options, rng: rand });
      if (item) counts[item.id] = (counts[item.id] ?? 0) + 1;
    }
    return counts;
  }

  it('库是空的：返回 null', async () => {
    assert.equal(await makeService(makeBase()).pick({ text: '在吗' }), null);
  });

  it('骰子没过：返回 null（sendChance 与情绪偏置都起作用）', async () => {
    const service = await seededService(makeBase(), [{ bytes: 'one', meaning: '得意', tags: ['得意'] }], { sendChance: 0.16 });
    assert.equal(await service.pick({ rng: () => 0.99 }), null);
    assert.ok(await service.pick({ rng: () => 0.01 }), '没到概率就挑一张');

    const picky = await seededService(makeBase(), [{ bytes: 'two', meaning: '得意', tags: ['得意'] }], { sendChance: 0.16 });
    assert.equal(await picky.pick({ mood: '生气', rng: () => 0.2 }), null, '生气时几乎不发表情包');
    assert.ok(await picky.pick({ mood: '开心', rng: () => 0.2 }), '开心时更容易发');
  });

  it('标签命中的分高：语境对得上就更容易被挑中', async () => {
    const base = makeBase();
    const service = await seededService(base, [], { sendChance: 1 });
    const proud = await service.learn(Buffer.from('proud'), { meaning: '得意', tags: ['得意'] });
    const bored = await service.learn(Buffer.from('bored'), { meaning: '无语', tags: ['无语'] });
    const rand = seededRandom(20261026);
    let proudCount = 0;
    let boredCount = 0;
    for (let i = 0; i < 300; i += 1) {
      const item = await service.pick({ text: '我今天很得意', mood: '开心', rng: rand });
      if (!item) continue;
      if (item.id === proud.id) proudCount += 1;
      if (item.id === bored.id) boredCount += 1;
    }
    assert.ok(proudCount > 0 && boredCount > 0, '两张都可能被挑中');
    assert.ok(proudCount > boredCount, `标签命中的应该更多（得意 ${proudCount} / 无语 ${boredCount}）`);
  });

  it('标题里的关键词也算命中：命中情绪或正文的更容易被挑中', async () => {
    const service = await seededService(makeBase(), [], { sendChance: 1 });
    const work = await service.learn(Buffer.from('pick-title-work'), { title: '加班', tags: ['打工'] });
    const fish = await service.learn(Buffer.from('pick-title-fish'), { title: '摸鱼', tags: ['闲着'] });
    assert.equal(work.title, '加班');
    assert.equal(fish.title, '摸鱼');

    // 正文里出现了标题 → 每个 +3
    const byText = await pickCounts(service, { text: '今晚又要加班到十点' });
    assert.ok(byText[work.id] > 0 && byText[fish.id] > 0, '两张都可能被挑中');
    assert.ok(byText[work.id] > byText[fish.id], `标题对上正文的应该更多（加班 ${byText[work.id]} / 摸鱼 ${byText[fish.id]}）`);

    // 情绪直接命中标题 → +4
    const byMood = await pickCounts(service, { mood: '摸鱼' });
    assert.ok(byMood[fish.id] > byMood[work.id], `标题命中情绪的应该更多（摸鱼 ${byMood[fish.id]} / 加班 ${byMood[work.id]}）`);
  });

  it('内容描述不参与打分：长描述里的词不制造假命中', async () => {
    const service = await seededService(makeBase(), [], { sendChance: 1 });
    const chatty = await service.learn(Buffer.from('pick-meaning-chatty'), { meaning: '适合在加班的时候发' });
    const quiet = await service.learn(Buffer.from('pick-meaning-quiet'), { meaning: '一张普通的图' });

    const counts = await pickCounts(service, { text: '今晚又要加班到十点' });
    assert.ok(counts[chatty.id] > 0 && counts[quiet.id] > 0);
    // 含义是描述、不是关键词，两边的分只差在「没用过」那点浮动上，不该一边倒
    const ratio = counts[chatty.id] / counts[quiet.id];
    assert.ok(ratio > 0.6 && ratio < 1.7, `含义不做子串匹配（${counts[chatty.id]} / ${counts[quiet.id]}）`);
  });

  it('冷却内不重复发同一张；最近发过的那张也会让开', async () => {
    const base = makeBase();
    const service = await seededService(base, [], { cooldownMs: 60000, sendChance: 1 });
    const item = await service.learn(Buffer.from('cool'), { meaning: '得意', tags: ['得意'] });
    const onebot = fakeOnebot();
    const picked = await service.pick({ rng: () => 0.01 });
    assert.equal(picked.id, item.id);
    await service.send(onebot, { scene: 'group', groupId: 20000 }, picked);
    assert.equal(await service.pick({ rng: () => 0.01 }), null, '冷却里挑不动');

    const noCooldown = await seededService(makeBase(), [], { cooldownMs: 0, sendChance: 1 });
    const only = await noCooldown.learn(Buffer.from('warm'), { meaning: '得意', tags: ['得意'] });
    assert.ok(await noCooldown.pick({ rng: () => 0.01 }));
    assert.equal(await noCooldown.pick({ recentStickers: [only.path], rng: () => 0.01 }), null, '最近发过的那张要让开');
  });
});

describe('表情包服务：发送（表情包单独一条）', () => {
  async function preparedService(sticker = {}) {
    const base = makeBase();
    const service = makeService(base, { sticker });
    const item = await service.learn(Buffer.from(`send-${JSON.stringify(sticker)}`), { meaning: '得意', tags: ['得意'] });
    return { service, item };
  }

  it('只发一条：单段 image，不夹带文字', async () => {
    const { service, item } = await preparedService();
    const onebot = fakeOnebot();
    const target = { scene: 'group', groupId: 20000 };
    const result = await service.send(onebot, target, item);

    assert.equal(result.ok, true);
    assert.equal(onebot.calls.length, 1);
    assert.deepEqual(onebot.calls[0].target, target);
    assert.deepEqual(onebot.calls[0].segments, [{ type: 'image', data: { file: toStickerFileUri(item.path) } }]);
    assert.equal(onebot.calls[0].segments.some((segment) => segment.type === 'text'), false);
    assert.equal(result.mode, 'image');
    assert.equal(result.messageId, 'm1');
    // 发出去算一次使用
    assert.equal(service.get(item.id).usedCount, 1);
  });

  it('给了文字 + standalone=true：先文字，再单独一条图', async () => {
    const { service, item } = await preparedService({ standalone: true });
    const onebot = fakeOnebot();
    const result = await service.send(onebot, { scene: 'private', userId: MEMBER_ID }, item, { text: '行' });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'standalone');
    assert.equal(onebot.calls.length, 2);
    assert.deepEqual(onebot.calls[0].segments, [{ type: 'text', data: { text: '行' } }]);
    assert.deepEqual(onebot.calls[1].segments, [{ type: 'image', data: { file: toStickerFileUri(item.path) } }]);
  });

  it('standalone=false：才允许文字和图合成一条', async () => {
    const { service, item } = await preparedService({ standalone: false });
    const onebot = fakeOnebot();
    const result = await service.send(onebot, { scene: 'group', groupId: 20000 }, item, { text: '行' });

    assert.equal(result.mode, 'combined');
    assert.equal(onebot.calls.length, 1);
    assert.deepEqual(onebot.calls[0].segments, [
      { type: 'text', data: { text: '行' } },
      { type: 'image', data: { file: toStickerFileUri(item.path) } },
    ]);
  });

  it('协议端不给 sendTo、或者发送报错：返回 ok:false，不抛', async () => {
    const { service, item } = await preparedService();
    const noSender = await service.send({}, { scene: 'private', userId: 1 }, item);
    assert.equal(noSender.ok, false);
    assert.equal(noSender.error, 'no_onebot');

    const failing = await service.send(
      {
        sendTo: async () => {
          throw new Error('socket closed');
        },
      },
      { scene: 'private', userId: 1 },
      item,
    );
    assert.equal(failing.ok, false);
    assert.match(failing.error, /socket closed/);
    assert.deepEqual(await service.send(null, { scene: 'private', userId: 1 }, null), { ok: false, error: 'no_item' });
  });
});
