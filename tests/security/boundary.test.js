/** 边界限定：工作区域、密钥文件名、命令权限。 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundaryError, createBoundary } from '../../src/security/boundary.js';
import { loadConfig } from '../../src/config/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

async function makeTemp(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

async function makeRoot() {
  const root = await makeTemp('ruohua-boundary-');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.js'), '// app\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
  return root;
}

function makeConfig(root, patch = {}) {
  return {
    rootDir: root,
    boundaryRoot: root,
    security: {
      boundary: {
        mode: 'sandbox',
        workspaceRoot: '.',
        allowPaths: [],
        denyPaths: [path.join(root, 'secret')],
        denyNamePatterns: ['.env', '.ssh', 'id_rsa'],
        maxReadBytes: 1024,
        maxWriteBytes: 512,
        shell: { enabled: true, denyPatterns: ['rm -rf /', 'format '], allowedRoots: ['.'] },
        ...patch,
      },
    },
  };
}

function isBoundaryError(code) {
  return (error) => error instanceof BoundaryError && error.name === 'BoundaryError' && (!code || error.code === code);
}

test('工作区内的路径解析成绝对路径', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root) });
  assert.equal(boundary.checkPath('src/app.js'), path.join(root, 'src', 'app.js'));
  assert.equal(boundary.checkPath(path.join(root, 'src')), path.join(root, 'src'));
  assert.equal(boundary.checkPath('.'), root);
});

test('越界的路径会被挡住', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root) });
  assert.throws(() => boundary.checkPath('../outside.txt'), isBoundaryError('out_of_bounds'));
  assert.throws(() => boundary.checkPath(path.join(root, '..', 'sibling.txt')), isBoundaryError('out_of_bounds'));
  assert.throws(() => boundary.checkPath('src/../../escape.txt'), isBoundaryError('out_of_bounds'));
  assert.throws(() => boundary.checkPath(''), isBoundaryError('empty_path'));
});

test('allowPaths 里的目录在沙箱外也放行', async () => {
  const root = await makeRoot();
  const outside = await makeTemp('ruohua-allow-');
  const boundary = createBoundary({ config: makeConfig(root, { allowPaths: [outside] }) });
  assert.equal(boundary.checkPath(path.join(outside, 'note.txt')), path.join(outside, 'note.txt'));
});

test('密钥文件名被挡：.env 及其变体、.ssh、id_rsa', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root) });
  assert.throws(() => boundary.checkPath('.env'), isBoundaryError('denied_name'));
  assert.throws(() => boundary.checkPath('.env.local'), isBoundaryError('denied_name'));
  assert.throws(() => boundary.checkPath('config/.ssh'), isBoundaryError('denied_name'));
  assert.throws(() => boundary.checkPath('keys/id_rsa.pub'), isBoundaryError('denied_name'));
  assert.equal(boundary.checkPath('src/app.js'), path.join(root, 'src', 'app.js'));
});

test('denyPaths 里的目录被挡住', async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, 'secret'), { recursive: true });
  await fs.writeFile(path.join(root, 'secret', 'key.txt'), 'x');
  const boundary = createBoundary({ config: makeConfig(root) });
  assert.throws(() => boundary.checkPath('secret/key.txt'), isBoundaryError('denied_path'));
  assert.throws(() => boundary.checkPath('secret'), isBoundaryError('denied_path'));
});

test('denyPaths 写绝对路径（配置里的 C:\\Windows 那种）也挡得住', async () => {
  const root = await makeRoot();
  const denied = await makeTemp('ruohua-denied-');
  const boundary = createBoundary({
    config: makeConfig(root, { denyPaths: [denied], allowPaths: [path.dirname(denied)] }),
  });
  assert.throws(() => boundary.checkPath(path.join(denied, 'anything.txt')), isBoundaryError('denied_path'));
  assert.equal(boundary.checkPath('src/app.js'), path.join(root, 'src', 'app.js'));
});

test('危险命令被挡，普通命令放行；命令执行关闭时一律拒绝', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root) });
  assert.equal(boundary.checkCommand('dir'), 'dir');
  assert.equal(boundary.checkCommand('node --version'), 'node --version');
  assert.throws(() => boundary.checkCommand('rm -rf /'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('FORMAT C:'), isBoundaryError('denied_command'));
  // "format " 末尾的空格是词边界，别被 trim 掉之后连 /format:list 都拦
  assert.equal(boundary.checkCommand('wmic os get caption /format:list'), 'wmic os get caption /format:list');

  const closed = createBoundary({ config: makeConfig(root, { shell: { enabled: false, denyPatterns: [] } }) });
  assert.throws(() => closed.checkCommand('dir'), isBoundaryError('shell_disabled'));
});

test('真配置（config/security.json）的命令黑名单：拦格式化、放行 /format: 参数', async () => {
  const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: '10001' }, useEnvFile: false });
  const boundary = createBoundary({ config, logger: null });

  // 该拦的
  assert.throws(() => boundary.checkCommand('format C: /q'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('FORMAT D: /FS:NTFS'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('format /q e:'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('rm -rf /'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('diskpart'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('shutdown -s -t 60'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('bcdedit /set safeboot minimal'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('net user tester 123456 /add'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('reg delete HKLM\\Software\\Foo /f'), isBoundaryError('denied_command'));
  assert.throws(() => boundary.checkCommand('Stop-Computer -Force'), isBoundaryError('denied_command'));
  assert.throws(
    () => boundary.checkCommand('powershell -c "Remove-Item -Path C:\\tmp -Recurse -Force"'),
    isBoundaryError('denied_command'),
  );

  // 该放行的（原来的误伤 + 日常命令）
  for (const command of [
    'wmic os get caption /format:list',
    'wmic process get name /format:csv',
    'wmic diskdrive get model /format:"list"',
    'docker ps --format json',
    'npm ci --no-audit',
    'node --test "tests/**/*.test.js"',
    'dir /b',
  ]) {
    assert.equal(boundary.checkCommand(command), command);
  }
});

test('读写大小上限', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root) });
  assert.equal(boundary.checkSize('write', 100), 100);
  assert.throws(() => boundary.checkSize('write', 1000), isBoundaryError('too_large'));
  assert.throws(() => boundary.checkSize('read', 2048), isBoundaryError('too_large'));
});

test('trusted 模式完全放行', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root, { mode: 'trusted' }) });
  assert.equal(boundary.trusted, true);
  assert.equal(boundary.checkPath('../anywhere/at/all'), path.resolve(root, '..', 'anywhere', 'at', 'all'));
  assert.equal(boundary.checkPath('.env'), path.join(root, '.env'));
  assert.equal(boundary.checkPath('keys/id_rsa'), path.join(root, 'keys', 'id_rsa'));
  assert.equal(boundary.checkCommand('rm -rf /'), 'rm -rf /');
  assert.equal(boundary.checkSize('write', 10 * 1024 * 1024), 10 * 1024 * 1024);
  assert.match(boundary.describe(), /完全信任/);
});

test('describe 说清边界规则', async () => {
  const root = await makeRoot();
  const boundary = createBoundary({ config: makeConfig(root) });
  const text = boundary.describe();
  assert.match(text, /sandbox/);
  assert.match(text, new RegExp(root.replace(/\\/g, '\\\\')));
  assert.match(text, /\.env/);
  assert.match(text, /rm -rf \//);
});
