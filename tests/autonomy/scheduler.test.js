/** 定时任务：时间解析、到点触发、失败隔离、持久化。 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScheduler } from '../../src/autonomy/scheduler.js';
import { readJson } from '../../src/util/io.js';

const TARGET = { scene: 'private', userId: 10001, groupId: null };

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

async function makeDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-schedule-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeConfig(patch = {}) {
  return {
    dataDir: patch.dataDir,
    autonomy: { scheduler: { enabled: true, tickSeconds: 20, maxTasks: 200, ...(patch.scheduler ?? {}) } },
    tasks: patch.tasks ?? { enabled: true, tasks: [] },
  };
}

test('once 到点触发一次，随即置 done', async () => {
  const dir = await makeDir();
  const delivered = [];
  const scheduler = createScheduler({
    config: makeConfig({ dataDir: dir }),
    dir,
    deliver: async (payload) => {
      delivered.push(payload);
    },
  });
  const now = new Date(2026, 9, 26, 10, 0, 0).getTime();

  const task = scheduler.create({ id: 't1', name: '喝水', type: 'once', at: now - 1000, prompt: '提醒我喝水', target: TARGET }, { now });
  assert.equal(task.type, 'once');
  assert.equal(task.at, now - 1000);
  assert.equal(task.nextRunAt, now - 1000);
  assert.equal(task.enabled, true);

  const result = await scheduler.tick(now);
  assert.equal(result.fired.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].prompt, '提醒我喝水');
  assert.equal(delivered[0].target.userId, 10001);
  assert.equal(delivered[0].task.id, 't1');

  const after = scheduler.get('t1');
  assert.equal(after.enabled, false);
  assert.equal(after.done, true);
  assert.equal(after.runCount, 1);
  assert.equal(after.lastRunAt, now);
  assert.equal(after.nextRunAt, null);

  await scheduler.tick(now + 60_000);
  assert.equal(delivered.length, 1, '触发过的 once 任务不该重复触发');
});

test('interval 与 daily 的下一次触发时间算得对', async () => {
  const dir = await makeDir();
  const delivered = [];
  const scheduler = createScheduler({ config: makeConfig({ dataDir: dir }), dir, deliver: async (p) => delivered.push(p) });
  const now = new Date(2026, 9, 26, 10, 0, 0).getTime();

  const interval = scheduler.create({ id: 'i1', type: 'interval', every: '30m', prompt: '喝水', target: TARGET }, { now });
  assert.equal(interval.every, 30 * 60_000);
  assert.equal(interval.nextRunAt, now + 30 * 60_000);

  await scheduler.tick(now + 30 * 60_000);
  assert.equal(delivered.length, 1);
  const afterInterval = scheduler.get('i1');
  assert.equal(afterInterval.runCount, 1);
  assert.equal(afterInterval.enabled, true);
  assert.equal(afterInterval.nextRunAt, now + 60 * 60_000);

  const daily = scheduler.create({ id: 'd1', type: 'daily', time: '8:00', prompt: '早上好', target: TARGET }, { now });
  assert.equal(daily.time, '08:00');
  const expected = new Date(now);
  expected.setDate(expected.getDate() + 1);
  expected.setHours(8, 0, 0, 0);
  assert.equal(daily.nextRunAt, expected.getTime(), '10:00 建的任务应排到明天 08:00');

  const before = scheduler.create({ id: 'd2', type: 'daily', time: '23:30', prompt: '该睡了', target: TARGET }, { now });
  const soon = new Date(now);
  soon.setHours(23, 30, 0, 0);
  assert.equal(before.nextRunAt, soon.getTime(), '当天还没到的时刻就排今天');
});

test('deliver 抛错只记进 lastError，不影响别的任务', async () => {
  const dir = await makeDir();
  const delivered = [];
  const scheduler = createScheduler({
    config: makeConfig({ dataDir: dir }),
    dir,
    deliver: async (payload) => {
      if (payload.task.id === 'bad') throw new Error('通道断了');
      delivered.push(payload);
    },
  });
  const now = Date.now();
  scheduler.create({ id: 'bad', type: 'once', at: now - 1, prompt: 'x', target: TARGET }, { now });
  scheduler.create({ id: 'good', type: 'once', at: now - 1, prompt: 'y', target: TARGET }, { now });

  const result = await scheduler.tick(now);
  assert.equal(result.fired.length, 2);
  const bad = scheduler.get('bad');
  const good = scheduler.get('good');
  assert.equal(bad.lastError, '通道断了');
  assert.equal(bad.done, true);
  assert.equal(good.lastError, null);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].task.id, 'good');
});

test('自然语言 when 能解析，解析不了就报清楚', async () => {
  const dir = await makeDir();
  const scheduler = createScheduler({ config: makeConfig({ dataDir: dir }), dir, deliver: async () => {} });
  const now = new Date(2026, 9, 26, 10, 0, 0).getTime();

  const once = scheduler.create({ id: 'w1', when: '半小时后', prompt: '喝水', target: TARGET }, { now });
  assert.equal(once.type, 'once');
  assert.equal(once.at, now + 30 * 60_000);
  assert.equal(once.nextRunAt, now + 30 * 60_000);

  const daily = scheduler.create({ id: 'w2', when: '每天08:00', prompt: '早上好', target: TARGET }, { now });
  assert.equal(daily.type, 'daily');
  assert.equal(daily.time, '08:00');

  const interval = scheduler.create({ id: 'w3', when: 'every 30m', prompt: '休息一下', target: TARGET }, { now });
  assert.equal(interval.type, 'interval');
  assert.equal(interval.every, 30 * 60_000);

  const everyTen = scheduler.create({ id: 'w4', when: '每隔十分钟', prompt: '看看有没有新消息', target: TARGET }, { now });
  assert.equal(everyTen.type, 'interval');
  assert.equal(everyTen.every, 10 * 60_000);

  const tonight = scheduler.create({ id: 'w5', when: '每天晚上八点', prompt: '该歇会儿了', target: TARGET }, { now });
  assert.equal(tonight.type, 'daily');
  assert.equal(tonight.time, '20:00');

  const half = scheduler.create({ id: 'w6', when: '一个半小时后', prompt: '起来走走', target: TARGET }, { now });
  assert.equal(half.type, 'once');
  assert.equal(half.at, now + 90 * 60_000);

  assert.throws(() => scheduler.create({ when: '等我有空的时候', prompt: 'x', target: TARGET }), /看不懂这个时间/);
  assert.throws(() => scheduler.create({ prompt: '没有时间', target: TARGET }), /when|type/);
  assert.throws(() => scheduler.create({ type: 'weekly', time: '08:00', prompt: 'x' }), /不支持的任务类型/);
});

test('list / enable / remove / runNow / stats', async () => {
  const dir = await makeDir();
  const delivered = [];
  const scheduler = createScheduler({ config: makeConfig({ dataDir: dir }), dir, deliver: async (p) => delivered.push(p) });
  const now = Date.now();
  scheduler.create({ id: 'r1', name: '喝水', type: 'interval', every: 60_000, prompt: '喝水', target: TARGET }, { now });

  assert.equal(scheduler.list().length, 1);
  assert.equal(scheduler.stats().enabled, 1);

  scheduler.enable('r1', false);
  assert.equal(scheduler.get('r1').enabled, false);
  await scheduler.tick(now + 5 * 60_000);
  assert.equal(delivered.length, 0, '关掉的任务不该触发');

  await scheduler.runNow('r1');
  assert.equal(delivered.length, 1, 'runNow 是手动跑，不看开关');

  await assert.rejects(scheduler.runNow('不存在'), /没有这个定时任务/);
  assert.equal(scheduler.remove('r1'), true);
  assert.equal(scheduler.list().length, 0);
  assert.equal(scheduler.remove('r1'), false);
});

test('超过 maxTasks 上限就拒绝新建', async () => {
  const dir = await makeDir();
  const scheduler = createScheduler({
    config: makeConfig({ dataDir: dir, scheduler: { maxTasks: 2 } }),
    dir,
    deliver: async () => {},
  });
  const now = Date.now();
  scheduler.create({ id: 'a', type: 'interval', every: 60_000, prompt: 'a', target: TARGET }, { now });
  scheduler.create({ id: 'b', type: 'interval', every: 60_000, prompt: 'b', target: TARGET }, { now });
  assert.throws(() => scheduler.create({ id: 'c', type: 'interval', every: 60_000, prompt: 'c', target: TARGET }, { now }), /上限/);
  scheduler.enable('c', true);
  assert.equal(scheduler.get('c'), null);
});

test('任务落到 data/schedule.json，重启后还在', async () => {
  const dir = await makeDir();
  const delivered = [];
  const config = makeConfig({
    dataDir: dir,
    tasks: {
      enabled: true,
      tasks: [{ id: 'cfg1', when: '每天08:00', prompt: '该起了', target: TARGET, enabled: true }],
    },
  });
  const first = createScheduler({ config, dir, deliver: async (p) => delivered.push(p) });
  await first.start();
  first.create({ id: 'manual1', type: 'interval', every: '1h', prompt: '喝水', target: TARGET });
  await first.save();

  assert.equal(first.list().filter((task) => task.id === 'cfg1').length, 1, '静态任务按 id 只合并一次');
  await first.start();
  assert.equal(first.list().filter((task) => task.id === 'cfg1').length, 1, '重复 start 不会重复合并');
  assert.equal(first.list().length, 2);

  const saved = await readJson(path.join(dir, 'schedule.json'), null);
  assert.ok(saved, 'schedule.json 应该写出来了');
  assert.equal(saved.tasks.length, 2);
  await first.stop();

  const second = createScheduler({ config, dir, deliver: async (p) => delivered.push(p) });
  await second.start();
  assert.deepEqual(
    second.list().map((task) => task.id).sort(),
    ['cfg1', 'manual1'],
  );
  assert.equal(second.get('manual1').prompt, '喝水');
  await second.stop();
});

test('start 后按 tickSeconds 自动检查，stop 能停下来', async () => {
  const dir = await makeDir();
  const delivered = [];
  const scheduler = createScheduler({
    config: makeConfig({ dataDir: dir, scheduler: { tickSeconds: 1 } }),
    dir,
    deliver: async (p) => delivered.push(p),
  });
  scheduler.create({ id: 'soon', when: '+1m', prompt: '一分钟后', target: TARGET });
  await scheduler.start();
  assert.equal(scheduler.running, true);
  assert.equal(scheduler.list().filter((task) => task.id === 'soon').length, 1);
  await scheduler.stop();
  assert.equal(scheduler.running, false);
});
