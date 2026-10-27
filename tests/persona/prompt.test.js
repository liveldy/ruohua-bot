import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config/index.js';
import { buildSystemPrompt } from '../../src/persona/prompt.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: '10001' } });
const persona = config.persona;

const emotion = {
  mood: '开心',
  affection: 68,
  label: '亲近',
  hints: { segmentGapMs: [168, 900], maxSegments: 6, tone: persona.style.tone['开心'], replyChance: 1, stickerChance: 0.24 },
};

function build(overrides = {}) {
  return buildSystemPrompt({
    persona,
    emotion,
    memory: ['对方在写一个 QQ 机器人', '对方不喜欢被人打断'],
    user: { userId: 10001, nickname: '小南', role: 'owner' },
    scene: 'private',
    mode: 'chat',
    ...overrides,
  });
}

test('system prompt 带身份、情绪、好感度与亲疏', () => {
  const prompt = build();
  assert.ok(prompt.includes(persona.name), prompt);
  assert.ok(prompt.includes(persona.identity), '身份要写进去');
  assert.ok(prompt.includes(persona.basePrompt.split('\n')[0]), 'basePrompt 要写进去');
  assert.ok(prompt.includes('开心'), '当前情绪要写进去');
  assert.ok(prompt.includes('68'), '好感度要写进去');
  assert.ok(prompt.includes('亲近'), '好感标签要写进去');
  assert.ok(prompt.includes('小南') && prompt.includes('10001'), '对方信息要写进去');
  assert.ok(prompt.includes(persona.roles.owner.address), '角色称呼要写进去');
  assert.ok(prompt.includes(persona.roles.owner.closeness), '角色亲疏要写进去');
});

test('system prompt 带现在的时间：她说得出日期、星期、几点', () => {
  // 2026-10-27 是星期二
  const at = new Date(2026, 9, 27, 14, 5, 0).getTime();
  const prompt = build({ now: at });
  assert.ok(prompt.includes('2026-10-27 14:05'), prompt);
  assert.ok(prompt.includes('星期二'), '星期几也要写进去');
  assert.ok(prompt.includes('现在的时间'), '要单独成节，别混在别处');
  assert.ok(prompt.includes('今天'), '要说清「今天」怎么算');
});

test('system prompt 带永久记忆', () => {
  const prompt = build();
  assert.ok(prompt.includes('对方在写一个 QQ 机器人'), prompt);
  assert.ok(prompt.includes('对方不喜欢被人打断'), prompt);
});

test('system prompt 带禁语与说话风格约束', () => {
  const prompt = build();
  for (const phrase of persona.style.forbidden) {
    assert.ok(prompt.includes(phrase), `禁语要列出来：${phrase}`);
  }
  assert.ok(prompt.includes('逗号'), prompt);
  assert.ok(prompt.includes('Markdown'), prompt);
  assert.ok(prompt.includes(persona.style.catchphrases[0]), prompt);
  for (const habit of persona.style.habits) {
    assert.ok(prompt.includes(habit), `习惯要写进去：${habit}`);
  }
});

test('system prompt 带表情使用习惯', () => {
  const prompt = build();
  assert.ok(prompt.includes('表情'), prompt);
  for (const id of persona.expressions.preferred.slice(0, 3)) {
    assert.ok(prompt.includes(String(id)), `常用表情 id 要写进去：${id}`);
  }
  // 交付文字里不出现某个不该出现的字（用码点比对，避免把字本身写进代码）
  assert.ok(!prompt.includes(String.fromCharCode(0x5a18)));
});

test('system prompt 区分私聊与群聊', () => {
  const privatePrompt = build({ scene: 'private' });
  const groupPrompt = build({ scene: 'group' });
  assert.ok(privatePrompt.includes('私聊'), privatePrompt);
  assert.ok(groupPrompt.includes('群聊'), groupPrompt);
  assert.ok(groupPrompt.includes('别抢话'), '群聊要提醒别抢话');
  assert.notEqual(privatePrompt, groupPrompt);
});

test('system prompt 区分三种任务模式', () => {
  const chat = build({ mode: 'chat' });
  const work = build({ mode: 'work' });
  const agent = build({ mode: 'agent' });
  assert.ok(chat.includes('闲聊'), chat);
  assert.ok(work.includes('干活'), work);
  assert.ok(agent.includes('长任务'), agent);
  assert.ok(agent.includes('先回一句'), 'agent 模式要先说一句再动手');
  assert.ok(!chat.includes('长任务：你会自己拆步骤'), '模式之间不要串');
  assert.notEqual(chat, work);
  assert.notEqual(work, agent);
});

test('system prompt 带长期习惯：先说一句、做完简短汇报', () => {
  const prompt = build();
  assert.ok(prompt.includes('大概多久'), prompt);
  assert.ok(prompt.includes('汇报'), prompt);
});

test('system prompt 带 extra 补充说明', () => {
  const prompt = build({ extra: '对方正在赶一个 deadline，回复尽量干脆' });
  assert.ok(prompt.includes('赶一个 deadline'), prompt);
});

test('system prompt 缺参数也不炸，且不输出 JSON', () => {
  const prompt = buildSystemPrompt();
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('若华'), prompt);
  const empty = buildSystemPrompt({ persona: { name: '若华', style: { forbidden: [] } }, emotion: null, memory: [], user: null });
  assert.ok(!empty.trim().startsWith('{'), '提示词是给模型看的中文，不是 JSON');
  assert.ok(empty.includes('不要'), '没有禁语配置时给出通用约束');
});
