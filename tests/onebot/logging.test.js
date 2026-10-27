/**
 * 断线时的日志节奏：协议端整点没开的时候，重连日志一小时能刷上百行。
 * 这里只验「压着报」这件事，不连真的协议端 —— 故意指一个没人听的端口。
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createOneBotClient } from '../../src/onebot/client.js';

/** 收日志的假 logger（child 返回自己，好接住所有分支）。 */
function recordingLogger() {
  const rows = [];
  const logger = {
    rows,
    debug: (message, error) => rows.push({ level: 'debug', message: String(message), error }),
    info: (message, error) => rows.push({ level: 'info', message: String(message), error }),
    warn: (message, error) => rows.push({ level: 'warn', message: String(message), error }),
    error: (message, error) => rows.push({ level: 'error', message: String(message), error }),
    operation: () => {},
    conversation: () => {},
    file: () => null,
    child: () => logger,
  };
  return logger;
}

function configFor(port, overrides = {}) {
  return {
    bot: {
      onebot: {
        mode: 'forward',
        wsUrl: `ws://127.0.0.1:${port}`,
        accessToken: '',
        reversePort: 0,
        reversePath: '/onebot',
        httpUrl: '',
        httpPort: 0,
        heartbeatTimeoutMs: 60000,
        reconnect: { minDelayMs: 20, maxDelayMs: 20, factor: 1 },
        requestTimeoutMs: 1000,
        selfId: 123,
        ...overrides,
      },
    },
    persona: { name: '若华' },
  };
}

/** 一个连不上的端口：先听上再关掉，端口短期内不会被人抢走。 */
async function closedPort() {
  const server = net.createServer(() => {});
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (rows, level, pattern) => rows.filter((row) => row.level === level && pattern.test(row.message)).length;

test('协议端没起来：重复的告警与重连日志都压着报，不刷屏', async () => {
  const port = await closedPort();
  const logger = recordingLogger();
  const client = createOneBotClient({ config: configFor(port), logger });
  try {
    await client.start();
    await sleep(1300);
    const attempts = client.status().attempts;
    assert.ok(attempts >= 10, `连不上就该一直重试，实际只试了 ${attempts} 次`);

    // 同一句 warn 在窗口（默认 5 分钟）内只打一次，其余并进这一条里
    assert.equal(count(logger.rows, 'warn', /OneBot 连接出错/), 1, '一小时上百行的「连接出错」要压成一条');

    // 重连播报：第一次必报，之后每 10 分钟一条 —— 测试里把窗口压到 1 秒，看它把静音的次数说明白
    const reconnectLines = logger.rows.filter((row) => row.level === 'info' && /重连/.test(row.message));
    assert.equal(reconnectLines.length, 1, '几十次重试只该留下第一条');
    assert.match(reconnectLines[0].message, /第 1 次重连/);
  } finally {
    await client.stop();
  }
});

test('重连播报的窗口翻篇：只报一条，但把中间静音的次数说清楚', async () => {
  const port = await closedPort();
  const logger = recordingLogger();
  const client = createOneBotClient({ config: configFor(port, { reconnectLogWindowMs: 400 }), logger });
  try {
    await client.start();
    await sleep(1400);
    const lines = logger.rows.filter((row) => row.level === 'info' && /重连/.test(row.message));
    assert.ok(lines.length >= 2, `窗口 400ms、跑了 1.4 秒，至少该有两条，实际 ${lines.length} 条`);
    assert.match(lines[0].message, /第 1 次重连/);
    assert.match(lines[1].message, /中间 \d+ 次重连没单独报/, '静音的那些次数要在下一条里交代');
    // 压着报，但确实比「每 20ms 一条」少得多
    assert.ok(lines.length < client.status().attempts, '重连日志条数必须明显少于重试次数');
  } finally {
    await client.stop();
  }
});

test('连上以后把静音的次数结清，下一次断线重新从第一条开始算', async () => {
  const port = await closedPort();
  const logger = recordingLogger();
  const client = createOneBotClient({ config: configFor(port, { reconnectLogWindowMs: 60_000 }), logger });
  let server = null;
  try {
    await client.start();
    await sleep(200);
    // 起一个真的 ws 服务端（客户端连的是根路径，别加 path 限制）：连上那一刻要交代「刚才静音的 N 次重连」
    server = new WebSocketServer({ port });
    await new Promise((resolve) => server.once('listening', resolve));
    await sleep(500);
    assert.equal(client.isConnected(), true, '连上以后状态要是已连接');
    const recovered = logger.rows.filter((row) => row.level === 'info' && /静音/.test(row.message));
    assert.equal(recovered.length, 1, '恢复时要交代一句之前静音了多少次');
    assert.match(recovered[0].message, /静音的 \d+ 次重连/);
  } finally {
    await client.stop();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  }
});
