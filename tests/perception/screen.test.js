/** 屏幕截图：侧车优先、PowerShell 兜底、失败不抛错。Windows 上兜底是真跑一遍。 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createScreenService } from '../../src/perception/screen.js';
import { makeConfig, makeLogger } from './helpers.js';

const IS_WINDOWS = process.platform === 'win32';
let dir;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-screen-'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function scene({ sidecar = null, logger = makeLogger(), name = 'case' } = {}) {
  const root = path.join(dir, name);
  const config = makeConfig({
    rootDir: root,
    dataDir: path.join(root, 'data'),
    sidecar: { screenshotDir: path.join(root, 'shots') },
  });
  return { service: createScreenService({ config, sidecar, logger }), config, logger, root };
}

test('优先走侧车：返回 path/width/height 并记住 lastPath', async () => {
  const requested = [];
  const sidecar = {
    screenshot: async ({ path: target, monitor }) => {
      requested.push({ target, monitor });
      await fs.writeFile(target, 'BM-fake');
      return { ok: true, path: target, width: 1920, height: 1080, method: 'gdi' };
    },
  };
  const { service } = scene({ sidecar, name: 'via-sidecar' });

  const shot = await service.capture();
  assert.ok(shot, '侧车成功时应拿到结果');
  assert.equal(shot.via, 'sidecar');
  assert.equal(shot.width, 1920);
  assert.equal(shot.height, 1080);
  assert.match(shot.path, /screen-\d{8}-\d{6}-\d{3}\.bmp$/);
  assert.equal(service.lastPath, shot.path);
  assert.equal(requested[0].monitor, 0);
  assert.equal(await fs.readFile(shot.path, 'utf8'), 'BM-fake');
});

test('传进来的路径扩展名会统一成 .bmp', async () => {
  let asked = null;
  const sidecar = {
    screenshot: async ({ path: target }) => {
      asked = target;
      await fs.writeFile(target, 'BM-fake');
      return { ok: true, path: target, width: 800, height: 600 };
    },
  };
  const { service, config } = scene({ sidecar, name: 'explicit-path' });

  const shot = await service.capture({ path: 'shots/whatever.png', monitor: 2 });
  assert.equal(asked, path.join(config.rootDir, 'shots', 'whatever.bmp'));
  assert.equal(shot.path, asked);
});

test('侧车说成功但文件没落地时，会用兜底重来一次', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('非 Windows 平台没有 PowerShell 兜底');
    return;
  }
  const sidecar = {
    // 撒谎：返回 ok 却没写文件
    screenshot: async ({ path: target }) => ({ ok: true, path: target, width: 1, height: 1 }),
  };
  const { service } = scene({ sidecar, name: 'liar' });

  const shot = await service.capture();
  assert.ok(shot, '兜底应该接住');
  assert.equal(shot.via, 'powershell');
  const stat = await fs.stat(shot.path);
  assert.ok(stat.size > 0, '真截出来的 BMP 不该是空文件');
  assert.ok(shot.width > 0 && shot.height > 0);
});

test('侧车不可用时用 PowerShell 兜底，真截一张', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('非 Windows 平台没有 PowerShell 兜底');
    return;
  }
  const { service, logger } = scene({ sidecar: null, name: 'ps-only' });

  const shot = await service.capture();
  assert.ok(shot, 'PowerShell 兜底必须能截到');
  assert.equal(shot.via, 'powershell');
  const stat = await fs.stat(shot.path);
  assert.ok(stat.size > 0);
  assert.equal(await fs.readFile(shot.path, 'utf8', { flag: 'r' }).then((b) => b.slice(0, 2)), 'BM');
  assert.equal(logger.records.warn.length, 0, '兜底成功不该报 warning');
  t.diagnostic(`PowerShell 兜底截图：${shot.path}（${stat.size} 字节，${shot.width}x${shot.height}）`);
});

test('彻底截不了时返回 null，不抛错，并只 warn 一次', async () => {
  const sidecar = { screenshot: async () => ({ ok: false, error: 'unsupported_platform' }) };
  const { service, logger, config } = scene({ sidecar, name: 'both-fail' });
  // 截图目录的位置上放个同名文件，目录建不出来，两条路都走不通
  await fs.mkdir(config.rootDir, { recursive: true });
  await fs.writeFile(config.sidecar.screenshotDir, 'occupying the path');

  assert.equal(await service.capture(), null);
  assert.equal(await service.capture(), null);
  assert.equal(logger.records.warn.length, 1, '连续失败只 warn 一次');
  assert.equal(service.lastPath, null);
});
