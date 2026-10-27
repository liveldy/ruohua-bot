/**
 * tests/dev 共用工具：找空闲端口、按子进程起 mock、HTTP/WS 断言辅助。
 * 本文件不是测试文件（名字不带 .test），只被 tests/dev/*.test.js 引用。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..', '..');

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 向系统要一个空闲端口：测试不依赖「某个固定端口没被占用」。 */
export async function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function getFreePorts(count, host = '127.0.0.1') {
  const ports = [];
  let guard = 0;
  while (ports.length < count && guard < count * 10) {
    guard += 1;
    const port = await getFreePort(host);
    if (!ports.includes(port)) ports.push(port);
  }
  if (ports.length < count) throw new Error('无法取得足够多的空闲端口');
  return ports;
}

export function mockScriptPath(name) {
  return path.join(projectRoot, 'tools', 'dev', name);
}

/** 起一个 mock 子进程；返回句柄（含输出收集、kill 并等待退出）。 */
export function spawnMock(scriptName, args = [], { env = {} } = {}) {
  const child = spawn(process.execPath, [mockScriptPath(scriptName), ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chunks = [];
  child.stdout.on('data', (data) => chunks.push(String(data)));
  child.stderr.on('data', (data) => chunks.push(String(data)));
  const handle = {
    child,
    /** 进程退出信息 { code, signal }，未退出时为 null。 */
    exitInfo: null,
    output: () => chunks.join(''),
    /** 杀掉子进程并等它真的退出（不留孤儿）。 */
    async stop() {
      if (handle.exitInfo) return handle.exitInfo;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 忽略 */
          }
          resolve();
        }, 4000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
      return handle.exitInfo;
    },
  };
  child.once('exit', (code, signal) => {
    handle.exitInfo = { code, signal };
  });
  child.once('error', (error) => chunks.push(`spawn error: ${error.message}\n`));
  return handle;
}

export async function waitForHealth(url, handle, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (handle?.exitInfo) {
      throw new Error(`mock 进程提前退出（code=${handle.exitInfo.code}）：\n${handle.output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`等待 ${url} 就绪超时：${lastError?.message ?? '未知原因'}\n${handle?.output?.() ?? ''}`);
}

/** 等子进程自己退出（用于断言启动失败会立即退出）。 */
export async function waitForExit(handle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.exitInfo) return handle.exitInfo;
    await delay(20);
  }
  throw new Error(`子进程未在 ${timeoutMs}ms 内退出：\n${handle.output()}`);
}

export async function startMockOneBot({ token = 'test-token', selfId = 10000, args = [], quiet = false } = {}) {
  const [wsPort, httpPort] = await getFreePorts(2);
  const cli = ['--port', String(wsPort), '--http-port', String(httpPort), '--self-id', String(selfId)];
  if (token) cli.push('--token', token);
  if (quiet) cli.push('--quiet');
  const handle = spawnMock('mock-onebot.js', [...cli, ...args]);
  const httpUrl = `http://127.0.0.1:${httpPort}`;
  await waitForHealth(`${httpUrl}/health`, handle);
  return Object.assign(handle, { wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl, wsPort, httpPort, token, selfId });
}

export async function startMockLlm({ scriptPath = null, scriptObject = null, args = [], quiet = false, model = 'mock-chat' } = {}) {
  const [port] = await getFreePorts(1);
  const cli = ['--port', String(port), '--model', model];
  if (scriptPath) cli.push('--script', scriptPath);
  if (quiet) cli.push('--quiet');
  const handle = spawnMock('mock-llm.js', [...cli, ...args]);
  const httpUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${httpUrl}/health`, handle);
  const mock = Object.assign(handle, { httpUrl, port, baseUrl: `${httpUrl}/v1`, model, scriptObject: null });
  if (scriptObject) {
    const loaded = await httpJson(`${httpUrl}/script`, { method: 'POST', body: scriptObject });
    if (loaded.status !== 200) throw new Error(`装载脚本失败：${loaded.text}`);
    mock.scriptObject = scriptObject;
  }
  return mock;
}

export async function httpJson(url, { method = 'GET', body = undefined, headers = {}, raw = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body !== undefined || raw !== null ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw !== null ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** 登录一个原始 ws 客户端，收集收到的所有帧（与 src/onebot/client.js 的握手方式一致）。 */
export async function openSocket(url, { token = null, timeoutMs = 8000 } = {}) {
  const socket = new WebSocket(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    handshakeTimeout: timeoutMs,
  });
  const frames = [];
  socket.on('message', (data) => {
    try {
      frames.push(JSON.parse(String(data)));
    } catch {
      frames.push({ __unparsed: String(data) });
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket 连接超时：${url}`)), timeoutMs);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return {
    socket,
    frames,
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () => socket.close(),
  };
}

/** 轮询等待条件成立（用于等异步到达的帧 / 事件 / HTTP 状态）。 */
export async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 10, describe = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`等待${describe}超时（${timeoutMs}ms）：${JSON.stringify(last)}`);
}

export function onceEvent(emitter, name, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      clearTimeout(timer);
      emitter.off?.(name, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      emitter.off?.(name, handler);
      reject(new Error(`等待事件 ${name} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    emitter.on(name, handler);
  });
}

export async function collectEvents(emitter, name, { timeoutMs = 300 } = {}) {
  const rows = [];
  const handler = (payload) => rows.push(payload);
  emitter.on(name, handler);
  await delay(timeoutMs);
  emitter.off?.(name, handler);
  return rows;
}

/** 不落盘的 logger 替身：mock 测试不写 data/logs。 */
export function stubLogger() {
  const noop = () => {};
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    operation: noop,
    conversation: noop,
    child: () => logger,
    file: () => null,
  };
  return logger;
}

export function onebotConfig({ wsUrl, accessToken = '' }) {
  return {
    bot: {
      onebot: {
        mode: 'forward',
        wsUrl,
        accessToken,
        reversePort: 0,
        reversePath: '/onebot',
        httpUrl: '',
        httpPort: 0,
        heartbeatTimeoutMs: 60000,
        reconnect: { minDelayMs: 200, maxDelayMs: 1000, factor: 1.5 },
        requestTimeoutMs: 5000,
        selfId: 0,
      },
    },
  };
}

export function llmConfig({ baseUrl, apiKey = 'sk-mock', model = 'mock-chat' }) {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl,
      apiKey,
      model,
      visionModel: '',
      temperature: 0.8,
      maxTokens: 512,
      timeoutMs: 10000,
      stream: true,
      retry: { times: 0, baseDelayMs: 20 },
      roles: { chat: {}, decision: { temperature: 0.2, stream: false }, judge: { stream: false }, memory: { stream: false }, agent: { stream: false } },
      offline: false,
    },
    env: {},
  };
}

/** 临时目录（写脚本、测试产物），测试结束时自行清理。 */
export async function tempDir(prefix = 'ruohua-dev-mock-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeJsonFile(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 解析 SSE 响应体：返回 { frames: object[], done: bool, raw }。 */
export function parseSse(text) {
  const raw = String(text);
  const frames = [];
  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') continue;
    try {
      frames.push(JSON.parse(data));
    } catch {
      frames.push({ __unparsed: data });
    }
  }
  return { frames, done: raw.includes('[DONE]'), raw };
}
