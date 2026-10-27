/**
 * 状态类工具：memory_write / memory_search（走 memory 服务）、
 * schedule_task / list_tasks（走 scheduler 服务）。
 */

import { parseTimeSpec } from '../../util/time.js';
import { truncate } from '../../util/text.js';
import { assertNotAborted, requireArg, requireMethod, requireService, ToolError } from './error.js';
import { t } from '../../i18n/index.js';

export function createStateTools({ config, services }) {
  const defaultTopK = () => Math.max(1, Number(config?.memory?.recall?.topK ?? 5) || 5);

  async function memoryWriteRun(args, ctx) {
    assertNotAborted(ctx);
    const content = requireArg(args, 'content', { type: 'string' });
    const remember = requireMethod(services, 'memory', 'remember', 'memory.remember');
    const importanceRaw = args?.importance === undefined ? null : Number(args.importance);
    const importance = Number.isFinite(importanceRaw) ? Math.min(Math.max(importanceRaw, 0), 1) : null;
    const tags = Array.isArray(args?.tags) ? args.tags.map((item) => String(item)) : null;
    const entry = await remember({
      userId: ctx?.userId ?? null,
      scene: ctx?.scene ?? 'private',
      content,
      kind: args?.kind ? String(args.kind) : 'note',
      importance,
      tags,
    });
    return { ok: true, saved: true, memory: entry ?? null, content };
  }

  async function memorySearchRun(args, ctx) {
    assertNotAborted(ctx);
    const query = requireArg(args, 'query', { type: 'string' });
    const recall = requireMethod(services, 'memory', 'recall', 'memory.recall');
    const topK = Math.min(Math.max(Number(args?.topK) > 0 ? Math.trunc(Number(args.topK)) : defaultTopK(), 1), 50);
    const rows = await recall({
      userId: ctx?.userId ?? null,
      scene: ctx?.scene ?? 'private',
      query,
      topK,
    });
    const items = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row?.id ?? null,
      content: String(row?.content ?? ''),
      kind: row?.kind ?? null,
      importance: row?.importance ?? null,
      score: row?.score ?? null,
      createdAt: row?.createdAt ?? null,
    }));
    return { ok: true, query, count: items.length, items };
  }

  async function scheduleTaskRun(args, ctx) {
    assertNotAborted(ctx);
    const prompt = requireArg(args, 'prompt', { type: 'string' });
    const time = requireArg(args, 'time', { type: 'string' });
    const spec = parseTimeSpec(time);
    if (!spec) {
      throw new ToolError(t('agent.state.invalidTime', { time }), 'invalid_time', { time });
    }
    const create = requireMethod(services, 'scheduler', 'create', 'scheduler.create');
    const payload = {
      name: args?.name ? String(args.name) : truncate(prompt, 20, ''),
      prompt,
      type: spec.type,
      at: spec.type === 'once' ? spec.at : null,
      every: spec.type === 'interval' ? args?.every ?? time : null,
      time: spec.type === 'daily' ? spec.time : null,
      target: args?.target ?? { scene: ctx?.scene ?? 'private', userId: ctx?.userId ?? null, groupId: ctx?.groupId ?? null },
      enabled: args?.enabled === false ? false : true,
    };
    const task = await create(payload);
    return { ok: true, created: true, schedule: task ?? null, spec };
  }

  async function listTasksRun(_args, ctx) {
    assertNotAborted(ctx);
    requireService(services, 'scheduler', 'scheduler');
    const list = requireMethod(services, 'scheduler', 'list', 'scheduler.list');
    const rows = await list();
    const items = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row?.id ?? null,
      name: row?.name ?? null,
      type: row?.type ?? null,
      prompt: row?.prompt ?? null,
      enabled: row?.enabled ?? null,
      nextRunAt: row?.nextRunAt ?? null,
      lastRunAt: row?.lastRunAt ?? null,
    }));
    return { ok: true, count: items.length, tasks: items };
  }

  const memoryWrite = {
    name: 'memory_write',
    description: t('agent.state.memoryWrite.description'),
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: t('agent.state.memoryWrite.content') },
        kind: { type: 'string', description: t('agent.state.memoryWrite.kind') },
        importance: { type: 'number', description: t('agent.state.memoryWrite.importance') },
        tags: { type: 'array', items: { type: 'string' }, description: t('agent.state.memoryWrite.tags') },
      },
      required: ['content'],
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: memoryWriteRun,
  };

  const memorySearch = {
    name: 'memory_search',
    description: t('agent.state.memorySearch.description'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: t('agent.state.memorySearch.query') },
        topK: { type: 'number', description: t('agent.state.memorySearch.topK') },
      },
      required: ['query'],
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: memorySearchRun,
  };

  const scheduleTask = {
    name: 'schedule_task',
    description: t('agent.state.scheduleTask.description'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: t('agent.state.scheduleTask.prompt') },
        time: { type: 'string', description: t('agent.state.scheduleTask.time') },
        name: { type: 'string', description: t('agent.state.scheduleTask.name') },
        target: {
          type: 'object',
          description: t('agent.state.scheduleTask.target'),
          properties: {
            scene: { type: 'string', description: t('agent.state.scheduleTask.target.scene') },
            userId: { type: 'number' },
            groupId: { type: 'number' },
          },
        },
      },
      required: ['prompt', 'time'],
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: scheduleTaskRun,
  };

  const listTasks = {
    name: 'list_tasks',
    description: t('agent.state.listTasks.description'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    sensitive: false,
    action: null,
    run: listTasksRun,
  };

  return [memoryWrite, memorySearch, scheduleTask, listTasks];
}
