/**
 * 真件串联：真实 boundary / security.guard / persona 模块 + 我的 runner 与工具，
 * 用假模型脚本驱动，验证接口对得上、越界真的被拦、口令两步验证真的走通。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentRunner } from '../../src/agent/runner.js';
import { createTaskRegistry } from '../../src/agent/tasks.js';
import { createTools } from '../../src/agent/tools/index.js';
import { createScheduler } from '../../src/autonomy/scheduler.js';
import { loadConfig } from '../../src/config/index.js';
import { createNullLogger } from '../../src/logging/logger.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createBoundary } from '../../src/security/boundary.js';
import { createSecurityGuard } from '../../src/security/guard.js';
import { createStatusReporter } from '../../src/system/status.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

async function setup(agentOverrides = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-agent-int-'));
  TEMP_DIRS.push(tmp);
  const workspace = path.join(tmp, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'note.txt'), '若华今天在干活', 'utf8');
  const config = loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: {
      bot: { dataDir: tmp },
      model: { apiKey: 'test-key' },
      security: {
        admins: [10001],
        passphrase: { enabled: true, pool: ['芝麻开门'], allowLlmChallenge: false },
        boundary: { workspaceRoot: workspace, shell: { enabled: true, timeoutMs: 10000 } },
      },
      agent: { maxSteps: 5, progressEverySteps: 1, stepTimeoutMs: 8000, ...agentOverrides },
    },
  });
  const logger = createNullLogger();
  const boundary = createBoundary({ config, logger });
  const security = createSecurityGuard({ config, logger, llm: null, notify: async () => {} });
  const services = { config, logger, boundary, security };
  const tools = createTools({ config, services });
  const tasks = createTaskRegistry({ logger, dir: null, maxSteps: config.agent.maxSteps });
  return { tmp, workspace, config, logger, boundary, security, services, tools, tasks };
}

function createFakeLLM(script) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async chat(params) {
      calls.push(params);
      const item = typeof script === 'function' ? script({ ...params, callIndex: index }) : script[Math.min(index, script.length - 1)];
      index += 1;
      return {
        content: item.content ?? '',
        toolCalls: item.toolCalls ?? [],
        json: null,
        usage: {},
        model: 'fake-model',
        finishReason: item.toolCalls?.length ? 'tool_calls' : 'stop',
        raw: {},
      };
    },
  };
}

function callTool(name, args = {}) {
  return { id: `call_${name}`, name, arguments: args, raw: JSON.stringify(args) };
}

test('真 boundary：工作区内能列目录、读文件，越界直接拒绝', async () => {
  const env = await setup();
  const { config, tools, tasks, logger, services } = env;
  config.security.sensitive.requireVerification = false; // 这一条只看边界，口令验证另测

  const okLlm = createFakeLLM([
    { content: '先看看工作区', toolCalls: [callTool('list_dir', {})] },
    { content: '工作区里有一个 note.txt', toolCalls: [] },
  ]);
  const runner = createAgentRunner({ config, llm: okLlm, tools, logger, tasks, services });
  const task = await runner.run({ goal: '看看工作区里有什么', userId: 10001 });
  assert.equal(task.status, 'done');
  assert.equal(task.result, '工作区里有一个 note.txt');
  assert.match(task.steps[0].result, /note\.txt/);

  const outside = path.join(os.tmpdir(), 'ruohua-outside.txt');
  const badLlm = createFakeLLM([{ content: '偷看一下外面', toolCalls: [callTool('read_file', { path: outside })] }, { content: '读不到，那算了' }]);
  const badRunner = createAgentRunner({ config, llm: badLlm, tools, logger, tasks, services });
  const bad = await badRunner.run({ goal: '读外面的文件', userId: 10001 });
  assert.equal(bad.status, 'done');
  assert.equal(bad.steps[0].error, 'boundary_denied');
  assert.match(bad.steps[0].result, /路径不允许访问/);
});

test('真 guard：管理员口令两步验证后 shell 真的跑起来，普通用户直接被婉拒', async () => {
  const env = await setup();
  const { config, tools, tasks, logger, services, security } = env;
  const command = 'node -e "console.log(6*7)"';

  // 第一步：管理员要跑命令 → 出题，任务挂在 waiting
  const firstLlm = createFakeLLM([{ content: '我来跑', toolCalls: [callTool('shell', { command })] }]);
  const first = createAgentRunner({ config, llm: firstLlm, tools, logger, tasks, services });
  const challengeTask = await first.run({ goal: '算一下 6 乘 7', userId: 10001, scene: 'private' });
  assert.equal(challengeTask.status, 'waiting');
  assert.ok(challengeTask.result, '要给出问话');
  assert.equal(security.sessionState(10001).pending, true);

  // 第二步：用户回口令 → 这次 verify 走应答判定，命令真的执行
  const secondLlm = createFakeLLM([
    { content: '口令对了，我来跑', toolCalls: [callTool('shell', { command })] },
    { content: '跑出来了', toolCalls: [callTool('finish', { result: '结果是 42' })] },
  ]);
  const second = createAgentRunner({ config, llm: secondLlm, tools, logger, tasks, services });
  const done = await second.run({ goal: '算一下 6 乘 7', userId: 10001, scene: 'private', message: { text: '芝麻开门' } });
  assert.equal(done.status, 'done');
  assert.equal(done.result, '结果是 42');
  assert.match(done.steps[0].result, /42/, 'shell 真的要跑出结果');
  assert.equal(done.steps[0].error, null);

  // 普通用户要跑命令：第一步就被拒
  const strangerLlm = createFakeLLM([{ content: '我来跑', toolCalls: [callTool('shell', { command })] }]);
  const stranger = createAgentRunner({ config, llm: strangerLlm, tools, logger, tasks, services });
  const refused = await stranger.run({ goal: '跑条命令', userId: 20002, scene: 'group', groupId: 555 });
  assert.equal(refused.status, 'done');
  assert.equal(refused.steps[0].error, 'verification_required');
  assert.equal(strangerLlm.calls.length, 1, '被拒之后不再让模型继续');
});

test('真 memory / scheduler / status：工具的参数与真实服务对得上', async () => {
  const env = await setup();
  const { config, tools, tasks, logger } = env;
  const memory = createMemoryService({ config, llm: null, sidecar: null, logger, dir: config.memoryDir });
  const scheduler = createScheduler({ config, logger, dir: config.dataDir, deliver: async () => {}, services: {} });
  const status = createStatusReporter({ config, logger, services: { memory, tasks, agent: null } });
  const services = { boundary: env.boundary, security: env.security, memory, scheduler, status };
  const toolList = createTools({ config, services });
  const ctx = {
    userId: 10001,
    scene: 'group',
    groupId: 555,
    taskId: 'task_int',
    task: null,
    message: null,
    services,
    logger,
    signal: new AbortController().signal,
  };

  const written = await toolList.get('memory_write').run({ content: '主人喜欢安静的下午', importance: 0.9 }, ctx);
  assert.equal(written.ok, true);
  const found = await toolList.get('memory_search').run({ query: '安静' }, ctx);
  assert.ok(found.count >= 1, '刚写进去的记忆要能召回');
  assert.match(found.items[0].content, /安静/);

  const scheduled = await toolList.get('schedule_task').run({ prompt: '把日志整理一下', time: '每天08:00' }, ctx);
  assert.equal(scheduled.ok, true);
  assert.ok(scheduled.schedule?.id, '定时任务要真的建出来');
  const listed = await toolList.get('list_tasks').run({}, ctx);
  assert.equal(listed.count, 1);
  assert.equal(listed.tasks[0].type, 'daily');

  const report = await toolList.get('system_status').run({}, ctx);
  assert.equal(report.ok, true);
  assert.ok(report.status.length > 0);
});

test('真 boundary + shell.enabled=false 时命令被拒，工具报错回灌后模型能收尾', async () => {
  const env = await setup();
  const { config, tools, tasks, logger, services } = env;
  config.security.boundary.shell.enabled = false;
  config.security.sensitive.requireVerification = false; // 这一步只想看命令关掉之后的行为

  const llm = createFakeLLM([
    { content: '跑条命令', toolCalls: [callTool('shell', { command: 'node -e "1"' })] },
    { content: '命令不让跑，我改用别的办法' },
  ]);
  const runner = createAgentRunner({ config, llm, tools, logger, tasks, services });
  const task = await runner.run({ goal: '跑条命令', userId: 10001 });
  assert.equal(task.status, 'done');
  assert.equal(task.steps[0].error, 'shell_disabled');
  assert.match(llm.calls[1].messages.find((m) => m.role === 'tool').content, /shell_disabled/);
});
