/**
 * 工具表：createTools({ config, services }) → Map<string, Tool>。
 * Tool 形如 { name, description, parameters(JSON Schema), sensitive, action, async run(args, ctx) }；
 * ctx = { userId, scene, groupId, taskId, task, message, services, logger, signal }。
 */

import { createCoreTools } from './core.js';
import { createFileTools } from './files.js';
import { createQqTools } from './qq.js';
import { createStateTools } from './state.js';
import { createSystemTools } from './system.js';
import { createWebTools } from './web.js';
import { t } from '../../i18n/index.js';

export { ToolError, combineSignals } from './error.js';

export const TOOL_NAMES = [
  'shell',
  'read_file',
  'write_file',
  'list_dir',
  'search_files',
  'screen_capture',
  'see_image',
  'web_fetch',
  'web_search',
  'memory_write',
  'memory_search',
  'schedule_task',
  'list_tasks',
  'system_status',
  'send_file',
  'send_expression',
  'ask_user',
  'finish',
];

export function createTools({ config, services, fetch: fetchOverride = null } = {}) {
  const groups = [
    createCoreTools({ config, services }),
    createFileTools({ config, services }),
    createSystemTools({ config, services }),
    createWebTools({ config, services, fetch: fetchOverride }),
    createStateTools({ config, services }),
    createQqTools({ config, services }),
  ];
  const tools = new Map();
  for (const group of groups) {
    for (const tool of group) {
      if (!tool?.name) throw new Error(t('agent.tools.missingName'));
      if (typeof tool.run !== 'function') throw new Error(t('agent.tools.missingRun', { name: tool.name }));
      if (tools.has(tool.name)) throw new Error(t('agent.tools.duplicateName', { name: tool.name }));
      tools.set(tool.name, tool);
    }
  }
  return tools;
}

/** 工具 → OpenAI function calling 的 tools 参数。 */
export function toOpenAiTools(tools) {
  const list = tools instanceof Map ? [...tools.values()] : Array.isArray(tools) ? tools : [];
  return list.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    },
  }));
}
