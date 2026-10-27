/**
 * 分发器：work 模式的步数上限、敏感操作不再预检、等暗号的任务不被收掉、
 * 任务回报的 ok 口径、/任务 的轮次口径、最终结果走技术通道。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../../src/brain/dispatcher.js';
import { createTaskRegistry } from '../../src/agent/tasks.js';
import { loadConfig } from '../../src/config/index.js';
import { sleep } from '../../src/util/common.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = 10001;

// 每个测试都要一个临时数据目录；跑完必须收走，别把 %TEMP% 塞满
const tempDirs = [];
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.allSettled(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

async function makeConfig(overrides = {}) {
  const tmp = await tempDir('ruohua-dispatch-');
  const config = loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: {
      bot: { dataDir: tmp },
      model: { apiKey: 'test-key' },
      security: { admins: [OWNER] },
      ...overrides,
    },
  });
  return config;
}

function makeLogger() {
  const ops = [];
  const logger = {
    ops,
    child: () => logger,
    debug() {},
    info() {},
    warn() {},
    error() {},
    operation: (entry) => {
      ops.push(entry);
      return entry;
    },
    conversation: () => {},
  };
  return logger;
}

function messageOf(text, { userId = OWNER, scene = 'private', groupId = null } = {}) {
  return {
    messageId: null,
    time: Date.now(),
    selfId: 99999,
    scene,
    userId,
    groupId,
    sender: { userId, nickname: '主人', card: null, role: 'owner' },
    segments: [{ type: 'text', data: { text } }],
    text,
    display: text,
    quoted: null,
    images: [],
    faces: [],
    files: [],
    records: [],
    isAt: scene === 'group',
    raw: {},
  };
}

function userOf(userId = OWNER) {
  return { userId, nickname: '主人', role: 'owner', scene: 'private', groupId: null };
}

function makeLLM(decision) {
  const calls = [];
  const llm = {
    calls,
    async chat(params) {
      calls.push(params);
      if (params.role === 'judge') {
        const judge = { mood: null, delta: 0, event: 'chat', reason: '测试', importance: 0.1 };
        return { content: JSON.stringify(judge), json: judge, toolCalls: [], usage: {}, model: 'fake' };
      }
      return { content: JSON.stringify(decision), json: decision, toolCalls: [], usage: {}, model: 'fake' };
    },
  };
  return llm;
}

function makeReply() {
  const progressTexts = [];
  const results = [];
  const sends = [];
  return {
    progressTexts,
    results,
    sends,
    async progress(params) {
      progressTexts.push(params.text);
      return { sentMessages: 1, texts: [params.text] };
    },
    async result(params) {
      results.push(params);
      return { sentMessages: 1, texts: [params.text], filePath: null, expressions: 0 };
    },
    async send(params) {
      sends.push(params);
      return { sentMessages: 1, texts: [params.text] };
    },
  };
}

const contextStub = {
  async build() {
    return { system: '人设', messages: [], meta: { hints: null } };
  },
  async addTurn() {},
  async recent() {
    return [];
  },
  async clear() {},
};

const onebotStub = {
  sendTo: async () => ({ message_id: 1 }),
  uploadFile: async () => ({ ok: true }),
  loginInfo: () => ({ user_id: 99999 }),
};

/** 等一个条件成立；startWork 是后台跑的，不 await 它的 promise。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  throw new Error('等待超时');
}

function workDecision(goal, extra = {}) {
  return { mode: 'work', goal, style: 'work', needs_tools: true, sensitive: [], reply: null, confidence: 0.9, reason: '测试', ...extra };
}

test('work 模式用 config.agent.workMaxSteps（默认 8），agent 模式照旧用 maxSteps（默认 24）', async () => {
  const config = await makeConfig();
  assert.equal(config.agent.workMaxSteps, 8, '默认值要落进配置');
  assert.equal(config.agent.maxSteps, 24);

  const runs = [];
  const agent = {
    async run(spec) {
      runs.push(spec);
      return { id: `task_${runs.length}`, status: 'done', result: '机器一切正常', error: null, steps: [] };
    },
    cancel() {},
  };

  const workReply = makeReply();
  const workDispatcher = createDispatcher({
    config,
    logger: makeLogger(),
    onebot: onebotStub,
    services: { llm: makeLLM(workDecision('查一下系统状态然后汇报')), reply: workReply, agent, context: contextStub, tools: new Map(), tasks: createTaskRegistry({ logger: null }) },
  });
  await workDispatcher.processMessage(messageOf('查一下系统状态然后汇报'), userOf());
  await waitFor(() => workReply.results.length === 1);

  assert.equal(runs[0].maxSteps, 8, 'work 模式要用 workMaxSteps（默认 8），不再是 min(3, maxSteps)');
  assert.equal(workReply.results[0].mode, 'work');
  assert.equal(workReply.results[0].text, '机器一切正常');

  const agentReply = makeReply();
  const agentDispatcher = createDispatcher({
    config,
    logger: makeLogger(),
    onebot: onebotStub,
    services: {
      llm: makeLLM({ ...workDecision('整理这堆资料'), mode: 'agent' }),
      reply: agentReply,
      agent,
      context: contextStub,
      tools: new Map(),
      tasks: createTaskRegistry({ logger: null }),
    },
  });
  await agentDispatcher.processMessage(messageOf('整理这堆资料'), userOf());
  await waitFor(() => agentReply.results.length === 1);

  assert.equal(runs[1].maxSteps, 24, 'agent 模式照旧走 maxSteps');
  assert.equal(agentReply.results[0].mode, 'agent');
});

test('decision.sensitive 不再触发暗号预检，口令只留给真正执行敏感工具那一刻', async () => {
  const config = await makeConfig();
  const verifies = [];
  const reply = makeReply();
  const runs = [];
  const services = {
    llm: makeLLM(workDecision('看看系统状态', { sensitive: ['shell', 'file_write'] })),
    reply,
    agent: {
      async run(spec) {
        runs.push(spec);
        return { id: 'task_s', status: 'done', result: '看过了', error: null, steps: [] };
      },
      cancel() {},
    },
    context: contextStub,
    tools: new Map(),
    tasks: createTaskRegistry({ logger: null }),
    security: {
      isAdmin: () => true,
      isSensitive: () => true,
      sessionState: () => ({ stage: 'idle' }),
      async verify(request) {
        verifies.push(request);
        return { ok: false, stage: 'challenge', replyText: '写东西之前，先跟我说句话吧' };
      },
    },
  };
  const dispatcher = createDispatcher({ config, logger: makeLogger(), onebot: onebotStub, services });

  await dispatcher.processMessage(messageOf('看看系统状态'), userOf());
  await waitFor(() => runs.length === 1);

  assert.equal(verifies.length, 0, 'dispatcher 不该做敏感预检');
  assert.equal(
    reply.progressTexts.some((text) => /先跟我说句话|暗号|验证/.test(String(text))),
    false,
    `不该冒出验证提问：${reply.progressTexts.join('|')}`,
  );
  assert.equal(runs[0].maxSteps, 8);
});

test('单独发出去的表情包要写回对话上下文（不能让她事后否认发过图）', async () => {
  const config = await makeConfig();
  const turns = [];
  const context = {
    async build() {
      return { system: '人设', messages: [], meta: { hints: null } };
    },
    async addTurn(turn) {
      turns.push(turn);
      return [];
    },
    async recent() {
      return [];
    },
  };
  const reply = {
    async progress() {
      return {};
    },
    async result() {
      return {};
    },
    async send() {
      return { sentMessages: 1, texts: ['知道了'], filePath: null, expressions: 1, extras: [{ kind: 'sticker', label: '假笑一张' }] };
    },
  };
  const dispatcher = createDispatcher({
    config,
    logger: makeLogger(),
    onebot: onebotStub,
    services: {
      llm: makeLLM({ mode: 'chat', reply: '知道了', style: 'chat', needs_tools: false, sensitive: [], confidence: 0.9, reason: '测试' }),
      reply,
      context,
      tools: new Map(),
      tasks: createTaskRegistry({ logger: null }),
    },
  });

  await dispatcher.processMessage(messageOf('在吗'), userOf());

  const assistant = turns.filter((turn) => turn.role === 'assistant');
  assert.equal(assistant.length, 1, '一轮只写一条助手消息');
  assert.match(assistant[0].content, /知道了/);
  assert.match(assistant[0].content, /假笑一张/, '单独发出去的表情包也得写进上下文，不然她会说「我没发过图」');
  assert.equal(turns.filter((turn) => turn.role === 'user').length, 1);
});

test('口令通过后重跑：等暗号的那条任务不被收掉（回归 19:30 那次自取消）', async () => {
  const config = await makeConfig();
  const logger = makeLogger();
  const registry = createTaskRegistry({ logger: null });
  const authTask = registry.create({ goal: '截取当前屏幕并识图', userId: OWNER, status: 'waiting', waitReason: 'authorization', maxSteps: 6 });
  const answerTask = registry.create({ goal: '整理某个目录', userId: OWNER, status: 'waiting', waitReason: 'answer', maxSteps: 6 });
  const legacyTask = registry.create({ goal: '老的等待任务', userId: OWNER, status: 'waiting', maxSteps: 6 });

  const results = [];
  let runCount = 0;
  // 第一句还没出题，第二句开始进入「等你答暗号」的状态
  let session = { stage: 'idle' };
  const services = {
    llm: makeLLM(workDecision('查一下屏幕上的内容并识图')),
    reply: {
      progress: async () => ({}),
      result: async (params) => {
        results.push(params);
        return { sentMessages: 1, texts: [params.text] };
      },
      send: async () => ({}),
    },
    agent: {
      async run() {
        runCount += 1;
        if (runCount === 1) return authTask;
        return { id: 'task_rerun', status: 'done', result: '屏截好了', error: null, steps: [] };
      },
      cancel() {},
    },
    context: contextStub,
    tools: new Map(),
    tasks: registry,
    security: {
      isAdmin: () => true,
      isSensitive: () => true,
      sessionState: () => session,
      async verify() {
        // 真实的 SecurityGuard 答对后就把质询会话删掉，sessionState 不再是 challenge
        session = { stage: 'passed' };
        return { ok: true, stage: 'passed', replyText: '好' };
      },
    },
  };
  const dispatcher = createDispatcher({ config, logger, onebot: onebotStub, services });

  // 第一次：任务卡在等暗号，dispatcher 要把这次请求记下来
  await dispatcher.processMessage(messageOf('查一下屏幕上的内容并识图'), userOf());
  await waitFor(() => results.length === 1);
  assert.equal(authTask.status, 'waiting', '等暗号的任务不该被这次对话收掉');

  // 第二次：对方把暗号答上来，重跑
  session = { stage: 'challenge', action: 'shell' };
  await dispatcher.processMessage(messageOf('芝麻开门'), userOf());
  await waitFor(() => runCount === 2);
  await sleep(20);

  assert.equal(authTask.status, 'waiting', `等暗号的任务不能被收：${authTask.status} / ${authTask.error}`);
  assert.notEqual(authTask.error, '对方回了别的话，这次没接着做');
  assert.equal(logger.ops.some((entry) => entry.action === 'passphrase' && entry.ok === true), true, '口令要记一条通过');
  assert.ok(results.length >= 2, '重跑要重新把结果发出去');

  // 下一次对话到来时，其它等待中的任务照旧收掉
  await dispatcher.processMessage(messageOf('在吗'), userOf());
  assert.equal(answerTask.status, 'cancelled');
  assert.match(String(answerTask.error), /别的话/);
  assert.equal(legacyTask.status, 'cancelled');
  assert.equal(authTask.status, 'waiting', '等暗号的那条一直都在');
});

test('task_report：waiting / cancelled 不算失败，failed 才算；结果文本带上真实原因', async () => {
  const config = await makeConfig();
  const logger = makeLogger();
  const tasks = [
    { id: 'task_a', status: 'waiting', waitReason: 'authorization', result: '写文件之前，先跟我说句「明月几时有」', error: null, steps: [] },
    { id: 'task_b', status: 'cancelled', result: null, error: '任务已取消', steps: [] },
    { id: 'task_c', status: 'failed', result: '已经查到的东西不能扔', error: '步数用尽（上限 6 步）', steps: [] },
    { id: 'task_d', status: 'failed', result: null, error: '模型调用失败', steps: [] },
  ];
  let index = 0;
  const results = [];
  const services = {
    llm: makeLLM(workDecision('看看系统状态')),
    reply: {
      progress: async () => ({}),
      result: async (params) => {
        results.push(params);
        return { sentMessages: 1, texts: [params.text] };
      },
      send: async () => ({}),
    },
    agent: {
      async run() {
        const task = tasks[index];
        index += 1;
        return task;
      },
      cancel() {},
    },
    context: contextStub,
    tools: new Map(),
    tasks: createTaskRegistry({ logger: null }),
  };
  const dispatcher = createDispatcher({ config, logger, onebot: onebotStub, services });

  for (let round = 0; round < tasks.length; round += 1) {
    await dispatcher.processMessage(messageOf('看看系统状态'), userOf());
  }
  await waitFor(() => results.length === tasks.length);

  const reportOf = (id) => logger.ops.find((entry) => entry.action === 'task_report' && entry.target === id);
  assert.equal(reportOf('task_a').ok, true, 'waiting 不是失败');
  assert.equal(reportOf('task_a').detail.status, 'waiting');
  assert.equal(reportOf('task_b').ok, true, 'cancelled 不是失败');
  assert.equal(reportOf('task_c').ok, false, 'failed 才算 not ok');
  assert.equal(reportOf('task_d').ok, false);

  assert.equal(results[0].text, '写文件之前，先跟我说句「明月几时有」');
  assert.equal(results[1].text, '停下来了');
  assert.equal(results[2].text, '已经查到的东西不能扔', '失败也要把已经拿到的结果发出去');
  assert.match(results[3].text, /模型调用失败/, '没有结果时至少说清原因');
});

test('任务收尾把一句摘要记回发起它的会话：只记 done / failed，还在跑的不记', async () => {
  const config = await makeConfig();
  const turns = [];
  const outcomes = [
    { id: 'task_done', status: 'done', result: '很长'.repeat(400), error: null, steps: [] },
    { id: 'task_wait', status: 'waiting', result: '在等你回话', error: null, steps: [] },
    { id: 'task_failed', status: 'failed', result: null, error: '步数用尽', steps: [] },
  ];
  let index = 0;
  const results = [];
  const services = {
    llm: makeLLM(workDecision('看看系统状态')),
    reply: {
      progress: async () => ({}),
      result: async (params) => {
        results.push(params);
        return { sentMessages: 1, texts: [params.text] };
      },
      send: async () => ({}),
    },
    agent: {
      async run() {
        const task = outcomes[index];
        index += 1;
        return task;
      },
      cancel() {},
    },
    context: { ...contextStub, async addTurn(turn) { turns.push(turn); } },
    tools: new Map(),
    tasks: createTaskRegistry({ logger: null }),
  };
  const dispatcher = createDispatcher({ config, logger: makeLogger(), onebot: onebotStub, services });

  for (let round = 0; round < outcomes.length; round += 1) {
    await dispatcher.processMessage(messageOf('看看系统状态'), userOf());
  }
  await waitFor(() => results.length === outcomes.length);
  await sleep(20);

  assert.equal(turns.length, 2, '只有终态（done / failed）才写回上下文');
  assert.equal(turns[0].role, 'assistant', '这事算她自己做过的，角色按她说的话算');
  assert.equal(turns[0].scene, 'private');
  assert.equal(turns[0].userId, OWNER);
  assert.equal(turns[0].groupId, null);
  assert.ok(turns[0].content.includes('看看系统状态'), `摘要要带上目标：${turns[0].content.slice(0, 60)}`);
  assert.ok(turns[0].content.length <= 500, `摘要不许超过 500 字：${turns[0].content.length}`);
  assert.ok(turns[0].content.endsWith('…'), '超长要截断加省略号');
  assert.match(turns[1].content, /步数用尽/, '失败也要把原因写进去');
});

test('聊天里她自己去查：带工具的聊天环真的被用上，问过一次就接着办', async () => {
  const config = await makeConfig();
  const sends = [];
  const progressTexts = [];
  const ctxs = [];
  const builds = [];
  let session = { stage: 'idle' };
  const services = {
    llm: makeLLM({ mode: 'chat', reply: null, style: 'chat', needs_tools: false, sensitive: [], confidence: 0.9, reason: '测试' }),
    chat: {
      enabled: true,
      async run({ ctx }) {
        ctxs.push(ctx);
        // 第一次：要跑命令，被口令拦住；第二次（口令答完重跑）：真的查到了
        if (ctxs.length === 1) return { content: null, blocked: { tool: 'shell', replyText: '老规矩，说句「明月几时有」', stage: 'challenge' } };
        return { content: '看过了，今天是星期二。' };
      },
    },
    reply: {
      async progress(params) {
        progressTexts.push(params.text);
        return { sentMessages: 1, texts: [params.text] };
      },
      async send(params) {
        sends.push(params);
        return { sentMessages: 1, texts: [params.text] };
      },
      async result() {
        return {};
      },
    },
    context: {
      ...contextStub,
      async build(params) {
        builds.push(params);
        return { system: '人设', messages: [], meta: { hints: null, userText: '帮我跑个命令看看' } };
      },
    },
    tools: new Map(),
    tasks: createTaskRegistry({ logger: null }),
    security: {
      isAdmin: () => true,
      sessionState: () => session,
      async verify() {
        // 真守卫答对后就把质询会话删掉
        session = { stage: 'passed' };
        return { ok: true, stage: 'passed', replyText: '好' };
      },
    },
  };
  const dispatcher = createDispatcher({ config, logger: makeLogger(), onebot: onebotStub, services });

  await dispatcher.processMessage(messageOf('帮我跑个命令看看'), userOf());

  assert.equal(ctxs.length, 1, '聊天要走带工具的环');
  assert.equal(ctxs[0].requestText, '帮我跑个命令看看', '口令质询要带上用户原话');
  assert.equal(builds[0].tools, true, '带工具的聊天要在系统提示里写明手上有工具');
  assert.match(progressTexts.join('|'), /明月几时有/, '被拦住就把口令问话发出去');
  assert.equal(sends.length, 0, '没答口令之前不该给出「查到了」的答复');

  // 对方对口令：processMessage 第一步判定通过 → 重跑刚才那条，这次真的去查
  session = { stage: 'challenge', action: 'shell' };
  await dispatcher.processMessage(messageOf('明月几时有'), userOf());
  await waitFor(() => sends.length === 1);

  assert.equal(ctxs.length, 2, '口令通过后要重跑一次');
  assert.match(sends[0].text, /星期二/);
});

test('/任务 的步数用「轮次」口径：同一个 index 只算一步', async () => {
  const config = await makeConfig();
  const registry = createTaskRegistry({ logger: null });
  const task = registry.create({ goal: '整理文件清单', userId: OWNER, status: 'running', maxSteps: 4 });
  registry.addStep(task.id, { index: 1, tool: 'list_dir' });
  registry.addStep(task.id, { index: 1, tool: 'system_status' });
  assert.equal(task.steps.length, 2);
  assert.equal(task.rounds, 1, '并行调两个工具仍然只算一步');
  assert.equal(task.progress, 0.25, '进度也用轮次算');

  const reply = makeReply();
  const dispatcher = createDispatcher({
    config,
    logger: makeLogger(),
    onebot: onebotStub,
    services: { llm: makeLLM(workDecision('x')), reply, agent: { run: async () => null, cancel() {} }, context: contextStub, tools: new Map(), tasks: registry },
  });

  await dispatcher.processMessage(messageOf('/任务'), userOf());
  const text = reply.progressTexts.join('\n');
  assert.match(text, /整理文件清单/);
  assert.match(text, /走了 1 步/, `轮次口径不对：${text}`);
  assert.doesNotMatch(text, /走了 2 步/);
});
