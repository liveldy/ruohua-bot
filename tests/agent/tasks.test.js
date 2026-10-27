/** 任务表：建/查/更新/步骤/收尾/取消/落盘与重启标记。 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTaskRegistry } from '../../src/agent/tasks.js';
import { createNullLogger } from '../../src/logging/logger.js';

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-tasks-'));
  TEMP_DIRS.push(dir);
  return dir;
}

test('建任务、记步骤、收尾，进度按 steps/maxSteps 估算', async () => {
  const registry = createTaskRegistry({ logger: createNullLogger(), dir: null, maxSteps: 4 });
  const task = registry.create({ goal: '整理文件清单', scene: 'group', userId: 10001, groupId: 555 });

  assert.equal(task.status, 'running');
  assert.equal(task.goal, '整理文件清单');
  assert.equal(task.scene, 'group');
  assert.equal(task.groupId, 555);
  assert.equal(task.progress, 0);
  assert.equal(registry.get(task.id), task);
  assert.equal(registry.list({ userId: 10001 }).length, 1);
  assert.equal(registry.list({ userId: 999 }).length, 0);
  assert.equal(registry.active().length, 1);

  registry.addStep(task.id, { thought: '先看看目录', tool: 'list_dir', args: { path: '.' }, result: { ok: true } });
  assert.equal(task.steps.length, 1);
  assert.equal(task.steps[0].index, 1);
  assert.equal(task.steps[0].tool, 'list_dir');
  assert.equal(task.progress, 0.25);

  registry.addStep(task.id, { tool: 'read_file', error: 'not_found' });
  assert.equal(task.progress, 0.5);
  assert.equal(task.steps[1].index, 2);
  assert.equal(task.steps[1].error, 'not_found');

  registry.finish(task.id, { status: 'done', result: '清单一共 3 个文件' });
  assert.equal(task.status, 'done');
  assert.equal(task.result, '清单一共 3 个文件');
  assert.equal(task.progress, 1);
  assert.ok(task.finishedAt);
  assert.deepEqual(registry.stats(), {
    total: 1,
    active: 0,
    running: 0,
    waiting: 0,
    done: 1,
    failed: 0,
    cancelled: 0,
    steps: 2,
    lastCreatedAt: task.createdAt,
  });
});

test('update 改状态、waiting 也算进行中；finish 带 error 时默认 failed', async () => {
  const registry = createTaskRegistry({ logger: createNullLogger(), dir: null });
  const task = registry.create({ goal: '找文件', userId: 1 });
  registry.update(task.id, { status: 'waiting', result: '你上次说的那个目录在哪' });
  assert.equal(registry.active().length, 1);

  registry.finish(task.id, { error: '模型调用失败' });
  assert.equal(task.status, 'failed');
  assert.equal(task.error, '模型调用失败');
  assert.equal(registry.active().length, 0);
  assert.equal(registry.finish('不存在的任务', { status: 'done' }), null);
});

test('cancel 会 abort 取消信号，signalOf 拿到的是同一个 signal', () => {
  const registry = createTaskRegistry({ logger: createNullLogger(), dir: null });
  const task = registry.create({ goal: '跑个长任务' });
  const signal = registry.signalOf(task.id);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);

  registry.cancel(task.id);
  assert.equal(signal.aborted, true);
  assert.equal(task.status, 'cancelled');
});

test('save 只留最近 100 条；重启后运行中的任务标记为 failed 并注明中断', async () => {
  const dir = await tempDir();
  const first = createTaskRegistry({ logger: createNullLogger(), dir, maxSteps: 4 });
  await first.ready;
  for (let i = 0; i < 105; i += 1) {
    const task = first.create({ goal: `任务${i}`, userId: 1, createdAt: 1000 + i });
    first.update(task.id, { createdAt: 1000 + i });
  }
  const running = first.create({ goal: '跑一半就重启了', userId: 2 });
  first.addStep(running.id, { tool: 'shell' });
  const finished = first.create({ goal: '已经做完的任务', userId: 3 });
  first.finish(finished.id, { status: 'done', result: '好了' });
  await first.save();

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'));
  assert.equal(raw.tasks.length, 100);
  assert.ok(raw.tasks.every((task) => task.createdAt >= 1006));

  const second = createTaskRegistry({ logger: createNullLogger(), dir });
  await second.ready;
  const reloaded = second.get(running.id);
  assert.equal(reloaded.status, 'failed');
  assert.equal(reloaded.error, '进程重启中断');
  assert.equal(reloaded.steps.length, 1);
  assert.equal(second.get(finished.id).status, 'done');
  assert.equal(second.get(finished.id).result, '好了');
  // 重启后的任务不能带着旧的取消信号
  assert.equal(second.signalOf(running.id).aborted, false);
});

test('waiting 的任务重启后也标成 failed，不留永远挂着的任务', async () => {
  const dir = await tempDir();
  const first = createTaskRegistry({ logger: createNullLogger(), dir });
  await first.ready;
  const task = first.create({ goal: '等用户回话', userId: 7 });
  first.update(task.id, { status: 'waiting', result: '问一句' });
  await first.save();

  const second = createTaskRegistry({ logger: createNullLogger(), dir });
  await second.ready;
  const reloaded = second.get(task.id);
  assert.equal(reloaded.status, 'failed');
  assert.equal(reloaded.error, '进程重启中断');
  assert.equal(reloaded.result, '问一句');
});

test('没有 dir 时 save/load 空跑不报错', async () => {
  const registry = createTaskRegistry({ logger: createNullLogger() });
  await registry.ready;
  assert.equal(await registry.save(), null);
  assert.deepEqual(registry.list(), []);
});
