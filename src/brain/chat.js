/**
 * 聊天里的工具环：她想知道什么就自己去查，查完照常说话。
 *
 * 与 agent 工作模式的区别：不建任务台账、不汇报进度、也不调 finish / ask_user ——
 * 一轮对话最多走 agent.chatMaxSteps 步工具，没有工具调用就直接把正文当回复；
 * 真要用满步数，最后再问一次（这次不给工具），让它拿手上的东西把话说圆。
 *
 * 敏感工具照旧在 src/agent/execute.js 里过 security.verify：被口令拦住时把问话交给调用方发出去。
 */

import { toOpenAiTools } from '../agent/tools/index.js';
import { createToolExecutor } from '../agent/execute.js';
import { truncate } from '../util/text.js';
import { t } from '../i18n/index.js';

/** 聊天里不给这两个：finish 是任务的收尾动作，ask_user 是挂起任务的问法，聊天本身就是在说话。 */
const EXCLUDED = new Set(['finish', 'ask_user']);

export function createChatToolLoop({ config, llm, tools, logger, services = {} } = {}) {
  const log = logger?.child ? logger.child('chat') : logger;
  const executor = createToolExecutor({ config, tools, logger, services });
  const maxSteps = Math.max(0, Math.trunc(Number(config?.agent?.chatMaxSteps ?? 3)) || 0);
  const enabled = config?.agent?.chatTools !== false && maxSteps > 0 && typeof llm?.chat === 'function';
  const maxResultChars = Math.max(200, Number(config?.agent?.toolResultMaxChars ?? 4000) || 4000);
  const usable = executor.list.filter((tool) => !EXCLUDED.has(tool.name));
  const schemas = toOpenAiTools(usable);

  /**
   * @param {{ messages: object[], ctx?: object, signal?: AbortSignal|null }} params
   * @returns {Promise<{ content: string|null, steps: number, blocked?: object, error?: Error }>}
   */
  async function run({ messages = [], ctx = {}, signal = null } = {}) {
    const trail = [...messages];
    for (let step = 1; step <= maxSteps; step += 1) {
      let response;
      try {
        response = await llm.chat({ messages: trail, tools: schemas, role: 'chat', signal });
      } catch (error) {
        log?.warn?.(t('brain.chat.callFailed', { message: error?.message ?? error }));
        return { content: null, steps: step - 1, error };
      }
      const content = typeof response?.content === 'string' ? response.content : '';
      const calls = (Array.isArray(response?.toolCalls) ? response.toolCalls : []).filter((call) => call?.name && !EXCLUDED.has(call.name));
      if (!calls.length) return { content, steps: step - 1 };

      trail.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments ?? {}) },
        })),
      });

      const outcomes = await executor.executeCalls(calls, { ...ctx, signal });
      const blocked = outcomes.find((outcome) => outcome.blocked);
      if (blocked) {
        log?.info?.(t('brain.chat.blocked', { tool: blocked.name }));
        return { content: content || null, steps: step, blocked: { tool: blocked.name, replyText: blocked.replyText, stage: blocked.stage ?? null } };
      }
      for (const outcome of outcomes) {
        trail.push({ role: 'tool', tool_call_id: outcome.id, name: outcome.name, content: truncate(outcome.text, maxResultChars) });
      }
    }

    // 步数用尽：不再给工具，只让它用已经查到的东西把话说完（别把查到的东西丢了）
    try {
      const final = await llm.chat({ messages: [...trail, { role: 'user', content: t('brain.chat.answerNow') }], role: 'chat', signal });
      return { content: typeof final?.content === 'string' ? final.content : '', steps: maxSteps };
    } catch (error) {
      log?.warn?.(t('brain.chat.callFailed', { message: error?.message ?? error }));
      return { content: null, steps: maxSteps, error };
    }
  }

  return {
    run,
    enabled,
    maxSteps,
    toolNames: () => usable.map((tool) => tool.name),
  };
}
