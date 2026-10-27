/**
 * 控制面板服务：静态页、状态接口、配置脱敏与原子保存、路径穿越、令牌校验、WebSocket 日志流。
 * 全部在 os.tmpdir() 下自建临时目录，跑完删掉，不碰项目的 data/。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLogger } from '../../src/logging/logger.js';
import { createWebServer } from '../../src/web/server.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');

/**
 * 日志文件名用的是**本地**日期（`src/logging/logger.js` 的 `dayStamp`）。
 * 拿 `toISOString()` 拼文件名会按 UTC 算，本地时间过了午夜而 UTC 还没过时就读空文件。
 */
function localDayStamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const WebSocketImpl = globalThis.WebSocket ?? (await import('ws')).WebSocket;

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-web-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.mkdir(path.join(root, 'web'), { recursive: true });
  await fs.mkdir(path.join(root, 'data', 'logs'), { recursive: true });
  // 静态资源用真文件，保证测的是真的页面；前端加了文件这里跟着走，不用改测试
  const frontendDir = path.join(projectRoot, 'web');
  for (const name of await fs.readdir(frontendDir)) {
    const from = path.join(frontendDir, name);
    if (!(await fs.stat(from)).isFile()) continue;
    await fs.copyFile(from, path.join(root, 'web', name));
  }
  await fs.writeFile(
    path.join(root, 'config', 'bot.json'),
    `${JSON.stringify(
      {
        name: '若华',
        logLevel: 'info',
        onebot: { mode: 'forward', accessToken: 'super-secret-token', wsUrl: 'ws://127.0.0.1:3001' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'config', 'model.json'),
    `${JSON.stringify({ apiKey: 'sk-secret', model: 'deepseek-chat', roles: { chat: { temperature: 1.1 } } }, null, 2)}\n`,
    'utf8',
  );
  return root;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 起一个面板，register 里拿得到 server/logger/root，跑完自动收摊。 */
async function withServer(options, run) {
  const root = options.root ?? (await tempRoot());
  const logger = options.logger ?? createLogger({ level: 'debug', dir: path.join(root, 'data', 'logs'), name: 'ruohua', console: false });
  const server = createWebServer({
    config: options.config ?? null,
    logger,
    services: options.services ?? null,
    options: { rootDir: root, host: '127.0.0.1', port: options.port ?? 0, ...(options.options ?? {}) },
  });
  const started = await server.start();
  const base = `http://127.0.0.1:${started.port}`;
  try {
    await run({ server, started, base, root, logger });
  } finally {
    await server.stop();
    await logger.flush?.();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function waitForSocket(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等日志事件超时'));
    }, timeoutMs);
    const onMessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data ?? event);
      } catch {
        return;
      }
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    };
    const onError = (error) => {
      cleanup();
      reject(new Error(`WebSocket 出错：${error?.message ?? error}`));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    }
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

// ————————————————————————————————— 静态资源 —————————————————————————————————

test('静态页可访问：index.html / app.js / styles.css 都是 200 且类型正确', async () => {
  await withServer({}, async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    // 页面本地化键走 data-i18n，后端不再断言具体字面量，只要求是个像样的 HTML 文档
    assert.ok(html.trim().length > 200, '页面不能是空的');
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<html[^>]*lang=/i);

    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const style = await fetch(`${base}/styles.css`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get('content-type'), /text\/css/);

    const missing = await fetch(`${base}/nope.html`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).ok, false);
  });
});

test('路径穿越与越界扩展名都被拦下', async () => {
  await withServer({}, async ({ base, root }) => {
    await fs.writeFile(path.join(root, 'web', 'notes.txt'), '不该被读出来', 'utf8');

    const cases = [
      `${base}/..%2f..%2fpackage.json`,
      `${base}/%2e%2e%2f%2e%2e%2f.env`,
      `${base}/../../config/bot.json`,
      `${base}/notes.txt`,
      `${base}/..%5c..%5cdata%5clogs`,
    ];
    for (const target of cases) {
      const response = await fetch(target);
      assert.notEqual(response.status, 200, `${target} 不该返回 200`);
      assert.ok([400, 403, 404].includes(response.status), `${target} 返回了 ${response.status}`);
      const text = await response.text();
      assert.ok(!text.includes('super-secret-token'), '穿越不能读到配置内容');
    }
  });
});

// ————————————————————————————————— 状态接口 —————————————————————————————————

test('/api/status 在没有 services 时不 500，独立模式如实说明', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.mode, 'standalone');
    assert.equal(data.running, true);
    assert.ok(data.web.port > 0);
    assert.match(data.note, /独立模式/);
    assert.equal(data.onebot, undefined);
    assert.equal(data.memory, undefined);
    assert.equal(data.tasks, undefined);
  });
});

test('/api/status 在 services 齐全时汇总各模块，缺哪块就跳过哪块', async () => {
  const services = {
    startedAt: Date.now() - 65_000,
    onebot: { status: () => ({ connected: true, mode: 'forward', messagesIn: 3, messagesOut: 5 }) },
    llm: {
      usageTotals: () => ({ requests: 2, totalTokens: 1234, byModel: {} }),
      balance: async () => ({ available: true, currency: 'CNY', balance: '9.99' }),
      modelName: 'mock-chat',
    },
    sidecar: { available: true, url: 'http://127.0.0.1:8765', health: async () => ({ ok: true }) },
    dispatcher: { stats: () => ({ received: 7, replied: 6, running: 0 }) },
    reply: { state: () => ({ sent: 6, files: 0, expressions: 1 }) },
    emotion: { snapshot: () => ({ 10001: { userId: 10001, affection: 61, mood: '开心' } }) },
    memory: { stats: () => ({ temporary: 12, permanent: 3, users: 1 }) },
    tasks: { list: () => [{ id: 'task_1', status: 'running' }], stats: () => ({ total: 1, active: 1 }) },
    // 故意缺 scheduler / agent：这些字段应该直接缺席，而不是让接口 500
  };
  await withServer({ services }, async ({ base }) => {
    const data = await (await fetch(`${base}/api/status`)).json();
    assert.equal(data.mode, 'attached');
    assert.equal(data.onebot.connected, true);
    assert.equal(data.llm.usage.totalTokens, 1234);
    assert.equal(data.llm.balance.balance, '9.99');
    assert.equal(data.memory.permanent, 3);
    assert.equal(data.emotion.users, 1);
    assert.equal(data.tasks.active, 1);
    assert.equal(data.sidecar.available, true);
    assert.ok(data.bot.uptimeMs >= 60_000);
    assert.ok(Array.isArray(data.modules));
    assert.ok(data.modules.includes('memory'));
    assert.ok(!data.modules.includes('scheduler'));
  });
});

test('坏了也不会 500：模块方法抛错时跳过那一项', async () => {
  const services = {
    onebot: {
      status: () => {
        throw new Error('onebot 炸了');
      },
    },
    memory: {
      stats: () => {
        throw new Error('memory 炸了');
      },
    },
    llm: {
      usageTotals: () => ({ requests: 1, totalTokens: 5 }),
      balance: async () => {
        throw new Error('余额接口挂了');
      },
    },
  };
  await withServer({ services }, async ({ base }) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.onebot, undefined);
    assert.equal(data.memory, undefined);
    assert.equal(data.llm.usage.totalTokens, 5);
    assert.equal(data.llm.balance, null);
  });
});

// ————————————————————————————————— 配置 —————————————————————————————————

test('/api/config 列出文件并给密钥脱敏，不放行 .env', async () => {
  await withServer({}, async ({ base, root }) => {
    await fs.writeFile(path.join(root, '.env'), 'MODEL_API_KEY=sk-leak\n', 'utf8');

    const response = await fetch(`${base}/api/config`);
    assert.equal(response.status, 200);
    const data = await response.json();
    const names = data.files.map((file) => file.name).sort();
    assert.deepEqual(names, ['bot', 'model']);
    assert.ok(!data.files.some((file) => file.name.includes('env')));

    const bot = data.files.find((file) => file.name === 'bot');
    assert.equal(bot.content.onebot.accessToken, '********');
    assert.equal(bot.content.name, '若华');
    const model = data.files.find((file) => file.name === 'model');
    assert.equal(model.content.apiKey, '********');

    const single = await (await fetch(`${base}/api/config/bot`)).json();
    assert.equal(single.content.onebot.accessToken, '********');
    assert.equal(single.content.onebot.wsUrl, 'ws://127.0.0.1:3001');

    const traversal = await fetch(`${base}/api/config/..%2f.env`);
    assert.equal(traversal.status, 400);
    const notFound = await fetch(`${base}/api/config/nothing`);
    assert.equal(notFound.status, 404);
  });
});

test('PUT /api/config 原子写入、备份旧文件、占位符表示不改', async () => {
  await withServer({}, async ({ base, root }) => {
    const before = JSON.parse(await fs.readFile(path.join(root, 'config', 'bot.json'), 'utf8'));

    const body = {
      name: '若华',
      logLevel: 'debug',
      onebot: { mode: 'forward', accessToken: '********', wsUrl: 'ws://127.0.0.1:3999' },
    };
    const response = await fetch(`${base}/api/config/bot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.ok(data.backup);

    const backup = JSON.parse(await fs.readFile(data.backup, 'utf8'));
    assert.deepEqual(backup, before, '备份必须是保存前的原文件');

    const onDisk = JSON.parse(await fs.readFile(path.join(root, 'config', 'bot.json'), 'utf8'));
    assert.equal(onDisk.logLevel, 'debug');
    assert.equal(onDisk.onebot.wsUrl, 'ws://127.0.0.1:3999');
    assert.equal(onDisk.onebot.accessToken, 'super-secret-token', '******** 要换回磁盘上的旧值');
    assert.equal(await fs.readFile(data.backup, 'utf8').then((text) => text.includes('super-secret-token')), true);

    const left = await fs.readdir(path.join(root, 'config'));
    assert.deepEqual(left.filter((name) => name.endsWith('.tmp')), [], '不能留下临时文件');

    const backups = await fs.readdir(path.join(root, 'data', 'config-backup'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^bot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/);

    const listed = await (await fetch(`${base}/api/config`)).json();
    assert.equal(listed.files.find((file) => file.name === 'bot').content.logLevel, 'debug');
  });
});

test('PUT /api/config 拒绝非法 JSON、数组、不存在的文件，磁盘内容不变', async () => {
  await withServer({}, async ({ base, root }) => {
    const before = await fs.readFile(path.join(root, 'config', 'bot.json'), 'utf8');

    const broken = await fetch(`${base}/api/config/bot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"logLevel": "debug",}',
    });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).ok, false);

    const array = await fetch(`${base}/api/config/bot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(array.status, 400);
    assert.match((await array.json()).error, /对象/);

    const scalar = await fetch(`${base}/api/config/bot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('就是一行字'),
    });
    assert.equal(scalar.status, 400);

    const missing = await fetch(`${base}/api/config/ghost`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(missing.status, 404);

    const weirdName = await fetch(`${base}/api/config/Bot.Config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(weirdName.status, 400);

    assert.equal(await fs.readFile(path.join(root, 'config', 'bot.json'), 'utf8'), before, '失败的保存不能碰到磁盘');
    const backups = await fs.readdir(path.join(root, 'data', 'config-backup')).catch(() => []);
    assert.equal(backups.length, 0, '失败的保存不该留下备份');
  });
});

test('保存 bot.json 的 logLevel 会顺手切日志级别', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/config/bot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logLevel: 'warn' }),
    });
    const data = await response.json();
    assert.equal(data.levelChanged, 'warn');
  });
});

// ————————————————————————————————— 令牌 —————————————————————————————————

test('配了 token 就要求 ?token= 或 Bearer，不对就 401', async () => {
  const token = 'tok3n-Abc123';
  await withServer({ options: { token } }, async ({ base }) => {
    const anonymous = await fetch(`${base}/api/status`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).ok, false);

    const wrong = await fetch(`${base}/api/status?token=nope`);
    assert.equal(wrong.status, 401);

    const queried = await fetch(`${base}/api/status?token=${encodeURIComponent(token)}`);
    assert.equal(queried.status, 200);

    const bearer = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(bearer.status, 200);

    const configWithout = await fetch(`${base}/api/config`);
    assert.equal(configWithout.status, 401);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, '静态页面本身不拦，令牌只护接口与日志通道');

    const wsDenied = new WebSocketImpl(`ws://127.0.0.1:${new URL(base).port}/ws/logs`);
    const denied = await new Promise((resolve) => {
      wsDenied.addEventListener('error', () => resolve('error'));
      wsDenied.addEventListener('open', () => resolve('open'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    assert.equal(denied, 'error');

    const wsAllowed = new WebSocketImpl(`ws://127.0.0.1:${new URL(base).port}/ws/logs?token=${encodeURIComponent(token)}`);
    try {
      const hello = await waitForSocket(wsAllowed, (payload) => payload.type === 'hello');
      assert.equal(hello.mode, 'standalone');
    } finally {
      wsAllowed.close();
    }
  });
});

test('没配 token 时接口随便访问', async () => {
  await withServer({}, async ({ base, server }) => {
    assert.equal(server.info().running, true);
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
  });
});

// ————————————————————————————————— 端口 —————————————————————————————————

test('端口被别的东西占着就往后找一个空闲端口', async () => {
  const busy = await freePort();
  const secondRoot = await tempRoot();
  // 占着端口的是一个普通 TCP 服务，不是若华面板 —— 这种才该退到下一个端口
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(busy, '127.0.0.1', resolve));
  try {
    const second = createWebServer({
      config: null,
      logger: createLogger({ level: 'error', dir: null, name: 'ruohua', console: false }),
      services: null,
      options: { rootDir: secondRoot, host: '127.0.0.1', port: busy },
    });
    const startedSecond = await second.start();
    try {
      assert.notEqual(startedSecond.port, busy);
      assert.ok(startedSecond.port > busy);
      assert.equal(startedSecond.existing, undefined, '占着端口的不是面板，别当成「已经有一个面板」');
      assert.equal((await fetch(`http://127.0.0.1:${startedSecond.port}/api/status`)).status, 200);
    } finally {
      await second.stop();
    }
    assert.equal(second.info().running, false);
    assert.equal(second.info().mode, 'standalone');
  } finally {
    // 面板探活会在它上面留一条 keep-alive 连接：close() 的回调会一直等，所以不等回调，
    // 只用 unref 让它别吊住测试进程
    blocker.closeAllConnections?.();
    blocker.unref?.();
    blocker.close();
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('端口上已经有一个若华面板：不再另开一个（一启动就冒出两个面板毫无意义）', async () => {
  const port = await freePort();
  const secondRoot = await tempRoot();
  await withServer({ port }, async ({ started, base }) => {
    assert.equal(started.port, port);
    const second = createWebServer({
      config: null,
      logger: createLogger({ level: 'error', dir: null, name: 'ruohua', console: false }),
      services: null,
      options: { rootDir: secondRoot, host: '127.0.0.1', port },
    });
    try {
      const startedSecond = await second.start();
      assert.equal(startedSecond.port, null, '不占新端口');
      assert.equal(startedSecond.url, null);
      assert.equal(startedSecond.existing?.url, `http://127.0.0.1:${port}`, '如实告诉调用方面板在哪');
      assert.equal(startedSecond.existing?.mode, 'standalone');
      assert.equal(second.info().running, false, '这个进程就不开面板了');
      assert.equal((await fetch(`${base}/api/status`)).status, 200, '原来那个面板还在跑');
    } finally {
      await second.stop();
    }
  });
  await fs.rm(secondRoot, { recursive: true, force: true });
});

test('拒绝监听非本机地址，除非显式打开 allowRemote', async () => {
  const server = createWebServer({
    config: null,
    logger: createLogger({ level: 'error', dir: null, name: 'ruohua', console: false }),
    services: null,
    options: { host: '0.0.0.0', port: 0 },
  });
  await assert.rejects(() => server.start(), /只允许本机/);

  const disabled = createWebServer({ config: { web: { enabled: false } }, logger: null, services: null, options: {} });
  await assert.rejects(() => disabled.start(), /enabled=false/);
});

// ————————————————————————————————— WebSocket —————————————————————————————————

test('/ws/logs 能收到进程内日志，并按 channel / level 过滤', async () => {
  await withServer({}, async ({ base, root, logger }) => {
    const port = new URL(base).port;
    const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws/logs?level=debug&channel=app`);
    try {
      const hello = await waitForSocket(socket, (payload) => payload.type === 'hello');
      assert.equal(hello.mode, 'standalone');
      assert.deepEqual(hello.channels, ['app', 'conversation', 'operation']);

      const waiting = waitForSocket(socket, (payload) => payload.type === 'logs' && payload.entries.some((entry) => entry.message === '面板测试：收到我了吗'));
      logger.child('probe').info('面板测试：收到我了吗', { answer: 42 });
      const logs = await waiting;
      const entry = logs.entries.find((item) => item.message === '面板测试：收到我了吗');
      assert.equal(entry.channel, 'app');
      assert.equal(entry.level, 'info');
      assert.equal(entry.name, 'ruohua.probe');
      assert.deepEqual(entry.meta, { answer: 42 });

      // 只收 warn：info 不该过来
      const warnOnly = new WebSocketImpl(`ws://127.0.0.1:${port}/ws/logs?level=warn&channel=app`);
      try {
        await waitForSocket(warnOnly, (payload) => payload.type === 'hello');
        let sawInfo = false;
        const onMessage = (event) => {
          const payload = JSON.parse(event.data);
          if (payload.type !== 'logs') return;
          if (payload.entries.some((item) => item.message === '这条不该过去')) sawInfo = true;
        };
        warnOnly.addEventListener('message', onMessage);
        logger.warn('这条应该过去', { level: 'warn' });
        logger.info('这条不该过去');
        const got = await waitForSocket(warnOnly, (payload) => payload.type === 'logs' && payload.entries.some((item) => item.message === '这条应该过去'));
        assert.ok(got.entries.every((item) => item.level === 'warn'));
        assert.ok(!sawInfo, 'level=warn 的订阅不该收到 info');
      } finally {
        warnOnly.close();
      }
    } finally {
      socket.close();
    }

    // 进程内事件也应该落进日志文件（两条路并存）
    await logger.flush();
    const file = path.join(root, 'data', 'logs', `app-${localDayStamp()}.jsonl`);
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /面板测试：收到我了吗/);
  });
});

test('客户端中途断开不影响服务继续干活', async () => {
  await withServer({}, async ({ base, logger }) => {
    const port = new URL(base).port;
    const sockets = [
      new WebSocketImpl(`ws://127.0.0.1:${port}/ws/logs`),
      new WebSocketImpl(`ws://127.0.0.1:${port}/ws/logs`),
    ];
    await Promise.all(sockets.map((socket) => waitForSocket(socket, (payload) => payload.type === 'hello')));
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    logger.info('断开之后还能写日志');
    const alive = await (await fetch(`${base}/api/status`)).json();
    assert.equal(alive.ok, true);
    assert.equal(alive.web.clients, 0);

    const fresh = new WebSocketImpl(`ws://127.0.0.1:${port}/ws/logs`);
    try {
      await waitForSocket(fresh, (payload) => payload.type === 'hello');
      const waiting = waitForSocket(fresh, (payload) => payload.type === 'logs' && payload.entries.some((entry) => entry.message === '新连接照样收得到'));
      logger.info('新连接照样收得到');
      await waiting;
    } finally {
      fresh.close();
    }
  });
});

test('未知的 WebSocket 路径被拒，连不上也不影响别的接口', async () => {
  await withServer({}, async ({ base }) => {
    const port = new URL(base).port;
    const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws/nope`);
    const outcome = await new Promise((resolve) => {
      socket.addEventListener('open', () => resolve('open'));
      socket.addEventListener('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    assert.equal(outcome, 'error');
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
  });
});

// ————————————————————————————————— 调试接口 —————————————————————————————————

test('独立模式下调试接口给「先启动主程序」的提示，而不是崩掉', async () => {
  await withServer({}, async ({ base }) => {
    const cases = [
      ['/api/debug/message', { scene: 'private', userId: 10001, text: '在吗' }],
      ['/api/debug/llm', { prompt: '你好' }],
      ['/api/debug/tool', { name: 'read_file', args: {} }],
      ['/api/debug/sidecar', { method: 'health' }],
    ];
    for (const [pathname, body] of cases) {
      const response = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 503, `${pathname} 应该是 503`);
      const data = await response.json();
      assert.equal(data.ok, false);
      assert.match(data.error, /需要先启动若华主程序/);
    }
  });
});

test('模拟消息灌进真实链路：抓得到发出去的内容，dryRun 不真发', async () => {
  const sent = [];
  const seen = [];
  const services = {
    reply: { state: () => ({ sent: sent.length, files: 0, expressions: 0 }) },
    onebot: {
      loginInfo: () => ({ user_id: 90001 }),
      async sendTo(target, content) {
        sent.push({ target, content });
        return { message_id: sent.length };
      },
    },
    dispatcher: {
      async handleMessage(message) {
        seen.push(message);
        await services.onebot.sendTo({ scene: 'private', userId: message.userId }, [{ type: 'text', data: { text: '嗯，我在' } }]);
        return { replied: true };
      },
    },
  };
  await withServer({ services }, async ({ base }) => {
    const dry = await fetch(`${base}/api/debug/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'private', userId: 12345, nickname: '小测', text: '在吗', dryRun: true }),
    });
    assert.equal(dry.status, 200);
    const dryData = await dry.json();
    assert.equal(dryData.ok, true);
    assert.equal(seen[0].userId, 12345);
    assert.equal(seen[0].text, '在吗');
    assert.equal(sent.length, 0, 'dryRun 不能真发出去');
    assert.equal(dryData.outbound.length, 1);
    assert.equal(dryData.outbound[0].text, '嗯，我在');
    assert.equal(dryData.outbound[0].messageId ?? dryData.outbound[0].message_id, undefined);
    assert.ok(Array.isArray(dryData.logs));
    assert.equal(dryData.result.replied, true);

    const real = await (await fetch(`${base}/api/debug/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'group', userId: 12345, groupId: 555, nickname: '小测', text: '晚上好', at: true }),
    })).json();
    assert.equal(sent.length, 1, '关了 dryRun 就真的发（这里发到假 onebot）');
    assert.equal(seen[1].scene, 'group');
    assert.equal(seen[1].groupId, 555);
    assert.equal(seen[1].isAt, true);
    assert.equal(real.outbound.length, 1);
    assert.equal(real.outbound[0].scene, 'private');
    assert.equal(real.replyState.before.sent, 0);
    assert.equal(real.replyState.after.sent, 1, 'concurrency');
  });
});

test('模型直调把 finishReason 与文本长度原样透出', async () => {
  const services = {
    llm: {
      async chat({ messages, role, maxTokens }) {
        assert.equal(role, 'judge');
        assert.equal(maxTokens, 32);
        assert.equal(messages[0].content, '写一句短的');
        return { content: '嗯，好', finishReason: 'length', usage: { promptTokens: 3, completionTokens: 32, totalTokens: 35 }, model: 'mock-chat' };
      },
    },
  };
  await withServer({ services }, async ({ base }) => {
    const data = await (await fetch(`${base}/api/debug/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '写一句短的', role: 'judge', maxTokens: 32 }),
    })).json();
    assert.equal(data.ok, true);
    assert.equal(data.finishReason, 'length');
    assert.equal(data.truncated, true);
    assert.equal(data.contentLength, 3);
    assert.equal(data.usage.totalTokens, 35);
    assert.equal(data.model, 'mock-chat');

    const failed = await fetch(`${base}/api/debug/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(failed.status, 502);
  });
});

test('工具直调按契约的 ctx 调工具；侧车只放白名单方法', async () => {
  const calls = [];
  const tools = new Map([
    [
      'echo',
      {
        name: 'echo',
        description: '把参数原样返回',
        sensitive: false,
        parameters: { type: 'object', properties: {} },
        async run(args, ctx) {
          calls.push({ args, ctx });
          return { ok: true, said: args.said ?? null, taskId: ctx.taskId, scene: ctx.scene };
        },
      },
    ],
  ]);
  const sidecarCalls = [];
  const services = {
    tools,
    sidecar: {
      available: true,
      async probe() {
        sidecarCalls.push('probe');
        return { ok: true, service: 'ruohua-sidecar' };
      },
      async health() {
        sidecarCalls.push('health');
        return { ok: true };
      },
      async embed(texts) {
        sidecarCalls.push(['embed', texts]);
        return texts.map(() => [0.1, 0.2]);
      },
      async stop() {
        sidecarCalls.push('stop');
        return true;
      },
    },
  };
  await withServer({ services }, async ({ base }) => {
    const listed = await (await fetch(`${base}/api/tools`)).json();
    assert.equal(listed.count, 1);
    assert.equal(listed.tools[0].name, 'echo');
    assert.ok(listed.allowedSidecarMethods.includes('embed'));

    const data = await (await fetch(`${base}/api/debug/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'echo', args: { said: '你好' }, scene: 'group', groupId: 777 }),
    })).json();
    assert.equal(data.ok, true);
    assert.equal(data.result.said, '你好');
    assert.equal(data.result.scene, 'group');
    assert.equal(data.result.taskId, 'web_debug');
    assert.ok(calls[0].ctx.services);

    const missing = await fetch(`${base}/api/debug/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nope', args: {} }),
    });
    assert.equal(missing.status, 404);

    const embed = await (await fetch(`${base}/api/debug/sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'embed', params: { texts: ['甲', '乙'] } }),
    })).json();
    assert.equal(embed.ok, true);
    assert.deepEqual(embed.result, [[0.1, 0.2], [0.1, 0.2]]);

    const forbidden = await fetch(`${base}/api/debug/sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'stop', params: {} }),
    });
    assert.equal(forbidden.status, 400);
    assert.ok(!sidecarCalls.includes('stop'), '白名单外的方法不能被调到');
  });
});

test('任务列表与停止任务', async () => {
  const cancelled = [];
  const tasks = [
    { id: 'task_a', goal: '查一下天气', status: 'running', progress: 0.3, steps: [{ index: 1, tool: 'web_search' }], createdAt: 1, updatedAt: 2, result: null },
    { id: 'task_b', goal: '写个文件', status: 'done', progress: 1, steps: [], createdAt: 0, updatedAt: 1, result: 'x'.repeat(3000) },
  ];
  const services = {
    tasks: {
      list: () => tasks,
      stats: () => ({ total: 2, active: 1 }),
      get: (id) => tasks.find((task) => task.id === id) ?? null,
    },
    agent: {
      cancel(id) {
        cancelled.push(id);
        return { ...tasks[0], status: 'cancelled' };
      },
    },
  };
  await withServer({ services }, async ({ base }) => {
    const listed = await (await fetch(`${base}/api/tasks`)).json();
    assert.equal(listed.count, 2);
    assert.equal(listed.active, 1);
    assert.equal(listed.tasks[1].resultLength, 3000);
    assert.match(listed.tasks[1].result, /已截断/);

    const stopped = await (await fetch(`${base}/api/tasks/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'task_a' }),
    })).json();
    assert.equal(stopped.ok, true);
    assert.deepEqual(cancelled, ['task_a']);

    const missing = await fetch(`${base}/api/tasks/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'task_zzz' }),
    });
    assert.equal(missing.status, 404);
  });
});

test('info() 与 stop() 前后状态自洽', async () => {
  const root = await tempRoot();
  const server = createWebServer({
    config: null,
    logger: createLogger({ level: 'error', dir: null, name: 'ruohua', console: false }),
    services: null,
    options: { rootDir: root, host: '127.0.0.1', port: 0 },
  });
  try {
    assert.equal(server.info().running, false);
    const started = await server.start();
    const info = server.info();
    assert.equal(info.running, true);
    assert.equal(info.port, started.port);
    assert.equal(info.url, `http://127.0.0.1:${started.port}`);
    assert.equal(info.clients, 0);
    assert.equal(info.mode, 'standalone');
    await server.stop();
    assert.equal(server.info().running, false);
  } finally {
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ————————————————————————————————— 配置字段表 —————————————————————————————————

test('/api/config/:name 的 fields：类型推导、枚举选项、密钥一律盖住', async () => {
  await withServer({}, async ({ base }) => {
    const bot = await (await fetch(`${base}/api/config/bot`)).json();
    assert.equal(bot.ok, true);
    assert.ok(Array.isArray(bot.fields) && bot.fields.length > 0);

    const byPath = new Map(bot.fields.map((field) => [field.path, field]));
    const name = byPath.get('name');
    assert.equal(name.type, 'text');
    assert.equal(name.value, '若华');
    assert.equal(name.secret, false);
    assert.equal(name.group, 'bot');
    assert.equal(name.labelKey, 'web.field.bot.name.label');
    assert.equal(name.descKey, 'web.field.bot.name.desc');

    const logLevel = byPath.get('logLevel');
    assert.equal(logLevel.type, 'enum');
    assert.deepEqual(logLevel.options, ['debug', 'info', 'warn', 'error']);

    const mode = byPath.get('onebot.mode');
    assert.equal(mode.type, 'enum');
    assert.deepEqual(mode.options, ['forward', 'reverse', 'http']);

    const token = byPath.get('onebot.accessToken');
    assert.equal(token.secret, true, 'accessToken 是密钥');
    assert.equal(token.type, 'secret');
    assert.equal(token.value, '********', '密钥值不能出网');

    // 表里有、文件里没写的字段也要在，值给 null，前端才知道该画什么
    const selfId = byPath.get('onebot.selfId');
    assert.equal(selfId.type, 'number');
    assert.equal(selfId.value, null);

    const model = await (await fetch(`${base}/api/config/model`)).json();
    const modelFields = new Map(model.fields.map((field) => [field.path, field]));
    assert.equal(modelFields.get('apiKey').value, '********');
    assert.equal(modelFields.get('maxTokens').secret, false, 'maxTokens 不是密钥，别误伤');
    assert.equal(modelFields.get('maxTokens').type, 'number');
    assert.equal(modelFields.get('roles.chat.temperature').type, 'number');

    // 文件里有、表里没有的字段照样列出来，扔进 other 组
    const saved = await (await fetch(`${base}/api/config/bot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bot.content, extra: { deep: 1 } }),
    })).json();
    assert.equal(saved.ok, true);
    const after = await (await fetch(`${base}/api/config/bot`)).json();
    const extra = after.fields.find((field) => field.path === 'extra');
    assert.ok(extra, '表外的字段不能丢');
    assert.equal(extra.group, 'other');
    assert.equal(extra.type, 'json');
  });
});

test('每个已知字段都有中文 label / desc 本地化键', async () => {
  const root = await tempRoot();
  const source = path.join(projectRoot, 'config');
  for (const name of await fs.readdir(source)) {
    if (!name.endsWith('.json')) continue;
    await fs.copyFile(path.join(source, name), path.join(root, 'config', name));
  }
  try {
    await withServer({ root }, async ({ base }) => {
      const table = (await (await fetch(`${base}/api/i18n`)).json()).values;
      const names = (await (await fetch(`${base}/api/config`)).json()).files.map((file) => file.name);
      assert.ok(names.length >= 10, '真实配置目录里的文件都该列出来');
      let checked = 0;
      for (const name of names) {
        const data = await (await fetch(`${base}/api/config/${name}`)).json();
        assert.equal(data.parseError, null, `${name}.json 应该能解析`);
        for (const field of data.fields) {
          if (field.group === 'other') continue; // 表外的键由前端自己拼名字
          checked += 1;
          for (const key of [field.labelKey, field.descKey]) {
            const text = table[key];
            assert.equal(typeof text, 'string', `${name} 的 ${field.path} 缺 ${key}`);
            assert.ok(text.trim().length > 0, `${key} 不能是空文字`);
            assert.notEqual(text, key, `${key} 没有真正的中文文字`);
            assert.ok(!text.includes('\u5a18'), `${key} 里不该出现那个字`);
          }
        }
      }
      assert.ok(checked > 200, `应该检查到不少字段，实际 ${checked}`);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ————————————————————————————————— .env —————————————————————————————————

test('/api/env：没写过也给全字段，密钥盖住，分组带本地化键', async () => {
  await withServer({}, async ({ base, root }) => {
    const empty = await (await fetch(`${base}/api/env`)).json();
    assert.equal(empty.ok, true);
    assert.equal(empty.exists, false);
    assert.equal(empty.file, '.env');
    assert.equal(empty.groups.length, 7);
    assert.ok(empty.keys.includes('MODEL_API_KEY'));
    assert.match(empty.note, /\*\*\*\*\*\*\*\*/);

    const model = empty.groups.find((group) => group.key === 'model');
    const key = model.fields.find((field) => field.key === 'MODEL_API_KEY');
    assert.equal(key.secret, true);
    assert.equal(key.value, '', '没写过就是空串，不是 MASK');
    assert.equal(key.set, false);
    assert.equal(key.labelKey, 'web.env.MODEL_API_KEY.label');
    assert.equal(key.descKey, 'web.env.MODEL_API_KEY.desc');

    const mode = empty.groups.flatMap((group) => group.fields).find((field) => field.key === 'ONEBOT_MODE');
    assert.equal(mode.type, 'enum');
    assert.deepEqual(mode.options, ['forward', 'reverse', 'http']);

    await fs.writeFile(
      path.join(root, '.env'),
      ['# 注释要留住', 'MODEL_BASE_URL=https://api.example.com/v1', 'MODEL_API_KEY=sk-real', '', 'LOG_LEVEL=debug # 尾注释', ''].join('\n'),
      'utf8',
    );
    const filled = await (await fetch(`${base}/api/env`)).json();
    assert.equal(filled.exists, true);
    const flat = new Map(filled.groups.flatMap((group) => group.fields).map((field) => [field.key, field]));
    // 密钥字段给的是真值：页面上默认按密码框打码，点「显示」就能看见（给 ******** 等于永远看不见）
    assert.equal(flat.get('MODEL_API_KEY').value, 'sk-real');
    assert.equal(flat.get('MODEL_BASE_URL').value, 'https://api.example.com/v1');
    assert.equal(flat.get('LOG_LEVEL').value, 'debug');
    assert.equal(flat.get('LOG_LEVEL').set, true);
  });
});

test('PUT /api/env：MASK 回填旧值、注释与顺序不动、写前备份', async () => {
  await withServer({}, async ({ base, root }) => {
    const before = ['# 头注释', 'MODEL_API_KEY=sk-real', 'MODEL_NAME=old-model', '# 中间注释', 'ADMIN_QQ=10001', ''].join('\n');
    await fs.writeFile(path.join(root, '.env'), before, 'utf8');

    const response = await fetch(`${base}/api/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { MODEL_API_KEY: '********', MODEL_NAME: 'new-model', LOG_LEVEL: 'warn' } }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.deepEqual([...data.changed].sort(), ['LOG_LEVEL', 'MODEL_NAME'], 'MASK 不算改动');
    assert.ok(data.backup, '写之前要备份');
    assert.match(data.backupRelative.replace(/\\/g, '/'), /^data\/config-backup\/env-/);
    assert.equal(await fs.readFile(data.backup, 'utf8'), before);

    const text = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(text, /# 头注释/);
    assert.match(text, /# 中间注释/);
    assert.match(text, /MODEL_API_KEY=sk-real/, 'MASK 要换回旧值');
    assert.match(text, /MODEL_NAME=new-model/);
    assert.match(text, /LOG_LEVEL=warn/, '新键追加到末尾');
    assert.ok(text.indexOf('# 头注释') < text.indexOf('# 中间注释'), '顺序不能乱');
    const leftovers = await fs.readdir(root);
    assert.ok(!leftovers.some((item) => item.includes('.tmp')), '不能留下临时文件');

    const again = await (await fetch(`${base}/api/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { MODEL_NAME: 'new-model' } }),
    })).json();
    assert.deepEqual(again.changed, [], '值没变就不算改动');
  });
});

test('PUT /api/env 拒绝表外的键与非对象，磁盘不动', async () => {
  await withServer({}, async ({ base, root }) => {
    const before = 'MODEL_NAME=old-model\n';
    await fs.writeFile(path.join(root, '.env'), before, 'utf8');

    const unknown = await fetch(`${base}/api/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { NOT_A_REAL_KEY: 'x', MODEL_NAME: 'y' } }),
    });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).ok, false);

    const array = await fetch(`${base}/api/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2]),
    });
    assert.equal(array.status, 400);

    const valuesArray = await fetch(`${base}/api/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: ['MODEL_NAME'] }),
    });
    assert.equal(valuesArray.status, 400);

    assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), before);
  });
});

// ————————————————————————————————— 本地化键 —————————————————————————————————

test('/api/i18n：读得到全部本地化键，改一条就落盘，撤回后回到默认', async () => {
  await withServer({}, async ({ base, root }) => {
    const listed = await (await fetch(`${base}/api/i18n`)).json();
    assert.equal(listed.ok, true);
    assert.equal(listed.locale, 'zh-CN');
    assert.equal(listed.file, 'data/locales/zh-CN.json');
    assert.ok(listed.keys.length > 600);
    assert.ok(listed.keys.includes('web.config.note'));
    assert.equal(listed.values['web.config.note'], listed.defaults['web.config.note']);
    assert.deepEqual(listed.overrides, {});
    assert.match(listed.values['web.config.note'], /脱敏/);

    const saved = await (await fetch(`${base}/api/i18n`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'web.config.note': '这是面板改过的文字' } }),
    })).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.saved.count, 1);
    assert.equal(saved.overrides['web.config.note'], '这是面板改过的文字');

    const file = path.join(root, 'data', 'locales', 'zh-CN.json');
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(onDisk, { 'web.config.note': '这是面板改过的文字' });

    const reread = await (await fetch(`${base}/api/i18n`)).json();
    assert.equal(reread.values['web.config.note'], '这是面板改过的文字');

    const reset = await (await fetch(`${base}/api/i18n`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: ['web.config.note'] }),
    })).json();
    assert.equal(reset.ok, true);
    assert.deepEqual(reset.overrides, {});
    assert.equal(reset.values['web.config.note'], listed.defaults['web.config.note']);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {}, '撤回后覆盖文件里不留这条');

    const noMethod = await fetch(`${base}/api/i18n`, { method: 'DELETE' });
    assert.equal(noMethod.status, 405);
  });
});

test('PUT /api/i18n 拒绝不存在的键与非字符串值', async () => {
  await withServer({}, async ({ base, root }) => {
    const unknown = await fetch(`${base}/api/i18n`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'web.not.a.key': 'x' } }),
    });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).ok, false);

    const unknownReset = await fetch(`${base}/api/i18n`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: ['web.not.a.key'] }),
    });
    assert.equal(unknownReset.status, 400);

    const notString = await fetch(`${base}/api/i18n`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { 'web.config.note': 42 } }),
    });
    assert.equal(notString.status, 400);

    const array = await fetch(`${base}/api/i18n`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['web.config.note']),
    });
    assert.equal(array.status, 400);

    const wrote = await fs.readFile(path.join(root, 'data', 'locales', 'zh-CN.json'), 'utf8').catch(() => null);
    assert.equal(wrote, null, '失败的保存不落盘');
  });
});

// ————————————————————————————————— 服务 —————————————————————————————————

test('/api/services：五个服务、统一形状、概览进 /api/status', async () => {
  await withServer({}, async ({ base }) => {
    const data = await (await fetch(`${base}/api/services`)).json();
    assert.equal(data.ok, true);
    assert.equal(data.mode, 'standalone');
    assert.deepEqual(data.services.map((row) => row.id), ['panel', 'node', 'napcat', 'ruohua', 'sidecar']);

    for (const row of data.services) {
      assert.ok(row.titleKey.startsWith('web.service.'));
      assert.ok(row.descKey.startsWith('web.service.'));
      assert.ok(['running', 'ok', 'stopped', 'unknown', 'warn'].includes(row.status), `怪状态：${row.status}`);
      assert.ok(row.statusKey.startsWith('web.service.status.'));
      assert.ok(Array.isArray(row.detail) && row.detail.length > 0);
      for (const item of row.detail) {
        assert.ok(item.labelKey.startsWith('web.service.'), `detail 的 labelKey 不对：${item.labelKey}`);
        assert.ok(item.value === null || ['string', 'number', 'boolean'].includes(typeof item.value));
        if (item.valueKey) assert.ok(item.valueKey.startsWith('web.service.'));
      }
      assert.ok(Array.isArray(row.actions) && row.actions.length > 0);
      for (const action of row.actions) {
        assert.ok(['check', 'start', 'stop', 'restart', 'open'].includes(action.id), `怪动作：${action.id}`);
        assert.equal(action.labelKey, `web.service.action.${action.id}`);
        assert.equal(typeof action.primary, 'boolean');
      }
      assert.equal(row.actions.filter((action) => action.primary).length, 1, '每个服务只能有一个主按钮');
    }

    const actionsById = new Map(data.services.map((row) => [row.id, row.actions.map((action) => action.id)]));
    assert.deepEqual(actionsById.get('panel'), ['check'], '面板不给自己停机的按钮');
    assert.deepEqual(actionsById.get('napcat'), ['check', 'start', 'stop', 'open']);
    assert.deepEqual(actionsById.get('ruohua'), ['check', 'start', 'stop', 'restart']);
    assert.deepEqual(actionsById.get('sidecar'), ['check', 'start', 'stop']);

    const panel = data.services.find((row) => row.id === 'panel');
    assert.equal(panel.status, 'running', '面板自己当然在跑');

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.mode, 'standalone');
    assert.equal(status.services.mode, 'standalone');
    assert.equal(status.services.count, 5);
    assert.deepEqual(status.services.items.map((item) => item.id), ['panel', 'node', 'napcat', 'ruohua', 'sidecar']);
    assert.ok(status.services.items.every((item) => item.statusKey.startsWith('web.service.status.')));

    const method = await fetch(`${base}/api/services`, { method: 'POST', body: '{}' });
    assert.equal(method.status, 405);
  });
});

test('POST /api/services/:id：未知服务 404、未知动作 400、独立模式下侧车启动 503', async () => {
  await withServer({}, async ({ base }) => {
    const ghost = await fetch(`${base}/api/services/ghost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    });
    assert.equal(ghost.status, 404);
    assert.equal((await ghost.json()).ok, false);

    const badAction = await fetch(`${base}/api/services/node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reboot' }),
    });
    assert.equal(badAction.status, 400);

    const missing = await fetch(`${base}/api/services/node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const check = await fetch(`${base}/api/services/node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    });
    assert.equal(check.status, 200);
    const checked = await check.json();
    assert.equal(checked.ok, true);
    assert.equal(checked.id, 'node');
    assert.equal(checked.action, 'check');
    assert.ok(checked.statusKey.startsWith('web.service.status.'));
    assert.ok(Array.isArray(checked.services) && checked.services.length === 5, '动作之后要回一份新清单');
    for (const row of checked.services) assert.ok(row.detail.length > 0);

    const sidecar = await fetch(`${base}/api/services/sidecar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    assert.equal(sidecar.status, 503, '独立模式下侧车的启停要主程序');
    assert.equal((await sidecar.json()).ok, false);

    const getAction = await fetch(`${base}/api/services/node/start`);
    assert.equal(getAction.status, 404, '动作只能 POST');

    const wrongPath = await fetch(`${base}/api/services/node/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    });
    assert.equal(wrongPath.status, 404, '路径里不能塞动作');
  });
});

test('/api/peers：扫到的面板进数组，扫不到就空数组', async () => {
  await withServer({}, async ({ base }) => {
    const none = await (await fetch(`${base}/api/peers`)).json();
    assert.equal(none.ok, true);
    assert.equal(none.mode, 'standalone');
    assert.ok(none.self.port > 0);
    assert.equal(none.self.url, `http://127.0.0.1:${none.self.port}`);
    assert.ok(Array.isArray(none.peers));
    assert.ok(!none.peers.some((peer) => peer.port === none.self.port), '自己不算 peer');
  });

  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (!String(url).startsWith('http://127.0.0.1:8789/')) throw new Error('connection refused');
    return { ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8789, clients: 0 } }) };
  };
  await withServer({ options: { fetchImpl } }, async ({ base }) => {
    const data = await (await fetch(`${base}/api/peers`)).json();
    assert.deepEqual(data.peers, [{ url: 'http://127.0.0.1:8789', port: 8789, mode: 'attached' }]);
    assert.ok(seen.length >= 8, '要真去扫那段端口');
  });
});

test('新接口一样受令牌保护', async () => {
  const token = 'tok3n-Services1';
  await withServer({ options: { token } }, async ({ base }) => {
    for (const pathname of ['/api/services', '/api/env', '/api/i18n', '/api/peers']) {
      const denied = await fetch(`${base}${pathname}`);
      assert.equal(denied.status, 401, `${pathname} 没拦住`);
    }
    const post = await fetch(`${base}/api/services/node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    });
    assert.equal(post.status, 401);

    const put = await fetch(`${base}/api/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: {} }),
    });
    assert.equal(put.status, 401);

    for (const pathname of ['/api/services', '/api/env', '/api/i18n', '/api/peers']) {
      const allowed = await fetch(`${base}${pathname}?token=${encodeURIComponent(token)}`);
      assert.equal(allowed.status, 200, `${pathname} 带对了令牌还进不去`);
    }
  });
});

// ————————————————————————————————— 表情包 —————————————————————————————————

/** 假表情包服务：索引在内存里，图片落在临时目录，只有 update 会“落盘”（记下来）。 */
async function stickerFixture(root) {
  const dir = path.join(root, 'stickers');
  await fs.mkdir(dir, { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await fs.writeFile(path.join(dir, 'sticker_aaa1.png'), png);
  await fs.writeFile(path.join(dir, 'sticker_bbb2.png'), png);
  await fs.writeFile(path.join(dir, 'notes.txt'), '不是图片', 'utf8');
  await fs.writeFile(path.join(root, 'outside.png'), png);

  const items = [
    { id: 'aaa1', file: 'sticker_aaa1.png', ext: '.png', bytes: png.length, title: '嘿嘿', meaning: '得意', tags: ['得意', '开心'], addedBy: 10001, addedAt: 300, usedCount: 2, lastUsedAt: 400, sourceHash: 'deadbeef' },
    { id: 'bbb2', file: 'sticker_bbb2.png', ext: '.png', bytes: png.length, title: '', meaning: '委屈', tags: ['难过'], addedBy: null, addedAt: 200, usedCount: 0, lastUsedAt: null, sourceHash: 'cafe' },
  ];
  // 存储层吐出来的条目带 path（面板认图时要按路径把文件读给模型）
  for (const item of items) item.path = path.join(dir, item.file);
  const updates = [];
  const removed = [];
  const described = [];
  const sticker = {
    dir,
    enabled: true,
    list({ tag = null, keyword = null, limit = null, offset = 0 } = {}) {
      let rows = items.slice();
      if (tag) rows = rows.filter((item) => item.tags.includes(tag));
      if (keyword) rows = rows.filter((item) => `${item.meaning}${item.id}${item.tags.join('')}`.includes(keyword));
      rows.sort((a, b) => b.addedAt - a.addedAt);
      const start = Math.max(0, Number(offset) || 0);
      return Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(start, start + Math.trunc(Number(limit))) : rows.slice(start);
    },
    get: (id) => items.find((item) => item.id === id) ?? null,
    remove: async (id) => {
      const index = items.findIndex((row) => row.id === id);
      if (index < 0) return false;
      removed.push(items.splice(index, 1)[0]);
      return true;
    },
    stats: () => ({ total: items.length, byTag: { 得意: 1, 开心: 1, 难过: 1 }, learned: items.length, sent: 2, lastUsedAt: 400, lastLearnedAt: 300, notes: 1, describes: 0, enabled: true }),
    notes: () => [{ userId: 10002, count: 3, faces: [], recent: [], lastAt: 500 }],
    describe: async (target) => {
      described.push(target);
      return { title: '哭笑不得', meaning: '画的是捂脸哭；对方说的太离谱时用', tags: ['离谱'] };
    },
    library: {
      dir,
      update: async (id, patch) => {
        const item = items.find((row) => row.id === id);
        if (!item) return null;
        updates.push({ id, patch });
        Object.assign(item, patch);
        return item;
      },
    },
  };
  return { sticker, items, updates, removed, described, dir, png };
}

test('/api/stickers：独立模式给一致的空壳，不 500', async () => {
  await withServer({}, async ({ base }) => {
    const listed = await fetch(`${base}/api/stickers`);
    assert.equal(listed.status, 200);
    const data = await listed.json();
    assert.equal(data.ok, true);
    assert.equal(data.mode, 'standalone');
    assert.equal(data.count, 0);
    assert.equal(data.total, 0);
    assert.deepEqual(data.items, []);
    assert.equal(data.stats, null);
    assert.deepEqual(data.notes, []);
    assert.match(data.note, /启动若华主程序/);

    const one = await fetch(`${base}/api/stickers/aaa1`);
    assert.equal(one.status, 503);
    assert.equal((await one.json()).ok, false);

    const put = await fetch(`${base}/api/stickers/aaa1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meaning: '随便' }),
    });
    assert.equal(put.status, 503);

    const del = await fetch(`${base}/api/stickers/aaa1`, { method: 'DELETE' });
    assert.equal(del.status, 503, '独立模式下删图也要说「先启动主程序」');

    const file = await fetch(`${base}/api/stickers/aaa1/file`);
    assert.equal(file.status, 503);

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.sticker, undefined, '没接上表情包就别给这一段');
  });
});

test('/api/stickers：列表带过滤与分页，单张详情带能直接用的图片地址', async () => {
  const root = await tempRoot();
  const fixture = await stickerFixture(root);
  try {
    await withServer({ root, services: { sticker: fixture.sticker } }, async ({ base }) => {
      const all = await (await fetch(`${base}/api/stickers`)).json();
      assert.equal(all.ok, true);
      assert.equal(all.mode, 'attached');
      assert.equal(all.count, 2);
      assert.equal(all.total, 2);
      assert.deepEqual(all.items.map((item) => item.id), ['aaa1', 'bbb2']);
      assert.deepEqual(
        Object.keys(all.items[0]).sort(),
        ['addedAt', 'addedBy', 'bytes', 'ext', 'file', 'id', 'lastUsedAt', 'meaning', 'tags', 'title', 'url', 'usedCount'],
        '列表项的字段是固定的那一组',
      );
      assert.equal(all.items[0].url, '/api/stickers/aaa1/file');
      assert.equal(all.items[0].meaning, '得意');
      assert.equal(all.items[0].usedCount, 2);
      assert.equal(all.items[0].sourceHash, undefined, '内部字段不外泄');
      assert.equal(all.stats.total, 2);
      assert.equal(all.stats.sent, 2);
      assert.equal(all.stats.learned, 2);
      assert.equal(all.stats.enabled, true);
      assert.equal(all.notes.length, 1);
      assert.equal(all.notes[0].userId, 10002);
      assert.equal(all.note, null);

      const byTag = await (await fetch(`${base}/api/stickers?tag=${encodeURIComponent('难过')}`)).json();
      assert.equal(byTag.count, 1);
      assert.deepEqual(byTag.items.map((item) => item.id), ['bbb2']);

      const byKeyword = await (await fetch(`${base}/api/stickers?keyword=${encodeURIComponent('得意')}`)).json();
      assert.equal(byKeyword.count, 1);
      assert.equal(byKeyword.total, 1, 'total 是过滤后的总数，方便翻页');

      const paged = await (await fetch(`${base}/api/stickers?limit=1`)).json();
      assert.equal(paged.count, 1);
      assert.equal(paged.total, 2);
      assert.deepEqual(paged.items.map((item) => item.id), ['aaa1']);
      assert.deepEqual(paged.filter, { tag: null, keyword: null, limit: 1, offset: 0 });

      const second = await (await fetch(`${base}/api/stickers?limit=1&offset=1`)).json();
      assert.deepEqual(second.items.map((item) => item.id), ['bbb2']);

      const one = await (await fetch(`${base}/api/stickers/bbb2`)).json();
      assert.equal(one.ok, true);
      assert.equal(one.item.id, 'bbb2');
      assert.equal(one.item.meaning, '委屈');
      assert.equal(one.item.usedCount, 0);
      assert.equal(one.item.addedBy, null);
      assert.equal(one.url, '/api/stickers/bbb2/file');

      assert.equal((await fetch(`${base}/api/stickers/ghost`)).status, 404);
      assert.equal((await fetch(`${base}/api/stickers/${encodeURIComponent('../../config/bot.json')}`)).status, 400);
      assert.equal((await fetch(`${base}/api/stickers`, { method: 'POST', body: '{}' })).status, 405);

      const status = await (await fetch(`${base}/api/status`)).json();
      assert.deepEqual(status.sticker, { total: 2, sent: 2, learned: 2 });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POST /api/stickers/:id/describe：给出标题 / 内容描述 / 标签建议，不落盘', async () => {
  const root = await tempRoot();
  const fixture = await stickerFixture(root);
  try {
    await withServer({ root, services: { sticker: fixture.sticker } }, async ({ base }) => {
      const response = await fetch(`${base}/api/stickers/aaa1/describe`, { method: 'POST' });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.ok, true);
      assert.equal(data.id, 'aaa1');
      assert.deepEqual(data.suggestion, { title: '哭笑不得', meaning: '画的是捂脸哭；对方说的太离谱时用', tags: ['离谱'] });
      assert.equal(fixture.described[0], fixture.items[0].path, '按条目的 path 把文件交给模型');
      assert.deepEqual(fixture.updates, [], '只给建议，别自己落盘');

      assert.equal((await fetch(`${base}/api/stickers/ghost/describe`, { method: 'POST' })).status, 404);
      assert.equal((await fetch(`${base}/api/stickers/aaa1/describe`)).status, 405, 'describe 只认 POST');

      const entries = await fs.readFile(path.join(root, 'data', 'logs', `operation-${localDayStamp()}.jsonl`), 'utf8').catch(() => '');
      assert.match(entries, /sticker_describe/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('PUT /api/stickers/:id：改含义与标签，落到存储层', async () => {
  const root = await tempRoot();
  const fixture = await stickerFixture(root);
  try {
    await withServer({ root, services: { sticker: fixture.sticker } }, async ({ base, logger }) => {
      const response = await fetch(`${base}/api/stickers/aaa1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '  嘿嘿  ', meaning: '  得意得很  ', tags: [' 得意 ', '', '开心'] }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.ok, true);
      assert.equal(data.item.title, '嘿嘿');
      assert.equal(data.item.meaning, '得意得很');
      assert.deepEqual(data.item.tags, ['得意', '开心']);
      assert.deepEqual(fixture.updates, [{ id: 'aaa1', patch: { title: '嘿嘿', meaning: '得意得很', tags: ['得意', '开心'] } }]);

      const onlyTags = await (await fetch(`${base}/api/stickers/bbb2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['难过'] }),
      })).json();
      assert.equal(onlyTags.ok, true);
      assert.deepEqual(fixture.updates[1], { id: 'bbb2', patch: { tags: ['难过'] } });

      const cases = [
        [{}, 400],
        [{ meaning: 42 }, 400],
        [{ title: 42 }, 400],
        [{ tags: '难过' }, 400],
        [{ tags: [1] }, 400],
      ];
      for (const [body, status] of cases) {
        const bad = await fetch(`${base}/api/stickers/aaa1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(bad.status, status, `${JSON.stringify(body)} 该是 ${status}`);
      }

      const arrayBody = await fetch(`${base}/api/stickers/aaa1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['得意']),
      });
      assert.equal(arrayBody.status, 400);

      const missing = await fetch(`${base}/api/stickers/ghost`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meaning: 'x' }),
      });
      assert.equal(missing.status, 404);
      assert.equal(fixture.updates.length, 2, '失败的请求不该动索引');

      const badId = await fetch(`${base}/api/stickers/${encodeURIComponent('../evil')}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meaning: 'x' }),
      });
      assert.equal(badId.status, 400);

      const entries = await fs.readFile(path.join(root, 'data', 'logs', `operation-${localDayStamp()}.jsonl`), 'utf8').catch(() => '');
      assert.match(entries, /sticker_update/);
      assert.ok(logger, '操作日志走 logger.operation');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DELETE /api/stickers/:id：连图一起删，找不到 404，怪 id 400，其它方法 405', async () => {
  const root = await tempRoot();
  const fixture = await stickerFixture(root);
  try {
    await withServer({ root, services: { sticker: fixture.sticker } }, async ({ base }) => {
      const response = await fetch(`${base}/api/stickers/bbb2`, { method: 'DELETE' });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(
        { ok: data.ok, id: data.id, removed: data.removed, total: data.total },
        { ok: true, id: 'bbb2', removed: true, total: 1 },
      );
      assert.deepEqual(fixture.removed.map((item) => item.id), ['bbb2'], '要真的走服务层的 remove');
      assert.equal((await fetch(`${base}/api/stickers/bbb2`)).status, 404, '删完就查不到了');
      assert.equal((await fetch(`${base}/api/stickers/bbb2`, { method: 'DELETE' })).status, 404, '再删一次是 404');
      assert.equal(fixture.removed.length, 1, '404 的那次不该动索引');
      assert.equal(
        (await fetch(`${base}/api/stickers/${encodeURIComponent('../evil')}`, { method: 'DELETE' })).status,
        400,
      );
      const patch = await fetch(`${base}/api/stickers/aaa1`, { method: 'PATCH' });
      assert.equal(patch.status, 405);
      assert.match((await patch.json()).error, /DELETE/);

      const entries = await fs
        .readFile(path.join(root, 'data', 'logs', `operation-${localDayStamp()}.jsonl`), 'utf8')
        .catch(() => '');
      assert.match(entries, /sticker_remove/);
      assert.match(entries, /sticker_bbb2\.png/, '操作日志里要写清删掉的是哪个文件');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('/api/stickers/:id/file：吐图片，路径越界与怪格式一律拒', async () => {  const root = await tempRoot();
  const fixture = await stickerFixture(root);
  try {
    await withServer({ root, services: { sticker: fixture.sticker } }, async ({ base }) => {
      const image = await fetch(`${base}/api/stickers/aaa1/file`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await image.arrayBuffer());
      assert.deepEqual(bytes, fixture.png);

      const head = await fetch(`${base}/api/stickers/aaa1/file`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-type'), 'image/png');

      assert.equal((await fetch(`${base}/api/stickers/ghost/file`)).status, 404);
      assert.equal((await fetch(`${base}/api/stickers/${encodeURIComponent('..%2f..%2fconfig%2fbot.json')}/file`)).status, 400);

      // 索引被人改坏了：文件名指向目录外面 —— 只认 stickers/ 里的文件
      fixture.items.push({ id: 'evil', file: '../outside.png', ext: '.png', bytes: 4, meaning: '', tags: [], addedAt: 1, usedCount: 0 });
      const escape = await fetch(`${base}/api/stickers/evil/file`);
      assert.equal(escape.status, 403);
      assert.match((await escape.json()).error, /目录外面/);

      // 不是图片：按后缀拦下来
      fixture.items.push({ id: 'evil2', file: 'notes.txt', ext: '.txt', bytes: 4, meaning: '', tags: [], addedAt: 1, usedCount: 0 });
      const text = await fetch(`${base}/api/stickers/evil2/file`);
      assert.equal(text.status, 403);
      assert.match((await text.json()).error, /图片格式/);

      // 索引里有、盘上没有：404
      fixture.items.push({ id: 'ghost2', file: 'sticker_gone.png', ext: '.png', bytes: 4, meaning: '', tags: [], addedAt: 1, usedCount: 0 });
      assert.equal((await fetch(`${base}/api/stickers/ghost2/file`)).status, 404);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('配了令牌时，图片地址里带着令牌，好让 <img src> 直接用', async () => {
  const root = await tempRoot();
  const fixture = await stickerFixture(root);
  const token = 'tok3n-Stickers9';
  try {
    await withServer({ root, services: { sticker: fixture.sticker }, options: { token } }, async ({ base }) => {
      const data = await (await fetch(`${base}/api/stickers/aaa1?token=${encodeURIComponent(token)}`)).json();
      assert.equal(data.url, `/api/stickers/aaa1/file?token=${encodeURIComponent(token)}`);
      assert.equal((await fetch(`${base}${data.url}`)).status, 200, '拿这个地址能直接取到图');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
