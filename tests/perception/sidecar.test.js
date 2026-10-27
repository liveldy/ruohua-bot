/** 侧车客户端：探活、降级、只 warn 一次、参数透传。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSidecarClient } from '../../src/perception/sidecar.js';
import { makeConfig, makeLogger, makeRouter } from './helpers.js';

const HEALTH = {
  ok: true,
  service: 'ruohua-sidecar',
  version: '0.1.0',
  python: '3.11.0',
  platform: 'Windows-10',
  features: { embed: true, screenshot: true, asr: false, ocr: false },
};

function makeClient(handlers, { config = makeConfig(), logger = makeLogger() } = {}) {
  const fetchImpl = makeRouter(handlers);
  const client = createSidecarClient({ config, logger, fetchImpl });
  return { client, fetchImpl, logger, config };
}

test('available 首次调用前是 null（未知）', () => {
  const { client } = makeClient({});
  assert.equal(client.available, null);
  assert.equal(client.lastHealth, null);
  assert.equal(client.pid, null);
});

test('health 成功后 available 变 true，失败后变 false（探活成功/失败降级）', async () => {
  let alive = true;
  const { client } = makeClient({
    '/health': () => (alive ? { body: HEALTH } : new Error('connect ECONNREFUSED')),
  });

  const info = await client.health();
  assert.equal(info.service, 'ruohua-sidecar');
  assert.equal(client.available, true);
  assert.equal(client.lastHealth.service, 'ruohua-sidecar');

  alive = false;
  assert.equal(await client.health(), null, '失败时返回 null 而不是抛错');
  assert.equal(client.available, false);

  const probed = await client.probe();
  assert.equal(probed.ok, false);
  assert.match(probed.error, /ECONNREFUSED/);
});

test('侧车不可用时只 warn 一次，恢复后再坏才再 warn', async () => {
  let alive = false;
  const { client, logger } = makeClient({
    '/health': () => (alive ? { body: HEALTH } : new Error('boom')),
  });

  await client.health();
  await client.health();
  await client.health();
  assert.equal(logger.records.warn.length, 1, '连续失败只刷一次警告');

  alive = true;
  await client.health();
  alive = false;
  await client.health();
  assert.equal(logger.records.warn.length, 2, '恢复后再坏会重新警告一次');
});

test('embed 拿到向量；参数按契约放在 texts 里', async () => {
  const { client, fetchImpl } = makeClient({
    '/embed': () => ({ body: { ok: true, vectors: [[0.5, 0.5], [-1, 0]], dim: 2 } }),
  });

  const vectors = await client.embed(['今天天气不错', '我在写代码']);
  assert.deepEqual(vectors, [[0.5, 0.5], [-1, 0]]);
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:8765/embed');
  assert.equal(fetchImpl.calls[0].options.method, 'POST');
  assert.deepEqual(fetchImpl.calls[0].body, { texts: ['今天天气不错', '我在写代码'] });
});

test('embed 遇到坏响应返回 null，不抛错', async () => {
  const { client } = makeClient({ '/embed': () => ({ body: { ok: true } }) });
  assert.equal(await client.embed(['x']), null);

  const { client: broken } = makeClient({ '/embed': () => new Error('网络断了') });
  assert.equal(await broken.embed(['x']), null);
});

test('相似的文本分数高于无关文本（按侧车返回原样透传）', async () => {
  const { client, fetchImpl } = makeClient({
    '/similar': (url, options) => {
      const { a, b } = JSON.parse(options.body);
      return { body: { ok: true, score: a === '今天天气不错' && b === '今天天气挺好' ? 0.72 : 0.03 } };
    },
  });
  const near = await client.similar('今天天气不错', '今天天气挺好');
  const far = await client.similar('今天天气不错', '我在写代码');
  assert.ok(near > far);
  assert.equal(fetchImpl.calls.length, 2);
});

test('截图失败返回 { ok:false }（不抛错）；连不上返回 null', async () => {
  const { client } = makeClient({
    '/screenshot': () => ({ body: { ok: false, error: 'unsupported_platform' } }),
  });
  const failed = await client.screenshot({ path: 'a.bmp' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'unsupported_platform');

  const { client: offline } = makeClient({ '/screenshot': () => new Error('ECONNREFUSED') });
  assert.equal(await offline.screenshot(), null);
});

test('截图成功时把 path / monitor 传下去并返回尺寸', async () => {
  const { client, fetchImpl } = makeClient({
    '/screenshot': () => ({ body: { ok: true, path: 'C:\\tmp\\a.bmp', width: 1920, height: 1080 } }),
  });
  const shot = await client.screenshot({ path: 'C:\\tmp\\a.bmp', monitor: 1 });
  assert.equal(shot.ok, true);
  assert.equal(shot.width, 1920);
  assert.equal(shot.path, 'C:\\tmp\\a.bmp');
  assert.match(fetchImpl.calls[0].url, /monitor=1/);
  assert.match(fetchImpl.calls[0].url, /path=C%3A%5Ctmp%5Ca\.bmp/);
});

test('asr 返回文本；不支持或失败时返回 null', async () => {
  const { client, fetchImpl } = makeClient({
    '/asr': (url, options) => {
      assert.deepEqual(JSON.parse(options.body), { path: 'a.wav' });
      return { body: { ok: true, text: '你好呀' } };
    },
  });
  assert.equal(await client.asr('a.wav'), '你好呀');
  assert.equal(fetchImpl.calls[0].options.method, 'POST');

  const { client: unsupported } = makeClient({ '/asr': () => ({ body: { ok: false, error: 'asr_unsupported' } }) });
  assert.equal(await unsupported.asr('a.wav'), null);
  assert.equal(await unsupported.asr(null), null);
});

test('score 透传 items/now 并用配置里的半衰期', async () => {
  const { client, fetchImpl } = makeClient({
    '/score': () => ({ body: { ok: true, scores: [0.9, 0.1] } }),
  });
  const items = [{ id: 1, importance: 1, createdAt: 0 }];
  const scores = await client.score(items, 1000);
  assert.deepEqual(scores, [0.9, 0.1]);
  assert.deepEqual(fetchImpl.calls[0].body, { items, now: 1000, halfLifeHours: 72 });
});

test('consolidate 用 config.memory 的阈值兜底，并可被 payload 覆盖', async () => {
  const { client, fetchImpl } = makeClient({
    '/consolidate': () => ({ body: { ok: true, keep: ['a'], promote: [], drop: [], merge: [] } }),
  });
  const result = await client.consolidate({ items: [{ id: 'a' }] });
  assert.deepEqual(result, { keep: ['a'], promote: [], drop: [], merge: [] });
  assert.deepEqual(fetchImpl.calls[0].body.thresholds, {
    halfLifeHours: 72,
    drop: 0.12,
    promote: 0.75,
    mergeSimilarity: 0.92,
  });

  await client.consolidate({ items: [], thresholds: { drop: 0.5 } });
  assert.equal(fetchImpl.calls[1].body.thresholds.drop, 0.5);
});

test('consolidate 失败返回 null', async () => {
  const { client } = makeClient({ '/consolidate': () => new Error('boom') });
  assert.equal(await client.consolidate({ items: [] }), null);
});

test('config.sidecar.enabled=false 时什么都不发，直接降级', async () => {
  const config = makeConfig();
  config.sidecar.enabled = false;
  const { client, fetchImpl, logger } = makeClient({}, { config });
  assert.equal(await client.embed(['x']), null);
  assert.equal(await client.health(), null);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(client.enabled, false);
  assert.equal(logger.records.warn.length, 1);
});

test('ensureStarted：autostart 关闭时只报原因，不启动进程', async () => {
  const { client } = makeClient({ '/health': () => new Error('ECONNREFUSED') });
  const result = await client.ensureStarted();
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  assert.equal(result.reason, 'autostart_disabled');
  assert.equal(client.pid, null);
});

test('ensureStarted：脚本不存在时如实报错', async () => {
  const config = makeConfig();
  config.sidecar.autostart = true;
  config.sidecar.script = 'C:\\definitely\\not\\here.py';
  const { client } = makeClient({ '/health': () => new Error('ECONNREFUSED') }, { config });
  const result = await client.ensureStarted();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'script_missing');
});

test('stop 没起过进程时返回 false（绝不误杀别人的进程）', async () => {
  const { client } = makeClient({});
  assert.equal(await client.stop(), false);
});
