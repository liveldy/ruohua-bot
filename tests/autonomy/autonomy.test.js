/** 自主性：空闲活动、每日上限、主动表达的约束。 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAutonomy } from '../../src/autonomy/autonomy.js';
import { readJsonl } from '../../src/util/io.js';

const TARGET = { scene: 'private', userId: 10001, groupId: null };

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-autonomy-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeConfig(dir, patch = {}) {
  return {
    rootDir: dir,
    dataDir: path.join(dir, 'data'),
    logDir: path.join(dir, 'data', 'logs'),
    boundaryRoot: dir,
    persona: { name: '若华' },
    autonomy: {
      enabled: true,
      idle: {
        enabled: true,
        checkIntervalSeconds: 60,
        idleAfterMinutes: 45,
        cooldownMinutes: 25,
        maxPerDay: 12,
        activities: ['recall'],
        activityWeights: {},
        ...(patch.idle ?? {}),
      },
      proactive: {
        enabled: true,
        targets: [TARGET],
        minIntervalMinutes: 90,
        maxPerDay: 8,
        quietHours: [],
        resumeGreeting: true,
        ...(patch.proactive ?? {}),
      },
    },
  };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function makeLlm(text = '想起你上次说的那句话，还是想笑。') {
  return {
    calls: [],
    async chat(params) {
      this.calls.push(params);
      return { content: text };
    },
  };
}

function makeMemory(items = [{ id: 'm1', content: '用户说他最近很忙', importance: 0.8 }]) {
  return {
    recalled: [],
    async recall(request) {
      this.recalled.push(request);
      return items;
    },
  };
}

test('用户刚有动静时不启动空闲活动', async () => {
  const dir = await makeDir();
  const delivered = [];
  const autonomy = createAutonomy({
    config: makeConfig(dir),
    llm: makeLlm(),
    memory: makeMemory(),
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });

  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(Date.now() + 1000);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'not_idle');
  assert.equal(delivered.length, 0);
});

test('空闲到点了就真做一件事，写进 autonomy.jsonl，并主动说一句', async () => {
  const dir = await makeDir();
  const delivered = [];
  const llm = makeLlm();
  const memory = makeMemory();
  const config = makeConfig(dir);
  const autonomy = createAutonomy({
    config,
    llm,
    memory,
    logger: null,
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);

  assert.equal(result.ok, true);
  assert.equal(result.activity, 'recall');
  assert.equal(result.note, '想起你上次说的那句话，还是想笑。');
  assert.ok(memory.recalled.length === 1, '回忆活动应该真的去拉记忆');
  assert.ok(llm.calls.length >= 1, '活动应该真的调用模型');

  const rows = await readJsonl(path.join(config.dataDir, 'autonomy.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activity, 'recall');
  assert.ok(rows[0].at >= t0);

  assert.equal(result.proactive.sent, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, result.note);
  assert.equal(delivered[0].target.userId, 10001);
  assert.match(delivered[0].reason, /^idle:/);
});

test('当天活动次数到上限就不再活动', async () => {
  const dir = await makeDir();
  const autonomy = createAutonomy({
    config: makeConfig(dir, { idle: { cooldownMinutes: 0, maxPerDay: 1 } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const first = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(first.ok, true);

  const second = await autonomy.tick(t0 + 47 * 60_000);
  assert.equal(second.ok, false);
  assert.equal(second.skipped, 'max_per_day');
});

test('冷却期内不重复活动', async () => {
  const dir = await makeDir();
  const autonomy = createAutonomy({
    config: makeConfig(dir, { idle: { cooldownMinutes: 25 } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  assert.equal((await autonomy.tick(t0 + 46 * 60_000)).ok, true);
  const soon = await autonomy.tick(t0 + 47 * 60_000);
  assert.equal(soon.ok, false);
  assert.equal(soon.skipped, 'cooldown');
});

test('noteActivity 会把空闲计时重新归零', async () => {
  const dir = await makeDir();
  const autonomy = createAutonomy({
    config: makeConfig(dir, { idle: { cooldownMinutes: 0 } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  assert.equal((await autonomy.tick(t0 + 46 * 60_000)).ok, true);

  await autonomy.noteActivity({ scene: 'group', userId: 10002, groupId: 555 });
  const after = await autonomy.tick(Date.now() + 60_000);
  assert.equal(after.ok, false);
  assert.equal(after.skipped, 'not_idle');
});

test('静默时段只做事、不主动说话', async () => {
  const dir = await makeDir();
  const delivered = [];
  const t0 = Date.now();
  const when = new Date(t0 + 46 * 60_000);
  const hour = when.getHours();
  const autonomy = createAutonomy({
    config: makeConfig(dir, { proactive: { quietHours: [`${pad(hour)}:00`, `${pad((hour + 1) % 24)}:00`] } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });

  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(result.ok, true, '静默时段仍可以自己活动');
  assert.equal(result.proactive.sent, false);
  assert.equal(result.proactive.skipped, 'quiet_hours');
  assert.equal(delivered.length, 0);
});

test('非静默时段会主动说话', async () => {
  const dir = await makeDir();
  const delivered = [];
  const t0 = Date.now();
  const when = new Date(t0 + 46 * 60_000);
  const hour = when.getHours();
  const autonomy = createAutonomy({
    config: makeConfig(dir, { proactive: { quietHours: [`${pad((hour + 2) % 24)}:00`, `${pad((hour + 3) % 24)}:00`] } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });

  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(result.proactive.sent, true);
  assert.equal(delivered.length, 1);
});

test('情绪不好（系数为 0）时几乎不主动', async () => {
  const dir = await makeDir();
  const delivered = [];
  const emotion = { hints: () => ({ frequencyMultiplier: 0 }) };
  const autonomy = createAutonomy({
    config: makeConfig(dir),
    llm: makeLlm(),
    memory: makeMemory(),
    emotion,
    logger: null,
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(result.ok, true);
  assert.equal(result.proactive.sent, false);
  assert.equal(delivered.length, 0);
});

test('没有目标对象就算了；有最近联系人就用他', async () => {
  const dir = await makeDir();
  const delivered = [];
  const alone = createAutonomy({
    config: makeConfig(dir, { proactive: { targets: [] } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });

  const t0 = Date.now();
  await alone.noteActivity({ scene: 'private', userId: 10001 });
  const noTarget = await alone.tick(t0 + 46 * 60_000);
  assert.equal(noTarget.proactive.sent, false);
  assert.equal(noTarget.proactive.skipped, 'no_target');
  assert.equal(delivered.length, 0);

  const withContact = createAutonomy({
    config: makeConfig(dir, { proactive: { targets: [] } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    services: { recentContacts: [{ scene: 'group', userId: 10003, groupId: 222 }] },
    deliver: async (payload) => delivered.push(payload),
    rng: () => 0,
  });
  await withContact.noteActivity({ scene: 'group', userId: 10003, groupId: 222 });
  const result = await withContact.tick(t0 + 46 * 60_000);
  assert.equal(result.proactive.sent, true);
  assert.equal(delivered[0].target.userId, 10003);
});

test('模型或记忆坏掉了也不影响活动，用本地兜底', async () => {
  const dir = await makeDir();
  const config = makeConfig(dir);
  const autonomy = createAutonomy({
    config,
    llm: {
      async chat() {
        throw new Error('model offline');
      },
    },
    memory: {
      async recall() {
        throw new Error('memory broken');
      },
    },
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(result.ok, true);
  assert.equal(result.activity, 'recall');
  assert.ok(result.note.length > 0);
  const rows = await readJsonl(path.join(config.dataDir, 'autonomy.jsonl'));
  assert.equal(rows.length, 1);
});

test('写作活动会把短文落到 data/notes', async () => {
  const dir = await makeDir();
  const config = makeConfig(dir, { idle: { activities: ['write'], cooldownMinutes: 0 } });
  const autonomy = createAutonomy({
    config,
    llm: makeLlm('今天安静，风也安静。'),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(result.activity, 'write');
  const notes = await fs.readdir(path.join(config.dataDir, 'notes'));
  assert.equal(notes.length, 1);
  const text = await fs.readFile(path.join(config.dataDir, 'notes', notes[0]), 'utf8');
  assert.match(text, /今天安静/);
});

test('翻看工作区的活动能用得上工具', async () => {
  const dir = await makeDir();
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  const config = makeConfig(dir, { idle: { activities: ['observe'] } });
  const autonomy = createAutonomy({
    config,
    llm: makeLlm('看见 notes.txt，想起不少事。'),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });

  const t0 = Date.now();
  await autonomy.noteActivity({ scene: 'private', userId: 10001 });
  const result = await autonomy.tick(t0 + 46 * 60_000);
  assert.equal(result.activity, 'observe');
  assert.match(result.note, /notes\.txt/);
});

test('start / stop 管住定时器；关掉自主性就不再活动', async () => {
  const dir = await makeDir();
  const autonomy = createAutonomy({
    config: makeConfig(dir, { idle: { checkIntervalSeconds: 1 } }),
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });
  await autonomy.start();
  assert.equal(autonomy.running, true);
  await autonomy.stop();
  assert.equal(autonomy.running, false);

  const off = createAutonomy({
    config: { ...makeConfig(dir), autonomy: { ...makeConfig(dir).autonomy, enabled: false } },
    llm: makeLlm(),
    memory: makeMemory(),
    logger: null,
    deliver: async () => {},
    rng: () => 0,
  });
  const result = await off.tick(Date.now() + 60 * 60_000);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'disabled');
});
