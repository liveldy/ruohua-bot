/** 模型客户端测试：用本地假服务验证流式、工具调用、JSON、重试与用量统计。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMClient } from '../../src/llm/client.js';
import { createNullLogger } from '../../src/logging/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function baseConfig(baseUrl, overrides = {}) {
  return {
    env: { ALLOW_EMPTY_API_KEY: '1' },
    model: {
      baseUrl,
      apiKey: 'test-key',
      model: 'test-model',
      visionModel: '',
      temperature: 0.5,
      maxTokens: 256,
      timeoutMs: 5000,
      stream: true,
      retry: { times: 1, baseDelayMs: 10 },
      roles: { decision: { temperature: 0.1, stream: false } },
      balance: { enabled: false },
      offline: false,
      ...overrides,
    },
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')));
  });
}

test('chat：非流式返回内容与用量', async () => {
  const seen = [];
  const { baseUrl, close } = await startServer(async (req, res) => {
    const body = await readBody(req);
    seen.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: '知道了' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
  });
  try {
    const llm = createLLMClient({ config: baseConfig(baseUrl, { stream: false }), logger: createNullLogger() });
    const result = await llm.chat({ messages: [{ role: 'user', content: '在吗' }] });
    assert.equal(result.content, '知道了');
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 3, totalTokens: 13 });
    assert.equal(llm.usageTotals().totalTokens, 13);
    assert.equal(seen[0].model, 'test-model');
    await close();
  } finally {
    await close().catch(() => {});
  }
});

test('chat：流式 + onDelta 逐段回调', async () => {
  const { baseUrl, close } = await startServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = [
      { choices: [{ delta: { content: '我' } }] },
      { choices: [{ delta: { content: '来了' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const llm = createLLMClient({ config: baseConfig(baseUrl), logger: createNullLogger() });
    const chunks = [];
    const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: (text) => chunks.push(text) });
    assert.equal(result.content, '我来了');
    assert.deepEqual(chunks, ['我', '来了']);
    assert.equal(result.usage.totalTokens, 7);
  } finally {
    await close().catch(() => {});
  }
});

test('chat：工具调用参数是对象，JSON 模式解析出结构', async () => {
  let call = 0;
  const { baseUrl, close } = await startServer(async (req, res) => {
    const body = await readBody(req);
    call += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (body.tools) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '{"mode":"agent","goal":"整理","confidence":0.8}' }, finish_reason: 'stop' }] }));
  });
  try {
    const llm = createLLMClient({ config: baseConfig(baseUrl, { stream: false }), logger: createNullLogger() });
    const toolResult = await llm.chat({ messages: [{ role: 'user', content: '列目录' }], tools: [{ type: 'function', function: { name: 'list_dir' } }] });
    assert.equal(toolResult.toolCalls[0].name, 'list_dir');
    assert.deepEqual(toolResult.toolCalls[0].arguments, { path: '.' });

    const jsonResult = await llm.chat({ messages: [{ role: 'user', content: '判断' }], json: true });
    assert.equal(jsonResult.json.mode, 'agent');
    assert.equal(call, 2);
  } finally {
    await close().catch(() => {});
  }
});

test('chat：上游 5xx 会重试，然后成功', async () => {
  let attempts = 0;
  const { baseUrl, close } = await startServer(async (req, res) => {
    await readBody(req);
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(500).end('boom');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '好了' }, finish_reason: 'stop' }] }));
  });
  try {
    const llm = createLLMClient({ config: baseConfig(baseUrl, { stream: false }), logger: createNullLogger() });
    const result = await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(result.content, '好了');
    assert.equal(attempts, 2);
  } finally {
    await close().catch(() => {});
  }
});

test('chat：非流式也会把整段内容交给 onDelta；角色参数生效', async () => {
  let body = null;
  const { baseUrl, close } = await startServer(async (req, res) => {
    body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '嗯' }, finish_reason: 'stop' }] }));
  });
  try {
    const llm = createLLMClient({ config: baseConfig(baseUrl), logger: createNullLogger() });
    const deltas = [];
    await llm.chat({ role: 'decision', messages: [{ role: 'user', content: 'x' }], onDelta: (t) => deltas.push(t) });
    assert.deepEqual(deltas, ['嗯']);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.stream, false);
  } finally {
    await close().catch(() => {});
  }
});

test('chat：离线模式直接拒绝', async () => {
  const llm = createLLMClient({ config: baseConfig('http://127.0.0.1:1/v1', { offline: true }), logger: createNullLogger() });
  await assert.rejects(() => llm.chat({ messages: [] }), (error) => {
    assert.equal(error.name, 'LLMError');
    assert.equal(error.code, 'offline');
    return true;
  });
});

test('chat：工具参数被截断时标出 argumentsError，并 warn 出工具名 / 长度 / finish_reason', async () => {
  const warns = [];
  const logger = {
    child: () => logger,
    debug() {},
    info() {},
    warn: (message) => warns.push(String(message)),
    error() {},
  };
  const truncated = '{"path":"a.py","content":"def main(:';
  let call = 0;
  const { baseUrl, close } = await startServer(async (req, res) => {
    await readBody(req);
    call += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const toolCall =
      call === 1
        ? { id: 'c1', type: 'function', function: { name: 'write_file', arguments: truncated } }
        : { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } };
    res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [toolCall] }, finish_reason: 'length' }] }));
  });
  try {
    const llm = createLLMClient({ config: baseConfig(baseUrl, { stream: false }), logger });

    const first = await llm.chat({ messages: [{ role: 'user', content: '写文件' }], tools: [{ type: 'function', function: { name: 'write_file' } }] });
    const truncatedCall = first.toolCalls[0];
    assert.equal(truncatedCall.name, 'write_file');
    assert.equal(truncatedCall.argumentsError, 'json_parse_failed', '解析失败要标出来，不能静默降级');
    assert.equal(truncatedCall.finishReason, 'length');
    assert.equal(truncatedCall.raw, truncated, '原始 arguments 要留着');
    assert.deepEqual(truncatedCall.arguments, { _raw: truncated }, '现有字段保持不变');

    assert.equal(warns.length, 1, '解析失败要 warn 一次');
    assert.ok(warns[0].includes('write_file'), `warn 里要有工具名：${warns[0]}`);
    assert.ok(warns[0].includes('finish_reason=length'), `warn 里要有 finish_reason：${warns[0]}`);
    assert.ok(warns[0].includes(String(truncated.length)), `warn 里要有 arguments 长度：${warns[0]}`);
    assert.ok(warns[0].includes(truncated.slice(0, 30)), 'warn 里要有前 200 字符的开头');

    // 参数本身是合法 JSON，但上游说 length：也要 warn（只是不报解析失败）
    const second = await llm.chat({ messages: [{ role: 'user', content: '列目录' }], tools: [{ type: 'function', function: { name: 'list_dir' } }] });
    assert.equal(second.toolCalls[0].argumentsError, null);
    assert.deepEqual(second.toolCalls[0].arguments, { path: '.' });
    assert.equal(warns.length, 2);
    assert.ok(warns[1].includes('list_dir'), `warn 里要有工具名：${warns[1]}`);
    assert.ok(warns[1].includes('finish_reason=length'));
  } finally {
    await close().catch(() => {});
  }
});

test('vision：没配 visionModel 就用主模型识图', async () => {
  let body = null;
  const { baseUrl, close } = await startServer(async (req, res) => {
    body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '一张笑脸。' }, finish_reason: 'stop' }] }));
  });
  try {
    // config/model.json 出厂就是 visionModel: ''，这时候必须拿主模型去识图
    const llm = createLLMClient({ config: baseConfig(baseUrl, { stream: false }), logger: createNullLogger() });
    assert.equal(await llm.vision({ prompt: '这是什么', images: ['data:image/png;base64,AAAA'] }), '一张笑脸。');
    assert.equal(body.model, 'test-model');
  } finally {
    await close().catch(() => {});
  }
});

test('vision：主模型与 visionModel 都空时才如实说「没有能看图的模型」', async () => {
  const llm = createLLMClient({ config: baseConfig('http://127.0.0.1:9/v1', { model: '', stream: false }), logger: createNullLogger() });
  await assert.rejects(
    () => llm.vision({ prompt: '看图', images: ['data:image/png;base64,AAAA'] }),
    (error) => error.code === 'vision_unsupported',
  );
});

test('chat：agent 角色的 maxTokens 来自配置（config/model.json 是 8192）', async () => {
  const shipped = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'model.json'), 'utf8'));
  assert.equal(shipped.roles.agent.maxTokens, 8192, 'deepseek-chat 的最大输出就是 8192');

  let body = null;
  const { baseUrl, close } = await startServer(async (req, res) => {
    body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] }));
  });
  try {
    const llm = createLLMClient({
      config: baseConfig(baseUrl, { stream: false, roles: { agent: { maxTokens: 8192 } } }),
      logger: createNullLogger(),
    });
    await llm.chat({ role: 'agent', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(body.max_tokens, 8192);
  } finally {
    await close().catch(() => {});
  }
});
