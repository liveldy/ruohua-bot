/**
 * 任务表：所有 agent 任务的状态、步骤、结果都记在这里，落盘 data/tasks.json。
 * 每个任务带一个 AbortController，runner 用它把取消信号一路传到工具 ctx.signal。
 */

import path from 'node:path';
import { clamp, round, shortId } from '../util/common.js';
import { readJson, writeJsonAtomic } from '../util/io.js';
import { t } from '../i18n/index.js';

const ACTIVE_STATUSES = new Set(['running', 'waiting']);
const MAX_PERSISTED = 100;
const MAX_STEPS_PERSISTED = 60;
const RESTART_NOTE = t('agent.tasks.restartNote');
const AUTOSAVE_DELAY_MS = 150;

/** 轮次口径：同一个 index 只算一步（一步里并行调多个工具仍算一步）。 */
export function countRounds(steps = []) {
  const rounds = new Set();
  const list = Array.isArray(steps) ? steps : [];
  list.forEach((step, position) => {
    const index = Number(step?.index);
    rounds.add(Number.isFinite(index) ? index : position + 1);
  });
  return rounds.size;
}

function normalizeStep(step = {}, index = 1) {
  const at = Number(step.at);
  return {
    index: Number.isFinite(Number(step.index)) ? Number(step.index) : index,
    thought: step.thought ?? null,
    tool: step.tool ?? null,
    args: step.args ?? null,
    result: step.result ?? null,
    error: step.error ?? null,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

export function createTaskRegistry({ logger = null, dir = null, maxSteps = 12 } = {}) {
  const file = dir ? path.join(dir, 'tasks.json') : null;
  const tasks = new Map();
  const controllers = new Map();
  let saveTimer = null;

  function defaultMaxSteps() {
    const value = Number(maxSteps);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 12;
  }

  function limitOf(task) {
    const value = Number(task.maxSteps);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : defaultMaxSteps();
  }

  /** 进度用「走了多少轮 / 上限多少步」估，0..1。 */
  function computeProgress(task) {
    if (task.status === 'done') return 1;
    const rounds = countRounds(task.steps);
    return round(clamp(rounds / limitOf(task), 0, 1), 2);
  }

  async function save() {
    if (!file) return null;
    const rows = [...tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PERSISTED)
      .map((task) => ({ ...task, steps: task.steps.slice(-MAX_STEPS_PERSISTED) }));
    await writeJsonAtomic(file, { version: 1, savedAt: Date.now(), tasks: rows });
    return file;
  }

  function scheduleSave() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save().catch((error) => logger?.warn?.(t('agent.tasks.saveFailed'), error));
    }, AUTOSAVE_DELAY_MS);
    saveTimer.unref?.();
  }

  function touch(task) {
    task.updatedAt = Date.now();
    task.rounds = countRounds(task.steps);
    task.progress = computeProgress(task);
    return task;
  }

  async function load() {
    if (!file) return registry;
    let data = null;
    try {
      data = await readJson(file, null);
    } catch (error) {
      logger?.warn?.(t('agent.tasks.loadFailed'), error);
      return registry;
    }
    const rows = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
    const now = Date.now();
    for (const row of rows.slice(0, MAX_PERSISTED)) {
      if (!row?.id) continue;
      const task = {
        id: String(row.id),
        goal: String(row.goal ?? ''),
        scene: row.scene === 'group' ? 'group' : 'private',
        userId: row.userId ?? null,
        groupId: row.groupId ?? null,
        status: ['running', 'waiting', 'done', 'failed', 'cancelled'].includes(row.status) ? row.status : 'failed',
        steps: Array.isArray(row.steps) ? row.steps.map(normalizeStep) : [],
        rounds: 0,
        result: row.result ?? null,
        error: row.error ?? null,
        // 等的是什么：'authorization'（等暗号）| 'answer'（等用户回话）；dispatcher 靠它决定收不收掉
        waitReason: row.waitReason === 'authorization' || row.waitReason === 'answer' ? row.waitReason : null,
        createdAt: Number(row.createdAt) || now,
        updatedAt: Number(row.updatedAt) || now,
        progress: Number(row.progress) || 0,
        note: row.note ?? null,
        maxSteps: Number(row.maxSteps) || defaultMaxSteps(),
        finishedAt: row.finishedAt ?? null,
      };
      if (ACTIVE_STATUSES.has(task.status)) {
        // 进程重启后没人接着干，标成失败并说明原因，不要让任务永远挂在运行中
        task.status = 'failed';
        task.error = task.error ? `${task.error}${t('agent.tasks.restartNoteSuffix', { note: RESTART_NOTE })}` : RESTART_NOTE;
        task.finishedAt = now;
      }
      tasks.set(task.id, touch(task));
      controllers.set(task.id, new AbortController());
    }
    return registry;
  }

  const registry = {
    /** 建任务，返回任务的活引用。 */
    create(spec = {}) {
      const now = Date.now();
      const id = spec.id ? String(spec.id) : shortId('task');
      const task = {
        id,
        goal: String(spec.goal ?? '').trim(),
        scene: spec.scene === 'group' ? 'group' : 'private',
        userId: spec.userId ?? null,
        groupId: spec.groupId ?? null,
        status: spec.status ?? 'running',
        steps: [],
        rounds: 0,
        result: spec.result ?? null,
        error: spec.error ?? null,
        waitReason: spec.waitReason ?? null,
        createdAt: now,
        updatedAt: now,
        progress: 0,
        note: spec.note ?? null,
        maxSteps: Number(spec.maxSteps) > 0 ? Math.trunc(Number(spec.maxSteps)) : defaultMaxSteps(),
        finishedAt: null,
      };
      tasks.set(id, task);
      controllers.set(id, new AbortController());
      touch(task);
      logger?.debug?.(t('agent.tasks.createLog', { id }), { goal: task.goal, userId: task.userId });
      scheduleSave();
      return task;
    },

    get(id) {
      return tasks.get(id) ?? null;
    },

    list({ userId = undefined, activeOnly = false } = {}) {
      let rows = [...tasks.values()];
      if (userId !== undefined && userId !== null) rows = rows.filter((task) => String(task.userId) === String(userId));
      if (activeOnly) rows = rows.filter((task) => ACTIVE_STATUSES.has(task.status));
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    },

    active() {
      return registry.list({ activeOnly: true });
    },

    update(id, patch = {}) {
      const task = tasks.get(id);
      if (!task) return null;
      const { steps, ...rest } = patch;
      Object.assign(task, rest);
      if (steps) task.steps = steps.map(normalizeStep);
      touch(task);
      scheduleSave();
      return task;
    },

    addStep(id, step = {}) {
      const task = tasks.get(id);
      if (!task) return null;
      const entry = normalizeStep(step, task.steps.length + 1);
      task.steps.push(entry);
      touch(task);
      logger?.debug?.(t('agent.tasks.stepLog', { id, index: entry.index, tool: entry.tool ?? t('agent.tasks.thinking') }), { error: entry.error ?? null });
      scheduleSave();
      return entry;
    },

    finish(id, { result = undefined, error = undefined, status = undefined, waitReason = undefined } = {}) {
      const task = tasks.get(id);
      if (!task) return null;
      const nextStatus = status ?? (error ? 'failed' : 'done');
      task.status = nextStatus;
      if (result !== undefined) task.result = result;
      if (error !== undefined) task.error = error;
      else if (nextStatus === 'done') task.error = null;
      else if (nextStatus === 'failed' && !task.error) task.error = t('agent.tasks.defaultError');
      if (nextStatus === 'waiting') {
        if (waitReason !== undefined) task.waitReason = waitReason ?? null;
      } else {
        task.waitReason = null;
      }
      task.finishedAt = nextStatus === 'waiting' ? null : Date.now();
      touch(task);
      logger?.info?.(t('agent.tasks.finishLog', { id, status: nextStatus }), { steps: task.steps.length, error: task.error ?? null });
      scheduleSave();
      return task;
    },

    /** 取消：先发取消信号（工具和循环都能看到），再把状态标掉。 */
    cancel(id) {
      const task = tasks.get(id);
      if (!task) return null;
      controllers.get(id)?.abort();
      if (ACTIVE_STATUSES.has(task.status)) {
        task.status = 'cancelled';
        task.error = task.error ?? t('agent.tasks.cancelled');
        task.waitReason = null;
        task.finishedAt = Date.now();
      }
      touch(task);
      logger?.info?.(t('agent.tasks.cancelLog', { id }));
      scheduleSave();
      return task;
    },

    /** 给 runner 用的取消信号。 */
    signalOf(id) {
      return controllers.get(id)?.signal ?? null;
    },

    stats() {
      const rows = [...tasks.values()];
      const countBy = (status) => rows.filter((task) => task.status === status).length;
      return {
        total: rows.length,
        active: rows.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
        running: countBy('running'),
        waiting: countBy('waiting'),
        done: countBy('done'),
        failed: countBy('failed'),
        cancelled: countBy('cancelled'),
        steps: rows.reduce((sum, task) => sum + task.steps.length, 0),
        lastCreatedAt: rows.reduce((max, task) => Math.max(max, task.createdAt), 0) || null,
      };
    },

    async save() {
      return save();
    },

    async load() {
      return load();
    },
  };

  const ready = load();

  return Object.assign(registry, { ready });
}
