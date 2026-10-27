/** 自检：离线跳过、单项失败判不通过、提示能指导人。 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSelfCheck } from '../../src/system/selfcheck.js';

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

async function makeRoot({ withConfig = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-selfcheck-'));
  TEMP_DIRS.push(root);
  if (withConfig) {
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await fs.writeFile(path.join(root, 'config', 'model.json'), JSON.stringify({ model: 'test-model' }));
    await fs.writeFile(path.join(root, 'config', 'security.json'), JSON.stringify({ admins: [10001] }));
  }
  return root;
}

function makeConfig(root, patch = {}) {
  const config = {
    rootDir: root,
    dataDir: path.join(root, 'data'),
    logDir: path.join(root, 'data', 'logs'),
    boundaryRoot: root,
    offline: false,
    env: {},
    bot: { name: '若华', onebot: { mode: 'forward' } },
    model: { model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-1234567890', visionModel: '' },
    sidecar: { enabled: true, url: 'http://127.0.0.1:8765' },
    security: {
      admins: [10001],
      passphrase: { enabled: true, pool: ['芝麻开门', '明月几时有'] },
      boundary: { mode: 'sandbox' },
    },
  };
  return {
    ...config,
    ...patch,
    security: { ...config.security, ...(patch.security ?? {}) },
    model: { ...config.model, ...(patch.model ?? {}) },
    sidecar: { ...config.sidecar, ...(patch.sidecar ?? {}) },
  };
}

function makeServices(overrides = {}) {
  return {
    llm: {
      async chat() {
        return { content: 'ok' };
      },
    },
    onebot: {
      async status() {
        return { connected: true, selfId: 2233 };
      },
    },
    sidecar: {
      async probe() {
        return { ok: true, version: '0.1.0', features: { embed: true, screenshot: true, asr: false } };
      },
    },
    security: { boundary: { describe: () => '边界模式：sandbox（受限）\n工作区根目录：D:\\Desktop\\RuoHua_Bot' } },
    ...overrides,
  };
}

test('离线模式跳过模型连通检查，其余项照常', async () => {
  const root = await makeRoot();
  const report = await createSelfCheck({ config: makeConfig(root), logger: null, services: makeServices() }).run({ offline: true });

  const item = report.items.find((entry) => entry.name === '模型接口连通');
  assert.equal(item.level, 'warn');
  assert.equal(item.ok, false);
  assert.match(item.detail, /跳过/);
  assert.ok(item.hint);

  for (const entry of report.items) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.detail, 'string');
    assert.ok(['ok', 'warn', 'fail'].includes(entry.level), entry.name);
  }
  assert.ok(report.items.length >= 10, `检查项太少：${report.items.length}`);
  assert.equal(report.ok, true);
  assert.match(report.summary, /^自检通过/);
  assert.match(report.summary, /项提醒/);
  assert.ok(report.startedAt > 0);
});

test('非离线模式下模型调用失败只提醒，不判整份自检失败', async () => {
  const root = await makeRoot();
  const services = makeServices({
    llm: {
      async chat() {
        const error = new Error('网络不通');
        error.code = 'network_error';
        throw error;
      },
    },
  });
  const report = await createSelfCheck({ config: makeConfig(root), logger: null, services }).run();
  const item = report.items.find((entry) => entry.name === '模型接口连通');
  assert.equal(item.level, 'warn');
  assert.match(item.detail, /network_error/);
  assert.equal(report.ok, true);
});

test('数据目录写不了就是失败，并给出怎么办', async () => {
  const root = await makeRoot();
  const blocker = path.join(root, 'blocker');
  await fs.writeFile(blocker, 'x');
  const config = makeConfig(root, { dataDir: path.join(blocker, 'data'), logDir: path.join(root, 'data', 'logs') });
  const report = await createSelfCheck({ config, logger: null, services: makeServices() }).run({ offline: true });

  const item = report.items.find((entry) => entry.name === '数据目录');
  assert.equal(item.level, 'fail');
  assert.equal(item.ok, false);
  assert.match(item.detail, /不可写/);
  assert.ok(item.hint && item.hint.length > 6, String(item.hint));
  assert.equal(report.ok, false);
  assert.match(report.summary, /^自检未通过/);
  assert.match(report.summary, /1 项失败/);
});

test('OneBot 状态查不了算失败', async () => {
  const root = await makeRoot();
  const services = makeServices({
    onebot: {
      async status() {
        throw new Error('客户端没起来');
      },
    },
  });
  const report = await createSelfCheck({ config: makeConfig(root), logger: null, services }).run({ offline: true });
  const item = report.items.find((entry) => entry.name === 'OneBot 连接');
  assert.equal(item.level, 'fail');
  assert.match(item.detail, /客户端没起来/);
  assert.ok(item.hint);
  assert.equal(report.ok, false);
});

test('没连上 OneBot 只是提醒', async () => {
  const root = await makeRoot();
  const services = makeServices({ onebot: { async status() { return { connected: false }; } } });
  const report = await createSelfCheck({ config: makeConfig(root), logger: null, services }).run({ offline: true });
  const item = report.items.find((entry) => entry.name === 'OneBot 连接');
  assert.equal(item.level, 'warn');
  assert.match(item.detail, /未连接/);
});

test('口令池为空算失败，trusted 边界要提醒', async () => {
  const root = await makeRoot();
  const config = makeConfig(root, {
    security: { passphrase: { enabled: true, pool: [] }, boundary: { mode: 'trusted' } },
  });
  const report = await createSelfCheck({ config, logger: null, services: makeServices() }).run({ offline: true });

  const pool = report.items.find((entry) => entry.name === '口令池');
  assert.equal(pool.level, 'fail');
  assert.match(pool.detail, /空/);
  assert.match(pool.hint, /pool/);

  const boundary = report.items.find((entry) => entry.name === '沙箱边界');
  assert.equal(boundary.level, 'warn');
  assert.match(boundary.hint, /sandbox/);
  assert.equal(report.ok, false);
});

test('侧车不可用只是提醒，不影响聊天', async () => {
  const root = await makeRoot();
  const services = makeServices({ sidecar: { async probe() { return { ok: false, error: 'connect ECONNREFUSED' }; } } });
  const report = await createSelfCheck({ config: makeConfig(root), logger: null, services }).run({ offline: true });
  const item = report.items.find((entry) => entry.name === 'Python 侧车');
  assert.equal(item.level, 'warn');
  assert.match(item.detail, /ECONNREFUSED/);
  assert.equal(report.ok, true);
});

test('边界挂在 services.boundary 上也认得', async () => {
  const root = await makeRoot();
  const services = {
    llm: makeServices().llm,
    onebot: makeServices().onebot,
    sidecar: makeServices().sidecar,
    boundary: { describe: () => '边界模式：sandbox（受限）\n工作区根目录：D:\\Desktop\\RuoHua_Bot' },
  };
  const report = await createSelfCheck({ config: makeConfig(root), logger: null, services }).run({ offline: true });
  const item = report.items.find((entry) => entry.name === '沙箱边界');
  assert.equal(item.level, 'ok');
  assert.match(item.detail, /sandbox/);
});
