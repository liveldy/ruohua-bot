/**
 * 端到端：用假 NapCat（tools/dev/mock-onebot.js）与假模型接口（tests/e2e/fake-llm.js）
 * 真起一个 src/main.js 进程，跑完整链路。
 *
 * 覆盖：闲聊被切成多条发出 → 情感与记忆落库 → agent 任务真的调工具并回报 →
 *       敏感操作两步验证（非管理员被拒 / 管理员对暗号通过后真的执行）→ 指令与定时任务。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockOneBot } from '../../tools/dev/mock-onebot.js';
import { freePort, startFakeLLM } from './fake-llm.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADMIN = 10001;
const STRANGER = 20001;
const PASSPHRASE = '芝麻开门';

let mock;
let fake;
let child;
let tempRoot;
let logs = [];

function freePort2() {
  return freePort();
}

async function waitFor(check, { timeoutMs = 20000, intervalMs = 120, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
    } catch (error) {
      last = null;
    }
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）\n--- 子进程日志 ---\n${logs.join('').slice(-4000)}`);
}

function sentSince(base, filter = {}) {
  return mock
    .sent()
    .slice(base)
    .filter((row) => (filter.scene ? row.scene === filter.scene : true))
    .filter((row) => (filter.userId ? row.userId === Number(filter.userId) : true));
}

async function inject(text, { userId = ADMIN, scene = 'private', groupId = null } = {}) {
  const base = mock.sent().length;
  mock.inject({ scene, userId, groupId, text });
  return base;
}

async function waitForTexts(base, predicate, label, filter = { userId: ADMIN }, timeoutMs = 25000) {
  const rows = await waitFor(
    () => {
      const texts = sentSince(base, filter).map((row) => row.text);
      return predicate(texts) ? texts : null;
    },
    { timeoutMs, label },
  );
  return rows;
}

describe('端到端：若华完整链路', { concurrency: false }, () => {
  before(async () => {
    const wsPort = await freePort2();
    const controlPort = await freePort2();
    mock = createMockOneBot({ port: wsPort, httpPort: controlPort, token: 'e2e-token', selfId: 10000, quiet: true });
    await mock.start();
    fake = await startFakeLLM();

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-e2e-'));
    await fs.cp(path.join(ROOT, 'config'), path.join(tempRoot, 'config'), { recursive: true });

    // 关掉余额查询，别让测试去打真接口
    const modelConfig = JSON.parse(await fs.readFile(path.join(tempRoot, 'config', 'model.json'), 'utf8'));
    modelConfig.balance = { enabled: false, url: '' };
    await fs.writeFile(path.join(tempRoot, 'config', 'model.json'), JSON.stringify(modelConfig, null, 2));

    await fs.writeFile(
      path.join(tempRoot, '.env'),
      [
        'MODEL_BASE_URL=' + fake.baseUrl,
        'MODEL_API_KEY=fake-key',
        'MODEL_NAME=deepseek-chat',
        `ADMIN_QQ=${ADMIN}`,
        'ONEBOT_MODE=forward',
        `ONEBOT_WS_URL=ws://127.0.0.1:${wsPort}`,
        'ONEBOT_ACCESS_TOKEN=e2e-token',
        'LOG_LEVEL=info',
        'SIDECAR_ENABLED=false',
      ].join('\n'),
      'utf8',
    );

    child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js'), '--config-dir', tempRoot, '--no-autonomy', '--no-sidecar'], {
      cwd: ROOT,
      env: { ...process.env, ADMIN_QQ: String(ADMIN) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    child.on('exit', (code) => logs.push(`\n[子进程退出 code=${code}]\n`));

    await waitFor(() => mock.health().connections >= 1, { timeoutMs: 30000, label: 'NapCat 被连上' });
    // 上线后会先给管理员发一条问候，收到它就说明整条装配链都通了
    await waitFor(() => mock.sent().length >= 1, { timeoutMs: 30000, label: '上线问候发出' });
  }, { timeout: 90000 });

  after(async () => {
    try {
      child?.kill();
    } catch {
      /* 忽略 */
    }
    await mock?.stop().catch(() => {});
    await fake?.stop().catch(() => {});
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('闲聊：回复被切成短消息、去掉 Markdown 与 emoji', async () => {
    fake.reset();
    const base = await inject('在吗');
    // 启动自检的提醒也是发给管理员的，且可能与这句回复前后脚到，别混进闲聊断言
    const notNotice = (text) => !String(text ?? '').includes('自检');
    const texts = (
      await waitForTexts(base, (list) => list.filter(notNotice).length >= 2, '闲聊回复被切成多条')
    ).filter(notNotice);
    assert.ok(texts.length >= 2, `应该切成多条，实际 ${texts.length} 条`);
    for (const text of texts) {
      assert.ok(!text.includes('**'), `不该留 Markdown：${text}`);
      assert.ok(!text.includes('😊'), `emoji 应该换成 QQ 表情：${text}`);
      assert.ok(text.length <= 40, `单条不该太长：${text}`);
    }
    const joined = texts.join('');
    assert.ok(joined.includes('在的') && joined.includes('怎么了'), `内容不完整：${joined}`);
    // 逐条之间有打字间隔
    const rows = sentSince(base, { userId: ADMIN }).filter((row) => notNotice(row.text));
    assert.ok(rows[1].at - rows[0].at >= 200, '两条之间应该有停顿');
  });

  it('情感与记忆：好感度变化、记忆落库', async () => {
    const emotionFile = path.join(tempRoot, 'data', 'emotion.json');
    const state = await waitFor(
      async () => {
        const raw = await fs.readFile(emotionFile, 'utf8').catch(() => '');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const entry = parsed.users?.[String(ADMIN)] ?? parsed[String(ADMIN)];
        return entry && entry.affection > 60 ? entry : null;
      },
      { timeoutMs: 20000, label: '好感度上涨并落盘' },
    );
    assert.ok(state.affection > 60, `被夸之后好感度应该上涨，实际 ${state.affection}`);
    assert.ok(['开心', '平静', '关心'].includes(state.mood), `情绪不该是 ${state.mood}`);

    const memoryFile = path.join(tempRoot, 'data', 'memory', `${ADMIN}.jsonl`);
    const rows = await waitFor(
      async () => {
        const raw = await fs.readFile(memoryFile, 'utf8').catch(() => '');
        const items = raw
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return items.length ? items : null;
      },
      { timeoutMs: 25000, label: '记忆写入 jsonl' },
    );
    assert.ok(rows[0].content.includes('打招呼') || rows[0].content.length > 0, '记忆内容不该为空');
    assert.ok(['temporary', 'permanent'].includes(rows[0].kind), `kind 非法：${rows[0].kind}`);
  });

  it('agent 模式：自己调工具、跑完回报、任务落盘为 done', async () => {
    fake.reset();
    const base = await inject('帮我理一理你现在什么状态');
    const texts = await waitForTexts(base, (list) => list.some((text) => text.includes('做完了')), 'agent 任务回报', { userId: ADMIN }, 40000);
    assert.ok(texts.some((text) => text.includes('做完了')), `没等到回报：${texts.join('|')}`);
    assert.ok(texts.length >= 1, '至少要有一句回应');

    const toolMessages = fake.toolMessages();
    assert.ok(toolMessages.length >= 1, 'agent 应该真的调用过工具');
    assert.ok(toolMessages.some((text) => text.includes('system_status') || text.includes('运行') || text.includes('时长')) || toolMessages[0].length > 0, '工具结果不该是空的');

    const tasksFile = path.join(tempRoot, 'data', 'tasks.json');
    const tasks = await waitFor(
      async () => {
        const raw = await fs.readFile(tasksFile, 'utf8').catch(() => '');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
        return list.length ? list : null;
      },
      { timeoutMs: 25000, label: '任务落盘' },
    );
    const done = tasks.find((task) => task.status === 'done');
    assert.ok(done, `应该有完成的任务：${JSON.stringify(tasks)}`);
    assert.ok(done.steps.some((step) => step.tool === 'system_status'), `步骤里该有 system_status：${JSON.stringify(done.steps.map((s) => s.tool))}`);
  });

  it('安全：普通用户要跑本机命令会被婉言拒绝，且什么都没执行', async () => {
    fake.reset();
    const base = await inject('帮我在电脑上执行一条命令看看网卡', { userId: STRANGER });
    const texts = await waitForTexts(base, (list) => list.length >= 1, '婉拒', { userId: STRANGER });
    assert.ok(texts.join('').length > 0, '应该给一句回复');
    assert.ok(!texts.join('').includes('ruohua-e2e'), '不该真的执行');
    assert.ok(!fake.toolMessages().some((text) => text.includes('ruohua-e2e')), '不该走到执行阶段');
    assert.ok(!texts.join('').includes(PASSPHRASE), '不该把口令说出去');
  });

  it('安全：管理员的敏感操作走暗号两步验证，通过后真的执行', async () => {
    fake.reset();
    const base = await inject('帮我在电脑上执行一条命令看看网卡');
    const challenge = await waitForTexts(base, (list) => list.length >= 1, '暗号提问', { userId: ADMIN }, 30000);
    const challengeText = challenge.join('');
    assert.ok(!challengeText.includes(PASSPHRASE), `提问里不能直接出现口令：${challengeText}`);
    assert.ok(challengeText.length > 0, '总得问一句');

    const answerBase = await inject(PASSPHRASE);
    await waitForTexts(answerBase, (list) => list.length >= 1, '应答后的确认', { userId: ADMIN }, 30000);
    await waitForTexts(answerBase, (list) => list.some((text) => text.includes('做完了')), '通过后任务完成', { userId: ADMIN }, 40000);
    assert.ok(fake.toolMessages().some((text) => text.includes('ruohua-e2e')), '通过验证之后应该真的执行命令');

    // 口令通过的那一瞬间，正在等授权的那条任务不能被「对方回了别的话」收掉
    const tasksFile = path.join(tempRoot, 'data', 'tasks.json');
    const taskRows = await waitFor(
      async () => {
        const raw = await fs.readFile(tasksFile, 'utf8').catch(() => '');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
        return list.length ? list : null;
      },
      { timeoutMs: 25000, label: '任务落盘' },
    );
    assert.ok(
      !taskRows.some((task) => task.status === 'cancelled' && String(task.error ?? '').includes('别的话')),
      `等暗号的任务不该被自己收掉：${JSON.stringify(taskRows.map((task) => [task.id, task.status, task.error, task.waitReason]))}`,
    );
    assert.ok(
      taskRows.some((task) => task.status === 'waiting' && task.waitReason === 'authorization'),
      `等暗号的原因要留在任务表里：${JSON.stringify(taskRows.map((task) => [task.status, task.waitReason]))}`,
    );
  });

  it('指令：/状态 报运行情况，/定时 写进 schedule.json', async () => {
    const statusBase = await inject('/状态');
    const statusTexts = await waitForTexts(statusBase, (list) => list.length >= 1, '/状态 回复', { userId: ADMIN }, 25000);
    const statusText = statusTexts.join('\n');
    assert.ok(/运行|上线|启动/.test(statusText), `状态汇报里应该有运行时长：${statusText}`);
    assert.ok(/deepseek-chat|模型/.test(statusText), `状态汇报里应该有模型：${statusText}`);

    const scheduleBase = await inject('/定时 +1m 提醒我喝水');
    const scheduleTexts = await waitForTexts(scheduleBase, (list) => list.some((text) => text.includes('安排上了')), '/定时 回复', { userId: ADMIN }, 25000);
    assert.ok(scheduleTexts.some((text) => text.includes('安排上了')), `应该确认安排：${scheduleTexts.join('|')}`);
    const scheduleFile = path.join(tempRoot, 'data', 'schedule.json');
    const schedule = await waitFor(
      async () => {
        const raw = await fs.readFile(scheduleFile, 'utf8').catch(() => '');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
        return list.length ? list : null;
      },
      { timeoutMs: 20000, label: '定时任务落盘' },
    );
    assert.ok(schedule.some((task) => String(task.prompt ?? '').includes('喝水')), `定时任务内容不对：${JSON.stringify(schedule)}`);
  });
});
