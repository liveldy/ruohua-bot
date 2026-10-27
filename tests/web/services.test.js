/**
 * 服务管理器：白名单动作、进程探测、只杀自己起的进程。
 * spawn / fetch / kill 全部注入假的，绝不真的启动或结束任何进程。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServiceManager, probePanels } from '../../src/web/services.js';
import { createNullLogger } from '../../src/logging/logger.js';
import { t } from '../../src/i18n/index.js';

/** 长驻的假子进程：给「面板自己起的服务」用。 */
function liveChild(pid = 4242) {
  return {
    pid,
    unref() {},
    kill() {},
    on() {},
    stdout: { on() {} },
    stderr: { on() {} },
  };
}

/** 命令探测用的假子进程：立刻「跑完」，输出为空（where / tasklist / ps）。 */
function commandChild(output = '') {
  return {
    pid: 1,
    unref() {},
    kill() {},
    stdout: {
      on(name, handler) {
        if (name === 'data' && output) handler(Buffer.from(output));
      },
    },
    stderr: { on() {} },
    on(name, handler) {
      if (name === 'close') setImmediate(() => handler(1));
    },
  };
}

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-svc-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.js'), '// stub\n', 'utf8');
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  return root;
}

function makeManager(root, options = {}) {
  return createServiceManager({
    config: options.config ?? { web: {} },
    logger: options.logger ?? createNullLogger(),
    services: options.services ?? null,
    mode: options.mode ?? 'standalone',
    rootDir: root,
    dataDir: path.join(root, 'data'),
    panelInfo: options.panelInfo,
    exists: options.exists,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? (async () => {}),
    spawnImpl: options.spawnImpl ?? (() => commandChild()),
    fetchImpl: options.fetchImpl ?? (async () => null),
    kill: options.kill,
    platform: options.platform,
    processInfo: options.processInfo ?? (async () => null),
    openUrl: options.openUrl,
    startTimeoutMs: options.startTimeoutMs ?? 500,
    napcatStartTimeoutMs: options.napcatStartTimeoutMs ?? options.startTimeoutMs ?? 500,
    stopTimeoutMs: options.stopTimeoutMs ?? 200,
    pollMs: options.pollMs ?? 1,
    listTtlMs: options.listTtlMs ?? 0,
  });
}

const NAPCAT_MISSING = {
  web: { napcat: { dir: 'Z:/definitely/not/here', launcher: 'launcher.bat', webuiUrl: 'http://127.0.0.1:6099', onebotPort: 39999 } },
};

async function writeState(root, id, value) {
  await fs.mkdir(path.join(root, 'data', 'web'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'web', 'services.json'), `${JSON.stringify({ [id]: value })}\n`, 'utf8');
}

test('服务清单：五个服务、统一形状、键都是 web.service.*', async () => {
  const root = await tempRoot();
  try {
    const manager = makeManager(root, { config: NAPCAT_MISSING, exists: () => false });
    const rows = await manager.list();
    assert.deepEqual(
      rows.map((row) => row.id),
      ['panel', 'node', 'napcat', 'ruohua', 'sidecar'],
    );
    for (const row of rows) {
      assert.match(row.titleKey, /^web\.service\.[a-z]+\.title$/);
      assert.match(row.descKey, /^web\.service\.[a-z]+\.desc$/);
      assert.match(row.statusKey, /^web\.service\.status\./);
      assert.ok(['running', 'stopped', 'ok', 'warn', 'unknown'].includes(row.status), `意外状态：${row.status}`);
      assert.ok(Array.isArray(row.detail) && row.detail.length > 0);
      for (const item of row.detail) {
        assert.match(item.labelKey, /^web\.service\./, `detail 必须是本地化键：${item.labelKey}`);
        assert.ok('value' in item);
      }
      assert.ok(Array.isArray(row.actions) && row.actions.length > 0);
      for (const action of row.actions) {
        assert.match(action.labelKey, /^web\.service\.action\./);
        assert.equal(typeof action.primary, 'boolean');
      }
      assert.equal(row.actions.filter((action) => action.primary).length, 1, '主按钮只能有一个');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('面板与 Node：给出模式、地址、运行时长、版本、可执行文件', async () => {
  const root = await tempRoot();
  try {
    const startedAt = Date.now() - 65_000;
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => false,
      panelInfo: () => ({ running: true, url: 'http://127.0.0.1:8788', port: 8788, clients: 2, startedAt }),
    });
    const rows = await manager.list();
    const panel = rows.find((row) => row.id === 'panel');
    assert.equal(panel.status, 'running');
    const byLabel = Object.fromEntries(panel.detail.map((item) => [item.labelKey, item]));
    assert.equal(byLabel['web.service.panel.port'].value, 8788);
    assert.equal(byLabel['web.service.panel.clients'].value, 2);
    assert.equal(byLabel['web.service.panel.mode'].valueKey, 'web.service.mode.standalone');
    assert.match(byLabel['web.service.panel.uptime'].value, /\d/);
    assert.equal(byLabel['web.service.panel.root'].value, root);

    const node = rows.find((row) => row.id === 'node');
    const nodeDetail = Object.fromEntries(node.detail.map((item) => [item.labelKey, item]));
    assert.equal(nodeDetail['web.service.node.version'].value, process.version);
    assert.equal(nodeDetail['web.service.node.execPath'].value, process.execPath);
    assert.equal(nodeDetail['web.service.node.inPath'].valueKey, 'web.service.value.no', '假 spawn 说 PATH 里没有 node');
    assert.equal(node.status, 'ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('NapCat：目录找不到就标 unknown 并写清没找到哪个路径，不抛错', async () => {
  const root = await tempRoot();
  try {
    const manager = makeManager(root, { config: NAPCAT_MISSING, exists: () => false });
    const napcat = (await manager.list()).find((row) => row.id === 'napcat');
    assert.equal(napcat.status, 'unknown');
    assert.equal(napcat.statusKey, 'web.service.status.unknown');
    const dir = napcat.detail.find((item) => item.labelKey === 'web.service.napcat.dir');
    assert.equal(dir.valueKey, 'web.service.value.missing');
    assert.equal(dir.params.path, 'Z:/definitely/not/here');
    assert.ok(napcat.detail.some((item) => item.labelKey === 'web.service.napcat.launcher' && item.valueKey === 'web.service.value.missing'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('动作白名单：不认识的 id / 动作一律拒绝', async () => {
  const root = await tempRoot();
  try {
    const manager = makeManager(root, { exists: () => false });
    await assert.rejects(() => manager.act('not-a-service', 'check'), (error) => error.code === 'unknown_service');
    await assert.rejects(() => manager.act('panel', 'stop'), (error) => error.code === 'unknown_action');
    await assert.rejects(() => manager.act('node', 'start'), (error) => error.code === 'unknown_action');
    const done = await manager.act('panel', 'check');
    assert.equal(done.ok, true);
    assert.equal(done.id, 'panel');
    assert.equal(done.action, 'check');
    assert.match(done.statusKey, /^web\.service\.status\./);
    assert.ok(Array.isArray(done.services));
    assert.equal(done.services.length, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('启动 NapCat：启动器不存在时拒绝，且不拉起启动器', async () => {
  const root = await tempRoot();
  const calls = [];
  try {
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => false,
      spawnImpl: (command, args) => {
        calls.push({ command, args });
        return commandChild();
      },
    });
    await assert.rejects(() => manager.act('napcat', 'start'), (error) => error.code === 'missing_file');
    const started = calls.filter((call) => call.command === 'cmd' || String((call.args ?? []).join(' ')).includes('launcher.bat'));
    assert.deepEqual(started, [], '找不到启动器就不该起进程');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('启动 NapCat（Windows）：在 UTF-8 控制台里跑启动器，并记下真的 NapCat pid', async () => {
  const root = await tempRoot();
  const calls = [];
  // 拿一个真空闲端口当 OneBot 端口：起之前关着，spawn 之后再听上，好走完「等到端口通」那一步
  const server = net.createServer(() => {});
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  await new Promise((resolve) => server.close(resolve));
  try {
    const manager = makeManager(root, {
      config: {
        web: { napcat: { dir: root, launcher: 'napcat.bat', webuiUrl: 'http://127.0.0.1:6099', onebotPort: port } },
      },
      platform: 'win32',
      exists: () => true,
      spawnImpl: (() => {
        let launched = false;
        return (command, args, options) => {
          calls.push({ command, args, options });
          if (command === 'cmd' && (args ?? []).includes('start')) {
            launched = true; // 起服务的那次：给一个长驻子进程，同时把端口听上
            server.listen(port, '127.0.0.1');
            return liveChild(7777);
          }
          // 起之前探不到 NapCat，起之后能探到 —— 记 pid 用的就是这一份
          if (command === 'tasklist') {
            return commandChild(launched ? '"NapCatWinBootMain.exe","8888","Console","1","12,345 K"\r\n' : '');
          }
          return commandChild('');
        };
      })(),
    });

    const done = await manager.act('napcat', 'start');
    assert.equal(done.ok, true);
    assert.equal(done.result.pid, 8888, '动作返回的也得是真的 NapCat 进程');
    assert.ok(
      ['windows-terminal', 'conhost'].includes(done.result.terminal),
      `动作要回报用的哪种终端窗口，实际是 ${done.result.terminal}`,
    );

    const started = calls.find((call) => call.command === 'cmd' && (call.args ?? []).includes('start'));
    assert.ok(started, '必须用 start 开一个新控制台，否则 detached 的子进程压根没有控制台');
    assert.ok(started.args.includes('/min'), '新控制台要最小化，别挡着人');
    assert.ok(String(started.args.at(-1)).endsWith('napcat.bat'), '最后是 NapCat 的启动器');
    const shim = started.args.find((arg) => String(arg).endsWith('console-utf8.bat'));
    assert.ok(shim, '要先跑 UTF-8 垫片');
    assert.equal(started.options.env.PYTHONUTF8, '1', '子进程环境要钉成 UTF-8');
    assert.equal(started.options.env.PYTHONIOENCODING, 'utf-8');

    const bytes = await fs.readFile(path.join(root, 'data', 'web', 'console-utf8.bat'));
    assert.ok(bytes.includes(Buffer.from('chcp 65001')), '垫片要先切到 UTF-8');
    assert.ok(bytes.includes(Buffer.from('\r\n')), '垫片是 CRLF');
    assert.ok(!bytes.some((byte) => byte > 0x7e), '垫片必须是纯 ASCII（cmd 按代码页读 .bat）');

    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'web', 'services.json'), 'utf8'));
    assert.equal(state.napcat.pid, 8888, '记的得是真的 NapCat 进程，不是那个短命的 cmd');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('启动 NapCat 超时：报 napcat_timeout（不是通用 timeout），超时按 NapCat 自己那一档算', async () => {
  const root = await tempRoot();
  const spawned = [];
  try {
    // 端口一直不通：NapCat 冷启动要拉起 QQ，真机上是两分钟级别的事
    const manager = makeManager(root, {
      config: {
        web: { napcat: { dir: root, launcher: 'napcat.bat', webuiUrl: 'http://127.0.0.1:6099', onebotPort: 39998 } },
      },
      platform: 'win32',
      exists: () => true,
      startTimeoutMs: 250,
      napcatStartTimeoutMs: 1200,
      spawnImpl: (command, args) => {
        spawned.push({ command, args });
        return command === 'cmd' ? liveChild(7778) : commandChild('');
      },
    });

    const failure = await manager
      .act('napcat', 'start')
      .then(() => null)
      .catch((error) => error);
    assert.equal(failure?.code, 'napcat_timeout', '要单独一个错误码，好让面板说清「它可能还在起」，而不是通用 timeout');
    assert.equal(failure?.params?.seconds, 1, '按 napcatStartTimeoutMs（1200ms）计时，不是通用的那 250ms');
    assert.equal(failure?.params?.port, 39998);
    // 面板那层把码翻成人话：本地化键得说清它可能还在启动（真机上 20 秒误报失败就是这么来的）
    const text = t('web.service.error.napcatTimeout', failure.params);
    assert.match(text, /1 秒/);
    assert.match(text, /还在启动/);
    assert.ok(spawned.some((call) => call.command === 'cmd'), '超时也得真的拉过启动器');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('停服务：没记过 pid 但那东西在跑 → 拒绝（不是我们起的）', async () => {
  const root = await tempRoot();
  try {
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8787 } }) }),
    });
    await assert.rejects(() => manager.act('ruohua', 'stop'), (error) => error.code === 'not_ours');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('停服务：记了 pid 但名字对不上 → 不敢动', async () => {
  const root = await tempRoot();
  const killed = [];
  try {
    await writeState(root, 'ruohua', { pid: 1234, startedAt: Date.now() });
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      processInfo: async () => ({ pid: 1234, name: 'notepad.exe' }),
      kill: (pid) => killed.push(pid),
    });
    await assert.rejects(() => manager.act('ruohua', 'stop'), (error) => error.code === 'unverifiable');
    assert.deepEqual(killed, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('停服务：pid 是 node 且命令行对得上，才真的杀', async () => {
  const root = await tempRoot();
  const killed = [];
  try {
    await writeState(root, 'ruohua', { pid: 7777, startedAt: Date.now() });
    let alive = { pid: 7777, name: 'node.exe', commandLine: 'node src/main.js', createdAt: Date.now() };
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      processInfo: async () => alive,
      kill: (pid) => {
        killed.push(pid);
        alive = null;
      },
    });
    const result = await manager.act('ruohua', 'stop');
    assert.deepEqual(killed, [7777]);
    assert.equal(result.result.killed, true);
    assert.equal(result.status, 'stopped');
    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'web', 'services.json'), 'utf8'));
    assert.equal(state.ruohua, undefined, '停完要把记录清掉');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('停服务：pid 被系统回收给了别的进程（命令行不对）→ 拒绝', async () => {
  const root = await tempRoot();
  const killed = [];
  try {
    await writeState(root, 'ruohua', { pid: 5555, startedAt: Date.now() });
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      processInfo: async () => ({ pid: 5555, name: 'node.exe', commandLine: 'node other-app.js' }),
      kill: (pid) => killed.push(pid),
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8787 } }) }),
    });
    await assert.rejects(() => manager.act('ruohua', 'stop'), (error) => error.code === 'unverifiable');
    assert.deepEqual(killed, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('停 NapCat：不是面板起的也照停 —— 按 OneBot 端口的占用者认，不问是谁起的', async () => {
  const root = await tempRoot();
  const killed = [];
  const server = net.createServer(() => {});
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const manager = makeManager(root, {
      config: {
        web: { napcat: { dir: root, launcher: 'napcat.bat', webuiUrl: 'http://127.0.0.1:6099', onebotPort: port } },
      },
      exists: () => true,
      platform: 'win32',
      spawnImpl: (command) => {
        if (command === 'netstat') {
          return commandChild(`  TCP    127.0.0.1:${port}         0.0.0.0:0              LISTENING       4321\r\n`);
        }
        return commandChild(''); // tasklist：进程名里没有 napcat（它跑在自己的宿主进程里）
      },
      processInfo: async (pid) =>
        pid === 4321 ? { pid: 4321, name: 'QQ.exe', commandLine: '"D:\\NapCat\\QQ.exe" --enable-logging' } : null,
      kill: (pid) => {
        killed.push(pid);
        server.close(); // 端口跟着关掉
      },
    });
    const result = await manager.act('napcat', 'stop');
    assert.deepEqual(killed, [4321], '端口上那个进程就是 NapCat，直接停');
    assert.equal(result.result.stopped, true);
    assert.equal(result.status, 'stopped');
    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'web', 'services.json'), 'utf8'));
    assert.equal(state.napcat, undefined, '停完要把记录清掉');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('停 NapCat：端口通着但认不出是谁 → 如实报 napcat_not_found，不乱杀', async () => {
  const root = await tempRoot();
  const killed = [];
  const server = net.createServer(() => {});
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const manager = makeManager(root, {
      config: {
        web: { napcat: { dir: root, launcher: 'napcat.bat', webuiUrl: 'http://127.0.0.1:6099', onebotPort: port } },
      },
      exists: () => true,
      platform: 'win32',
      spawnImpl: () => commandChild(''), // netstat / tasklist 都什么都没给
      kill: (pid) => killed.push(pid),
    });
    await assert.rejects(() => manager.act('napcat', 'stop'), (error) => error.code === 'napcat_not_found');
    assert.deepEqual(killed, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('独立模式启动若华：像双击那样跑 start.bat，等到新面板出现才算成功', async () => {
  const root = await tempRoot();
  const spawned = [];
  let running = false;
  try {
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true, // start.bat 与 src/main.js 都在
      spawnImpl: (command, args, options) => {
        spawned.push({ command, args, options });
        if (command === 'cmd' && (args ?? []).includes('start')) {
          running = true;
          return liveChild(9001);
        }
        return commandChild(); // netstat 没输出 → pid 退回那层 cmd
      },
      fetchImpl: async () =>
        running ? { ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8787 } }) } : null,
    });
    const done = await manager.act('ruohua', 'start');
    assert.equal(done.ok, true);
    const started = spawned.find((call) => call.command === 'cmd');
    assert.ok(started, '要开一个控制台窗口跑 start.bat');
    assert.ok(String(started.args.at(-1)).endsWith('start.bat'), '和用户双击一模一样');
    assert.ok(
      started.args.find((arg) => String(arg).endsWith('console-utf8.bat')),
      '先跑 UTF-8 垫片，窗口里的中文才不乱',
    );
    assert.equal(started.options.cwd, root);
    assert.equal(started.options.detached, true);
    assert.equal(done.url, 'http://127.0.0.1:8787/');
    assert.equal(done.result.launcher, 'start.bat');
    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'web', 'services.json'), 'utf8'));
    assert.equal(state.ruohua.pid, 9001);
    assert.ok(state.ruohua.startedAt > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('独立模式启动若华：没有 start.bat 就退回直接起 node，并记下面板端口上那个真 node', async () => {
  const root = await tempRoot();
  const spawned = [];
  let running = false;
  try {
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: (target) => !String(target).endsWith('start.bat'),
      spawnImpl: (command, args) => {
        spawned.push({ command, args });
        if (command === process.execPath) {
          running = true;
          return liveChild(9001); // 短命的 cmd / 直接起的 node，都不是要记的那个
        }
        if (command === 'netstat') {
          return commandChild('  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       7777\r\n');
        }
        return commandChild();
      },
      fetchImpl: async () =>
        running ? { ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8787 } }) } : null,
    });
    const done = await manager.act('ruohua', 'start');
    assert.deepEqual(spawned[0].args, ['src/main.js']);
    assert.equal(done.result.launcher, 'node');
    assert.equal(done.result.pid, 7777, '记的得是面板端口上那个 node，停止时才认得准');
    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'web', 'services.json'), 'utf8'));
    assert.equal(state.ruohua.pid, 7777);
    assert.equal(state.ruohua.port, 8787);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('独立模式启动若华：已经有 attached 面板时拒绝重复启动', async () => {
  const root = await tempRoot();
  const spawned = [];
  try {
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      spawnImpl: (command, args) => {
        if (command === process.execPath) spawned.push(args);
        return commandChild();
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8787 } }) }),
    });
    await assert.rejects(() => manager.act('ruohua', 'start'), (error) => error.code === 'already_running');
    assert.deepEqual(spawned, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('attached 模式：若华就是本进程，停不了自己，侧车走 services.sidecar', async () => {
  const root = await tempRoot();
  try {
    const sidecarCalls = [];
    const services = {
      startedAt: Date.now() - 1000,
      onebot: { status: () => ({ connected: true }) },
      sidecar: {
        url: 'http://127.0.0.1:8765',
        available: true,
        pid: 4321,
        enabled: true,
        probe: async () => ({ ok: true }),
        ensureStarted: async () => {
          sidecarCalls.push('ensureStarted');
          return { ok: true, pid: 4321 };
        },
        stop: async () => {
          sidecarCalls.push('stop');
          return true;
        },
      },
    };
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      mode: 'attached',
      services,
      exists: () => true,
      panelInfo: () => ({ running: true, url: 'http://127.0.0.1:8787', port: 8787, clients: 0, startedAt: Date.now() }),
      processInfo: async () => ({ pid: process.pid, name: 'node.exe' }),
    });
    const rows = await manager.list();
    const ruohua = rows.find((row) => row.id === 'ruohua');
    assert.equal(ruohua.status, 'running');
    assert.equal(ruohua.detail.find((item) => item.labelKey === 'web.service.ruohua.onebot').valueKey, 'web.service.value.yes');
    assert.equal(ruohua.detail.find((item) => item.labelKey === 'web.service.ruohua.pid').value, process.pid);

    const sidecar = rows.find((row) => row.id === 'sidecar');
    assert.equal(sidecar.status, 'ok');
    assert.equal(sidecar.detail.find((item) => item.labelKey === 'web.service.sidecar.pid').value, 4321);

    await assert.rejects(() => manager.act('ruohua', 'stop'), (error) => error.code === 'attached_self');

    const started = await manager.act('sidecar', 'start');
    assert.equal(started.ok, true);
    assert.deepEqual(sidecarCalls, ['ensureStarted']);
    const stopped = await manager.act('sidecar', 'stop');
    assert.equal(stopped.ok, true);
    assert.deepEqual(sidecarCalls, ['ensureStarted', 'stop']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('独立模式：侧车的启停要主程序，check 只探 HTTP', async () => {
  const root = await tempRoot();
  try {
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      fetchImpl: async (url) => (url.includes('/health') ? { ok: true, json: async () => ({ ok: true }) } : null),
    });
    const sidecar = (await manager.list()).find((row) => row.id === 'sidecar');
    assert.equal(sidecar.status, 'ok', '探到 /health 就算可用');
    await assert.rejects(() => manager.act('sidecar', 'start'), (error) => error.code === 'unavailable');
    await assert.rejects(() => manager.act('sidecar', 'stop'), (error) => error.code === 'unavailable');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('NapCat 的「打开」动作：打不开就如实报错，打得开就回地址', async () => {
  const root = await tempRoot();
  try {
    const missing = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => false,
      openUrl: () => false,
    });
    await assert.rejects(() => missing.act('napcat', 'open'), (error) => error.code === 'open_failed');

    const opened = [];
    const ok = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => false,
      openUrl: (url) => {
        opened.push(url);
        return true;
      },
    });
    const result = await ok.act('napcat', 'open');
    assert.deepEqual(opened, ['http://127.0.0.1:6099']);
    assert.equal(result.url, 'http://127.0.0.1:6099');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('动作会写操作日志：service_check，失败也记一笔', async () => {
  const root = await tempRoot();
  const ops = [];
  try {
    const logger = createNullLogger();
    logger.operation = (entry) => {
      ops.push(entry);
      return entry;
    };
    const manager = makeManager(root, { config: NAPCAT_MISSING, exists: () => false, logger });
    await manager.act('panel', 'check');
    assert.equal(ops.length, 1);
    assert.equal(ops[0].actor, 'web-panel');
    assert.equal(ops[0].action, 'service_check');
    assert.equal(ops[0].target, 'panel');
    assert.equal(ops[0].ok, true);
    assert.ok(ops[0].detail.status);

    await manager.act('lapcat' in {} ? 'lapcat' : 'napcat', 'check');
    assert.equal(ops.length, 2);
    await assert.rejects(() => manager.act('napcat', 'noop'));
    assert.equal(ops.length, 2, '白名单外的动作压根不执行，也就没有日志');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('probePanels：找到的按端口返回，skip 里的跳过', async () => {
  const none = await probePanels({
    from: 1,
    to: 2,
    fetchImpl: async () => {
      throw new Error('closed');
    },
  });
  assert.deepEqual(none, []);

  const found = await probePanels({
    from: 1,
    to: 3,
    skip: [2],
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ ok: true, mode: url.includes(':1/') ? 'attached' : 'standalone', web: { port: 1 } }),
    }),
  });
  assert.deepEqual(found, [
    { url: 'http://127.0.0.1:1', port: 1, mode: 'attached' },
    { url: 'http://127.0.0.1:3', port: 3, mode: 'standalone' },
  ]);

  const notPanel = await probePanels({
    from: 4,
    to: 4,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  assert.deepEqual(notPanel, [], '答得不像若华面板的不算');
});

test('独立模式：扫到 attached 面板后，把它的启动时间 / OneBot 状态问清楚再显示', async () => {
  const root = await tempRoot();
  try {
    const asked = [];
    const startedAt = Date.now() - 90_000;
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      fetchImpl: async (url) => {
        asked.push(String(url));
        if (!String(url).includes(':8787/')) return null;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            mode: 'attached',
            web: { port: 8787, startedAt },
            bot: { startedAt, uptimeMs: 90_000 },
            onebot: { connected: true, mode: 'forward' },
          }),
        };
      },
    });
    const rows = await manager.list();
    const ruohua = rows.find((row) => row.id === 'ruohua');
    assert.equal(ruohua.status, 'running');
    const byKey = new Map(ruohua.detail.map((item) => [item.labelKey, item]));
    assert.equal(byKey.get('web.service.ruohua.startedAt').value, new Date(startedAt).toISOString());
    assert.equal(byKey.get('web.service.ruohua.startedAt').valueKey, null);
    assert.ok(byKey.get('web.service.ruohua.uptime').value, '运行时长要算出来');
    assert.equal(byKey.get('web.service.ruohua.onebot').valueKey, 'web.service.value.yes');
    assert.equal(byKey.get('web.service.ruohua.panel').value, 'http://127.0.0.1:8787/');
    assert.ok(asked.some((url) => url.includes(':8787/api/status')), '要单独问一次那个面板');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('独立模式：我们自己起过的若华没报启动时间时，用面板记下的那笔', async () => {
  const root = await tempRoot();
  const startedAt = Date.now() - 30_000;
  try {
    await writeState(root, 'ruohua', { pid: 8888, startedAt });
    const manager = makeManager(root, {
      config: NAPCAT_MISSING,
      exists: () => true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, mode: 'attached', web: { port: 8787 } }) }),
    });
    const ruohua = (await manager.list()).find((row) => row.id === 'ruohua');
    const byKey = new Map(ruohua.detail.map((item) => [item.labelKey, item]));
    assert.equal(byKey.get('web.service.ruohua.pid').value, 8888, '记着的 pid 要显示');
    assert.equal(byKey.get('web.service.ruohua.startedAt').value, new Date(startedAt).toISOString());
    assert.ok(byKey.get('web.service.ruohua.uptime').value);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
