/**
 * agent 循环：想一步 → 选工具 → 真的执行 → 看结果 → 再决定下一步，直到给出最终答案或触顶。
 * 工具报错只当作观察结果回灌，不终止任务；敏感工具要先过 SecurityGuard.verify。
 */

import { clamp } from '../util/common.js';
import { formatDuration } from '../util/time.js';
import { truncate } from '../util/text.js';
import { createToolExecutor, safeStringify } from './execute.js';
import { countRounds } from './tasks.js';
import { t } from '../i18n/index.js';

/** 轮次口径：同一个 index 只算一步；runner 对外说的「已走 N 步」就是轮次。 */
function roundsOf(task) {
  const value = Number(task?.rounds);
  return Number.isFinite(value) ? value : countRounds(task?.steps);
}

export function createAgentRunner({ config, llm, tools, logger, tasks, services = {} }) {
  const log = logger?.child ? logger.child('agent') : logger;
  const agentConfig = config?.agent ?? {};
  // 工具执行（含敏感工具的两步验证与单步超时）与聊天里的工具环共用一份，见 src/agent/execute.js
  const executor = createToolExecutor({ config, tools, logger, services });
  const maxConcurrent = Math.max(1, Number(agentConfig.maxConcurrent ?? 3) || 3);
  const maxResultChars = Math.max(200, Number(agentConfig.toolResultMaxChars ?? 4000) || 4000);
  const progressEvery = Math.max(1, Number(agentConfig.progressEverySteps ?? 6) || 6);
  const taskTimeoutMs = Math.max(1000, Number(agentConfig.taskTimeoutMs ?? 900000) || 900000);

  const running = new Map(); // taskId → { notes, message, onProgress }
  const queue = [];
  let active = 0;

  function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  function clampResult(text) {
    const value = String(text ?? '');
    if (value.length <= maxResultChars) return value;
    return `${value.slice(0, maxResultChars)}${t('agent.runner.truncatedNote', { length: value.length })}`;
  }

  function buildSystemPrompt(task) {
    const note = String(agentConfig.systemNote ?? '').trim() || t('agent.runner.defaultNote');
    const scene = task.scene === 'group' ? t('agent.runner.sceneGroup', { groupId: task.groupId }) : t('agent.runner.scenePrivate');
    return [
      note,
      t('agent.runner.workModeIntro'),
      t('agent.runner.rulesHeader'),
      t('agent.runner.rule1'),
      t('agent.runner.rule2'),
      t('agent.runner.rule3'),
      t('agent.runner.rule4'),
      t('agent.runner.rule5'),
      t('agent.runner.rule6'),
      t('agent.runner.sessionLine', { scene, userId: task.userId ?? t('agent.runner.unknown') }),
    ].join('\n');
  }

  function buildUserPrompt(task, limit) {
    return t('agent.runner.userPrompt', { goal: task.goal, limit });
  }

  function applyNotes(state, messages) {
    if (!state.notes.length) return;
    const pending = state.notes.splice(0, state.notes.length);
    for (const note of pending) {
      messages.push({ role: 'user', content: t('agent.runner.notePrefix', { note }) });
    }
  }

  function finishTask(state, { status, result = null, error = null, waitReason = null }) {
    const task = tasks.finish(state.task.id, { status, result, error, waitReason });
    log?.info?.(t('agent.runner.finishLog', { id: state.task.id, status }), { steps: roundsOf(state.task), error });
    return task ?? state.task;
  }

  function reportProgress(state, step, outcomes) {
    if (agentConfig.reportProgress === false || step % progressEvery !== 0) return;
    const note = describeProgress(state.task, step, outcomes);
    try {
      state.onProgress?.(tasks.get(state.task.id) ?? state.task, note);
    } catch (error) {
      log?.warn?.(t('agent.runner.onProgressFailed'), error);
    }
  }

  function describeProgress(task, step, outcomes = []) {
    const tool = outcomes[outcomes.length - 1]?.name ?? task.steps[task.steps.length - 1]?.tool ?? null;
    const tail = tool ? t('agent.runner.progressTail', { tool }) : '';
    return t('agent.runner.progress', { goal: truncate(task.goal, 24), step, tail });
  }

  /** 把一个 tool_call 交给共用的执行器（src/agent/execute.js）跑：身份、场景、信号都从任务里取。 */
  function toolCtx(state) {
    const task = state.task;
    return {
      userId: task.userId,
      scene: task.scene,
      groupId: task.groupId,
      taskId: task.id,
      task,
      goal: task.goal,
      message: state.message ?? null,
      signal: tasks.signalOf(task.id) ?? null,
    };
  }

  async function executeCalls(calls, state) {
    return executor.executeCalls(calls, toolCtx(state));
  }

  /**
   * 步数用尽后的收尾：不再给工具，只让模型把已经拿到的观察汇总成一句给用户的答复。
   * 拿不到内容就退回 lastContent，总之别把已经查到的东西扔掉。
   */
  async function summarizeObservations({ messages, signal, limit }) {
    try {
      const response = await llm.chat({
        messages: [
          ...messages,
          {
            role: 'user',
            content: t('agent.runner.summaryPrompt', { limit }),
          },
        ],
        role: 'agent',
        signal,
      });
      const content = typeof response?.content === 'string' ? response.content.trim() : '';
      return content || null;
    } catch (error) {
      log?.warn?.(t('agent.runner.summaryFailed', { message: error?.message ?? error }));
      return null;
    }
  }

  async function loop(state, limit) {
    const task = state.task;
    const signal = tasks.signalOf(task.id) ?? new AbortController().signal;
    const startedAt = Date.now();
    const deadline = startedAt + taskTimeoutMs;
    const messages = [
      { role: 'system', content: buildSystemPrompt(task) },
      { role: 'user', content: buildUserPrompt(task, limit) },
    ];
    let lastContent = null;

    for (let step = 1; step <= limit; step += 1) {
      if (signal.aborted) {
        return finishTask(state, { status: 'cancelled', error: t('agent.runner.cancelled'), result: lastContent });
      }
      if (Date.now() >= deadline) {
        return finishTask(state, {
          status: 'failed',
          error: t('agent.runner.timeout', { duration: formatDuration(taskTimeoutMs) }),
          result: lastContent,
        });
      }
      applyNotes(state, messages);
      // 最后一步前提醒一次：真机日志里好几件活都是「成果都在手上、就是没调 finish」，
      // 最后被记成「步数用尽、没做成」。
      if (step === limit) messages.push({ role: 'user', content: t('agent.runner.lastStepHint', { limit }) });

      let response;
      try {
        response = await llm.chat({ messages, tools: executor.schemas, role: 'agent', signal });
      } catch (error) {
        const detail = `${error?.code ? `${error.code}\uFF1A` : ''}${error?.message ?? error}`;
        if (signal.aborted) return finishTask(state, { status: 'cancelled', error: t('agent.runner.cancelled'), result: lastContent });
        return finishTask(state, { status: 'failed', error: t('agent.runner.llmFailed', { detail }), result: lastContent });
      }

      const content = typeof response?.content === 'string' ? response.content : '';
      const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls.filter((call) => call?.name) : [];
      if (content) lastContent = content;

      if (!toolCalls.length) {
        // 没有工具调用 = 给出最终答案
        tasks.addStep(task.id, { index: step, thought: content || null, tool: null, args: null, result: null });
        return finishTask(state, { status: 'done', result: content || lastContent || t('agent.runner.noContent') });
      }

      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.raw ?? safeStringify(call.arguments ?? {}) },
        })),
      });

      const outcomes = await executeCalls(toolCalls, state);
      for (const outcome of outcomes) {
        tasks.addStep(task.id, {
          index: step,
          thought: content || null,
          tool: outcome.name,
          args: outcome.args,
          result: clampResult(outcome.text),
          error: outcome.error ?? null,
        });
        messages.push({
          role: 'tool',
          tool_call_id: outcome.id,
          name: outcome.name,
          content: clampResult(outcome.text),
        });
      }

      const blocked = outcomes.find((outcome) => outcome.blocked);
      if (blocked) {
        return finishTask(state, {
          status: blocked.status ?? 'done',
          result: blocked.replyText,
          waitReason: (blocked.status ?? 'done') === 'waiting' ? 'authorization' : null,
        });
      }
      const finished = outcomes.find((outcome) => outcome.name === 'finish' && !outcome.error);
      if (finished) {
        const result = finished.observation?.result ?? finished.text;
        return finishTask(state, { status: 'done', result: String(result ?? '') });
      }
      const asked = outcomes.find((outcome) => outcome.name === 'ask_user' && !outcome.error);
      if (asked) {
        const question = asked.observation?.question ?? asked.text;
        return finishTask(state, { status: 'waiting', result: String(question ?? ''), waitReason: 'answer' });
      }

      reportProgress(state, step, outcomes);

      if (signal.aborted) {
        return finishTask(state, { status: 'cancelled', error: t('agent.runner.cancelled'), result: lastContent });
      }
    }

    const summary = await summarizeObservations({ messages, signal, limit });
    // 收尾确实拿回了给用户的答复 —— 这件活其实是交付了的，别再记成「没做成」：
    // 面板、/任务 和任务台账都会照着状态说，记错状态比丢内容更误导人。
    if (summary) {
      log?.warn?.(t('agent.runner.stepsExhaustedDelivered', { limit }));
      return finishTask(state, { status: 'done', result: summary });
    }
    return finishTask(state, {
      status: 'failed',
      error: t('agent.runner.stepsExhausted', { limit }),
      result: lastContent,
    });
  }

  /** 跑一个任务；超出 maxConcurrent 就排队等着，谁都不阻塞谁。 */
  async function run({ goal, userId = null, scene = 'private', groupId = null, onProgress = null, maxSteps = null, message = null, onTask = null } = {}) {
    const text = String(goal ?? '').trim();
    if (!text) throw new Error(t('agent.runner.needGoal'));
    if (typeof llm?.chat !== 'function') throw new Error(t('agent.runner.needLlm'));
    const limit = clamp(Number(maxSteps) > 0 ? Math.trunc(Number(maxSteps)) : Number(agentConfig.maxSteps ?? 12) || 12, 1, 200);
    const task = tasks.create({
      goal: text,
      scene,
      userId,
      groupId,
      status: 'waiting',
      maxSteps: limit,
    });
    const state = { task, notes: [], message, onProgress, lastContent: null };
    running.set(task.id, state);
    try {
      onTask?.(task);
    } catch (error) {
      log?.warn?.(t('agent.runner.onTaskFailed'), error);
    }
    log?.info?.(t('agent.runner.enqueueLog', { id: task.id }), { goal: text, userId, scene, limit });
    await acquire();
    try {
      if (tasks.get(task.id)?.status === 'cancelled' || tasks.signalOf(task.id)?.aborted) {
        return finishTask(state, { status: 'cancelled', error: t('agent.runner.cancelled') });
      }
      if (task.note && !state.notes.length) state.notes.push(task.note);
      tasks.update(task.id, { status: 'running' });
      return await loop(state, limit);
    } finally {
      release();
      running.delete(task.id);
      tasks.save().catch((error) => log?.warn?.(t('agent.runner.saveFailed'), error));
    }
  }

  /** 追加用户指令：写进 note，并让正在跑的循环在下一步开始时看到。 */
  async function followUp({ taskId, message } = {}) {
    const text = String(message ?? '').trim();
    if (!taskId) throw new Error(t('agent.runner.followUpNeedTaskId'));
    if (!text) throw new Error(t('agent.runner.followUpNeedMessage'));
    const task = tasks.get(taskId);
    if (!task) return null;
    task.note = task.note ? `${task.note}\n${text}` : text;
    tasks.update(taskId, { note: task.note });
    const state = running.get(taskId);
    if (state) {
      state.notes.push(text);
      log?.info?.(t('agent.runner.followUpLog', { id: taskId }), { text: truncate(text, 60) });
    }
    return task;
  }

  function cancel(taskId) {
    return tasks.cancel(taskId);
  }

  function status(taskId) {
    return tasks.get(taskId);
  }

  /** 人类可读的进度文本，直接可以发给用户。步数口径与 /任务、进度回调一致：同一个 index 算一步。 */
  function describe(taskId) {
    const task = tasks.get(taskId);
    if (!task) return t('agent.runner.describe.notFound');
    const goal = truncate(task.goal, 24);
    const steps = roundsOf(task);
    const last = task.steps[task.steps.length - 1];
    switch (task.status) {
      case 'running':
        return t('agent.runner.describe.running', { goal, steps });
      case 'waiting':
        if (steps === 0) return t('agent.runner.describe.queued', { goal });
        return t('agent.runner.describe.waiting', {
          what: truncate(String(task.result ?? ''), 30) || goal,
          steps,
        });
      case 'done':
        return t('agent.runner.describe.done', { goal, steps });
      case 'failed':
        return t('agent.runner.describe.failed', { goal, reason: task.error ?? t('agent.runner.unknownReason') });
      case 'cancelled':
        return t('agent.runner.describe.cancelled', { goal, steps });
      default:
        return t('agent.runner.describe.status', {
          status: task.status,
          goal,
          tail: last?.tool ? t('agent.runner.describe.statusTail', { tool: last.tool }) : '',
        });
    }
  }

  function stats() {
    return { active, queued: queue.length, maxConcurrent, running: running.size };
  }

  return {
    run,
    followUp,
    cancel,
    status,
    describe,
    stats,
    /** 内部台账快照，排查用。 */
    runningIds: () => [...running.keys()],
  };
}
