/**
 * tools/dev/mock-llm.js 的单元测试：默认应答、脚本应答、流式、usage 统计，
 * 并用 src/llm/client.js 做一次真实对接（同一份协议）。
 * mock 跑在子进程里，端口由系统分配。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createLLMClient } from '../../src/llm/client.js';
import {
  getFreePorts,
  httpJson,
  llmConfig,
  parseSse,
  removeDir,
  spawnMock,
  startMockLlm,
  stubLogger,
  tempDir,
  waitForExit,
  writeJsonFile,
} from './harness.js';

const SCRIPT = {
  rules: [
    { match: '决策', matchOn: 'any', content: '{"mode":"chat","reply":"嗯，我在","reason":"rule-mock","confidence":0.8}' },
    { match: '/^列表/', content: '正则命中' },
    { match: '坏JSON', content: '这不是 JSON' },
    { match: '给对象', json: { mode: 'work', reply: '这就去做', steps: 2 } },
    { match: '看目录', tool_calls: [{ name: 'list_dir', arguments: { path: '.' } }] },
    {
      match: '两个工具',
      tool_calls: [
        { name: 'list_dir', arguments: { path: '.' } },
        { name: 'read_file', arguments: { path: 'a.txt' } },
      ],
    },
  ],
  sequence: [
    { content: '第一句' },
    { content: '第二步', tool_calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
  ],
  default: { content: '兜底答复' },
};

function chat(mock, content, extra = {}) {
  return httpJson(`${mock.baseUrl}/chat/completions`, {
    method: 'POST',
    body: { model: 'mock-chat', messages: [{ role: 'user', content }], stream: false, ...extra },
  });
}

function streamChat(mock, content, extra = {}) {
  return fetch(`${mock.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content }], stream: true, ...extra }),
  });
}

test('mock-llm：默认应答与 usage 统计', async (t) => {
  const mock = await startMockLlm();
  try {
    await t.test('/health 与 /v1/models', async () => {
      const health = (await httpJson(`${mock.httpUrl}/health`)).json;
      assert.equal(health.ok, true);
      assert.equal(health.service, 'mock-llm');
      assert.equal(health.model, 'mock-chat');
      assert.equal(health.scriptLoaded, false);

      const models = (await httpJson(`${mock.baseUrl}/models`)).json;
      assert.equal(models.object, 'list');
      assert.ok(models.data.some((row) => row.id === 'mock-chat'));
      assert.ok(models.data.some((row) => row.id === 'mock-vision'));
    });

    await t.test('非流式：中文短回复 + 合法 usage', async () => {
      const response = await httpJson(`${mock.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-super-secret' },
        body: {
          model: 'mock-chat',
          messages: [
            { role: 'system', content: '你是若华' },
            { role: 'user', content: '你好呀' },
          ],
          temperature: 0.8,
          max_tokens: 128,
        },
      });
      assert.equal(response.status, 200);
      const payload = response.json;
      assert.equal(payload.object, 'chat.completion');
      assert.equal(payload.model, 'mock-chat');
      assert.equal(payload.choices.length, 1);
      assert.equal(payload.choices[0].message.role, 'assistant');
      assert.equal(payload.choices[0].message.tool_calls, undefined);
      assert.equal(payload.choices[0].finish_reason, 'stop');
      const content = payload.choices[0].message.content;
      assert.equal(typeof content, 'string');
      assert.ok(content.length > 0);
      assert.ok(Array.from(content).length <= 40, `默认回复应短：${content}`);
      assert.match(content, /[，。？！…]/);
      assert.ok(payload.usage.prompt_tokens > 0);
      assert.ok(payload.usage.completion_tokens > 0);
      assert.equal(payload.usage.total_tokens, payload.usage.prompt_tokens + payload.usage.completion_tokens);
    });

    await t.test('stream:true 走 SSE，include_usage 时末尾给 usage 帧', async () => {
      const plain = await chat(mock, '你好呀');
      const expected = plain.json.choices[0].message.content;

      const response = await streamChat(mock, '你好呀', { stream_options: { include_usage: true } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const parsed = parseSse(await response.text());
      assert.equal(parsed.done, true);
      assert.ok(parsed.frames.length >= 3, `应有多个 chunk：${parsed.frames.length}`);
      assert.equal(parsed.frames[0].object, 'chat.completion.chunk');
      assert.equal(parsed.frames[0].choices[0].delta.role, 'assistant');
      const assembled = parsed.frames.map((frame) => frame.choices?.[0]?.delta?.content ?? '').join('');
      assert.equal(assembled, expected);
      const contentFrames = parsed.frames.filter((frame) => frame.choices?.[0]?.delta?.content);
      assert.ok(contentFrames.length >= 2, '内容应被切成多个 chunk');
      const last = parsed.frames.at(-1);
      assert.deepEqual(last.choices, []);
      assert.ok(last.usage.total_tokens > 0);
      assert.equal(parsed.frames.at(-2).choices[0].finish_reason, 'stop');

      const noUsage = await streamChat(mock, '你好呀');
      const parsedNoUsage = parseSse(await noUsage.text());
      assert.equal(parsedNoUsage.done, true);
      assert.ok(parsedNoUsage.frames.every((frame) => frame.usage === undefined), '未请求 include_usage 时不应给 usage 帧');
    });

    await t.test('请求体非法返回 400', async () => {
      const badJson = await httpJson(`${mock.baseUrl}/chat/completions`, { method: 'POST', raw: '这不是 JSON' });
      assert.equal(badJson.status, 400);
      assert.equal(badJson.json.error.type, 'invalid_request_error');

      const noMessages = await httpJson(`${mock.baseUrl}/chat/completions`, { method: 'POST', body: { model: 'mock-chat' } });
      assert.equal(noMessages.status, 400);
      assert.match(noMessages.json.error.message, /messages/);
    });

    await t.test('GET /usage 记录请求与打码的 Authorization，DELETE /usage 清空', async () => {
      await httpJson(`${mock.httpUrl}/usage`, { method: 'DELETE' });
      const cleared = (await httpJson(`${mock.httpUrl}/usage`)).json;
      assert.equal(cleared.requests, 0);
      assert.equal(cleared.lastRequest, null);
      assert.equal(cleared.lastRequestHeaders, null);

      const messages = [
        { role: 'system', content: '你是若华' },
        { role: 'user', content: '帮我看看日志' },
      ];
      const response = await httpJson(`${mock.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-super-secret', 'X-Ruohua-Role': 'decision' },
        body: { model: 'mock-chat', messages },
      });
      assert.equal(response.status, 200);

      const usage = (await httpJson(`${mock.httpUrl}/usage`)).json;
      assert.equal(usage.requests, 1);
      assert.equal(usage.streams, 0);
      assert.equal(usage.byRole.decision, 1);
      assert.deepEqual(usage.lastRequest.messages, messages);
      assert.equal(usage.lastRequest.stream, false);
      assert.equal(usage.lastRequest.model, 'mock-chat');
      assert.equal(usage.lastRequest.json, false);
      assert.equal(usage.lastRequestHeaders.authorizationPresent, true);
      assert.equal(usage.lastRequestHeaders.authorization, 'Bearer ***');
      assert.ok(!JSON.stringify(usage).includes('sk-super-secret'), 'usage 里不应泄漏原始 token');
      assert.ok(usage.lastResponse.content.length > 0);

      await chat(mock, '再说一句');
      const usage2 = (await httpJson(`${mock.httpUrl}/usage`)).json;
      assert.equal(usage2.requests, 2);
      assert.equal(usage2.byRole.default, 1);
      assert.equal(usage2.lastRequestHeaders.authorizationPresent, false);
      assert.equal(usage2.lastRequestHeaders.authorization, null);

      await streamChat(mock, '流式一下', { stream_options: { include_usage: true } });
      const usage3 = (await httpJson(`${mock.httpUrl}/usage`)).json;
      assert.equal(usage3.requests, 3);
      assert.equal(usage3.streams, 1);
      assert.equal(usage3.lastRequest.stream, true);

      const cleared2 = (await httpJson(`${mock.httpUrl}/usage`, { method: 'DELETE' })).json;
      assert.equal(cleared2.requests, 0);
      assert.equal((await httpJson(`${mock.httpUrl}/usage`)).json.requests, 0);
    });

    await t.test('POST /script 运行时装载，DELETE /script 卸载', async () => {
      const loaded = await httpJson(`${mock.httpUrl}/script`, {
        method: 'POST',
        body: { rules: [{ match: '测试', content: '脚本生效' }], default: { content: '兜底' } },
      });
      assert.equal(loaded.status, 200);
      assert.equal(loaded.json.rules, 1);
      assert.equal(loaded.json.hasDefault, true);

      assert.equal((await chat(mock, '这是一次测试')).json.choices[0].message.content, '脚本生效');
      assert.equal((await chat(mock, '别的话')).json.choices[0].message.content, '兜底');

      const removed = await httpJson(`${mock.httpUrl}/script`, { method: 'DELETE' });
      assert.equal(removed.json.ok, true);
      const restored = (await chat(mock, '别的话')).json.choices[0].message.content;
      assert.notEqual(restored, '兜底');
      assert.ok(restored.length > 0);
      assert.equal((await httpJson(`${mock.httpUrl}/health`)).json.scriptLoaded, false);
    });
  } finally {
    await mock.stop();
    assert.ok(mock.exitInfo, 'mock-llm 子进程应已退出');
  }
});

test('mock-llm：脚本应答（rules / sequence / tool_calls / json）', async (t) => {
  const dir = await tempDir();
  const scriptFile = path.join(dir, 'script.json');
  await writeJsonFile(scriptFile, SCRIPT);
  const mock = await startMockLlm({ scriptPath: scriptFile });
  try {
    await t.test('sequence 按调用顺序消费，用尽后回落到 default', async () => {
      const first = await chat(mock, '随便聊两句');
      assert.equal(first.json.choices[0].message.content, '第一句');
      assert.equal(first.json.choices[0].finish_reason, 'stop');
      assert.equal((await httpJson(`${mock.httpUrl}/usage`)).json.lastResponse.source, 'sequence:1');

      const second = await chat(mock, '再接着说');
      assert.equal(second.json.choices[0].message.content, '第二步');
      assert.equal(second.json.choices[0].finish_reason, 'tool_calls');
      assert.equal((await httpJson(`${mock.httpUrl}/usage`)).json.lastResponse.source, 'sequence:2');

      const third = await chat(mock, '还说点什么');
      assert.equal(third.json.choices[0].message.content, '兜底答复');
      assert.equal((await httpJson(`${mock.httpUrl}/usage`)).json.lastResponse.source, 'default');
    });

    await t.test('rules：子串与正则匹配都生效', async () => {
      assert.equal((await chat(mock, '这里有个坏JSON')).json.choices[0].message.content, '这不是 JSON');
      assert.equal((await chat(mock, '列表里有什么')).json.choices[0].message.content, '正则命中');
      assert.equal((await chat(mock, '帮我决策一下')).json.choices[0].message.content, '{"mode":"chat","reply":"嗯，我在","reason":"rule-mock","confidence":0.8}');
    });

    await t.test('tool_calls 按 OpenAI 格式返回', async () => {
      const response = await chat(mock, '看目录');
      const message = response.json.choices[0].message;
      assert.equal(response.json.choices[0].finish_reason, 'tool_calls');
      assert.equal(message.tool_calls.length, 1);
      assert.deepEqual(message.tool_calls[0], {
        id: 'call_mock_1',
        type: 'function',
        function: { name: 'list_dir', arguments: '{"path":"."}' },
      });
      assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { path: '.' });
    });

    await t.test('stream:true 时 tool_calls 分片下发', async () => {
      const response = await streamChat(mock, '两个工具', { stream_options: { include_usage: true } });
      const parsed = parseSse(await response.text());
      const calls = new Map();
      for (const frame of parsed.frames) {
        for (const delta of frame.choices?.[0]?.delta?.tool_calls ?? []) {
          const slot = delta.index ?? 0;
          const current = calls.get(slot) ?? { id: null, name: '', arguments: '' };
          if (delta.id) current.id = delta.id;
          if (delta.function?.name) current.name = delta.function.name;
          if (delta.function?.arguments) current.arguments += delta.function.arguments;
          calls.set(slot, current);
        }
      }
      assert.equal(calls.size, 2);
      assert.equal(calls.get(0).name, 'list_dir');
      assert.deepEqual(JSON.parse(calls.get(0).arguments), { path: '.' });
      assert.equal(calls.get(1).name, 'read_file');
      assert.deepEqual(JSON.parse(calls.get(1).arguments), { path: 'a.txt' });
      assert.equal(parsed.frames.at(-2).choices[0].finish_reason, 'tool_calls');
      assert.ok(parsed.frames.at(-1).usage.total_tokens > 0);
    });

    await t.test('response_format.json_object：坏 JSON 原样返回，json 字段给合法 JSON', async () => {
      const broken = await chat(mock, '坏JSON', { response_format: { type: 'json_object' } });
      assert.equal(broken.json.choices[0].message.content, '这不是 JSON');
      assert.throws(() => JSON.parse(broken.json.choices[0].message.content));
      assert.equal((await httpJson(`${mock.httpUrl}/usage`)).json.lastRequest.json, true);

      const object = await chat(mock, '给对象', { response_format: { type: 'json_object' } });
      assert.deepEqual(JSON.parse(object.json.choices[0].message.content), { mode: 'work', reply: '这就去做', steps: 2 });

      // 未声明 json_object 时同样返回脚本内容
      const plain = await chat(mock, '给对象');
      assert.deepEqual(JSON.parse(plain.json.choices[0].message.content), { mode: 'work', reply: '这就去做', steps: 2 });
    });

    await t.test('与 src/llm/client.js 真实对接：流式、工具调用、JSON', async () => {
      // 重置脚本（同时把 sequence 指针归零）
      const reloaded = await httpJson(`${mock.httpUrl}/script`, { method: 'POST', body: SCRIPT });
      assert.equal(reloaded.status, 200);

      const llm = createLLMClient({ config: llmConfig({ baseUrl: mock.baseUrl }), logger: stubLogger() });

      const deltas = [];
      const streamed = await llm.chat({ messages: [{ role: 'user', content: '随便聊两句' }], role: 'chat', onDelta: (text) => deltas.push(text) });
      assert.equal(streamed.content, '第一句');
      assert.equal(deltas.join(''), '第一句');
      assert.equal(streamed.finishReason, 'stop');
      assert.ok(streamed.usage.totalTokens > 0);
      assert.equal(streamed.model, 'mock-chat');

      const toolResult = await llm.chat({ messages: [{ role: 'user', content: '看目录' }], role: 'agent', stream: false });
      assert.equal(toolResult.finishReason, 'tool_calls');
      assert.equal(toolResult.toolCalls.length, 1);
      assert.equal(toolResult.toolCalls[0].name, 'list_dir');
      assert.deepEqual(toolResult.toolCalls[0].arguments, { path: '.' });
      assert.equal(toolResult.toolCalls[0].raw, '{"path":"."}');

      const jsonResult = await llm.chat({ messages: [{ role: 'user', content: '帮我决策一下' }], role: 'decision', json: true, stream: false });
      assert.deepEqual(jsonResult.json, { mode: 'chat', reply: '嗯，我在', reason: 'rule-mock', confidence: 0.8 });

      const totals = llm.usageTotals();
      assert.equal(totals.requests, 3);
      assert.ok(totals.totalTokens > 0);
      assert.equal(totals.byModel['mock-chat'].requests, 3);
    });
  } finally {
    await mock.stop();
    await removeDir(dir);
  }
});

test('mock-llm：脚本文件读取失败时立即退出并报错', async () => {
  const [port] = await getFreePorts(1);
  const handle = spawnMock('mock-llm.js', ['--port', String(port), '--script', path.join('不存在的目录', 'script.json')]);
  try {
    const info = await waitForExit(handle);
    assert.notEqual(info.code, 0);
    assert.match(handle.output(), /读取脚本失败/);
  } finally {
    await handle.stop();
  }
});
