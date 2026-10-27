/**
 * 表情包接线：管理员发的入库、别人发的只记印象（门槛之前）；回复时表情包单独一条；
 * 服务缺失或报错就静默降级，绝不影响消息链路。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../../src/brain/dispatcher.js';
import { createReplyPipeline } from '../../src/brain/reply.js';
import { createStickerService } from '../../src/sticker/service.js';
import { loadConfig } from '../../src/config/index.js';
import { createNullLogger } from '../../src/logging/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = 10001;
const MEMBER = 20002;

// 每个测试都要一个临时数据目录；跑完必须收走，别把 %TEMP% 塞满
const tempDirs = [];
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.allSettled(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

async function makeConfig(overrides = {}) {
  const tmp = await tempDir('ruohua-brain-sticker-');
  return loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: { bot: { dataDir: tmp }, model: { apiKey: 'test-key' }, security: { admins: [OWNER] }, ...overrides },
  });
}

function makeLogger() {
  const ops = [];
  const logger = {
    ops,
    child: () => logger,
    debug() {},
    info() {},
    warn() {},
    error() {},
    operation: (entry) => {
      ops.push(entry);
      return entry;
    },
    conversation: () => {},
  };
  return logger;
}

const onebotStub = {
  sendTo: async () => ({ message_id: 1 }),
  uploadFile: async () => ({ ok: true }),
  loginInfo: () => ({ user_id: 99999 }),
};

/** 群里一条没 @ 机器人的图片消息：过不了门槛，但表情包那一步照样要跑。 */
function imageMessage({ userId = OWNER } = {}) {
  return {
    messageId: null,
    time: Date.now(),
    selfId: 99999,
    scene: 'group',
    userId,
    groupId: 555,
    sender: { userId, nickname: '谁', card: null, role: null },
    segments: [{ type: 'image', data: { file: 'napcat-cache.png' } }],
    text: '',
    display: '[图片]',
    quoted: null,
    images: [{ file: 'napcat-cache.png', url: null }],
    faces: [],
    files: [],
    records: [],
    isAt: false,
    raw: {},
  };
}

/** 假会话：记录发出去的每条消息段。 */
function makeChat() {
  const texts = [];
  const segments = [];
  return {
    texts,
    segments,
    scene: 'private',
    userId: OWNER,
    groupId: null,
    async sendTo(_target, content) {
      segments.push(content);
      texts.push(content.map((segment) => (segment.type === 'text' ? segment.data.text : `[${segment.type}]`)).join(''));
      return { message_id: texts.length };
    },
    async uploadFile() {
      return { ok: true };
    },
  };
}

test('管理员发的图走 observe 入库，别人发的只走 note，且都在门槛之前', async () => {
  const config = await makeConfig();
  const logger = makeLogger();
  const observed = [];
  const noted = [];
  const dispatcher = createDispatcher({
    config,
    logger,
    onebot: onebotStub,
    services: {
      sticker: {
        enabled: true,
        async observe(message, options) {
          observed.push({ message, options });
          return { saved: 1, items: [], duplicates: 0 };
        },
        note(message) {
          noted.push(message);
        },
      },
    },
  });

  await dispatcher.handleMessage(imageMessage({ userId: OWNER }));
  assert.equal(observed.length, 1, '管理员发的表情包要走 observe');
  assert.equal(observed[0].options.byAdmin, true);
  assert.equal(noted.length, 0, '管理员的不记印象');
  assert.equal(logger.ops.filter((entry) => entry.action === 'sticker_learn').length, 1, '入库要记一条日志');

  await dispatcher.handleMessage(imageMessage({ userId: MEMBER }));
  assert.equal(noted.length, 1, '别人发的只记印象，不入库');
  assert.equal(observed.length, 1);
});

test('表情包服务缺失或报错都不影响消息链路', async () => {
  const config = await makeConfig();
  const bare = createDispatcher({ config, logger: makeLogger(), onebot: onebotStub, services: {} });
  await assert.doesNotReject(() => bare.handleMessage(imageMessage()));

  const angry = createDispatcher({
    config,
    logger: makeLogger(),
    onebot: onebotStub,
    services: {
      sticker: {
        enabled: true,
        async observe() {
          throw new Error('库坏了');
        },
        note() {
          throw new Error('库坏了');
        },
      },
    },
  });
  await assert.doesNotReject(() => angry.handleMessage(imageMessage({ userId: OWNER })));
  await assert.doesNotReject(() => angry.handleMessage(imageMessage({ userId: MEMBER })));
});

test('掷中表情包时正文与表情包各一条：先文字，后只有一张图', async () => {
  const config = await makeConfig({ sticker: { sendChance: 1, standalone: true, cooldownMs: 0 } });
  const dir = await tempDir('ruohua-sticker-dir-');
  const item = { id: 's1', file: 'sticker_s1.png', path: path.join(dir, 'sticker_s1.png'), meaning: '得意', tags: [], usedCount: 0, lastUsedAt: null };
  const sticker = createStickerService({
    config,
    logger: createNullLogger(),
    library: { loaded: true, load: async () => {}, list: () => [item], get: () => item, markUsed: async () => {} },
    dir,
  });
  const reply = createReplyPipeline({ config, persona: config.persona, emotion: null, logger: createNullLogger(), sticker });
  const chat = makeChat();

  const sent = await reply.send({ chat, text: '知道了', hints: { segmentGapMs: [0, 0], segmentGapScale: 0 } });

  assert.equal(chat.segments.length, 2, `正文与表情包要分两条：${JSON.stringify(chat.texts)}`);
  assert.equal(chat.texts[0], '知道了', '先发正文');
  assert.ok(chat.segments[0].every((segment) => segment.type === 'text'), '第一条只有文字');
  assert.equal(chat.segments[1].length, 1, '表情包单独一条，不跟文字挤在一起');
  assert.equal(chat.segments[1][0].type, 'image');
  assert.ok(String(chat.segments[1][0].data.file).includes('sticker_s1.png'), `要发库里那一张：${chat.segments[1][0].data.file}`);
  assert.equal(sent.expressions, 1);
  assert.equal(reply.state().expressions, 1);
  assert.deepEqual(sent.extras, [{ kind: 'sticker', label: '得意' }], '发出去的表情包要说给上下文听（她会忘记自己发过）');
  assert.ok(reply.state().recentStickers.includes(item.path), '发过的要进最近的记录，别连着发同一张');
});

test('没接表情包服务时发送不受影响', async () => {
  const config = await makeConfig();
  const reply = createReplyPipeline({ config, persona: config.persona, emotion: null, logger: createNullLogger() });
  const chat = makeChat();

  const sent = await reply.send({ chat, text: '知道了', hints: { segmentGapMs: [0, 0], segmentGapScale: 0 }, skipExpression: true });

  assert.equal(sent.texts.length, 1);
  assert.equal(chat.segments.length, 1, '就是一条普通文字，没多出别的东西');
  assert.equal(chat.segments[0][0].type, 'text');
  assert.equal(sent.expressions, 0);
});
