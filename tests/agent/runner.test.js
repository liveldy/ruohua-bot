/** agent 循环：工具调用、错误回灌、步数/时间触顶、敏感验证、取消、追加指令、并发排队。 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentRunner } from '../../src/agent/runner.js';
import { createTaskRegistry } from '../../src/agent/tasks.js';
import { createTools } from '../../src/agent/tools/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createNullLogger } from '../../src/logging/logger.js';
import { sleep } from '../../src/util/common.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 每个测试都要一个临时数据目录；跑完必须收走，别把 %TEMP% 塞满
const tempDirs = [];
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.allSettled(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

async function makeConfig(agentOverrides = {}) {
  const tmp = await tempDir('ruohua-runner-');
  const config = loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: {
      bot: { dataDir: tmp },
      model: { apiKey: 'test-key' },
      security: { admins: [10001], boundary: { workspaceRoot: tmp } },
      agent: agentOverrides,
    },
  });
  return config;
}

function fakeTool(name, run, extra = {}) {
  return {
    name,
    description: `${name} 工具`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    sensitive: false,
    action: null,
    run,
    ...extra,
  };
}

/** 脚本化的假模型：script 可以是数组，也可以是 ({messages, callIndex}) => 响应 的函数。 */
function createFakeLLM(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(params) {
      calls.push(params);
      const item = typeof script === 'function' ? script({ ...params, callIndex: index }) : script[Math.min(index, script.length - 1)];
      index += 1;
      if (!item) throw new Error('假模型脚本用完了');
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
  return { id: `call_${name}_${Math.random().toString(36).slice(2, 7)}`, name, arguments: args, raw: JSON.stringify(args) };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  throw new Error('等待超时');
}

test('单步工具调用 → 观察 → 最终答案', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const seen = [];
  const tools = new Map([
    [
      'read_file',
      fakeTool('read_file', async (args, ctx) => {
        seen.push({ args, ctx });
        return { ok: true, path: args.path, content: 'hello 若华' };
      }),
    ],
  ]);
  const llm = createFakeLLM([
    { content: '先读一下 a.txt', toolCalls: [callTool('read_file', { path: 'a.txt' })] },
    { content: 'a.txt 里写的是 hello 若华' },
  ]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '看看 a.txt 里写了什么', userId: 10001, scene: 'private' });

  assert.equal(task.status, 'done');
  assert.equal(task.result, 'a.txt 里写的是 hello 若华');
  assert.equal(task.progress, 1);
  assert.equal(task.steps.length, 2);
  assert.equal(task.steps[0].tool, 'read_file');
  assert.deepEqual(task.steps[0].args, { path: 'a.txt' });
  assert.equal(task.steps[0].thought, '先读一下 a.txt');
  assert.equal(task.steps[0].error, null);
  assert.equal(task.steps[1].tool, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].args.path, 'a.txt');
  assert.equal(seen[0].ctx.taskId, task.id);
  assert.equal(seen[0].ctx.userId, 10001);
  assert.equal(seen[0].ctx.scene, 'private');

  // 工具结果以 role:'tool' 回灌
  const secondMessages = llm.calls[1].messages;
  const toolMessage = secondMessages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, '工具结果要回灌成 role:tool');
  assert.match(toolMessage.content, /hello 若华/);
  assert.equal(toolMessage.name, 'read_file');
  const assistantMessage = secondMessages.find((message) => message.role === 'assistant');
  assert.equal(assistantMessage.tool_calls[0].function.name, 'read_file');
  assert.equal(assistantMessage.tool_calls[0].function.arguments, '{"path":"a.txt"}');

  // 工具 schema 用 OpenAI function calling 格式
  assert.equal(llm.calls[0].tools[0].type, 'function');
  assert.equal(llm.calls[0].tools[0].function.name, 'read_file');
  assert.equal(llm.calls[0].role, 'agent');
  assert.ok(llm.calls[0].messages[0].content.includes('agent 工作模式'));
  assert.ok(llm.calls[0].messages[0].content.includes(config.agent.systemNote.slice(0, 6)));
  // 不许把内部独白写进最终结果
  assert.ok(llm.calls[0].messages[0].content.includes('文件已写好，现在发送给用户'), '守则里要写明不许写旁白');
  assert.ok(llm.calls[0].messages[0].content.includes('我正在'), '守则里要写明不许写旁白');
});

test('守则要求拿到成果就立刻 finish 交出去，做不完也先交已完成的部分', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const llm = createFakeLLM([{ content: '做完了' }]);
  const runner = createAgentRunner({ config, llm, tools: new Map(), logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '写一份周报', userId: 10001, scene: 'private' });
  assert.equal(task.status, 'done');

  const system = llm.calls[0].messages[0].content;
  assert.ok(system.includes('守则：'), '守则段落还在');
  assert.match(system, /finish/, '守则里要点名 finish');
  assert.match(system, /优化一下/, '要写明不许拿到成果再回头优化');
  assert.match(system, /做不完/, '一件事做不完也要先把做完的部分交出来');
});

test('工具报错后模型改主意，任务仍然完成', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([
    [
      'shell',
      fakeTool(
        'shell',
        async () => {
          const error = new Error('命令被边界拒绝：rm -rf /');
          error.name = 'ToolError';
          error.code = 'command_denied';
          throw error;
        },
        { sensitive: false },
      ),
    ],
    ['list_dir', fakeTool('list_dir', async () => ({ ok: true, entries: [{ path: 'a.txt', type: 'file' }] }))],
  ]);
  const llm = createFakeLLM([
    { content: '先清个目录', toolCalls: [callTool('shell', { command: 'rm -rf /' })] },
    { content: '换个数法', toolCalls: [callTool('list_dir', { path: '.' })] },
    { content: '目录里只有一个 a.txt' },
  ]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '看看目录里有什么', userId: 10001 });

  assert.equal(task.status, 'done');
  assert.equal(task.result, '目录里只有一个 a.txt');
  assert.equal(task.steps.length, 3);
  assert.equal(task.steps[0].error, 'command_denied');
  assert.match(task.steps[0].result, /命令被边界拒绝/);
  assert.equal(task.steps[1].error, null);
  const errorMessage = llm.calls[1].messages.find((message) => message.role === 'tool');
  assert.match(errorMessage.content, /command_denied/);
});

test('调用不存在的工具不会终止任务', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['list_dir', fakeTool('list_dir', async () => ({ ok: true }))]]);
  const llm = createFakeLLM([{ content: '试试这个', toolCalls: [callTool('no_such_tool', {})] }, { content: '没有这个工具，我改用别的办法' }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '随便做点什么', userId: 10001 });
  assert.equal(task.status, 'done');
  assert.equal(task.steps[0].error, 'unknown_tool');
  assert.match(llm.calls[1].messages.find((m) => m.role === 'tool').content, /没有叫 no_such_tool 的工具/);
});

test('步数用尽但收尾汇总给出了答复 → 记 done，不写成「没做成」', async () => {
  const config = await makeConfig({ maxSteps: 2 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['list_dir', fakeTool('list_dir', async () => ({ ok: true, entries: [] }))]]);
  const llm = createFakeLLM(({ callIndex }) =>
    callIndex < 2
      ? { content: '再查一遍', toolCalls: [callTool('list_dir', { path: '.' })] }
      : { content: '我查到的：目录是空的，还没写文件' },
  );
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '一直查下去', userId: 10001 });
  assert.equal(task.status, 'done', '成果已经交到用户手上，不该记成 failed');
  assert.equal(task.error, null);
  assert.equal(task.steps.length, 2, '收尾那一次不算新的一步');
  assert.equal(task.result, '我查到的：目录是空的，还没写文件', '最后要把已经查到的东西交给用户');

  assert.equal(llm.calls.length, 3, '触顶之后还要再问一次模型');
  assert.equal(llm.calls[2].tools, undefined, '汇总那一次不能带工具');
  const lastMessage = llm.calls[2].messages.at(-1);
  assert.equal(lastMessage.role, 'user');
  assert.match(lastMessage.content, /不能再调用任何工具/);
  assert.match(lastMessage.content, /汇总/);
  assert.ok(
    llm.calls[2].messages.some((message) => message.role === 'tool'),
    '汇总时模型还是能看到之前的观察结果',
  );
});

test('最后一步前会提醒模型收尾（真机上「活干完了没调 finish」就是这么来的）', async () => {
  const config = await makeConfig({ maxSteps: 3 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['list_dir', fakeTool('list_dir', async () => ({ ok: true, entries: [] }))]]);
  const snapshots = [];
  const llm = {
    async chat(params) {
      // runner 把同一个 messages 数组递给每一次调用，要看清「当时说了什么」得当场拍一张
      snapshots.push(params.messages.map((message) => ({ ...message })));
      if (Array.isArray(params.tools) && params.tools.length) {
        return { content: '再看一眼', toolCalls: [callTool('list_dir', { path: '.' })], usage: {}, model: 'fake', finishReason: 'tool_calls', raw: {} };
      }
      return { content: '做完了，目录是空的', toolCalls: [], usage: {}, model: 'fake', finishReason: 'stop', raw: {} };
    },
  };
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  await runner.run({ goal: '查三遍', userId: 10001 });
  const userTexts = (index) => snapshots[index].filter((message) => message.role === 'user').map((message) => message.content);
  assert.equal(
    userTexts(0).some((text) => /最后一步/.test(text)),
    false,
    '第一步不该催',
  );
  assert.equal(
    userTexts(1).some((text) => /最后一步/.test(text)),
    false,
    '倒数第二步也不催',
  );
  const last = userTexts(2).at(-1);
  assert.match(last, /最后一步/, '最后一步要提醒：干完就调用 finish');
  assert.match(last, /finish/);
});

test('步数用尽后的汇总也失败 → 退回最后一次内容，绝不丢', async () => {
  const config = await makeConfig({ maxSteps: 1 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['list_dir', fakeTool('list_dir', async () => ({ ok: true, entries: [] }))]]);
  const llm = {
    calls: [],
    async chat(params) {
      this.calls.push(params);
      if (Array.isArray(params.tools) && params.tools.length) {
        return { content: '我先看一眼目录', toolCalls: [callTool('list_dir', { path: '.' })], usage: {}, model: 'fake', finishReason: 'tool_calls', raw: {} };
      }
      throw new Error('模型这会儿不听话');
    },
  };
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '看一眼就停', userId: 10001 });
  assert.equal(task.status, 'failed');
  assert.match(task.error, /步数用尽/);
  assert.equal(task.result, '我先看一眼目录', '汇总失败就退回模型最后说的话');
  assert.equal(llm.calls.length, 2);
});

test('参数被截断的 tool_call 不执行，回一条 tool 消息让模型拆小重来', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  let executed = 0;
  const tools = new Map([
    [
      'write_file',
      fakeTool(
        'write_file',
        async (args) => {
          executed += 1;
          return { ok: true, path: args.path };
        },
        { sensitive: false, action: 'file_write' },
      ),
    ],
  ]);
  const truncatedRaw = '{"path":"a.py","content":"def main(:';
  const llm = createFakeLLM([
    {
      content: '一次写完',
      toolCalls: [
        { id: 'call_w1', name: 'write_file', arguments: { _raw: truncatedRaw }, raw: truncatedRaw, index: 0, finishReason: 'length', argumentsError: 'json_parse_failed' },
      ],
    },
    { content: '拆开写', toolCalls: [callTool('write_file', { path: 'a.py', content: 'print(1)' })] },
    { content: '写好了：a.py' },
  ]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '写个排序脚本', userId: 10001 });

  assert.equal(executed, 1, '被截断的那一次绝不能执行工具');
  assert.equal(task.steps[0].error, 'arguments_truncated');
  assert.equal(task.steps[0].args, null);
  const toolMessage = llm.calls[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /finish_reason=length/);
  assert.match(toolMessage.content, /拆小/);
  assert.equal(task.status, 'done');
  assert.equal(task.result, '写好了：a.py');
  assert.equal(task.steps.length, 3, '被截断那一步照样计入步骤');
});

test('时间用尽 → 任务以明确原因收尾', async () => {
  const config = await makeConfig({ taskTimeoutMs: 1000 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['slow', fakeTool('slow', async () => ({ ok: true }))]]);
  let callIndex = 0;
  const llm = {
    calls: [],
    async chat(params) {
      this.calls.push(params);
      callIndex += 1;
      if (callIndex > 1) await sleep(1200); // 第一次之后把时间耗光
      return { content: '', toolCalls: [callTool('slow', {})], usage: {}, model: 'fake', finishReason: 'tool_calls', raw: {} };
    },
  };
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '慢慢磨', userId: 10001 });
  assert.equal(task.status, 'failed');
  assert.match(task.error, /时间用尽/);
});

test('敏感工具被 security.verify 拒绝时不执行', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  let executed = false;
  const tools = new Map([
    [
      'shell',
      fakeTool(
        'shell',
        async () => {
          executed = true;
          return { ok: true };
        },
        { sensitive: true, action: 'shell' },
      ),
    ],
  ]);
  const verifies = [];
  const services = {
    security: {
      async verify(request) {
        verifies.push(request);
        return { ok: false, stage: 'denied', reason: '不是管理员', replyText: '这个我做不了，得主人发话' };
      },
    },
  };
  const llm = createFakeLLM([{ content: '我来执行', toolCalls: [callTool('shell', { command: 'dir' })] }, { content: '不该走到这里' }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services });

  const task = await runner.run({ goal: '删掉整个目录', userId: 12345, scene: 'group', groupId: 777 });

  assert.equal(executed, false, '验证没过多工具就不能跑');
  assert.equal(task.status, 'done');
  assert.equal(task.result, '这个我做不了，得主人发话');
  assert.equal(task.steps[0].error, 'verification_required');
  assert.equal(verifies.length, 1);
  assert.equal(verifies[0].action, 'shell');
  assert.equal(verifies[0].userId, 12345);
  assert.equal(verifies[0].groupId, 777);
  assert.match(verifies[0].request, /删掉整个目录/, 'request 要带上用户的原始请求');
  assert.equal(llm.calls.length, 1, '被拒之后不再多问模型');
});

test('口令质询（stage=challenge）时任务挂在 waiting，等用户回话', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['write_file', fakeTool('write_file', async () => ({ ok: true }), { sensitive: true, action: 'file_write' })]]);
  const services = {
    security: {
      async verify() {
        return { ok: false, stage: 'challenge', replyText: '写文件之前，先跟我说句「明月几时有」吧' };
      },
    },
  };
  const llm = createFakeLLM([{ content: '写文件', toolCalls: [callTool('write_file', { path: 'a.txt', content: 'x' })] }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services });

  const task = await runner.run({ goal: '写个文件', userId: 10001 });
  assert.equal(task.status, 'waiting');
  assert.match(task.result, /明月几时有/);
  assert.equal(task.waitReason, 'authorization', '等暗号要在任务里写明原因');
  assert.equal(registry.active().length, 1);
});

test('安全模块不存在时拒绝执行敏感工具', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  let executed = false;
  const tools = new Map([
    [
      'shell',
      fakeTool(
        'shell',
        async () => {
          executed = true;
          return { ok: true };
        },
        { sensitive: true, action: 'shell' },
      ),
    ],
  ]);
  const llm = createFakeLLM([{ content: '执行', toolCalls: [callTool('shell', { command: 'dir' })] }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '跑条命令', userId: 10001 });
  assert.equal(executed, false);
  assert.equal(task.status, 'done');
  assert.match(task.result, /安全模块不可用/);
});

test('cancel 能中断运行中的任务，AbortSignal 真的传到 ctx.signal', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  let captured = null;
  const tools = new Map([
    [
      'slow_tool',
      fakeTool('slow_tool', async (_args, ctx) => {
        captured = ctx;
        await new Promise((resolve) => {
          if (ctx.signal?.aborted) {
            resolve();
            return;
          }
          ctx.signal?.addEventListener('abort', resolve, { once: true });
          const timer = setTimeout(resolve, 3000);
          timer.unref?.();
        });
        return { ok: true, note: '被叫停了' };
      }),
    ],
  ]);
  const llm = createFakeLLM([{ content: '干起来', toolCalls: [callTool('slow_tool', {})] }, { content: '收工' }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  let taskId = null;
  const promise = runner.run({ goal: '一件很久的事', userId: 10001, onTask: (task) => (taskId = task.id) });
  assert.ok(taskId, '任务要在 run 开始时就能拿到 id');
  await waitFor(() => captured !== null);
  assert.equal(captured.signal.aborted, false);

  runner.cancel(taskId);
  const task = await promise;

  assert.equal(task.status, 'cancelled');
  assert.equal(task.error, '任务已取消');
  assert.equal(captured.signal.aborted, true, 'ctx.signal 要真的被 abort');
  assert.equal(registry.signalOf(taskId).aborted, true);
  assert.equal(runner.describe(taskId).startsWith('停下了'), true);
});

test('followUp 的追加指令出现在后续 LLM 请求里', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const gates = [];
  let started = false;
  const tools = new Map([
    [
      'wait',
      fakeTool('wait', async () => {
        started = true;
        await new Promise((resolve) => gates.push(resolve));
        return { ok: true };
      }),
    ],
  ]);
  let finalMessages = null;
  const llm = createFakeLLM(({ messages, callIndex }) => {
    if (callIndex === 0) return { content: '先等一下', toolCalls: [callTool('wait', {})] };
    finalMessages = messages;
    return { content: '好，都按你说的办了' };
  });
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  let taskId = null;
  const promise = runner.run({ goal: '整理一下目录', userId: 10001, onTask: (task) => (taskId = task.id) });
  await waitFor(() => started);
  const updated = await runner.followUp({ taskId, message: '顺便把日志也看一眼' });
  assert.match(updated.note, /顺便把日志也看一眼/);
  gates.splice(0).forEach((resolve) => resolve());

  const task = await promise;
  assert.equal(task.status, 'done');
  assert.equal(task.result, '好，都按你说的办了');
  const noteMessage = finalMessages.find((message) => typeof message.content === 'string' && message.content.includes('顺便把日志也看一眼'));
  assert.ok(noteMessage, '追加指令要进后续请求');
  assert.equal(noteMessage.role, 'user');
  assert.match(task.note, /顺便把日志也看一眼/);
});

test('用户正在对口令时，verify 收到的 request 为 null（走应答判定）', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['shell', fakeTool('shell', async () => ({ ok: true, output: '2' }), { sensitive: true, action: 'shell' })]]);
  const verifies = [];
  const state = { pending: true, attemptsLeft: 2, expiresAt: Date.now() + 60000 };
  const services = {
    security: {
      sessionState: (userId) => (userId === 10001 ? state : null),
      async verify(request) {
        verifies.push(request);
        return { ok: true, stage: 'passed', replyText: null };
      },
    },
  };
  const llm = createFakeLLM([{ content: '执行', toolCalls: [callTool('shell', { command: 'dir' })] }, { content: '跑完了' }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services });

  const task = await runner.run({ goal: '跑条命令', userId: 10001 });
  assert.equal(task.status, 'done');
  assert.equal(verifies[0].request, null, '口头应答要走应答判定');
  assert.equal(verifies[0].action, 'shell');

  // 没有待答质询时，request 带上用户的原始请求
  state.pending = false;
  const again = createAgentRunner({ config, llm: createFakeLLM([{ content: '执行', toolCalls: [callTool('shell', { command: 'dir' })] }, { content: '跑完了' }]), tools, logger: createNullLogger(), tasks: registry, services });
  await again.run({ goal: '再跑一条', userId: 10001 });
  assert.equal(verifies[1].request, '再跑一条');
});

test('finish 收尾为 done，ask_user 收尾为 waiting', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = createTools({ config, services: {} });

  const finishLlm = createFakeLLM([{ content: '看完了', toolCalls: [callTool('finish', { result: '目录里只有一个 note.txt' })] }]);
  const finishRunner = createAgentRunner({ config, llm: finishLlm, tools, logger: createNullLogger(), tasks: registry, services: {} });
  const finished = await finishRunner.run({ goal: '看看目录', userId: 10001 });
  assert.equal(finished.status, 'done');
  assert.equal(finished.result, '目录里只有一个 note.txt');
  assert.equal(finished.steps[0].tool, 'finish');
  assert.equal(finished.waitReason, null, '收尾成 done 就不该留等待原因');

  const askLlm = createFakeLLM([{ content: '得问一句', toolCalls: [callTool('ask_user', { question: '要整理哪个目录', options: ['D:/Desktop', 'D:/文档'] })] }]);
  const askRunner = createAgentRunner({ config, llm: askLlm, tools, logger: createNullLogger(), tasks: registry, services: {} });
  const asked = await askRunner.run({ goal: '整理目录', userId: 10001 });
  assert.equal(asked.status, 'waiting');
  assert.equal(asked.result, '要整理哪个目录');
  assert.equal(asked.finishedAt, null);
  assert.equal(asked.waitReason, 'answer', '问用户一句话是等回话，不是等暗号');
  assert.match(askRunner.describe(asked.id), /在等你回话/);
});

test('并发上限：同时在跑的任务数不超过 maxConcurrent，其余排队', async () => {
  const config = await makeConfig({ maxConcurrent: 2 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const gates = [];
  let live = 0;
  let peak = 0;
  const tools = new Map([
    [
      'wait',
      fakeTool('wait', async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => gates.push(resolve));
        live -= 1;
        return { ok: true };
      }),
    ],
  ]);
  const llm = createFakeLLM(({ messages }) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return { content: '这个任务做完了' };
    return { content: '等一下', toolCalls: [callTool('wait', {})] };
  });
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const promises = [];
  const settled = [];
  for (let index = 0; index < 5; index += 1) {
    const promise = runner.run({ goal: `第${index}件事`, userId: 10001 });
    promise.then((task) => settled.push(task), () => settled.push(null));
    promises.push(promise);
  }

  await waitFor(() => gates.length >= 2);
  await sleep(30);
  assert.equal(peak, 2, '同时在跑的不该超过 maxConcurrent');
  assert.equal(registry.list().filter((task) => task.status === 'running').length, 2);
  assert.equal(registry.list().filter((task) => task.status === 'waiting').length, 3);
  assert.equal(runner.stats().queued, 3);

  const deadline = Date.now() + 5000;
  while (settled.length < 5 && Date.now() < deadline) {
    gates.splice(0).forEach((resolve) => resolve());
    await sleep(10);
  }
  gates.splice(0).forEach((resolve) => resolve());

  const tasks = await Promise.all(promises);
  assert.equal(tasks.filter((task) => task.status === 'done').length, 5);
  assert.ok(peak <= config.agent.maxConcurrent);
  assert.equal(runner.stats().active, 0);
  assert.equal(runner.stats().queued, 0);
});

test('describe 给出人类可读的进度文本', async () => {
  const config = await makeConfig({ progressEverySteps: 1, maxSteps: 4 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['list_dir', fakeTool('list_dir', async () => ({ ok: true, entries: [] }))]]);
  const llm = createFakeLLM([{ content: '先列目录', toolCalls: [callTool('list_dir', { path: '.' })] }, { content: '目录是空的' }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const notes = [];
  let runningText = null;
  const task = await runner.run({
    goal: '整理文件清单',
    userId: 10001,
    onProgress: (current, note) => {
      notes.push(note);
      if (current.status === 'running') runningText = runner.describe(current.id);
    },
  });

  assert.equal(notes.length, 1);
  assert.match(notes[0], /正在做：整理文件清单（已走 1 步/);
  assert.ok(!notes[0].includes('先列目录'), '进度只许来自模板，不能把模型说的话塞进去');
  assert.match(runningText, /^正在做：整理文件清单（已走 1 步）/);
  assert.equal(runner.describe(task.id), '做完了：整理文件清单（共 2 步）');
  assert.equal(runner.describe('没有的任务'), '找不到这个任务');
  assert.equal(runner.status(task.id), task);

  const queued = registry.create({ goal: '排在后面的任务', userId: 1, status: 'waiting' });
  assert.match(runner.describe(queued.id), /排队等着做/);
});

test('工具结果超过 toolResultMaxChars 会被截断并注明', async () => {
  const config = await makeConfig({ toolResultMaxChars: 300 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const tools = new Map([['big', fakeTool('big', async () => ({ ok: true, content: '甲'.repeat(5000) }))]]);
  const llm = createFakeLLM([{ content: '读个大的', toolCalls: [callTool('big', {})] }, { content: '读完了' }]);
  const runner = createAgentRunner({ config, llm, tools, logger: createNullLogger(), tasks: registry, services: {} });

  const task = await runner.run({ goal: '读个大文件', userId: 10001 });
  assert.equal(task.status, 'done');
  const toolMessage = llm.calls[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.length < 500);
  assert.match(toolMessage.content, /已截断/);
  assert.match(task.steps[0].result, /已截断/);
});

test('waitReason 落盘再读回来还在，轮次口径一致', async () => {
  const dir = await tempDir('ruohua-tasks-');
  const registry = createTaskRegistry({ logger: createNullLogger(), dir, maxSteps: 4 });
  const task = registry.create({ goal: '截屏并识图', userId: 10001, status: 'waiting', waitReason: 'authorization', maxSteps: 4 });
  registry.addStep(task.id, { index: 1, tool: 'screen_capture' });
  registry.addStep(task.id, { index: 1, tool: 'see_image' });
  await registry.save();

  const reloaded = createTaskRegistry({ logger: createNullLogger(), dir, maxSteps: 4 });
  await reloaded.ready;
  const back = reloaded.get(task.id);
  assert.ok(back, '任务要读回来');
  assert.equal(back.waitReason, 'authorization', '等暗号的原因不能被落盘丢掉');
  assert.equal(back.steps.length, 2);
  assert.equal(back.rounds, 1);
  assert.equal(back.progress, 0.25);
});

test('describe 与进度都按「轮次」算：同一个 index 只算一步', async () => {
  const config = await makeConfig({ maxSteps: 4 });
  const registry = createTaskRegistry({ logger: createNullLogger() });
  const runner = createAgentRunner({ config, llm: createFakeLLM([{ content: '好' }]), tools: new Map(), logger: createNullLogger(), tasks: registry, services: {} });

  const task = registry.create({ goal: '并行看两眼', userId: 10001, status: 'running', maxSteps: 4 });
  registry.addStep(task.id, { index: 1, thought: '先想', tool: 'list_dir' });
  registry.addStep(task.id, { index: 1, thought: '先想', tool: 'system_status' });

  assert.equal(task.steps.length, 2, '一步里调了两个工具');
  assert.equal(task.rounds, 1, '轮次只算一步');
  assert.equal(task.progress, 0.25);
  assert.equal(runner.describe(task.id), '正在做：并行看两眼（已走 1 步）');
});
