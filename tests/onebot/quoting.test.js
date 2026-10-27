/**
 * 引用回复（reply 段）的识别与消费。
 *
 * 覆盖：reply 段自带字段 / 只有 message_id 走缓存 / 缓存未命中且 get_msg 失败 /
 *       get_msg 补查成功 / 机器人自己发的消息也进缓存 / CQ 码字符串形式 /
 *       上下文里出现引用内容 / 判定提示词带上引用 / 群聊引用机器人算 @。
 *
 * 假的协议端用 tools/dev/mock-onebot.js（同进程起，不连真 QQ、不联网）。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockOneBot } from '../../tools/dev/mock-onebot.js';
import { createOneBotClient } from '../../src/onebot/client.js';
import { describeQuoted, normalizeMessage, quotesSelf } from '../../src/onebot/segments.js';
import { createContextBuilder } from '../../src/brain/context.js';
import { createDispatcher } from '../../src/brain/dispatcher.js';
import { decide } from '../../src/brain/decision.js';
import { getFreePort, stubLogger, waitFor } from '../dev/harness.js';

const SELF_ID = 10000;
const TOKEN = 'quote-token';

function replySegment(data) {
  return { type: 'reply', data };
}

/** 一条「引用 + 正文」的原始上报事件。 */
function rawWithQuote(replyData, text, { userId = 10001, nickname = '小林', messageId = 900 } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: messageId,
    self_id: SELF_ID,
    user_id: userId,
    time: 1761000000,
    sender: { user_id: userId, nickname },
    message: [replySegment(replyData), { type: 'text', data: { text } }],
  };
}

describe('引用：normalizeMessage 的 quoted 字段', () => {
  it('reply 段自带字段时直接可用，不用查任何缓存', () => {
    const message = normalizeMessage(rawWithQuote({ id: '7', user_id: 10002, nickname: '张三', time: 1761000000, text: '晚上开会' }, '就按这个办'));
    assert.deepEqual(message.quoted, {
      messageId: '7',
      userId: 10002,
      nickname: '张三',
      text: '晚上开会',
      time: 1761000000000,
      resolved: true,
    });
    // 引用内容不进 display：日志与记忆吃的是它
    assert.equal(message.display, '[回复]就按这个办');
    assert.equal(message.text, '就按这个办');
  });

  it('reply 段只有 message_id 时，先标 resolved:false，等上层补', () => {
    const message = normalizeMessage(rawWithQuote({ id: '123' }, '嗯'));
    assert.deepEqual(message.quoted, { messageId: '123', userId: null, nickname: null, text: null, time: null, resolved: false });
    assert.equal(message.display, '[回复]嗯');
  });

  it('只有 message_id 的老写法（message_id 字段）也认', () => {
    const message = normalizeMessage(rawWithQuote({ message_id: 456 }, '在吗'));
    assert.equal(message.quoted.messageId, '456');
    assert.equal(message.quoted.resolved, false);
  });

  it('CQ 码字符串形式的 reply 一样能解析', () => {
    const message = normalizeMessage({
      post_type: 'message',
      message_type: 'private',
      message_id: 901,
      self_id: SELF_ID,
      user_id: 10001,
      time: 1761000000,
      sender: { user_id: 10001, nickname: '小林' },
      raw_message: '[CQ:reply,id=888]那就这样[CQ:face,id=5]',
    });
    assert.equal(message.quoted.messageId, '888');
    assert.equal(message.text, '那就这样');
    assert.equal(message.display, '[回复]那就这样[表情5]');
  });

  it('没有 reply 段时 quoted 是 null，老格式完全不受影响', () => {
    const arrayForm = normalizeMessage({ post_type: 'message', message_type: 'private', self_id: SELF_ID, user_id: 10001, message: [{ type: 'text', data: { text: '在吗' } }] });
    assert.equal(arrayForm.quoted, null);
    const cqForm = normalizeMessage({ post_type: 'message', message_type: 'private', self_id: SELF_ID, user_id: 10001, raw_message: '看看[CQ:image,file=x.png]这个' });
    assert.equal(cqForm.quoted, null);
    assert.equal(cqForm.text, '看看这个');
  });

  it('describeQuoted 的几种说法', () => {
    assert.equal(describeQuoted({ nickname: '张三', userId: 10002, text: '晚上开会' }), '（在回复 张三 的消息：「晚上开会」）');
    assert.equal(describeQuoted({ nickname: null, userId: 10002, text: '晚上开会' }), '（在回复 10002 的消息：「晚上开会」）');
    assert.equal(describeQuoted({ nickname: null, userId: null, text: '晚上开会' }), '（在回复一条消息：「晚上开会」）');
    assert.equal(describeQuoted({ nickname: '张三', userId: 10002, text: null }), '（在回复 张三 的消息，没看到内容）');
    assert.equal(describeQuoted({ nickname: null, userId: null, text: null }), '（在回复一条消息，没取到内容）');
    assert.equal(describeQuoted(null), null);
  });

  it('quotesSelf 只在引用的是自己那一条时为真', () => {
    assert.equal(quotesSelf({ userId: SELF_ID }, SELF_ID), true);
    assert.equal(quotesSelf({ userId: '10000' }, SELF_ID), true);
    assert.equal(quotesSelf({ userId: 10002 }, SELF_ID), false);
    assert.equal(quotesSelf({ userId: null }, SELF_ID), false);
    assert.equal(quotesSelf(null, SELF_ID), false);
    assert.equal(quotesSelf({ userId: SELF_ID }, 0), false);
  });
});

describe('引用：客户端的缓存与 get_msg 补查', { concurrency: false }, () => {
  let mock;
  let client;
  let config;
  let received = [];
  /** 客户端连上之前就存在的一条消息：客户端缓存里没有它，只能靠 get_msg 找回来。 */
  let preExisting;

  const inject = (body) => mock.inject(body);

  async function injectAndWait(body, timeoutMs = 8000) {
    received = [];
    const injected = inject(body);
    const message = await waitFor(() => received.find((item) => String(item.messageId) === String(injected.messageId)), {
      timeoutMs,
      describe: `收到消息 ${injected.messageId}`,
    });
    return { injected, message };
  }

  before(async () => {
    const wsPort = await getFreePort();
    const controlPort = await getFreePort();
    mock = createMockOneBot({ port: wsPort, httpPort: controlPort, token: TOKEN, selfId: SELF_ID, quiet: true });
    await mock.start();

    // 先把这条「历史消息」塞进假协议端（此刻还没有客户端连着），用来验证 get_msg 补查
    preExisting = mock.inject({ scene: 'private', userId: 10002, nickname: '张三', text: '晚上开会' });

    config = {
      bot: {
        onebot: {
          mode: 'forward',
          wsUrl: `ws://127.0.0.1:${wsPort}`,
          accessToken: TOKEN,
          reversePort: 0,
          reversePath: '/onebot',
          httpUrl: '',
          httpPort: 0,
          heartbeatTimeoutMs: 60000,
          reconnect: { minDelayMs: 200, maxDelayMs: 1000, factor: 1.5 },
          requestTimeoutMs: 5000,
          selfId: SELF_ID,
        },
      },
      persona: { name: '若华' },
    };
    client = createOneBotClient({ config, logger: stubLogger() });
    client.on('message', (message) => received.push(message));
    await client.start();
    await waitFor(() => client.isConnected(), { timeoutMs: 8000, describe: '连上假协议端' });
  }, { timeout: 30000 });

  after(async () => {
    await client?.stop().catch(() => {});
    await mock?.stop().catch(() => {});
  });

  it('只有 message_id：从最近消息缓存里还原出来', async () => {
    const first = await injectAndWait({ scene: 'private', userId: 10001, nickname: '小林', text: '记得买牛奶' });
    const { message } = await injectAndWait({ scene: 'private', userId: 10001, nickname: '小林', segments: [replySegment({ id: first.injected.messageId }), { type: 'text', data: { text: '嗯好' } }] });
    assert.equal(message.quoted.messageId, String(first.injected.messageId));
    assert.equal(message.quoted.resolved, true);
    assert.equal(message.quoted.text, '记得买牛奶');
    assert.equal(message.quoted.nickname, '小林');
    assert.equal(message.quoted.userId, 10001);
    // 收到的消息都进了缓存
    assert.ok(client.messageCache().entries.some((entry) => entry.messageId === String(first.injected.messageId)));
  });

  it('缓存未命中但协议端能查到：get_msg 补一次', async () => {
    const { message } = await injectAndWait({
      scene: 'private',
      userId: 10001,
      nickname: '小林',
      segments: [replySegment({ id: preExisting.messageId }), { type: 'text', data: { text: '我们几点开始' } }],
    });
    assert.equal(message.quoted.resolved, true);
    assert.equal(message.quoted.text, '晚上开会');
    assert.equal(message.quoted.nickname, '张三');
    assert.equal(message.quoted.userId, 10002);
    assert.ok(mock.actionCounts().get_msg >= 1, '应该真的调过 get_msg');
  });

  it('缓存未命中且 get_msg 失败：resolved:false，消息照常处理不抛错', async () => {
    const { message } = await injectAndWait({
      scene: 'private',
      userId: 10001,
      nickname: '小林',
      segments: [replySegment({ id: 424242 }), { type: 'text', data: { text: '这条引用的早没了' } }],
    });
    assert.equal(message.quoted.messageId, '424242');
    assert.equal(message.quoted.resolved, false);
    assert.equal(message.quoted.text, null);
    assert.equal(message.display, '[回复]这条引用的早没了');

    // 出过查询失败也不能影响后面的消息
    const next = await injectAndWait({ scene: 'private', userId: 10001, nickname: '小林', text: '还在吗' });
    assert.equal(next.message.text, '还在吗');
    assert.equal(client.isConnected(), true);
  });

  it('机器人自己发出去的消息也在缓存里', async () => {
    const sent = await client.sendTo({ scene: 'private', userId: 10001 }, '材料我放桌面上了');
    assert.ok(sent?.message_id !== undefined, 'sendTo 应该返回 message_id');
    const { message } = await injectAndWait({
      scene: 'private',
      userId: 10001,
      nickname: '小林',
      segments: [replySegment({ id: sent.message_id }), { type: 'text', data: { text: '好的我看看' } }],
    });
    assert.equal(message.quoted.resolved, true);
    assert.equal(message.quoted.text, '材料我放桌面上了');
    assert.equal(message.quoted.userId, SELF_ID);
    assert.equal(message.quoted.nickname, '若华');
  });

  it('CQ 码字符串形式的 reply：一样能还原被引用的内容', async () => {
    received = [];
    const injected = inject({ scene: 'private', userId: 10001, nickname: '小林', raw: { message: `[CQ:reply,id=${preExisting.messageId}]我们几点开始` } });
    const message = await waitFor(() => received.find((item) => String(item.messageId) === String(injected.messageId)), { timeoutMs: 8000, describe: 'CQ 码形式的引用消息' });
    assert.equal(message.text, '我们几点开始');
    assert.equal(message.quoted.messageId, String(preExisting.messageId));
    assert.equal(message.quoted.resolved, true);
    assert.equal(message.quoted.text, '晚上开会');
  });

  it('缓存有上限，满了按时间淘汰最旧的', async () => {
    const tinyMock = createMockOneBot({ port: await getFreePort(), httpPort: await getFreePort(), token: TOKEN, selfId: SELF_ID, quiet: true });
    await tinyMock.start();
    const tinyConfig = {
      bot: { onebot: { ...config.bot.onebot, wsUrl: `ws://127.0.0.1:${tinyMock.options.port}`, recentMessages: 2 } },
      persona: { name: '若华' },
    };
    const tinyClient = createOneBotClient({ config: tinyConfig, logger: stubLogger() });
    const tinyReceived = [];
    tinyClient.on('message', (message) => tinyReceived.push(message));
    try {
      await tinyClient.start();
      await waitFor(() => tinyClient.isConnected(), { timeoutMs: 8000, describe: '连上小缓存客户端' });
      for (const text of ['一', '二', '三']) {
        tinyReceived.length = 0;
        const injected = tinyMock.inject({ scene: 'private', userId: 10001, nickname: '小林', text });
        await waitFor(() => tinyReceived.find((item) => String(item.messageId) === String(injected.messageId)), { timeoutMs: 8000, describe: `收到 ${text}` });
      }
      const cache = tinyClient.messageCache();
      assert.equal(cache.capacity, 2);
      assert.equal(cache.size, 2);
      assert.deepEqual(cache.entries.map((entry) => entry.text), ['二', '三']);
    } finally {
      await tinyClient.stop().catch(() => {});
      await tinyMock.stop().catch(() => {});
    }
  });
});

describe('引用：喂给模型与门槛判定', () => {
  function quotedMessage(text = '就按这个办') {
    return normalizeMessage(rawWithQuote({ id: '7', user_id: 10002, nickname: '张三', text: '晚上开会' }, text));
  }

  it('上下文：用户消息前多一行引用提示，display 不变', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-quote-ctx-'));
    try {
      const builder = createContextBuilder({
        config: { dataDir: dir, bot: { context: { persist: false } }, memory: { enabled: false } },
        persona: { name: '若华', basePrompt: '你是若华。' },
        logger: stubLogger(),
      });
      const message = quotedMessage();
      const context = await builder.build({ message, user: { userId: 10001, nickname: '小林', role: 'owner' }, scene: 'private' });
      const last = context.messages.at(-1);
      assert.equal(last.role, 'user');
      // 引用提示加在前面，正文照旧用 message.display（reply 段还是渲染成 [回复]）
      assert.equal(last.content, '（在回复 张三 的消息：「晚上开会」）\n[回复]就按这个办');
      assert.equal(context.meta.quoted.text, '晚上开会');
      assert.equal(message.display, '[回复]就按这个办');
      // 历史里也不带引用前缀
      await builder.addTurn({ scene: 'private', userId: 10001, role: 'user', content: message.display });
      const recent = await builder.recent({ scene: 'private', userId: 10001 });
      assert.ok(recent.every((item) => !item.content.includes('晚上开会')), `历史不该被引用污染：${JSON.stringify(recent)}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('没有引用时上下文与以前一模一样', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-quote-ctx-plain-'));
    try {
      const builder = createContextBuilder({
        config: { dataDir: dir, bot: { context: { persist: false } }, memory: { enabled: false } },
        persona: { name: '若华', basePrompt: '你是若华。' },
        logger: stubLogger(),
      });
      const message = normalizeMessage({ post_type: 'message', message_type: 'private', self_id: SELF_ID, user_id: 10001, message: [{ type: 'text', data: { text: '在吗' } }] });
      const context = await builder.build({ message, user: { userId: 10001, role: 'owner' }, scene: 'private' });
      assert.equal(context.messages.at(-1).content, '在吗');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('决策提示词里带上引用内容', async () => {
    let captured = null;
    const llm = {
      async chat({ messages }) {
        captured = messages;
        return { content: JSON.stringify({ mode: 'chat', reply: '好', confidence: 0.6, reason: 'test' }) };
      },
    };
    const message = quotedMessage('那我们还是按原来的安排接着往下弄吧，你先把材料准备一下');
    const decision = await decide({ llm, config: {}, message, user: { role: 'owner' }, scene: 'private', tools: null, logger: stubLogger() });
    assert.equal(decision.mode, 'chat');
    const prompt = captured.at(-1).content;
    assert.ok(prompt.includes('（在回复 张三 的消息：「晚上开会」）'), `判定提示词里该有引用：${prompt}`);
    assert.ok(prompt.includes('对方的话：'), `判定提示词该保留原话：${prompt}`);
  });

  function makeGate(behavior = {}) {
    const config = { bot: { behavior }, persona: { name: '若华' } };
    const onebot = { sendTo: async () => ({}), uploadFile: async () => ({}), loginInfo: () => ({ user_id: SELF_ID }) };
    return createDispatcher({ config, logger: stubLogger(), onebot, services: {} });
  }

  function groupMessage({ quoted, isAt = false, text = '嗯' } = {}) {
    return { scene: 'group', groupId: 20001, userId: 10002, selfId: SELF_ID, sender: { nickname: '张三' }, text, display: text, quoted, isAt };
  }

  it('群聊里引用机器人自己发的消息，等同 @，能通过门槛', () => {
    const gate = makeGate();
    const quoted = { messageId: '5', userId: SELF_ID, nickname: '若华', text: '要不要我把材料整理一下', time: null, resolved: true };
    assert.deepEqual(gate.shouldHandle(groupMessage({ quoted })), { ok: true });
    // 引用的是别人、又没 @，照旧不理
    assert.deepEqual(gate.shouldHandle(groupMessage({ quoted: { ...quoted, userId: 10001, nickname: '小林' } })), { ok: false, why: 'no_at' });
    // 引用里拿不到对方 id（resolved:false）也算不出来，照旧不理
    assert.deepEqual(gate.shouldHandle(groupMessage({ quoted: { messageId: '5', userId: null, nickname: null, text: null, time: null, resolved: false } })), { ok: false, why: 'no_at' });
    // @ 仍然照旧通过
    assert.deepEqual(gate.shouldHandle(groupMessage({ quoted: null, isAt: true })), { ok: true });
    // 直接喊名字仍然照旧通过
    assert.deepEqual(gate.shouldHandle(groupMessage({ quoted: null, text: '若华在吗' })), { ok: true });
  });

  it('behavior.replyToBotCountsAsAt = false 时，引用机器人不再算 @', () => {
    const gate = makeGate({ replyToBotCountsAsAt: false });
    const quoted = { messageId: '5', userId: SELF_ID, nickname: '若华', text: '要不要我把材料整理一下', time: null, resolved: true };
    assert.deepEqual(gate.shouldHandle(groupMessage({ quoted })), { ok: false, why: 'no_at' });
  });

  it('私聊不受引用影响', () => {
    const gate = makeGate();
    const message = { scene: 'private', groupId: null, userId: 10001, selfId: SELF_ID, sender: { nickname: '小林' }, text: '嗯', display: '嗯', quoted: { messageId: '5', userId: SELF_ID, nickname: '若华', text: '材料整理好了', time: null, resolved: true }, isAt: false };
    assert.deepEqual(gate.shouldHandle(message), { ok: true });
    // 私聊里引用机器人发的话=自己引用自己，同样照常处理
    assert.deepEqual(gate.shouldHandle({ ...message, quoted: { messageId: '5', userId: 10001, nickname: '小林', text: '在吗', time: null, resolved: true } }), { ok: true });
  });
});
