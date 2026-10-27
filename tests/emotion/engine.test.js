import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config/index.js';
import { createEmotionEngine } from '../../src/emotion/engine.js';
import { splitMessages } from '../../src/persona/style.js';
import { createLogger } from '../../src/logging/logger.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const OWNER = '10001';
const MEMBER = '20002';
const T0 = new Date(2026, 9, 26, 9, 0, 0).getTime();

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
  TEMP_DIRS.length = 0;
});

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruohua-emotion-'));
  TEMP_DIRS.push(dir);
  return path.join(dir, 'emotion.json');
}

function makeEngine(overrides = {}, options = {}) {
  const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: OWNER }, overrides });
  return createEmotionEngine({
    config,
    logger: createLogger({ level: 'silent', console: false }),
    stateFile: tempStateFile(),
    ...options,
  });
}

function moodHints(engine, userId) {
  return engine.hints(userId);
}

test('新用户的初始好感度按角色取，标签跟着好感度走', async () => {
  const engine = makeEngine();
  await engine.ready;
  const owner = engine.get(OWNER);
  assert.equal(owner.affection, 60);
  assert.equal(owner.role, 'owner');
  assert.equal(owner.label, '熟悉');
  const member = engine.get(MEMBER);
  assert.equal(member.affection, 15);
  assert.equal(member.role, 'member');
  assert.equal(member.label, '生疏');
});

test('显式传 role 时按 role 取初始值', async () => {
  const engine = makeEngine();
  await engine.ready;
  assert.equal(engine.get('30003').affection, 15);
  await engine.apply('30003', { role: 'owner', event: 'chat', at: T0 });
  assert.equal(engine.get('30003').affection, 60.2);
});

test('事件增量来自 deltas，未给事件时用 delta', async () => {
  const engine = makeEngine();
  await engine.ready;
  const praised = await engine.apply(OWNER, { event: 'praise', at: T0 });
  assert.equal(praised.affection, 63);
  const insulted = await engine.apply(OWNER, { event: 'insult', at: T0 });
  assert.equal(insulted.affection, 57);
  const deltaOnly = await engine.apply(OWNER, { delta: 5, at: T0 });
  assert.equal(deltaOnly.affection, 62);
});

test('好感度按 affectionRange 夹紧', async () => {
  const engine = makeEngine();
  await engine.ready;
  for (let i = 0; i < 40; i += 1) await engine.apply(MEMBER, { event: 'insult', at: T0 });
  assert.equal(engine.get(MEMBER).affection, 0);
  assert.equal(engine.get(MEMBER).label, '生疏');
  for (let i = 0; i < 60; i += 1) await engine.apply(MEMBER, { event: 'praise', at: T0 });
  assert.equal(engine.get(MEMBER).affection, 100);
  assert.equal(engine.get(MEMBER).label, '很亲近');
});

test('interactions 与 lastSeenAt 会被记录', async () => {
  const engine = makeEngine();
  await engine.ready;
  await engine.apply(MEMBER, { event: 'chat', at: T0, note: '来问了天气' });
  const state = engine.get(MEMBER);
  assert.equal(state.interactions, 1);
  assert.equal(state.lastSeenAt, T0);
  await engine.apply(MEMBER, { event: 'chat', at: T0 + 1000 });
  assert.equal(engine.get(MEMBER).interactions, 2);
});

test('情绪按阈值触发，持续时间来自 moodDurationMinutes', async () => {
  const engine = makeEngine();
  await engine.ready;
  const happy = await engine.apply(MEMBER, { event: 'praise', at: T0 });
  assert.equal(happy.mood, '开心');
  assert.equal(happy.moodUntil, T0 + 60 * 60000);
  assert.equal(happy.moodChanged, true);

  const angry = await engine.apply(MEMBER, { event: 'insult', at: T0 });
  assert.equal(angry.mood, '生气');
  assert.equal(angry.moodUntil, T0 + 45 * 60000);

  const t1 = T0 + 46 * 60000;
  const chat = await engine.apply(MEMBER, { event: 'chat', at: t1 });
  assert.equal(chat.mood, '平静', '平静状态下普通闲聊不改情绪');
  assert.equal(chat.moodUntil, null);
});

test('情绪到期由 tick 回落到 defaultMood', async () => {
  const engine = makeEngine();
  await engine.ready;
  await engine.apply(MEMBER, { event: 'praise', at: T0 });
  assert.equal(engine.get(MEMBER).mood, '开心');
  const early = await engine.tick(T0 + 30 * 60000);
  assert.equal(engine.get(MEMBER).mood, '开心', '没到时间不该回落');
  assert.equal(early.moodReset, 0);
  const late = await engine.tick(T0 + 61 * 60000);
  assert.equal(engine.get(MEMBER).mood, '平静');
  assert.equal(engine.get(MEMBER).moodUntil, null);
  assert.equal(late.moodReset, 1);
});

test('setMood 手动设定情绪与时长', async () => {
  const engine = makeEngine();
  await engine.ready;
  const before = Date.now();
  const state = await engine.setMood(MEMBER, '委屈', 10);
  assert.equal(state.mood, '委屈');
  assert.ok(state.moodUntil >= before + 9.9 * 60000 && state.moodUntil <= Date.now() + 10 * 60000);
  await engine.setMood(MEMBER, '不存在的心情');
  assert.equal(engine.get(MEMBER).mood, '平静', '非法心情回落到默认');
});

test('好感度按半衰期向 decay.toward 衰减', async () => {
  const engine = makeEngine({ emotion: { decay: { halfLifeHours: 1, toward: 40, minIntervalMinutes: 0 } } });
  await engine.ready;
  assert.equal(engine.get(OWNER).affection, 60);
  await engine.tick(T0);
  assert.equal(engine.get(OWNER).affection, 60, '第一次 tick 只打时间戳');
  await engine.tick(T0 + 3600000);
  assert.equal(engine.get(OWNER).affection, 50);
  await engine.tick(T0 + 2 * 3600000);
  assert.equal(engine.get(OWNER).affection, 45);
});

test('minIntervalMinutes 之内不重复衰减', async () => {
  const engine = makeEngine({ emotion: { decay: { halfLifeHours: 1, toward: 40, minIntervalMinutes: 30 } } });
  await engine.ready;
  assert.equal(engine.get(OWNER).affection, 60, '先建立用户');
  await engine.tick(T0);
  await engine.tick(T0 + 5 * 60000);
  assert.equal(engine.get(OWNER).affection, 60, '间隔不够，不衰减');
  const after = await engine.tick(T0 + 40 * 60000);
  assert.equal(after.decayed, 1);
  const affection = engine.get(OWNER).affection;
  assert.ok(affection < 60 && affection > 50, `应缓慢衰减：${affection}`);
});

test('hints 随情绪变化：节奏、条数、语气、表情概率', async () => {
  const engine = makeEngine();
  await engine.ready;
  const calm = moodHints(engine, MEMBER);
  assert.deepEqual(calm.segmentGapMs, [280, 1500]);
  assert.equal(calm.maxSegments, 5);
  assert.equal(calm.replyChance, 1);
  assert.equal(calm.frequencyMultiplier, 1);
  assert.equal(calm.tone, '平常的样子，句子短，语气平淡但不冷');
  assert.ok(Math.abs(calm.stickerChance - 0.16) < 1e-9, String(calm.stickerChance));
  assert.equal(calm.mood, '平静');

  await engine.apply(MEMBER, { event: 'praise', at: T0 });
  const happy = moodHints(engine, MEMBER);
  assert.deepEqual(happy.segmentGapMs, [168, 900]);
  assert.equal(happy.maxSegments, 6, '开心可以多一条');
  assert.equal(happy.frequencyMultiplier, 1.5);
  assert.ok(Math.abs(happy.stickerChance - 0.24) < 1e-9, String(happy.stickerChance));
  assert.equal(happy.tone, '轻快，会重复用词，会主动多说一句');

  await engine.apply(MEMBER, { event: 'insult', at: T0 });
  const angry = moodHints(engine, MEMBER);
  assert.deepEqual(angry.segmentGapMs, [448, 2400]);
  assert.equal(angry.maxSegments, 2, '生气时更碎更少');
  assert.equal(angry.replyChance, 0.75);
  assert.ok(angry.stickerChance < calm.stickerChance, '生气时少发表情');
});

test('hints 能直接喂给分段', async () => {
  const engine = makeEngine();
  await engine.ready;
  const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: OWNER } });
  const sentences = Array.from({ length: 6 }, (_, i) => `这是第${i + 1}句话，我特意写得长一点点好凑够长度。`);
  const text = sentences.join('');
  await engine.apply(MEMBER, { event: 'insult', at: T0 });
  const angry = splitMessages(text, { persona: config.persona, emotion: { mood: '生气', hints: moodHints(engine, MEMBER) } });
  const calm = splitMessages(text, { persona: config.persona, emotion: null });
  assert.ok(angry.length < calm.length, `${angry.length} < ${calm.length}`);
  assert.equal(angry.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('save 落盘后新引擎能读回好感度与情绪', async () => {
  const stateFile = tempStateFile();
  const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: OWNER } });
  const first = createEmotionEngine({ config, logger: createLogger({ level: 'silent', console: false }), stateFile });
  await first.apply(MEMBER, { event: 'praise', at: T0 });
  await first.save();

  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(raw.users[MEMBER], 'state file 里应有该用户');
  assert.equal(raw.users[MEMBER].affection, 18);

  const second = createEmotionEngine({ config, logger: createLogger({ level: 'silent', console: false }), stateFile });
  await second.ready;
  const state = second.get(MEMBER);
  assert.equal(state.affection, 18);
  assert.equal(state.mood, '开心');
  assert.equal(state.interactions, 1);
});

test('reset 清掉单个用户或全部', async () => {
  const engine = makeEngine();
  await engine.ready;
  await engine.apply(MEMBER, { event: 'praise', at: T0 });
  assert.equal(engine.get(MEMBER).affection, 18);
  assert.equal(engine.reset(MEMBER), true);
  assert.equal(engine.get(MEMBER).affection, 15, '重置后回到初始值');
  assert.equal(engine.reset('99999'), false);
  engine.get(OWNER);
  assert.equal(engine.snapshot().length, 2);
  assert.equal(engine.reset(), 2);
  assert.deepEqual(engine.snapshot(), []);
});

test('snapshot 返回全部用户状态并按好感度排序', async () => {
  const engine = makeEngine();
  await engine.ready;
  await engine.apply(MEMBER, { event: 'praise', at: T0 });
  engine.get(OWNER);
  const snap = engine.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].userId, OWNER);
  assert.equal(snap[0].label, '熟悉');
  assert.equal(snap[1].userId, MEMBER);
  assert.equal(snap[1].mood, '开心');
  assert.ok(snap.every((item) => typeof item.label === 'string'));
});

test('缺省配置（无 config）也能建引擎', async () => {
  const engine = createEmotionEngine({ stateFile: tempStateFile() });
  await engine.ready;
  const state = engine.get(MEMBER);
  assert.equal(state.mood, '平静');
  assert.equal(state.label, '生疏');
  assert.deepEqual(engine.hints(MEMBER).segmentGapMs, [300, 1200]);
});
