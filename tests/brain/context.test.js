/** 上下文：手头任务当成系统事实写进提示词；别人发的表情包按含义渲染，不再只是「[图片]」。 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContextBuilder, taskFactsNote } from '../../src/brain/context.js';
import { createTaskRegistry } from '../../src/agent/tasks.js';
import { normalizeMessage } from '../../src/onebot/segments.js';
import { loadConfig } from '../../src/config/index.js';
import { noVisionText } from '../../src/perception/vision.js';
import { createNullLogger } from '../../src/logging/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  const tmp = await tempDir('ruohua-context-');
  return loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: { bot: { dataDir: tmp }, model: { apiKey: 'test-key' }, security: { admins: [10001] }, ...overrides },
  });
}

function contextOf(config) {
  return createContextBuilder({ config, persona: config.persona, emotion: null, memory: null, logger: createNullLogger() });
}

const USER = { userId: 10001, nickname: '主人', role: 'owner' };

function textMessage(text) {
  return normalizeMessage({
    message_type: 'private',
    user_id: 10001,
    self_id: 99999,
    message: [{ type: 'text', data: { text } }],
  });
}

test('taskFactsNote：running / waiting 都写成系统事实，一件都没有时明说没有', () => {
  const tasks = createTaskRegistry({ logger: null });
  const running = tasks.create({ goal: '整理桌面上的文件', userId: 10001, status: 'running', maxSteps: 8 });
  tasks.addStep(running.id, { index: 1, tool: 'list_dir' });
  tasks.addStep(running.id, { index: 2, tool: 'read_file' });
  tasks.create({ goal: '查一下磁盘占用', userId: 10001, status: 'waiting', waitReason: 'answer', maxSteps: 8 });
  tasks.create({ goal: '别人要的活', userId: 20002, status: 'running', maxSteps: 8 });

  const note = taskFactsNote({ tasks, userId: 10001 });
  assert.ok(note.includes('整理桌面上的文件'), `要带上目标：${note}`);
  assert.ok(note.includes('正在做'), `running 要说正在做：${note}`);
  assert.ok(note.includes('等你回话'), `waiting 要说等你回话：${note}`);
  assert.ok(note.includes('已走 2 步'), `要带上走到第几步：${note}`);
  assert.ok(!note.includes('别人要的活'), '只说这个人自己的任务');

  assert.equal(taskFactsNote({ tasks, userId: 30003 }), '手头现在没有在跑的任务（系统给的实情）。');
  assert.equal(taskFactsNote({ tasks: null }), null, '没有任务表就不硬编事实');
});

test('build：手头任务的系统事实进 system 提示词，没有任务时也写清楚', async () => {
  const config = await makeConfig();
  const context = contextOf(config);
  const message = textMessage('任务怎么样了');

  const tasks = createTaskRegistry({ logger: null });
  tasks.create({ goal: '整理桌面上的文件', userId: 10001, status: 'running', maxSteps: 8 });
  const built = await context.build({
    message,
    user: USER,
    scene: 'private',
    mode: 'chat',
    extraNote: taskFactsNote({ tasks, userId: 10001 }),
  });
  assert.ok(built.system.includes('整理桌面上的文件'), '在跑的任务要进系统提示词');

  const empty = await context.build({
    message,
    user: USER,
    scene: 'private',
    mode: 'chat',
    extraNote: taskFactsNote({ tasks: createTaskRegistry({ logger: null }), userId: 10001 }),
  });
  assert.ok(empty.system.includes('没有在跑的任务'), '一件都没有时也要明说，别让模型自己编');
});

test('别人发的表情包在上下文里按含义渲染，认不出来或没接服务时保持原样', async () => {
  const config = await makeConfig();
  const tmp = await tempDir('ruohua-sticker-cache-');
  const cacheFile = path.join(tmp, 'napcat-cache-1.png');
  const bytes = Buffer.from('fake-sticker-bytes');
  await fs.writeFile(cacheFile, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');

  const item = { id: 's1', file: 'sticker_s1.png', path: path.join(tmp, 'sticker_s1.png'), meaning: '得意', tags: [] };
  const hashes = [];
  const sticker = {
    enabled: true,
    library: {
      findByHash(value) {
        hashes.push(value);
        return value === hash ? item : null;
      },
    },
    list: () => [item],
  };

  const message = normalizeMessage({
    message_type: 'group',
    group_id: 555,
    user_id: 20002,
    self_id: 99999,
    message: [{ type: 'image', data: { file: cacheFile } }],
  });
  assert.equal(message.display, '[图片]', '消息正文本身还是占位，只是提示词里换个说法');

  const context = contextOf(config);
  const user = { userId: 20002, nickname: '群友', role: 'member' };

  const known = await context.build({ message, user, scene: 'group', mode: 'chat', sticker });
  assert.equal(known.messages.at(-1).content, '[表情包：得意]');
  assert.deepEqual(hashes, [hash], '按内容 sha256 去库里认');

  const noMeaning = await context.build({
    message,
    user,
    scene: 'group',
    mode: 'chat',
    sticker: { enabled: true, library: { findByHash: () => ({ ...item, meaning: '' }) }, list: () => [] },
  });
  assert.equal(noMeaning.messages.at(-1).content, '[表情包]', '库里有这张但没含义，就只说是个表情包');

  const unknown = await context.build({
    message,
    user,
    scene: 'group',
    mode: 'chat',
    sticker: { enabled: true, library: { findByHash: () => null }, list: () => [] },
  });
  assert.equal(unknown.messages.at(-1).content, '[图片]', '认不出来就当普通图片');

  await assert.doesNotReject(() => context.build({ message, user, scene: 'group', mode: 'chat' }));
});

test('协议端给的裸文件名：先换回真路径再去看，别报「图读不到」', async () => {
  const config = await makeConfig();
  const user = { userId: 20002, nickname: '群友', role: 'member' };
  const asks = [];
  const vision = {
    visionEnabled: true,
    async describeImages({ images }) {
      asks.push(images);
      return '一只橘猫趴在键盘上';
    },
  };
  const resolved = 'C:/Users/Nelson/Documents/Tencent Files/3244750966/nt_qq/nt_data/Emoji/emoji-recv/2026-10/Ori/3147a15d4bc3715ff840424d59589115.jpg';
  const asked = [];
  const imageSource = {
    async resolve(name) {
      asked.push(name);
      return name === '3147A15D4BC3715FF840424D59589115.jpg' ? resolved : null;
    },
  };
  const message = normalizeMessage({
    message_type: 'private',
    user_id: 20002,
    self_id: 99999,
    message: [{ type: 'image', data: { file: '3147A15D4BC3715FF840424D59589115.jpg' } }],
  });

  const built = await createContextBuilder({
    config,
    persona: config.persona,
    emotion: null,
    memory: null,
    logger: createNullLogger(),
    imageSource,
  }).build({ message, user, scene: 'private', mode: 'chat', vision });

  assert.deepEqual(asked, ['3147A15D4BC3715FF840424D59589115.jpg'], '裸名字要交给解析器');
  assert.deepEqual(asks[0], [{ file: resolved }], '视觉模型拿到的是能读的绝对路径');
  assert.equal(built.messages.at(-1).content, '[图片：一只橘猫趴在键盘上]');
});

test('别人发的图会被真的看一眼：描述写进正文，认不出来才留占位', async () => {
  const config = await makeConfig();
  const user = { userId: 20002, nickname: '群友', role: 'member' };
  const asks = [];
  const vision = {
    visionEnabled: true,
    async describeImages({ images, prompt }) {
      asks.push({ images, prompt });
      return '一只橘猫趴在键盘上，屏幕里是代码';
    },
  };
  const message = normalizeMessage({
    message_type: 'private',
    user_id: 20002,
    self_id: 99999,
    message: [{ type: 'image', data: { file: 'D:/tmp/ruohua-cat-unique.png' } }],
  });
  assert.equal(message.display, '[图片]');

  const context = contextOf(config);
  const built = await context.build({ message, user, scene: 'private', mode: 'chat', vision });
  assert.equal(built.messages.at(-1).content, '[图片：一只橘猫趴在键盘上，屏幕里是代码]');
  assert.equal(built.meta.userText, built.messages.at(-1).content, '写回历史时复用它，别再识一次图');
  assert.equal(asks.length, 1);
  assert.ok(asks[0].prompt && asks[0].prompt !== '', '要带一句给视觉模型的提示');

  // 同一张图再来一次：命中缓存，不再烧一次视觉调用
  await context.build({ message, user, scene: 'private', mode: 'chat', vision });
  assert.equal(asks.length, 1, '同一张图不重复问模型');

  // 没有视觉服务 / 模型看不了图 → 保持原来的「[图片]」
  const noService = await context.build({ message: { ...message, display: '[图片]' }, user, scene: 'private', mode: 'chat' });
  assert.equal(noService.messages.at(-1).content, '[图片]');

  const blind = {
    visionEnabled: true,
    async describeImages() {
      return noVisionText();
    },
  };
  const blindMessage = normalizeMessage({
    message_type: 'private',
    user_id: 20002,
    self_id: 99999,
    message: [{ type: 'image', data: { file: 'D:/tmp/ruohua-blind-unique.png' } }],
  });
  const canNotSee = await context.build({ message: blindMessage, user, scene: 'private', mode: 'chat', vision: blind });
  assert.equal(canNotSee.messages.at(-1).content, '[图片]', '「看不了图」不是对这张图的描述，别写进正文');

  // 已经是库里的表情包：认含义就够，不该再多看一眼
  const stickerVision = { visionEnabled: true, calls: 0, async describeImages() { this.calls += 1; return '不该被调用'; } };
  const stickerMessage = normalizeMessage({
    message_type: 'private',
    user_id: 20002,
    self_id: 99999,
    message: [{ type: 'image', data: { file: 'D:/tmp/ruohua-known-sticker-unique.png' } }],
  });
  const sticker = {
    enabled: true,
    library: { findByHash: () => null },
    list: () => [{ file: 'ruohua-known-sticker-unique.png', meaning: '得意', tags: [] }],
  };
  const known = await context.build({ message: stickerMessage, user, scene: 'private', mode: 'chat', sticker, vision: stickerVision });
  assert.equal(known.messages.at(-1).content, '[表情包：得意]');
  assert.equal(stickerVision.calls, 0, '认得出表情包就别再烧一次视觉调用');
})
