/** 聊天里的工具环：她要能自己去查（查完照常回话），敏感工具照旧过口令，步数用尽要收尾而不是丢结果。 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChatToolLoop } from '../../src/brain/chat.js';
import { createTools } from '../../src/agent/tools/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createNullLogger } from '../../src/logging/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  const tmp = await tempDir('ruohua-chat-');
  return loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: {
      bot: { dataDir: tmp },
      model: { apiKey: 'test-key' },
      security: { admins: [10001], boundary: { workspaceRoot: tmp } },
      agent: agentOverrides,
    },
  });
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

/** 脚本化的假模型：按脚本依次返回，用完了重复最后一条。 */
function createFakeLLM(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(params) {
      calls.push(params);
      const item = typeof script === 'function' ? script({ ...params, callIndex: index }) : script[Math.min(index, script.length - 1)];
      index += 1;
      return {
        content: item?.content ?? '',
        toolCalls: item?.toolCalls ?? [],
        json: null,
        usage: {},
        model: 'fake-model',
        finishReason: item?.toolCalls?.length ? 'tool_calls' : 'stop',
        raw: {},
      };
    },
  };
}

function callTool(name, args = {}) {
  return { id: `call_${name}`, name, arguments: args, raw: JSON.stringify(args) };
}

const MESSAGES = [
  { role: 'system', content: '你是若华。' },
  { role: 'user', content: '这台机器现在什么情况？' },
];

test('要查就先查：工具真的跑了，结果回灌之后才给答复', async () => {
  const config = await makeConfig();
  const ran = [];
  const tools = new Map([
    [
      'system_status',
      fakeTool('system_status', async () => {
        ran.push('system_status');
        return { ok: true, status: '一切正常，OneBot 已连接' };
      }),
    ],
  ]);
  const llm = createFakeLLM([
    { content: '我看一下', toolCalls: [callTool('system_status', {})] },
    { content: '都好着呢，OneBot 连着。' },
  ]);
  const loop = createChatToolLoop({ config, llm, tools, logger: createNullLogger(), services: {} });

  const outcome = await loop.run({ messages: MESSAGES, ctx: { userId: 10001, scene: 'private' } });

  assert.deepEqual(ran, ['system_status'], '工具要真的跑一次');
  assert.equal(outcome.content, '都好着呢，OneBot 连着。');
  assert.equal(outcome.steps, 1);
  assert.equal(llm.calls.length, 2, '一次要工具、一次给答复');
  assert.ok(llm.calls[0].tools?.some((tool) => tool.function.name === 'system_status'), '聊天里也要把工具交给模型');
  const toolTurn = llm.calls[1].messages.find((message) => message.role === 'tool');
  assert.match(toolTurn.content, /OneBot 已连接/, '工具结果要回灌给模型');
});

test('聊天里不给 finish / ask_user：那是任务收尾和挂起用的', async () => {
  const config = await makeConfig();
  const llm = createFakeLLM([{ content: '在呢' }]);
  const loop = createChatToolLoop({ config, llm, tools: createTools({ config, services: {} }), logger: createNullLogger(), services: {} });

  await loop.run({ messages: MESSAGES, ctx: { userId: 10001 } });

  const names = llm.calls[0].tools.map((tool) => tool.function.name);
  assert.ok(names.includes('read_file') && names.includes('web_search') && names.includes('shell'), '查东西、跑命令的工具都在');
  assert.ok(!names.includes('finish') && !names.includes('ask_user'));
});

test('敏感工具被口令拦住：工具不执行，问话交回调用方', async () => {
  const config = await makeConfig();
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
  const llm = createFakeLLM([{ content: '我跑一下', toolCalls: [callTool('shell', { command: 'dir' })] }]);
  const services = {
    security: {
      async verify() {
        return { ok: false, stage: 'challenge', replyText: '老规矩，说句「明月几时有」' };
      },
    },
  };
  const loop = createChatToolLoop({ config, llm, tools, logger: createNullLogger(), services });

  const outcome = await loop.run({ messages: MESSAGES, ctx: { userId: 10001, requestText: '跑个 dir' } });

  assert.equal(executed, false, '口令没过就不能跑');
  assert.equal(outcome.blocked?.tool, 'shell');
  assert.match(outcome.blocked.replyText, /明月几时有/);
});

test('步数用尽：最后不再给工具，用已经查到的内容把话说完', async () => {
  const config = await makeConfig({ chatMaxSteps: 1 });
  const tools = new Map([['system_status', fakeTool('system_status', async () => ({ ok: true, status: '内存 32G' }))]]);
  const llm = createFakeLLM([
    { content: '我看看', toolCalls: [callTool('system_status', {})] },
    { content: '内存 32G，够用。' },
  ]);
  const loop = createChatToolLoop({ config, llm, tools, logger: createNullLogger(), services: {} });

  const outcome = await loop.run({ messages: MESSAGES, ctx: { userId: 10001 } });

  assert.equal(outcome.content, '内存 32G，够用。');
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[1].tools, undefined, '收尾那次不再给工具');
  assert.ok(llm.calls[1].messages.some((message) => message.role === 'tool'), '已经查到的结果还在上下文里');
});

test('关掉 agent.chatTools 就不带工具；maxSteps 归零也一样', async () => {
  const off = await makeConfig({ chatTools: false });
  const zero = await makeConfig({ chatMaxSteps: 0 });
  const llm = createFakeLLM([{ content: '在呢' }]);
  const tools = new Map([['system_status', fakeTool('system_status', async () => ({ ok: true }))]]);

  assert.equal(createChatToolLoop({ config: off, llm, tools, logger: createNullLogger(), services: {} }).enabled, false);
  assert.equal(createChatToolLoop({ config: zero, llm, tools, logger: createNullLogger(), services: {} }).enabled, false);
  assert.equal(createChatToolLoop({ config: await makeConfig(), llm, tools, logger: createNullLogger(), services: {} }).enabled, true);
});
