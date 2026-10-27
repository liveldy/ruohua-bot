/**
 * 子进程的编码垫子（src/util/console.js）：
 * 「面板起的命令行终端乱码」修的就是这里 —— 新控制台要 UTF-8，环境要 UTF-8，垫片要纯 ASCII。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONSOLE_CWD_VAR,
  CONSOLE_LAUNCHER_NAME,
  consoleLauncherPath,
  consoleLauncherScript,
  consoleStart,
  ensureConsoleLauncher,
  utf8Env,
  windowsTerminalAlias,
} from '../../src/util/console.js';

test('utf8Env：钉住 PYTHONUTF8 / PYTHONIOENCODING，原来的变量都还在', () => {
  const env = utf8Env({ PATH: '/bin', PYTHONUTF8: '0', LANG: 'zh_CN.GBK' });
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.LANG, 'zh_CN.GBK', '别顺手改别人的语言环境');
  assert.notEqual(utf8Env({}).PYTHONUTF8, undefined);
  const extra = utf8Env({ PATH: '/bin' }, { [CONSOLE_CWD_VAR]: 'D:/NapCat' });
  assert.equal(extra[CONSOLE_CWD_VAR], 'D:/NapCat', '垫片要的工作目录得能带进去');
  assert.equal(extra.PYTHONUTF8, '1');
});

test('垫片脚本：纯 ASCII + CRLF，先 chcp 65001、再进工作目录、再跑传进来的命令', () => {
  const script = consoleLauncherScript();
  assert.match(script, /chcp 65001/);
  // Windows Terminal 不继承工作目录，所以「进哪个目录」得由垫片自己按环境变量做
  assert.match(script, /if not "%RUOHUA_CWD%"=="" cd \/d "%RUOHUA_CWD%"/);
  assert.match(script, /%\*/);
  assert.ok(script.includes('\r\n'), 'cmd 读 .bat 要 CRLF');
  for (const char of script) {
    assert.ok(char.charCodeAt(0) <= 0x7e, `不能出现非 ASCII 字符：${JSON.stringify(char)}`);
  }
});

test('ensureConsoleLauncher：写进 data/web/，内容对得上，写第二次不重复动文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-console-'));
  try {
    const file = await ensureConsoleLauncher(root);
    assert.equal(file, path.join(root, 'web', CONSOLE_LAUNCHER_NAME));
    const bytes = await fs.readFile(file);
    assert.equal(bytes.toString('utf8'), consoleLauncherScript());
    assert.ok(!bytes.includes(Buffer.from([0xef, 0xbb, 0xbf])), '不能带 BOM');

    const again = await ensureConsoleLauncher(root);
    assert.equal(again, file);
    assert.equal(await consoleLauncherPath(root), file);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('consoleStart：Windows 上用 start 开一个最小化的新控制台，别的平台原样跑', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-console-'));
  try {
    const win = consoleStart({
      target: 'D:/NapCat/napcat.bat',
      dataDir: root,
      platform: 'win32',
      terminal: 'conhost',
    });
    assert.equal(win.command, 'cmd');
    assert.equal(win.terminal, 'conhost');
    assert.deepEqual(win.args.slice(0, 4), ['/c', 'start', '', '/min']);
    assert.equal(win.args.at(-1), 'D:/NapCat/napcat.bat');
    assert.equal(win.args.at(-2), win.launcher);
    assert.equal(win.launcher, path.join(root, 'web', CONSOLE_LAUNCHER_NAME));
    assert.equal(win.args.includes('-NoProfile'), false);
    assert.equal(win.env, null, '没给 cwd 就别往环境里塞工作目录');

    // 给了 cwd：交给 spawn 的环境，垫片自己 cd 过去
    const withCwd = consoleStart({
      target: 'D:/NapCat/napcat.bat',
      dataDir: root,
      cwd: 'D:/NapCat/NapCat.52230.Shell',
      platform: 'win32',
      terminal: 'conhost',
    });
    assert.deepEqual(withCwd.env, { [CONSOLE_CWD_VAR]: 'D:/NapCat/NapCat.52230.Shell' });

    const posix = consoleStart({ target: '/usr/bin/node', args: ['main.js'], dataDir: root, platform: 'linux' });
    assert.deepEqual(posix, { command: '/usr/bin/node', args: ['main.js'], launcher: null, terminal: null, env: null });

    const noData = consoleStart({ target: 'D:/NapCat/napcat.bat', platform: 'win32' });
    assert.deepEqual(noData, { command: 'D:/NapCat/napcat.bat', args: [], launcher: null, terminal: null, env: null });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('windowsTerminalAlias：只在 %LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe 真的在时给路径', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-wt-'));
  try {
    assert.equal(windowsTerminalAlias({ platform: 'linux', env: { LOCALAPPDATA: home } }), null);
    assert.equal(windowsTerminalAlias({ platform: 'win32', env: {} }), null, '没有 LOCALAPPDATA 就别猜');
    assert.equal(
      windowsTerminalAlias({ platform: 'win32', env: { LOCALAPPDATA: home } }),
      null,
      '没装 wt 的机器上必须返回 null，好让调用方退回 conhost',
    );

    const alias = path.join(home, 'Microsoft', 'WindowsApps', 'wt.exe');
    await fs.mkdir(path.dirname(alias), { recursive: true });
    await fs.writeFile(alias, '');
    assert.equal(windowsTerminalAlias({ platform: 'win32', env: { LOCALAPPDATA: home } }), alias);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('consoleStart：机器上有 wt 就走新版终端（新窗口、仍然过 UTF-8 垫片）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-console-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-wt-'));
  try {
    const alias = path.join(home, 'Microsoft', 'WindowsApps', 'wt.exe');
    await fs.mkdir(path.dirname(alias), { recursive: true });
    await fs.writeFile(alias, '');

    const spec = consoleStart({
      target: 'D:/Desktop/RuoHua_Bot/start.bat',
      args: [],
      dataDir: root,
      platform: 'win32',
      env: { LOCALAPPDATA: home },
    });
    assert.equal(spec.command, 'cmd');
    assert.equal(spec.terminal, 'windows-terminal');
    assert.deepEqual(spec.args, [
      '/c',
      'start',
      '',
      '/min',
      alias,
      '-w',
      '-1',
      'cmd',
      '/c',
      spec.launcher,
      'D:/Desktop/RuoHua_Bot/start.bat',
    ]);
    assert.equal(spec.launcher, path.join(root, 'web', CONSOLE_LAUNCHER_NAME));

    // 钉死 conhost（或机器上没装 wt）时不能出现 wt，退回旧路径
    const fallback = consoleStart({
      target: 'D:/Desktop/RuoHua_Bot/start.bat',
      dataDir: root,
      platform: 'win32',
      env: { LOCALAPPDATA: home },
      terminal: 'conhost',
    });
    assert.equal(fallback.terminal, 'conhost');
    assert.equal(fallback.args.includes(alias), false);
    assert.deepEqual(fallback.args, ['/c', 'start', '', '/min', fallback.launcher, 'D:/Desktop/RuoHua_Bot/start.bat']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('垫片写不出来时退回普通启动，不抛错', () => {
  const broken = path.join('Z:', 'definitely-not-here', 'nope');
  const spec = consoleStart({ target: 'D:/NapCat/napcat.bat', dataDir: broken, platform: 'win32', cwd: 'D:/NapCat' });
  assert.equal(spec.command, 'D:/NapCat/napcat.bat');
  assert.equal(spec.launcher, null);
  assert.equal(spec.terminal, null);
  assert.equal(spec.env, null, '退回普通启动时工作目录还是靠 spawn 的 cwd');
});
