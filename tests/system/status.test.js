/** 状态汇报：给聊天软件发的中文短句，含模型名与运行时长。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusReporter } from '../../src/system/status.js';

const config = {
  bot: { name: '若华' },
  model: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', visionModel: '' },
  sidecar: { enabled: true },
};

function makeServices(patch = {}) {
  return {
    startedAt: Date.now() - 3_660_000,
    llm: {
      modelName: 'deepseek-chat',
      visionModelName: null,
      baseUrl: 'https://api.deepseek.com/v1',
      usageTotals: () => ({
        requests: 3,
        failed: 0,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        since: Date.now(),
        byModel: {},
      }),
      balance: async () => null,
    },
    memory: { stats: () => ({ temporary: 3, permanent: 1, users: 2, lastConsolidateAt: null }) },
    tasks: { stats: () => ({ total: 2, running: 1, waiting: 0, done: 1 }) },
    scheduler: { stats: () => ({ total: 3, enabled: 2, done: 1, nextRunAt: Date.now() + 600_000, nextName: '早安' }) },
    onebot: {
      status: async () => ({ connected: true, selfId: 2233 }),
      getLoginInfo: async () => ({ nickname: '若华', user_id: 2233 }),
    },
    sidecar: { available: true, probe: async () => ({ ok: true }) },
    emotion: { snapshot: () => ({ 10001: { affection: 60, mood: '开心' }, 10002: { affection: 20, mood: '平静' } }) },
    contextStats: () => ({ tokens: 1200, limit: 6000 }),
    ...patch,
  };
}

test('状态汇报是一段中文短句，含模型名、运行时长与用量', async () => {
  const reporter = createStatusReporter({ config, logger: null, services: makeServices() });
  const text = await reporter.report();

  assert.equal(typeof text, 'string');
  assert.ok(text.includes('deepseek-chat'), text);
  assert.ok(text.includes('运行时长：1小时1分钟'), text);
  assert.ok(text.includes('已用 token：150'), text);
  assert.ok(text.includes('余额：拿不到余额信息'), text);
  assert.ok(text.includes('记忆：临时 3 条，永久 1 条，覆盖 2 个人'), text);
  assert.ok(text.includes('任务：共 2 个'), text);
  assert.ok(text.includes('定时任务：2 个在跑'), text);
  assert.ok(text.includes('OneBot 已连接'), text);
  assert.ok(text.includes('2233'), text);
  assert.ok(text.includes('上下文占用：约 1200 token / 上限 6000'), text);
  assert.ok(text.includes('情感：2 个人'), text);
  assert.ok(text.includes('侧车：可用'), text);
  // 聊天窗口不渲染 Markdown，不能出现表格
  assert.ok(!text.includes('|'), text);
  assert.ok(text.split('\n').length >= 10, text);
  assert.ok(text.startsWith('若华'), text);
});

test('模块缺失或接口报错时也能给出兜底文字', async () => {
  const reporter = createStatusReporter({
    config,
    logger: null,
    services: {
      startedAt: Date.now(),
      llm: {
        modelName: 'deepseek-chat',
        usageTotals: () => {
          throw new Error('坏了');
        },
        balance: async () => {
          throw new Error('也坏了');
        },
      },
    },
  });
  const text = await reporter.report();
  assert.ok(text.includes('deepseek-chat'), text);
  assert.ok(text.includes('余额：拿不到余额信息'), text);
  assert.ok(text.includes('连接：OneBot 没有装配'), text);
  assert.ok(text.includes('运行时长：0秒'), text);
  assert.ok(text.split('\n').length >= 4, text);
});

test('拿得到余额时就把余额写进去', async () => {
  const reporter = createStatusReporter({
    config,
    logger: null,
    services: makeServices({
      llm: {
        modelName: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        usageTotals: () => ({ requests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
        balance: async () => ({ balance: '12.34', currency: 'CNY', available: true }),
      },
    }),
  });
  const text = await reporter.report();
  assert.ok(text.includes('余额：12.34 CNY'), text);
});
