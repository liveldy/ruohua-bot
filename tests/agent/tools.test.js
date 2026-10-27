/** 工具层：边界拦截、参数校验、服务缺失、shell 超时与截断、finish/ask_user 的形态、各服务工具打通。 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTools } from '../../src/agent/tools/index.js';
import { createNullLogger } from '../../src/logging/logger.js';

function createBoundary(root) {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    checkPath(target) {
      const abs = path.resolve(resolved, String(target ?? '.'));
      const rel = path.relative(resolved, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        const error = new Error(`越界路径：${abs}`);
        error.name = 'BoundaryError';
        throw error;
      }
      return abs;
    },
    checkCommand(command) {
      if (/rm -rf \//.test(command)) {
        const error = new Error('命令在拒绝名单里');
        error.name = 'BoundaryError';
        throw error;
      }
      return true;
    },
    describe: () => `沙箱 ${resolved}`,
  };
}

function makeConfig(root, { shell = {}, maxReadBytes = 4096, maxWriteBytes = 1024, persona = {} } = {}) {
  const absoluteRoot = path.resolve(root);
  return {
    rootDir: absoluteRoot,
    boundaryRoot: absoluteRoot,
    dataDir: path.join(absoluteRoot, 'data'),
    stickerDir: path.join(absoluteRoot, 'stickers'),
    persona: { expressions: { stickerChance: 0.16, faceChance: 0.35, maxConsecutiveSame: 3, ...persona } },
    agent: { stepTimeoutMs: 5000, toolResultMaxChars: 4000 },
    memory: { recall: { topK: 5 } },
    security: {
      boundary: {
        maxReadBytes,
        maxWriteBytes,
        shell: { enabled: true, timeoutMs: 30000, maxOutputBytes: 200, ...shell },
      },
    },
  };
}

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  // 命令类用例会留下正在退出的子进程，它们占着 cwd 时 Windows 会 EBUSY：多退几步再删
  await Promise.all(
    TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
  TEMP_DIRS.length = 0;
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-tools-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeCtx(services, extra = {}) {
  return {
    userId: 10001,
    scene: 'private',
    groupId: null,
    taskId: 'task_test',
    task: null,
    message: null,
    services,
    logger: createNullLogger(),
    signal: extra.signal ?? new AbortController().signal,
    ...extra,
  };
}

function toolOf(tools, name) {
  const tool = tools.get(name);
  assert.ok(tool, `缺少工具 ${name}`);
  return tool;
}

test('createTools 给全了契约里的工具，且 schema 规范', () => {
  const tools = createTools({ config: makeConfig('D:/tmp'), services: {} });
  const expected = [
    'shell',
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
    'screen_capture',
    'see_image',
    'web_fetch',
    'web_search',
    'memory_write',
    'memory_search',
    'schedule_task',
    'list_tasks',
    'system_status',
    'send_file',
    'send_expression',
    'ask_user',
    'finish',
  ];
  for (const name of expected) assert.ok(tools.has(name), `缺工具 ${name}`);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10, `${tool.name} 的描述太短`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.run, 'function');
    assert.equal(typeof tool.sensitive, 'boolean');
  }
  assert.equal(toolOf(tools, 'shell').action, 'shell');
  assert.equal(toolOf(tools, 'read_file').sensitive, true);
  assert.equal(toolOf(tools, 'write_file').action, 'file_write');
  assert.equal(toolOf(tools, 'send_file').action, 'send_file');
  assert.equal(toolOf(tools, 'list_dir').sensitive, false);
});

test('list_dir / read_file 越界被 boundary 拦下', async () => {
  const root = await tempDir();
  const tools = createTools({ config: makeConfig(root), services: { security: { boundary: createBoundary(root) } } });
  const ctx = makeCtx({ security: { boundary: createBoundary(root) } });

  await assert.rejects(() => toolOf(tools, 'list_dir').run({ path: '../' }, ctx), (error) => {
    assert.equal(error.name, 'ToolError');
    assert.equal(error.code, 'boundary_denied');
    return true;
  });
  await assert.rejects(() => toolOf(tools, 'read_file').run({ path: path.join(os.tmpdir(), 'outside.txt') }, ctx), (error) => {
    assert.equal(error.code, 'boundary_denied');
    return true;
  });
  await assert.rejects(() => toolOf(tools, 'write_file').run({ path: '../evil.txt', content: 'x' }, ctx), (error) => {
    assert.equal(error.code, 'boundary_denied');
    return true;
  });
});

test('read_file：正常读、目录、不存在、二进制、超限', async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'a.txt'), '若华在干活', 'utf8');
  await fs.writeFile(path.join(root, 'big.txt'), '甲'.repeat(3000), 'utf8');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const config = makeConfig(root, { maxReadBytes: 1024 });
  const services = { security: { boundary: createBoundary(root) } };
  const tools = createTools({ config, services });
  const ctx = makeCtx(services);

  const ok = await toolOf(tools, 'read_file').run({ path: 'a.txt' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.content, '若华在干活');
  assert.equal(path.isAbsolute(ok.path), true);

  await assert.rejects(() => toolOf(tools, 'read_file').run({ path: '.' }, ctx), /这是一个目录/);
  await assert.rejects(() => toolOf(tools, 'read_file').run({ path: 'missing.txt' }, ctx), (error) => error.code === 'not_found');
  await assert.rejects(() => toolOf(tools, 'read_file').run({ path: 'big.txt' }, ctx), (error) => error.code === 'file_too_large');
  const binary = await toolOf(tools, 'read_file').run({ path: 'bin.dat' }, ctx);
  assert.equal(binary.binary, true);
  await assert.rejects(() => toolOf(tools, 'read_file').run({}, ctx), (error) => {
    assert.equal(error.name, 'ToolError');
    assert.equal(error.code, 'missing_argument');
    return true;
  });
});

test('write_file 写进沙箱、超限被拒', async () => {
  const root = await tempDir();
  const config = makeConfig(root, { maxWriteBytes: 32 });
  const services = { security: { boundary: createBoundary(root) } };
  const tools = createTools({ config, services });
  const ctx = makeCtx(services);

  const written = await toolOf(tools, 'write_file').run({ path: 'out/note.txt', content: '记一笔' }, ctx);
  assert.equal(written.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'out', 'note.txt'), 'utf8'), '记一笔');

  await assert.rejects(() => toolOf(tools, 'write_file').run({ path: 'out/big.txt', content: '甲'.repeat(64) }, ctx), (error) => error.code === 'content_too_large');
});

test('list_dir 与 search_files 能列目录、按名找文件', async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf8');
  await fs.writeFile(path.join(root, 'sub', 'b.md'), 'bbb', 'utf8');
  await fs.writeFile(path.join(root, 'sub', 'notes.md'), '若华在这里记了一笔', 'utf8');
  const services = { security: { boundary: createBoundary(root) } };
  const tools = createTools({ config: makeConfig(root), services });
  const ctx = makeCtx(services);

  const flat = await toolOf(tools, 'list_dir').run({}, ctx);
  assert.deepEqual(flat.entries.map((entry) => entry.path).sort(), ['a.txt', 'sub/']);
  const deep = await toolOf(tools, 'list_dir').run({ recursive: true }, ctx);
  assert.ok(deep.entries.some((entry) => entry.path === 'sub/b.md'));

  const byGlob = await toolOf(tools, 'search_files').run({ pattern: '*.md' }, ctx);
  assert.deepEqual(byGlob.results.map((row) => row.path).sort(), ['sub/b.md', 'sub/notes.md']);
  const byName = await toolOf(tools, 'search_files').run({ pattern: 'a.txt' }, ctx);
  assert.deepEqual(byName.results.map((row) => row.path), ['a.txt']);
  const byContent = await toolOf(tools, 'search_files').run({ pattern: '记了一笔', content: true }, ctx);
  assert.equal(byContent.results[0].path, 'sub/notes.md');
  assert.equal(byContent.results[0].line, 1);
});

test('shell：shell.enabled=false 直接拒绝，越权命令与越界 cwd 也被拦', async () => {
  const root = await tempDir();
  const services = { security: { boundary: createBoundary(root) } };
  const ctx = makeCtx(services);

  const disabled = createTools({ config: makeConfig(root, { shell: { enabled: false } }), services });
  await assert.rejects(() => toolOf(disabled, 'shell').run({ command: 'dir' }, ctx), (error) => {
    assert.equal(error.name, 'ToolError');
    assert.equal(error.code, 'shell_disabled');
    assert.match(error.message, /已被关闭/);
    return true;
  });

  const enabled = createTools({ config: makeConfig(root), services });
  await assert.rejects(() => toolOf(enabled, 'shell').run({ command: 'rm -rf /' }, ctx), (error) => error.code === 'command_denied');
  await assert.rejects(() => toolOf(enabled, 'shell').run({ command: 'dir', cwd: '../..' }, ctx), (error) => error.code === 'boundary_denied');
  await assert.rejects(() => toolOf(enabled, 'shell').run({}, ctx), (error) => error.code === 'missing_argument');
});

test('shell：能跑通、输出超限截断、超时以 timeout 抛出', async () => {
  const root = await tempDir();
  const services = { security: { boundary: createBoundary(root) } };
  const tools = createTools({ config: makeConfig(root, { shell: { maxOutputBytes: 200, timeoutMs: 5000 } }), services });
  const ctx = makeCtx(services);

  const ok = await toolOf(tools, 'shell').run({ command: 'node -e "console.log(1+1)"' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /2/);

  const big = await toolOf(tools, 'shell').run({ command: 'node -e "console.log(String.fromCharCode(30002).repeat(500))"' }, ctx);
  assert.equal(big.truncated, true);
  assert.match(big.output, /已截断/);
  assert.ok(big.output.length < 400);

  await assert.rejects(() => toolOf(tools, 'shell').run({ command: 'node -e "setTimeout(()=>{},2000)"', timeoutMs: 300 }, ctx), (error) => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.name, 'ToolError');
    return true;
  });

  const failed = await toolOf(tools, 'shell').run({ command: 'node -e "process.exit(3)"' }, ctx);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
});

test('shell 的 abort 信号会让命令停下', async () => {
  const root = await tempDir();
  const services = { security: { boundary: createBoundary(root) } };
  const tools = createTools({ config: makeConfig(root, { shell: { timeoutMs: 10000 } }), services });
  const controller = new AbortController();
  const ctx = makeCtx(services, { signal: controller.signal });

  const promise = toolOf(tools, 'shell').run({ command: 'node -e "setTimeout(()=>{},3000)"' }, ctx);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => promise, (error) => error.code === 'aborted');
});

test('finish 与 ask_user 的结果形态', async () => {
  const tools = createTools({ config: makeConfig(await tempDir()), services: {} });
  const ctx = makeCtx({});

  const finished = await toolOf(tools, 'finish').run({ result: '都办好了' }, ctx);
  assert.deepEqual(finished, { ok: true, done: true, result: '都办好了' });
  assert.equal(toolOf(tools, 'finish').sensitive, false);
  assert.equal(toolOf(tools, 'finish').parameters.required.includes('result'), true);

  const asked = await toolOf(tools, 'ask_user').run({ question: '你要哪个目录', options: ['D盘', 'E盘'] }, ctx);
  assert.deepEqual(asked, { ok: true, awaiting: true, question: '你要哪个目录', options: ['D盘', 'E盘'] });
  assert.deepEqual((await toolOf(tools, 'ask_user').run({ question: '哪个' }, ctx)).options, []);
  await assert.rejects(() => toolOf(tools, 'ask_user').run({}, ctx), (error) => error.code === 'missing_argument');
});

test('服务不存在时报「服务未就绪」，不伪造结果', async () => {
  const root = await tempDir();
  const tools = createTools({ config: makeConfig(root), services: {} });
  const ctx = makeCtx({});

  await assert.rejects(() => toolOf(tools, 'screen_capture').run({}, ctx), (error) => {
    assert.equal(error.name, 'ToolError');
    assert.match(error.message, /服务未就绪：screen/);
    return true;
  });
  await assert.rejects(() => toolOf(tools, 'see_image').run({ path: 'a.png' }, ctx), /服务未就绪：vision/);
  await assert.rejects(() => toolOf(tools, 'system_status').run({}, ctx), /服务未就绪：status/);
  await assert.rejects(() => toolOf(tools, 'memory_write').run({ content: 'x' }, ctx), /服务未就绪：memory/);
  await assert.rejects(() => toolOf(tools, 'memory_search').run({ query: 'x' }, ctx), /服务未就绪：memory/);
  await assert.rejects(() => toolOf(tools, 'schedule_task').run({ prompt: 'x', time: '+10m' }, ctx), /服务未就绪：scheduler/);
  await assert.rejects(() => toolOf(tools, 'list_tasks').run({}, ctx), /服务未就绪：scheduler/);
  await assert.rejects(() => toolOf(tools, 'send_file').run({ path: 'a.txt' }, ctx), (error) => {
    assert.equal(error.code, 'service_unavailable');
    return true;
  });
  await assert.rejects(() => toolOf(tools, 'send_expression').run({ type: 'auto' }, ctx), /服务未就绪：onebot/);
  // 没有 boundary 时，路径类工具也要明确拒绝
  await assert.rejects(() => toolOf(tools, 'list_dir').run({}, ctx), /服务未就绪：security\.boundary/);
});

test('screen_capture 与 see_image 走屏幕/视觉服务', async () => {
  const root = await tempDir();
  const services = {
    security: { boundary: createBoundary(root) },
    screen: { async capture({ path: target }) { return { path: target ?? path.join(root, 'shot.png'), width: 1920, height: 1080 }; } },
    vision: { async describeImages({ images, prompt, userId }) { return `看到 ${images.length} 张图：${prompt}（用户 ${userId}）`; } },
  };
  const tools = createTools({ config: makeConfig(root), services });
  const ctx = makeCtx(services);

  const shot = await toolOf(tools, 'screen_capture').run({ path: 'shot.png' }, ctx);
  assert.equal(shot.ok, true);
  assert.equal(shot.width, 1920);
  assert.equal(path.isAbsolute(shot.path), true);
  await assert.rejects(() => toolOf(tools, 'screen_capture').run({ path: '../shot.png' }, ctx), (error) => error.code === 'boundary_denied');

  const seen = await toolOf(tools, 'see_image').run({ path: 'shot.png' }, ctx);
  assert.match(seen.description, /看到 1 张图/);
  const multi = await toolOf(tools, 'see_image').run({ images: ['https://example.com/a.png', 'shot.png'] }, ctx);
  assert.equal(multi.images.length, 2);
  await assert.rejects(() => toolOf(tools, 'see_image').run({}, ctx), (error) => error.code === 'missing_argument');
});

test('memory / scheduler / status 工具走对应服务', async () => {
  const root = await tempDir();
  const remembered = [];
  const schedules = [];
  const services = {
    security: { boundary: createBoundary(root) },
    memory: {
      async remember(spec) {
        remembered.push(spec);
        return { id: 'mem_1', ...spec };
      },
      async recall({ query, topK }) {
        return [{ id: 'mem_1', content: `关于 ${query} 的记忆`, importance: 0.8, score: 0.9, createdAt: 1 }].slice(0, topK);
      },
    },
    scheduler: {
      async create(spec) {
        schedules.push(spec);
        return { id: 'sch_1', ...spec };
      },
      async list() {
        return [{ id: 'sch_1', name: '每日摘要', type: 'daily', prompt: '整理日志', enabled: true, nextRunAt: 123 }];
      },
    },
    status: { async report() { return '已运行 3 分钟，任务 2 个'; } },
  };
  const tools = createTools({ config: makeConfig(root), services });
  const ctx = makeCtx(services, { scene: 'group', groupId: 555 });

  const written = await toolOf(tools, 'memory_write').run({ content: '主人喜欢安静', kind: 'preference', importance: 1.3 }, ctx);
  assert.equal(written.ok, true);
  assert.equal(remembered[0].userId, 10001);
  assert.equal(remembered[0].scene, 'group');
  assert.equal(remembered[0].importance, 1, '重要度夹在 0..1');

  const found = await toolOf(tools, 'memory_search').run({ query: '偏好' }, ctx);
  assert.equal(found.count, 1);
  assert.match(found.items[0].content, /偏好/);

  const created = await toolOf(tools, 'schedule_task').run({ prompt: '整理昨天的日志', time: '每天08:00' }, ctx);
  assert.equal(created.ok, true);
  assert.equal(schedules[0].type, 'daily');
  assert.equal(schedules[0].time, '08:00');
  assert.deepEqual(schedules[0].target, { scene: 'group', userId: 10001, groupId: 555 });
  await toolOf(tools, 'schedule_task').run({ prompt: '半小时后提醒', time: '+30m' }, ctx);
  assert.equal(schedules[1].type, 'once');
  assert.ok(schedules[1].at > Date.now());
  await assert.rejects(() => toolOf(tools, 'schedule_task').run({ prompt: 'x', time: '什么时候都行' }, ctx), (error) => {
    assert.equal(error.code, 'invalid_time');
    return true;
  });

  const listed = await toolOf(tools, 'list_tasks').run({}, ctx);
  assert.equal(listed.count, 1);
  assert.equal(listed.tasks[0].name, '每日摘要');

  const status = await toolOf(tools, 'system_status').run({}, ctx);
  assert.match(status.status, /已运行 3 分钟/);
});

test('send_file / send_expression 通过 OneBot 发出去', async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'report.md'), '# 报告', 'utf8');
  const uploads = [];
  const sends = [];
  const services = {
    security: { boundary: createBoundary(root) },
    onebot: {
      async uploadFile(payload) {
        uploads.push(payload);
        return { message_id: 9 };
      },
      async sendTo(target, content) {
        sends.push({ target, content });
        return { message_id: 10 };
      },
    },
    persona: {
      async pickExpression({ context }) {
        return context.userId ? { type: 'face', id: '14' } : null;
      },
    },
  };
  const tools = createTools({ config: makeConfig(root), services });
  const ctx = makeCtx(services, { scene: 'group', groupId: 555 });

  const sent = await toolOf(tools, 'send_file').run({ path: 'report.md', name: '日志报告.md' }, ctx);
  assert.equal(sent.ok, true);
  assert.equal(uploads[0].scene, 'group');
  assert.equal(uploads[0].groupId, 555);
  assert.equal(uploads[0].name, '日志报告.md');
  assert.equal(path.isAbsolute(uploads[0].file), true);
  await assert.rejects(() => toolOf(tools, 'send_file').run({ path: 'missing.md' }, ctx), (error) => error.code === 'not_found');
  await assert.rejects(() => toolOf(tools, 'send_file').run({ path: '../outside.md' }, ctx), (error) => error.code === 'boundary_denied');

  const expression = await toolOf(tools, 'send_expression').run({ type: 'auto' }, ctx);
  assert.deepEqual(expression.expression, { type: 'face', id: '14' });
  assert.deepEqual(sends[0].content, [{ type: 'face', data: { id: '14' } }]);
  assert.equal(sends[0].target.groupId, 555);

  await toolOf(tools, 'send_expression').run({ type: 'sticker', file: 'sticker.png' }, ctx);
  assert.deepEqual(sends[1].content, [{ type: 'image', data: { file: 'sticker.png' } }]);
});

test('send_expression 没有 persona 服务时自己用 persona 模块挑一个', async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'stickers'), { recursive: true });
  await fs.writeFile(path.join(root, 'stickers', 'smile.png'), 'fake-png-bytes');
  const sends = [];
  const services = {
    security: { boundary: createBoundary(root) },
    onebot: {
      async sendTo(target, content) {
        sends.push({ target, content });
        return { message_id: 1 };
      },
    },
  };
  const config = makeConfig(root, { persona: { stickerChance: 1, faceChance: 0 } });
  const tools = createTools({ config, services });
  const ctx = makeCtx(services);

  const result = await toolOf(tools, 'send_expression').run({ type: 'auto' }, ctx);
  assert.equal(result.expression.type, 'sticker');
  assert.ok(result.expression.file.endsWith('smile.png'));
  assert.deepEqual(sends[0].content, [{ type: 'image', data: { file: result.expression.file } }]);
});

test('工具已经取消时直接退出', async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
  const services = { security: { boundary: createBoundary(root) } };
  const tools = createTools({ config: makeConfig(root), services });
  const controller = new AbortController();
  controller.abort();
  const ctx = makeCtx(services, { signal: controller.signal });

  await assert.rejects(() => toolOf(tools, 'read_file').run({ path: 'a.txt' }, ctx), (error) => error.code === 'aborted');
  await assert.rejects(() => toolOf(tools, 'list_dir').run({}, ctx), (error) => error.code === 'aborted');
  await assert.rejects(() => toolOf(tools, 'finish').run({ result: 'x' }, ctx), (error) => error.code === 'aborted');
});
