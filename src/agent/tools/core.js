/**
 * 收尾类工具：finish（声明干完了）、ask_user（信息不够，问一句并挂起任务）。
 * runner 认得这两个工具的返回值，会把任务收成 done / waiting。
 */

import { assertNotAborted, requireArg } from './error.js';
import { t } from '../../i18n/index.js';

function finishRun(args, ctx) {
  assertNotAborted(ctx);
  const result = requireArg(args, 'result', { type: 'string' });
  return { ok: true, done: true, result };
}

function askUserRun(args, ctx) {
  assertNotAborted(ctx);
  const question = requireArg(args, 'question', { type: 'string' });
  const options = Array.isArray(args?.options) ? args.options.map((item) => String(item)) : [];
  return { ok: true, awaiting: true, question, options };
}

export const FINISH_TOOL = {
  name: 'finish',
  description: t('agent.core.finish.description'),
  parameters: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        description: t('agent.core.finish.result'),
      },
    },
    required: ['result'],
    additionalProperties: false,
  },
  sensitive: false,
  action: null,
  run: async (args, ctx) => finishRun(args, ctx),
};

export const ASK_USER_TOOL = {
  name: 'ask_user',
  description: t('agent.core.askUser.description'),
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: t('agent.core.askUser.question') },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: t('agent.core.askUser.options'),
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  sensitive: false,
  action: null,
  run: async (args, ctx) => askUserRun(args, ctx),
};

export function createCoreTools() {
  return [FINISH_TOOL, ASK_USER_TOOL];
}
