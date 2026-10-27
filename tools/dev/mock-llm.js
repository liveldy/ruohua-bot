#!/usr/bin/env node
/**
 * 模拟 OpenAI 兼容接口（/v1/chat/completions），供本地开发与测试使用。
 *
 *   node tools/dev/mock-llm.js --port 3903 [--script <file.json>] [--quiet]
 *
 * 无 script 时按最后一条 user 消息回一段中文短回复（人设：短句、逗号断句），用于人工试跑；
 * 有 script 时按脚本应答（rules / sequence / default），支持 tool_calls、JSON 对象与 SSE 流式。
 * 脚本格式与用法见 tools/dev/README.md。
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HELP = `用法：node tools/dev/mock-llm.js [选项]

选项：
  --port <n>       监听端口（默认 3000）
  --host <ip>      监听地址（默认 127.0.0.1）
  --script <file>  JSON 应答脚本（也可用环境变量 RUOHUA_MOCK_LLM_SCRIPT）
  --model <name>   默认模型名（默认 mock-chat）
  --chunk-size <n> 流式每个 chunk 的字符数（默认 8）
  --quiet          不打日志
  -h, --help       显示本帮助

接口：
  POST   /v1/chat/completions   对话（支持 stream / tools / response_format.json_object）
  GET    /v1/models             假模型列表
  GET    /usage                 计数与最后一次请求（含打码后的请求头）
  DELETE /usage                 清空计数
  POST   /script                运行时装载脚本（body 为脚本对象）
  DELETE /script                卸载脚本
  GET    /health
`;

export function parseArgs(argv = []) {
  const options = { port: 3000, host: '127.0.0.1', script: process.env.RUOHUA_MOCK_LLM_SCRIPT ?? null, model: 'mock-chat', chunkSize: 8, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === '--port' || arg === '-p') options.port = Number(value());
    else if (arg === '--host') options.host = String(value() ?? '');
    else if (arg === '--script') options.script = String(value() ?? '');
    else if (arg === '--model') options.model = String(value() ?? '');
    else if (arg === '--chunk-size') options.chunkSize = Number(value());
    else if (arg === '--quiet' || arg === '-q') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (String(arg).startsWith('-')) throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) throw new Error(`--port 非法：${options.port}`);
  if (!Number.isInteger(options.chunkSize) || options.chunkSize < 1) throw new Error(`--chunk-size 非法：${options.chunkSize}`);
  return options;
}

export async function loadScript(file) {
  const text = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('脚本必须是 JSON 对象');
  return parsed;
}

/** 取最后一条 user 消息的纯文本（内容可能是字符串或内容块数组）。 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

function messagesText(messages = [], scope = 'user') {
  const rows = Array.isArray(messages) ? messages : [];
  if (scope === 'system') {
    return rows
      .filter((row) => row?.role === 'system')
      .map((row) => contentToText(row.content))
      .join('\n');
  }
  if (scope === 'user') {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i]?.role === 'user') return contentToText(rows[i].content);
    }
    return '';
  }
  return rows.map((row) => contentToText(row?.content)).join('\n');
}

/** match 默认按子串匹配；写成 /正则/flags 或 matchType:'regex' 时按正则。 */
function matchRegex(rule, pattern) {
  const type = rule.matchType ?? 'auto';
  if (type === 'substring' || type === 'includes' || type === 'plain') return null;
  const slashForm = /^\/([\s\S]+)\/([a-z]*)$/.exec(pattern);
  if (type === 'regex' || type === 're') {
    return slashForm ? new RegExp(slashForm[1], rule.flags ?? slashForm[2]) : new RegExp(pattern, rule.flags ?? '');
  }
  if (slashForm) return new RegExp(slashForm[1], slashForm[2]);
  return null;
}

function ruleMatches(rule = {}, messages = []) {
  const pattern = String(rule.match ?? '');
  if (!pattern) return true;
  const haystack = messagesText(messages, rule.matchOn ?? rule.on ?? 'user');
  const regex = matchRegex(rule, pattern);
  if (regex) return regex.test(haystack);
  return haystack.includes(pattern);
}

/** 人设化的默认回复：短句、逗号断句，用于人工试跑。 */
export function defaultReply(messages = []) {
  const text = messagesText(messages, 'user').trim();
  if (!text) return '嗯，我在，说吧';
  const has = (pattern) => pattern.test(text);
  if (has(/你好|在吗|在不在|hi|hello|早上好|晚上好/i)) return '在的，刚在看点东西，你说';
  if (has(/晚安|睡了|再见|拜拜/)) return '晚安，早点睡，明天见';
  if (has(/谢谢|多谢|辛苦|厉害|不错|真棒/)) return '这没什么，本来就要做的，还有别的没';
  if (has(/生气|烦|难受|累|不开心|委屈|难过/)) return '嗯…，我听着，你慢慢说，不着急';
  if (has(/文件|目录|代码|脚本|日志|改一下|修一下|写个/)) return '知道了，我去看看，弄完跟你说';
  if (has(/多少|怎么|为什么|能不能|可以吗|是什么|\?|？/)) return '这个我看看，稍等，别急';
  const snippet = Array.from(text.replace(/\s+/g, ' ')).slice(0, 12).join('');
  return `嗯，你说${snippet}，我想想，等下回你`;
}

/** 把脚本条目统一成 { content, toolCalls, finishReason }；json 为字符串时原样返回（可故意给坏 JSON）。 */
export function normalizeEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return { content: entry, toolCalls: [], finishReason: 'stop' };
  let content;
  if (entry.content !== undefined && entry.content !== null) content = String(entry.content);
  else if (entry.json !== undefined) content = typeof entry.json === 'string' ? entry.json : JSON.stringify(entry.json);
  else content = '';
  const rawCalls = entry.tool_calls ?? entry.toolCalls ?? null;
  const toolCalls = Array.isArray(rawCalls)
    ? rawCalls
        .map((call, index) => {
          const fn = call?.function ?? call ?? {};
          const args = fn.arguments ?? call?.arguments ?? {};
          return {
            id: call?.id ?? `call_mock_${index + 1}`,
            type: 'function',
            function: {
              name: String(fn.name ?? call?.name ?? ''),
              arguments: typeof args === 'string' ? args : JSON.stringify(args),
            },
          };
        })
        .filter((call) => call.function.name)
    : [];
  return {
    content,
    toolCalls,
    finishReason: String(entry.finish_reason ?? entry.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop')),
  };
}

function maskAuth(value) {
  if (!value) return null;
  const text = String(value);
  const scheme = text.split(' ')[0] || 'Bearer';
  return `${scheme} ***`;
}

function computeUsage(body, content, toolCalls) {
  const promptText = (body.messages ?? [])
    .map((row) => `${contentToText(row?.content)}${row?.tool_calls ? JSON.stringify(row.tool_calls) : ''}`)
    .join('\n');
  const completionText = `${content}${toolCalls.map((call) => call.function.arguments).join('')}`;
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 2));
  const completionTokens = Math.max(1, Math.ceil(Array.from(completionText).length / 2));
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

export function createMockLlm(rawOptions = {}) {
  const options = { ...parseArgs([]), ...rawOptions };
  const log = options.quiet ? () => {} : (...args) => console.log('[mock-llm]', ...args);
  const state = {
    requests: 0,
    streams: 0,
    rejected: 0,
    byRole: {},
    paths: {},
    lastRequest: null,
    lastRequestHeaders: null,
    lastResponse: null,
    script: null,
    scriptSource: null,
    sequenceIndex: 0,
    startedAt: Date.now(),
  };

  function setScript(script, source = 'runtime') {
    state.script = script ?? null;
    state.scriptSource = script ? source : null;
    state.sequenceIndex = 0;
    log(script ? `已装载脚本（${source}）：rules=${script.rules?.length ?? 0} sequence=${script.sequence?.length ?? 0} default=${script.default ? 'yes' : 'no'}` : '已卸载脚本');
  }

  // 初始脚本来源：编程调用直接给对象（options.scriptObject / options.script），CLI 由 main() 读文件后放进 options.scriptObject
  const initialScript = options.scriptObject ?? (options.script && typeof options.script === 'object' ? options.script : null);
  if (initialScript) setScript(initialScript, options.scriptPath ? `file:${options.scriptPath}` : 'options');

  /** 依次尝试：rules（默认优先）→ sequence → default；返回命中的条目与来源。 */
  function resolveEntry(body) {
    const script = state.script;
    if (!script) return null;
    const tryRules = () => {
      for (const rule of script.rules ?? []) {
        if (ruleMatches(rule, body.messages)) return { entry: rule, source: `rule:${rule.match ?? '*'}` };
      }
      return null;
    };
    const trySequence = () => {
      const list = script.sequence ?? [];
      if (state.sequenceIndex >= list.length) return null;
      const entry = list[state.sequenceIndex];
      state.sequenceIndex += 1;
      return { entry, source: `sequence:${state.sequenceIndex}` };
    };
    const tryDefault = () => (script.default ? { entry: script.default, source: 'default' } : null);
    if (script.preferSequence === true) return trySequence() ?? tryRules() ?? tryDefault();
    return tryRules() ?? trySequence() ?? tryDefault();
  }

  function buildCompletion(body) {
    const resolved = resolveEntry(body);
    const normalized = resolved ? normalizeEntry(resolved.entry) : null;
    const jsonRequested = body.response_format?.type === 'json_object';
    const content = resolved && normalized ? normalized.content : defaultReply(body.messages);
    const toolCalls = resolved && normalized ? normalized.toolCalls : [];
    const finishReason = resolved && normalized ? normalized.finishReason : 'stop';
    const usage = computeUsage(body, content, toolCalls);
    return { content, toolCalls, finishReason, usage, source: resolved?.source ?? 'builtin-default', jsonRequested };
  }

  function modelName(requested) {
    return requested ? String(requested) : options.model;
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          const failure = new Error(`请求体不是合法 JSON：${error.message}`);
          failure.statusCode = 400;
          reject(failure);
        }
      });
      req.on('error', reject);
    });
  }

  function splitChunks(content) {
    const chars = Array.from(content);
    const size = options.chunkSize;
    const chunks = [];
    for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(''));
    if (chunks.length > 5) {
      const head = chunks.slice(0, 4);
      head.push(chunks.slice(4).join(''));
      return head;
    }
    return chunks;
  }

  function streamCompletion(req, res, body, completion, model) {
    const id = `chatcmpl-mock-${state.requests}`;
    const created = Math.floor(Date.now() / 1000);
    const includeUsage = Boolean(body.stream_options?.include_usage);
    const frame = (payload) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const choice = (delta, finishReason = null) => ({ index: 0, delta, finish_reason: finishReason, logprobs: null });
    frame({ id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'mock', choices: [choice({ role: 'assistant', content: '' })] });
    let chunks = 0;
    for (const piece of splitChunks(completion.content)) {
      chunks += 1;
      frame({ id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'mock', choices: [choice({ content: piece })] });
    }
    completion.toolCalls.forEach((call, index) => {
      chunks += 1;
      frame({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: 'mock',
        choices: [choice({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] })],
      });
      const args = Array.from(call.function.arguments);
      const half = Math.ceil(args.length / 2);
      for (const part of [args.slice(0, half).join(''), args.slice(half).join('')]) {
        if (!part) continue;
        chunks += 1;
        frame({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          system_fingerprint: 'mock',
          choices: [choice({ tool_calls: [{ index, function: { arguments: part } }] })],
        });
      }
    });
    frame({ id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'mock', choices: [choice({}, completion.finishReason)] });
    if (includeUsage) {
      frame({ id, object: 'chat.completion.chunk', created, model, system_fingerprint: 'mock', choices: [], usage: completion.usage });
    }
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    state.lastResponse = { stream: true, content: completion.content, toolCalls: completion.toolCalls, finishReason: completion.finishReason, chunks, usage: includeUsage ? completion.usage : null, source: completion.source };
    log(`流式应答 ${chunks} 个 chunk：${completion.content.slice(0, 40)}`);
  }

  async function handleChat(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      state.rejected += 1;
      json(res, error.statusCode ?? 400, { error: { message: error.message, type: 'invalid_request_error', code: 'invalid_json' } });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      state.rejected += 1;
      json(res, 400, { error: { message: '请求体必须是 JSON 对象', type: 'invalid_request_error', code: 'invalid_request' } });
      return;
    }
    if (!Array.isArray(body.messages)) {
      state.rejected += 1;
      json(res, 400, { error: { message: 'messages 必须是数组', type: 'invalid_request_error', code: 'invalid_messages' } });
      return;
    }

    const model = modelName(body.model);
    const role = String(body.role ?? req.headers['x-ruohua-role'] ?? 'default');
    const headers = {
      authorizationPresent: Boolean(req.headers.authorization),
      authorization: maskAuth(req.headers.authorization),
      contentType: req.headers['content-type'] ?? null,
    };
    state.requests += 1;
    state.byRole[role] = (state.byRole[role] ?? 0) + 1;
    state.lastRequestHeaders = headers;
    state.lastRequest = {
      at: Date.now(),
      role,
      model,
      stream: Boolean(body.stream),
      json: body.response_format?.type === 'json_object',
      messages: body.messages,
      tools: body.tools ?? null,
      tool_choice: body.tool_choice ?? null,
      temperature: body.temperature ?? null,
      max_tokens: body.max_tokens ?? null,
      streamOptions: body.stream_options ?? null,
      headers,
    };

    const completion = buildCompletion(body);
    if (body.stream) {
      state.streams += 1;
      streamCompletion(req, res, body, completion, model);
      return;
    }
    const id = `chatcmpl-mock-${state.requests}`;
    const created = Math.floor(Date.now() / 1000);
    const payload = {
      id,
      object: 'chat.completion',
      created,
      model,
      system_fingerprint: 'mock',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: completion.content,
            ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
          },
          finish_reason: completion.finishReason,
          logprobs: null,
        },
      ],
      usage: completion.usage,
    };
    state.lastResponse = { stream: false, content: completion.content, toolCalls: completion.toolCalls, finishReason: completion.finishReason, usage: completion.usage, source: completion.source };
    log(`应答（${completion.source}）：${completion.content.slice(0, 40)}`);
    json(res, 200, payload);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    state.paths[route] = (state.paths[route] ?? 0) + 1;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }).end();
        return;
      }
      switch (route) {
        case 'GET /': {
          const text = ['mock-llm：OpenAI 兼容的假模型服务', '', `  POST   http://${options.host}:${options.port}/v1/chat/completions`, '  GET    /v1/models', '  GET    /usage', '  DELETE /usage', '  POST   /script   （body 为脚本对象）', '  DELETE /script', '  GET    /health'].join('\n');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${text}\n`);
          return;
        }
        case 'GET /health':
          json(res, 200, { ok: true, service: 'mock-llm', requests: state.requests, streams: state.streams, model: options.model, scriptLoaded: Boolean(state.script), baseUrl: `http://${options.host}:${options.port}/v1`, startedAt: state.startedAt, uptimeMs: Date.now() - state.startedAt });
          return;
        case 'GET /v1/models':
          json(res, 200, {
            object: 'list',
            data: [
              { id: options.model, object: 'model', created: Math.floor(state.startedAt / 1000), owned_by: 'mock-llm' },
              { id: 'mock-vision', object: 'model', created: Math.floor(state.startedAt / 1000), owned_by: 'mock-llm' },
            ],
          });
          return;
        case 'POST /v1/chat/completions':
          await handleChat(req, res);
          return;
        case 'GET /usage':
          json(res, 200, {
            ok: true,
            requests: state.requests,
            streams: state.streams,
            rejected: state.rejected,
            byRole: { ...state.byRole },
            paths: { ...state.paths },
            lastRequest: state.lastRequest,
            lastRequestHeaders: state.lastRequestHeaders,
            lastResponse: state.lastResponse,
            scriptSource: state.scriptSource,
            sequenceIndex: state.sequenceIndex,
            startedAt: state.startedAt,
          });
          return;
        case 'DELETE /usage':
          state.requests = 0;
          state.streams = 0;
          state.rejected = 0;
          state.byRole = {};
          state.paths = {};
          state.lastRequest = null;
          state.lastRequestHeaders = null;
          state.lastResponse = null;
          json(res, 200, { ok: true, requests: 0 });
          return;
        case 'POST /script': {
          const script = await readJson(req);
          if (!script || typeof script !== 'object' || Array.isArray(script)) {
            json(res, 400, { ok: false, error: 'script_must_be_object' });
            return;
          }
          setScript(script, 'runtime');
          json(res, 200, { ok: true, rules: script.rules?.length ?? 0, sequence: script.sequence?.length ?? 0, hasDefault: Boolean(script.default) });
          return;
        }
        case 'DELETE /script':
          setScript(null);
          json(res, 200, { ok: true, script: null });
          return;
        default:
          json(res, 404, { ok: false, error: 'not_found', route });
      }
    } catch (error) {
      state.rejected += 1;
      if (!res.headersSent) json(res, error.statusCode ?? 500, { ok: false, error: error.message });
      else res.end();
    }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    log(`OpenAI 兼容接口已监听 http://${options.host}:${options.port}/v1（模型 ${options.model}${state.script ? '，已装载脚本' : ''}）`);
    return { baseUrl: `http://${options.host}:${options.port}/v1`, url: `http://${options.host}:${options.port}` };
  }

  async function stop() {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    options,
    start,
    stop,
    setScript: (script, source = 'runtime') => setScript(script, source),
    usage: () => ({
      requests: state.requests,
      streams: state.streams,
      rejected: state.rejected,
      byRole: { ...state.byRole },
      lastRequest: state.lastRequest,
      lastRequestHeaders: state.lastRequestHeaders,
      lastResponse: state.lastResponse,
    }),
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[mock-llm] ${error.message}`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.script && typeof options.script === 'string') {
    try {
      options.scriptObject = await loadScript(options.script);
      options.scriptPath = options.script;
    } catch (error) {
      console.error(`[mock-llm] 读取脚本失败：${options.script} —— ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  const mock = createMockLlm(options);
  try {
    await mock.start();
  } catch (error) {
    console.error(`[mock-llm] 启动失败：${error.message}`);
    console.error(`  端口 ${options.port} 可能已被占用，换一个 --port 再试。`);
    process.exitCode = 1;
    return;
  }
  const shutdown = async () => {
    await mock.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error('[mock-llm] 未捕获错误', error);
    process.exitCode = 1;
  });
}
