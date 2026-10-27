/**
 * 工具执行：跑一个 tool_call 该做的全部事情 —— 参数被截断不执行、未知工具如实回、敏感工具先过两步验证、单步超时。
 *
 * agent 循环（src/agent/runner.js）与聊天里的工具环（src/brain/chat.js）共用这一份：
 * 同一个工具在哪儿调，权限与超时的规矩都一样。
 */

import { ToolError, combineSignals, toOpenAiTools } from './tools/index.js';
import { t } from '../i18n/index.js';

export function toToolList(tools) {
  if (tools instanceof Map) return [...tools.values()];
  if (Array.isArray(tools)) return tools;
  return [];
}

export function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

/**
 * @param {{ config?: object, tools?: Map|Array, logger?: object, services?: object }} opts
 * @returns {{ execute: Function, list: object[], schemas: object[], names: () => string[] }}
 */
export function createToolExecutor({ config, tools, logger, services = {} } = {}) {
  const log = logger?.child ? logger.child('tools') : logger;
  const agentConfig = config?.agent ?? {};
  const toolList = toToolList(tools);
  const toolMap = new Map(toolList.map((tool) => [tool.name, tool]));
  const toolSchemas = toOpenAiTools(toolList);
  const stepTimeoutMs = Math.max(0, Number(agentConfig.stepTimeoutMs ?? 120000) || 0);

  /** 这个用户是不是正卡在上一步的口令质询里（这条消息就是对口令的回答）。 */
  function hasPendingChallenge(userId) {
    const guard = services?.security;
    if (!guard || typeof guard.sessionState !== 'function') return false;
    try {
      const state = guard.sessionState(userId);
      if (!state?.pending) return false;
      return state.expiresAt == null || state.expiresAt > Date.now();
    } catch {
      return false;
    }
  }

  /** 敏感工具执行前的两步验证。request 非空 = 第一次质询，request 为空 = 用户应答（由 security 模块判定）。 */
  async function verifySensitive(tool, ctx) {
    const guard = services?.security;
    if (!guard || typeof guard.verify !== 'function') {
      return { blocked: true, status: 'done', replyText: t('agent.runner.securityUnavailable') };
    }
    const request = hasPendingChallenge(ctx.userId)
      ? null
      : ctx.requestText
        ? String(ctx.requestText)
        : (ctx.message?.text ?? ctx.goal ?? null);
    let verdict;
    try {
      verdict = await guard.verify({
        userId: ctx.userId,
        scene: ctx.scene,
        groupId: ctx.groupId,
        action: tool.action ?? tool.name,
        message: ctx.message ?? null,
        request,
      });
    } catch (error) {
      return { blocked: false, error: t('agent.runner.verifyFailed', { message: error?.message ?? error }) };
    }
    if (!verdict || verdict.ok !== false) return { blocked: false };
    const replyText = String(verdict.replyText || t('agent.runner.verifyRequired'));
    return {
      blocked: true,
      status: verdict.stage === 'denied' || !verdict.stage ? 'done' : 'waiting',
      replyText,
      stage: verdict.stage ?? null,
    };
  }

  async function runToolWithTimeout(tool, args, ctx) {
    if (!stepTimeoutMs) return tool.run(args, ctx);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    let timer = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ToolError(t('agent.runner.stepTimeout', { timeout: stepTimeoutMs, name: tool.name }), 'step_timeout'));
      }, stepTimeoutMs);
      timer.unref?.();
    });
    const signal = combineSignals(ctx.signal, controller.signal);
    const runPromise = Promise.resolve().then(() => tool.run(args, { ...ctx, signal: signal ?? ctx.signal }));
    try {
      return await Promise.race([runPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  function toolContext(ctx) {
    return {
      userId: ctx.userId ?? null,
      scene: ctx.scene ?? null,
      groupId: ctx.groupId ?? null,
      taskId: ctx.taskId ?? null,
      task: ctx.task ?? null,
      message: ctx.message ?? null,
      services,
      logger: log,
      signal: ctx.signal ?? null,
    };
  }

  /**
   * 执行一个 tool_call。
   * @returns {Promise<{id,name,args,result?,text,observation,error?,blocked?,status?,replyText?}>}
   */
  async function execute(call, ctx = {}) {
    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const base = { id: call.id, name: call.name, args };
    // 参数被截断（finish_reason=length 或 JSON 解析不出来）时绝不执行，回一条 tool 消息让模型自己拆小重来
    if (call.argumentsError) {
      const text = t('agent.runner.argumentsTruncated', {
        name: call.name,
        finishReason: call.finishReason ?? t('agent.runner.unknown'),
        length: String(call.raw ?? '').length,
      });
      return { ...base, args: null, error: 'arguments_truncated', text, observation: { ok: false, code: 'arguments_truncated', error: text } };
    }
    const tool = toolMap.get(call.name);
    if (!tool) {
      const text = t('agent.runner.unknownTool', { name: call.name, tools: toolList.map((item) => item.name).join('\u3001') });
      return { ...base, error: 'unknown_tool', text, observation: { ok: false, error: text } };
    }
    if (ctx.signal?.aborted) {
      const text = t('agent.runner.aborted');
      return { ...base, error: 'aborted', text, observation: { ok: false, error: text } };
    }
    if (tool.sensitive) {
      const verdict = await verifySensitive(tool, ctx);
      if (verdict.blocked) {
        return {
          ...base,
          error: 'verification_required',
          text: verdict.replyText,
          observation: { ok: false, stage: verdict.stage ?? null, error: verdict.replyText },
          blocked: true,
          status: verdict.status,
          replyText: verdict.replyText,
        };
      }
      if (verdict.error) {
        return { ...base, error: 'verify_failed', text: verdict.error, observation: { ok: false, error: verdict.error } };
      }
    }
    try {
      const result = await runToolWithTimeout(tool, args, toolContext(ctx));
      return { ...base, result, text: safeStringify(result), observation: result };
    } catch (error) {
      const code = error?.code ?? error?.name ?? 'tool_error';
      const text = t('agent.runner.toolFailed', { name: call.name, code, message: error?.message ?? error });
      return { ...base, error: code, text, observation: { ok: false, code, error: error?.message ?? String(error) } };
    }
  }

  /** 一次响应里的多个 tool_call：先按配置决定并行还是串行。 */
  async function executeCalls(calls, ctx = {}) {
    if (agentConfig.allowParallelTools === true && calls.length > 1) {
      return Promise.all(calls.map((call) => execute(call, ctx)));
    }
    const outcomes = [];
    for (const call of calls) outcomes.push(await execute(call, ctx));
    return outcomes;
  }

  return {
    execute,
    executeCalls,
    list: toolList,
    schemas: toolSchemas,
    has: (name) => toolMap.has(name),
    names: () => toolList.map((tool) => tool.name),
  };
}
