/**
 * Python 侧车实测：真起进程、真发请求、真截一张屏。
 * python 不在环境里时整组跳过（CI 友好）。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createI18n } from '../../src/i18n/index.js';
import { createSidecarClient } from '../../src/perception/sidecar.js';
import { makeConfig, makeLogger } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'python', 'sidecar.py');
/** 和侧车那边 configure() 一样：默认文字 + 管理员在 data/locales 里的覆盖。 */
const sidecarI18n = createI18n({
  locale: 'zh-CN',
  overrideFile: path.join(repoRoot, 'data', 'locales', 'zh-CN.json'),
});
const defaultDataDir = path.join(repoRoot, 'data');
const PORT = Number(process.env.RUOHUA_SIDECAR_TEST_PORT ?? 8799);
const baseUrl = `http://127.0.0.1:${PORT}`;

let python = null;
let skipReason = 'python 不可用';
let child = null;
let dataDir = null;
let health = null;
let serverOutput = '';

function findPython() {
  for (const candidate of ['python', 'python3']) {
    const probe = spawnSync(candidate, ['-V'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

before(async () => {
  python = findPython();
  if (!python) {
    skipReason = '环境里没有 python / python3，跳过侧车实测';
    return;
  }
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-sidecar-'));
  child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', dataDir], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await delay(250);
  }
  if (!health) {
    throw new Error(`侧车 25 秒内没起来（exitCode=${child.exitCode}）：\n${serverOutput.slice(-1500)}`);
  }
});

after(async () => {
  if (child) {
    child.kill();
    await delay(200);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('/health 报出服务名与能力位', (t) => {
  if (!python) return t.skip(skipReason);
  assert.equal(health.ok, true);
  assert.equal(health.service, 'ruohua-sidecar');
  assert.equal(health.features.embed, true);
  assert.equal(health.features.screenshot, process.platform === 'win32');
  assert.equal(typeof health.features.asr, 'boolean');
  assert.equal(typeof health.features.ocr, 'boolean');
  return undefined;
});

test('/ 是纯文本说明页', async (t) => {
  if (!python) return t.skip(skipReason);
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  const text = await response.text();
  assert.match(text, /ruohua-sidecar/);
  assert.match(text, /\/embed/);
});

test('/ 说明页的文字来自 sidecar.json，不是写死的', async (t) => {
  if (!python) return t.skip(skipReason);
  const text = await (await fetch(`${baseUrl}/`)).text();
  const rendered = sidecarI18n.t('sidecar.index.body', {
    service: health.service,
    version: health.version,
    dim: 512,
    dataDir: defaultDataDir, // 说明页是脚本导入时拼好的，数据目录取默认值
  });
  assert.equal(text, rendered, '说明页应当逐字等于 sidecar.json 里的 sidecar.index.body');
});

test('python/i18n.py 读到的本地化键与 JS 侧一致（含占位符与缺键）', (t) => {
  if (!python) return t.skip(skipReason);
  const code = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'python').split(path.sep).join('/'))})`,
    'from i18n import t, configure',
    `configure(${JSON.stringify(repoRoot.split(path.sep).join('/'))})`,
    "print(t('sidecar.server.interrupted'))",
    "print(t('sidecar.selftest.embed', dim=512, score='0.5966'))",
    "print(t('sidecar.nope.没有这个键'))",
  ].join('\n');
  const probe = spawnSync(python, ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  assert.equal(probe.status, 0, `python/i18n.py 应当能直接用：${probe.stderr}`);
  const [interrupted, embedded, missing] = probe.stdout.trim().split(/\r?\n/);
  assert.equal(interrupted, sidecarI18n.t('sidecar.server.interrupted'));
  assert.equal(embedded, sidecarI18n.t('sidecar.selftest.embed', { dim: 512, score: '0.5966' }));
  assert.equal(missing, 'sidecar.nope.没有这个键', '找不到键就返回键本身');
  assert.match(interrupted, /[\u4e00-\u9fff]/, '拿到的得是中文文字，不是键名');
  assert.match(embedded, /^embed: 512 .+ 0\.5966$/, `占位符没填对：${embedded}`);
});

test('/embed 返回 512 维、L2 归一化、可复现的向量', async (t) => {
  if (!python) return t.skip(skipReason);
  const texts = ['今天天气不错', '今天天气挺好的', '我在写代码'];
  const first = await postJson('/embed', { texts });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.dim, 512);
  assert.equal(first.body.vectors.length, 3);
  for (const vector of first.body.vectors) {
    assert.equal(vector.length, 512);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `向量应当 L2 归一化，实际范数 ${norm}`);
  }

  const again = await postJson('/embed', { texts });
  assert.deepEqual(again.body.vectors, first.body.vectors, '同样的输入必须给同样的向量');
});

test('/similar 对相近文本的分数高于无关文本', async (t) => {
  if (!python) return t.skip(skipReason);
  const near = await postJson('/similar', { a: '今天天气不错', b: '今天天气挺好的' });
  const far = await postJson('/similar', { a: '今天天气不错', b: '我在写代码' });
  assert.ok(near.body.score > far.body.score, `相近 ${near.body.score} 应高于无关 ${far.body.score}`);
  assert.ok(near.body.score > 0.3, '相近措辞至少要有点区分度');
  assert.ok(far.body.score < 0.2, '无关文本的分数应当很低');

  const same = await postJson('/similar', { a: '完全相同的一句话', b: '完全相同的一句话' });
  assert.ok(Math.abs(same.body.score - 1) < 1e-6, '完全相同的文本相似度必须是 1');
});

test('/score 体现衰减与永久记忆', async (t) => {
  if (!python) return t.skip(skipReason);
  const now = Date.now();
  const day = 86400000;
  const { body } = await postJson('/score', {
    items: [
      { id: 'fresh', importance: 1, createdAt: now, accessCount: 0 },
      { id: 'old', importance: 1, createdAt: now - 30 * day, accessCount: 0 },
      { id: 'touched', importance: 1, createdAt: now, accessCount: 20 },
      { id: 'forever', importance: 0.2, kind: 'permanent', createdAt: 0, accessCount: 0 },
    ],
    now,
  });
  assert.equal(body.ok, true);
  const [fresh, old, touched, forever] = body.scores;
  assert.ok(fresh > old, '新记忆应当比 30 天前的强');
  assert.ok(old < 0.01, '半衰期 72 小时的记忆 30 天后几乎归零');
  assert.ok(touched >= fresh, '访问次数多的不该更弱');
  assert.equal(forever, 0.2, '永久记忆不衰减，只按重要度算');
});

test('/consolidate 给出保留/晋升/遗忘/合并建议', async (t) => {
  if (!python) return t.skip(skipReason);
  const now = Date.now();
  const { body } = await postJson('/consolidate', {
    items: [
      { id: 'a', content: '用户喜欢喝咖啡', importance: 0.9, createdAt: now },
      { id: 'b', content: '用户喜欢喝咖啡呢', importance: 0.4, createdAt: now },
      { id: 'c', content: '用户住在北京', importance: 0.8, createdAt: now },
      { id: 'd', content: '用户很久前提过一句无关的话', importance: 0.05, createdAt: now - 400 * 86400000 },
      { id: 'e', content: '主人对若华有特殊意义', importance: 0.1, kind: 'permanent', createdAt: 0 },
    ],
    thresholds: { drop: 0.12, promote: 0.75, mergeSimilarity: 0.8 },
    now,
  });
  assert.equal(body.ok, true);
  assert.deepEqual(body.merge, [['a', 'b']], '近义的两条应当被并到一起');
  assert.ok(body.promote.includes('c'), '高重要度的临时记忆该晋升');
  assert.ok(body.drop.includes('d'), '衰减到底的该忘掉');
  assert.ok(body.keep.includes('e'), '永久记忆必须留');
  const mergedIds = body.merge.flat();
  for (const id of ['a', 'b']) assert.ok(!body.keep.includes(id), '并入合并组的 id 不该再出现在 keep 里');
  assert.equal(mergedIds.length, 2);
});

test('/asr 与 /ocr 缺依赖时如实报不支持，而不是崩', async (t) => {
  if (!python) return t.skip(skipReason);
  const asr = await postJson('/asr', { path: 'not-here.wav' });
  assert.equal(asr.status, 200);
  assert.equal(asr.body.ok, false);
  assert.equal(typeof asr.body.error, 'string');
  if (!health.features.asr) assert.equal(asr.body.error, 'asr_unsupported');

  const ocr = await postJson('/ocr', { path: 'not-here.png' });
  assert.equal(ocr.status, 200);
  assert.equal(ocr.body.ok, false);
  assert.equal(ocr.body.error, 'file_not_found');
});

test('未知路由返回 JSON 错误，不是空 500', async (t) => {
  if (!python) return t.skip(skipReason);
  const missing = await getJson('/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
  assert.equal(typeof missing.body.error, 'string');

  const badBody = await fetch(`${baseUrl}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ 这不是 JSON',
  });
  assert.equal(badBody.status, 500);
  const parsed = await badBody.json();
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.error, 'string');
});

test('/screenshot 真的截出一张非空图片', async (t) => {
  if (!python) return t.skip(skipReason);
  if (process.platform !== 'win32') return t.skip('侧车截图只支持 Windows');
  const target = path.join(dataDir, 'shots', 'probe.bmp');
  const { status, body } = await getJson(`/screenshot?path=${encodeURIComponent(target)}&monitor=0`);
  assert.equal(status, 200);
  if (!body.ok) {
    t.diagnostic(`截图失败：${JSON.stringify(body)}`);
    t.skip('侧车截图在当前环境失败，原因见 diagnostic');
    return undefined;
  }
  const stat = await fs.stat(body.path);
  assert.ok(stat.size > 0, '截出来的图片不能是空文件');
  const header = await fs.readFile(body.path);
  assert.equal(header.subarray(0, 2).toString('latin1'), 'BM', '应当是一张 BMP');
  assert.ok(body.width > 0 && body.height > 0);
  t.diagnostic(`截图成功：${body.path}（${stat.size} 字节，${body.width}x${body.height}，方式 ${body.method}）`);
  return undefined;
});

test('/ocr 在有能力时能认出截屏里的文字', async (t) => {
  if (!python) return t.skip(skipReason);
  // OCR 能力是侧车启动后后台探出来的，给它几秒钟
  for (let i = 0; i < 12 && !health.features.ocr; i += 1) {
    await delay(300);
    health = (await getJson('/health')).body;
  }
  if (!health.features.ocr) return t.skip('这台机器没有可用的 OCR 后端');
  const shot = path.join(dataDir, 'shots', 'ocr.bmp');
  const captured = await getJson(`/screenshot?path=${encodeURIComponent(shot)}&monitor=0`);
  if (!captured.body.ok) {
    t.diagnostic(`截图失败，OCR 没法验：${JSON.stringify(captured.body)}`);
    t.skip('截图失败，跳过');
    return undefined;
  }
  const { body } = await postJson('/ocr', { path: shot });
  assert.equal(body.ok, true, `OCR 应当能跑通：${JSON.stringify(body).slice(0, 300)}`);
  assert.equal(typeof body.text, 'string');
  t.diagnostic(`OCR（${body.backend}）认出 ${body.text.length} 个字符：${body.text.slice(0, 60).replace(/\s+/g, ' ')}`);
  return undefined;
});

test('客户端 ensureStarted 能拉起来，stop 只关自己起的那个', async (t) => {
  if (!python) return t.skip(skipReason);
  const port = await freePort();
  const config = makeConfig({
    rootDir: repoRoot,
    dataDir,
    logDir: path.join(dataDir, 'logs'),
    sidecar: {
      enabled: true,
      url: `http://127.0.0.1:${port}`,
      autostart: true,
      python,
      script: scriptPath,
      host: '127.0.0.1',
      port,
      timeoutMs: 1000,
      screenshotDir: path.join(dataDir, 'screenshots'),
    },
  });
  const client = createSidecarClient({ config, logger: makeLogger() });

  const started = await client.ensureStarted({ startTimeoutMs: 25000 });
  assert.equal(started.ok, true, `侧车应当被拉起来：${JSON.stringify(started)}`);
  assert.equal(started.started, true);
  assert.equal(client.available, true);
  const autoPid = client.pid;
  assert.ok(autoPid > 0);

  assert.equal(await client.stop(), true, 'stop 应当杀掉自己起的进程');

  let gone = false;
  for (let i = 0; i < 20 && !gone; i += 1) {
    gone = (await client.health()) === null;
    if (!gone) await delay(200);
  }
  assert.equal(gone, true, '关掉之后不该还能探活');
  assert.equal(client.available, false);

  // 手动起的那个侧车不归它管，必须还活着
  assert.equal(child.exitCode, null, 'stop 不能误杀别人的进程');
  const stillUp = await fetch(`${baseUrl}/health`);
  assert.equal(stillUp.ok, true);
  assert.equal(await client.stop(), false, '已经关过就返回 false');
});
