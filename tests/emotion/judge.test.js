import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config/index.js';
import { judgeEmotion } from '../../src/emotion/judge.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: '10001' } });
const FALLBACK = { mood: null, delta: 0, event: 'chat', reason: 'fallback', importance: 0.3 };

function fakeLlm(reply, spy) {
  return {
    async chat(request) {
      spy?.push(request);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test('judgeEmotion 正常解析模型返回的 JSON', async () => {
  const spy = [];
  const result = await judgeEmotion({
    llm: fakeLlm(
      { content: '{"event":"praise","delta":3,"mood":"开心","reason":"对方在夸她","importance":0.8}', json: { event: 'praise', delta: 3, mood: '开心', reason: '对方在夸她', importance: 0.8 } },
      spy,
    ),
    persona: config.persona,
    config,
    message: '你今天真靠谱',
    reply: '知道了',
    history: [
      { role: 'user', name: '小南', content: '在忙吗' },
      { role: 'assistant', content: '嗯，你说' },
    ],
  });
  assert.deepEqual(result, { mood: '开心', delta: 3, event: 'praise', reason: '对方在夸她', importance: 0.8 });

  assert.equal(spy.length, 1);
  assert.equal(spy[0].role, 'judge');
  assert.equal(spy[0].json, true);
  assert.equal(spy[0].messages[0].role, 'system');
  assert.ok(spy[0].messages[0].content.includes('praise'), '事件枚举要给模型');
  assert.ok(spy[0].messages[0].content.includes('开心'), '心情枚举要给模型');
  assert.ok(spy[0].messages[1].content.includes('你今天真靠谱'), '要带上看对话');
  assert.ok(spy[0].messages[1].content.includes('小南'), '要带上历史');
});

test('judgeEmotion 没有 json 字段时从 content 里抠 JSON', async () => {
  const result = await judgeEmotion({
    llm: fakeLlm({ content: '```json\n{"event":"thanks","delta":2,"mood":"关心","reason":"道谢","importance":0.5}\n```', json: null }),
    persona: config.persona,
    config,
    message: '谢谢',
    reply: '不用谢',
  });
  assert.equal(result.event, 'thanks');
  assert.equal(result.mood, '关心');
  assert.equal(result.importance, 0.5);
});

test('judgeEmotion 非法 JSON 回退到默认值', async () => {
  const result = await judgeEmotion({
    llm: fakeLlm({ content: '我不知道该怎么判断', json: null }),
    persona: config.persona,
    config,
    message: '……',
    reply: '',
  });
  assert.deepEqual(result, FALLBACK);
});

test('judgeEmotion llm 抛错时回退，不往外抛', async () => {
  const result = await judgeEmotion({
    llm: fakeLlm(new Error('boom')),
    persona: config.persona,
    config,
    message: '在吗',
    reply: '在',
  });
  assert.deepEqual(result, FALLBACK);
});

test('judgeEmotion 没有 llm 或 llm.chat 时回退', async () => {
  assert.deepEqual(await judgeEmotion({ persona: config.persona, message: '在吗' }), FALLBACK);
  assert.deepEqual(await judgeEmotion({ llm: {}, message: '在吗' }), FALLBACK);
  assert.deepEqual(await judgeEmotion(), FALLBACK);
});

test('judgeEmotion 修正非法字段：事件回落到 chat、心情回落 null、数值夹紧', async () => {
  const result = await judgeEmotion({
    llm: fakeLlm({
      json: { event: '不存在的动作', delta: 999, mood: '狂喜', reason: '', importance: 7 },
      content: '',
    }),
    persona: config.persona,
    config,
    message: '随便说说',
  });
  assert.equal(result.event, 'chat');
  assert.equal(result.delta, 10);
  assert.equal(result.mood, null);
  assert.equal(result.reason, 'fallback');
  assert.equal(result.importance, 1);
});

test('judgeEmotion 缺 delta 时用配置里该事件的增量', async () => {
  const result = await judgeEmotion({
    llm: fakeLlm({ json: { event: 'insult', mood: '生气', reason: '被骂了', importance: 0.6 }, content: '' }),
    persona: config.persona,
    config,
    message: '你真笨',
  });
  assert.equal(result.event, 'insult');
  assert.equal(result.delta, config.emotion.deltas.insult);
  assert.equal(result.mood, '生气');
});

test('judgeEmotion 只给 persona 也能拿到事件枚举', async () => {
  const spy = [];
  const personaWithDeltas = { ...config.persona, emotion: { deltas: { praise: 3, chat: 0.2 } } };
  await judgeEmotion({ llm: fakeLlm({ json: { event: 'praise' } }, spy), persona: personaWithDeltas, message: '好棒' });
  assert.ok(spy[0].messages[0].content.includes('praise'));
  assert.ok(spy[0].messages[0].content.includes('chat'));
});
