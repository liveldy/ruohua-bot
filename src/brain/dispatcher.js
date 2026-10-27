/**
 * 分发器：一条消息从进来到出去，全在这条链上。
 *
 *   过滤/门槛 → 记录 → 可疑行为检测（安全） → 情感与记忆 → 上下文组装
 *   → 决策（指令 / 闲聊 / 传统工作 / agent 工作） → 执行 → 回复
 *   → 复盘（情绪判定、记忆沉淀、好感度变化）
 *
 * 工作类任务在当前会话之外自己跑，不阻塞后续对话：可以边干活边聊天、问进度、喊停。
 */

import { conversationKeyOf, quotesSelf, textSegment } from '../onebot/segments.js';
import { decide } from './decision.js';
import { taskFactsNote } from './context.js';
import { sentExtrasNote } from './reply.js';
import { judgeEmotion } from '../emotion/judge.js';
import { restyle } from '../persona/style.js';
import { parseTimeSpec } from '../util/time.js';
import { stripMarkdown, truncate } from '../util/text.js';
import { sleep } from '../util/common.js';
import { t } from '../i18n/index.js';

const HELP_TEXT = t('brain.dispatcher.help');

// 任务状态与开工应答的句子按变量选，写成映射表（见 docs/I18N.md 第 1 节）
const TASK_STATE = {
  running: t('brain.dispatcher.taskState.running'),
  waiting: t('brain.dispatcher.taskState.waiting'),
};

const ACKS = {
  agent: t('brain.dispatcher.ack.agent').split('\n'),
  work: t('brain.dispatcher.ack.work').split('\n'),
};

/** 任务摘要写回上下文时的字数上限，超了截断加省略号。 */
const TASK_SUMMARY_LIMIT = 500;

export function createDispatcher({ config, logger, onebot, services = {}, rng = Math.random } = {}) {
  const childLog = logger?.child ? logger.child('dispatcher') : logger;
  const behavior = config.bot.behavior ?? {};
  const blacklist = new Set((behavior.blacklist ?? []).map(String));
  const activeConversations = new Map();
  const pendingAuthorizations = new Map();
  const stats = { received: 0, handled: 0, replied: 0, chats: 0, works: 0, agentTasks: 0, skipped: 0, commands: 0, errors: 0 };
  let running = 0;
  const waitQueue = [];

  function acquire() {
    const limit = Math.max(1, behavior.maxConcurrentReplies ?? 4);
    if (running < limit) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waitQueue.push(() => {
      running += 1;
      resolve();
    }));
  }

  function release() {
    running = Math.max(0, running - 1);
    const next = waitQueue.shift();
    if (next) next();
  }

  /** 同一会话内的处理串行，避免同一群里两条消息抢着回复。 */
  function enqueue(key, task) {
    const previous = activeConversations.get(key) ?? Promise.resolve();
    const next = previous.then(task, task).catch((error) => {
      childLog?.error?.(t('brain.dispatcher.conversationFailed'), error);
      stats.errors += 1;
    });
    activeConversations.set(key, next.finally(() => {
      if (activeConversations.get(key) === next) activeConversations.delete(key);
    }));
    return next;
  }

  function roleOf(userId) {
    try {
      return services.security?.isAdmin?.(userId) ? 'owner' : 'member';
    } catch {
      return 'member';
    }
  }

  /** 管理员判定：优先问 security，没接 security 时按 config.security.admins 认。 */
  function isAdmin(userId) {
    if (roleOf(userId) === 'owner') return true;
    return (config.security?.admins ?? []).map(String).includes(String(userId));
  }

  function shouldHandle(message) {
    const { scene, userId, groupId, selfId } = message;
    if (behavior.ignoreSelf !== false && selfId && userId === selfId) return { ok: false, why: 'self' };
    if (blacklist.has(String(userId))) return { ok: false, why: 'blacklist' };
    if (scene === 'group') {
      const whitelist = (behavior.groupWhitelist ?? []).map(String);
      if (whitelist.length && !whitelist.includes(String(groupId))) return { ok: false, why: 'group_not_allowed' };
      if (behavior.groupRequireAt !== false && !message.isAt) {
        // 引用机器人自己发的消息，等同于在跟机器人说话（behavior.replyToBotCountsAsAt 可关）
        const quotedBot = behavior.replyToBotCountsAsAt !== false && quotesSelf(message.quoted, selfId);
        const name = config.persona.name ?? '';
        if (!quotedBot && (!name || !message.text.includes(name))) return { ok: false, why: 'no_at' };
      }
      return { ok: true };
    }
    const whitelist = (behavior.privateWhitelist ?? []).map(String);
    if (whitelist.length && !whitelist.includes(String(userId))) return { ok: false, why: 'private_not_allowed' };
    if (behavior.privateAutoReply === false && roleOf(userId) !== 'owner') return { ok: false, why: 'private_disabled' };
    if (behavior.replyToUnknownPrivate === false && roleOf(userId) !== 'owner') return { ok: false, why: 'unknown_private' };
    return { ok: true };
  }

  function makeChat(message, user) {
    return {
      scene: message.scene,
      userId: user.userId,
      groupId: message.groupId,
      sendTo: (target, content) =>
        onebot.sendTo({ scene: target.scene ?? message.scene, userId: target.userId ?? user.userId, groupId: target.groupId ?? message.groupId }, content),
      uploadFile: ({ file, name }) =>
        onebot.uploadFile({ scene: message.scene, userId: user.userId, groupId: message.groupId, file, name }),
    };
  }

  function syntheticMessage(target, text) {
    const scene = target.scene ?? (target.groupId ? 'group' : 'private');
    return {
      messageId: null,
      time: Date.now(),
      selfId: onebot.loginInfo?.()?.user_id ?? 0,
      scene,
      userId: Number(target.userId ?? 0),
      groupId: scene === 'group' ? Number(target.groupId ?? 0) : null,
      sender: { userId: Number(target.userId ?? 0), nickname: t('brain.dispatcher.scheduleSender'), card: null, role: null },
      segments: [textSegment(text)],
      text,
      quoted: null,
      display: text,
      images: [],
      faces: [],
      files: [],
      records: [],
      isAt: scene === 'group',
      raw: {},
      synthetic: true,
    };
  }

  /** 走完整大脑：给一句话，拿到回复（定时任务、主动发言都用它）。 */
  async function runPrompt({ target, prompt, user = null, mode = null, quiet = false }) {
    const message = syntheticMessage(target, prompt);
    const resolvedUser = user ?? { userId: message.userId, nickname: message.sender.nickname, role: roleOf(message.userId), scene: message.scene, groupId: message.groupId };
    const chat = makeChat(message, resolvedUser);

    let decision = null;
    if (mode) {
      decision = { mode, goal: prompt, style: mode === 'chat' ? 'chat' : 'work', needsTools: mode !== 'chat', sensitive: [], reply: null, confidence: 1, reason: 'forced' };
    } else {
      decision = await decide({ llm: services.llm, config, message, user: resolvedUser, scene: message.scene, tools: services.tools, logger: childLog });
    }

    if (decision.mode === 'chat') {
      const context = await services.context.build({
        message,
        user: resolvedUser,
        scene: message.scene,
        mode: 'chat',
        extraNote: taskFactsNote({ tasks: services.tasks, userId: resolvedUser.userId }),
        sticker: services.sticker ?? null,
        tools: services.chat?.enabled === true,
      });
      const outcome = await chatOnce({
        messages: context.messages,
        ctx: { userId: resolvedUser.userId, scene: message.scene, groupId: message.groupId, message, requestText: prompt },
      });
      const text = decision.reply || outcome.content || '';
      if (!quiet && text) await services.reply.send({ chat, text, hints: context.meta.hints, skipExpression: true });
      await services.context.addTurn({ scene: message.scene, userId: resolvedUser.userId, groupId: message.groupId, role: 'assistant', content: text, name: config.persona.name });
      return { mode: 'chat', text };
    }

    const task = await services.agent.run({
      goal: decision.goal ?? prompt,
      userId: resolvedUser.userId,
      scene: message.scene,
      groupId: message.groupId,
    });
    if (!quiet) {
      const text = task.result ?? t('brain.dispatcher.resultFailed', { reason: task.error ?? t('brain.dispatcher.unknownReason') });
      await services.reply.result({ chat, text, mode: 'agent' });
    }
    return { mode: 'agent', text: task.result ?? '', taskId: task.id };
  }

  async function handleCommand({ command, message, user, chat }) {
    stats.commands += 1;
    const ownerOnly = ['forget', 'reset', 'schedule', 'remember', 'selfcheck'];
    if (ownerOnly.includes(command.name) && user.role !== 'owner') {
      const text = restyle(t('brain.dispatcher.commandDenied'), { persona: config.persona });
      await services.reply.progress({ chat, text });
      return { handled: true, denied: true };
    }

    switch (command.name) {
      case 'status': {
        const text = await services.status.report();
        await services.reply.progress({ chat, text });
        break;
      }
      case 'tasks': {
        const list = services.tasks.list({ userId: user.userId, activeOnly: true });
        const text = list.length
          ? list
              .map((task) => {
                // 步数口径统一成「轮次」：同一个 index 只算一步（一步里并行调两个工具也是一步）
                const steps = task.rounds ?? task.steps?.length ?? 0;
                const state =
                  task.status === 'running' ? TASK_STATE.running : task.status === 'waiting' ? TASK_STATE.waiting : task.status;
                return t('brain.dispatcher.taskLine', { goal: truncate(String(task.goal ?? ''), 30), state, steps });
              })
              .join('\n')
          : t('brain.dispatcher.tasksEmpty');
        await services.reply.progress({ chat, text });
        break;
      }
      case 'stop': {
        const list = services.tasks.list({ userId: user.userId, activeOnly: true });
        list.forEach((task) => services.agent.cancel(task.id));
        await services.reply.progress({ chat, text: list.length ? t('brain.dispatcher.stop.done', { count: list.length }) : t('brain.dispatcher.stop.none') });
        break;
      }
      case 'forget': {
        const records = services.memory.list(user.userId);
        for (const record of records) await services.memory.forget({ id: record.id });
        await services.context.clear({ scene: message.scene, userId: user.userId, groupId: message.groupId });
        await services.reply.progress({ chat, text: t('brain.dispatcher.forget.done', { count: records.length }) });
        break;
      }
      case 'reset': {
        await services.context.clear({ scene: message.scene, userId: user.userId, groupId: message.groupId });
        await services.reply.progress({ chat, text: t('brain.dispatcher.reset.done') });
        break;
      }
      case 'remember': {
        if (!command.args) {
          await services.reply.progress({ chat, text: t('brain.dispatcher.remember.empty') });
          break;
        }
        await services.memory.remember({ userId: user.userId, scene: message.scene, content: command.args, kind: 'permanent', importance: 0.9, tags: [t('brain.dispatcher.remember.tag')] });
        await services.reply.progress({ chat, text: t('brain.dispatcher.remember.done') });
        break;
      }
      case 'schedule': {
        const spec = parseTimeSpec(command.args.split(/\s+/)[0]);
        const prompt = command.args.split(/\s+/).slice(1).join(' ').trim();
        if (!spec || !prompt) {
          await services.reply.progress({ chat, text: t('brain.dispatcher.schedule.hint') });
          break;
        }
        const task = services.scheduler.create({
          name: truncate(prompt, 20),
          when: command.args.split(/\s+/)[0],
          target: { scene: message.scene, userId: user.userId, groupId: message.groupId },
          prompt,
        });
        await services.reply.progress({ chat, text: t('brain.dispatcher.schedule.done', { name: task.name }) });
        break;
      }
      case 'selfcheck': {
        const report = await services.selfcheck.run({ offline: config.offline });
        await services.reply.progress({ chat, text: report.summary });
        break;
      }
      case 'help':
      default:
        await services.reply.progress({ chat, text: HELP_TEXT });
    }
    return { handled: true };
  }

  /**
   * 走一次「带工具的聊天」：她能自己去查（文件、系统、联网）。
   * 工具这边出任何问题都退回一次普通对话 —— 查不了不等于不能说话。
   */
  async function chatOnce({ messages, ctx }) {
    const loop = services.chat;
    if (loop?.enabled) {
      let outcome = null;
      try {
        outcome = await loop.run({ messages, ctx });
      } catch (error) {
        childLog?.warn?.(t('brain.dispatcher.chatToolsFailed'), error);
      }
      if (outcome?.blocked) return { blocked: outcome.blocked, content: null };
      if (typeof outcome?.content === 'string' && outcome.content.trim()) return { content: outcome.content };
      if (outcome?.error) childLog?.debug?.(t('brain.dispatcher.chatToolsFailed'), outcome.error);
    }
    const result = await services.llm.chat({ messages, role: 'chat' });
    return { content: result.content };
  }

  async function chatReply({ message, user, chat, decision }) {
    stats.chats += 1;
    // 手头在跑的任务当成系统事实喂进去：没有就说没有，别让模型自己编
    const context = await services.context.build({
      message,
      user,
      scene: message.scene,
      mode: 'chat',
      extraNote: taskFactsNote({ tasks: services.tasks, userId: user.userId }),
      sticker: services.sticker ?? null,
      tools: services.chat?.enabled === true,
    });
    const hints = context.meta.hints;

    // 情绪会改回复概率：生气、疲惫时可能不想理
    const chance = hints?.replyChance ?? 1;
    if (message.scene === 'group' && chance < 1 && rng() > chance) {
      childLog?.debug?.(t('brain.dispatcher.skipByMood', { chance }), { userId: user.userId });
      stats.skipped += 1;
      return { replied: false };
    }

    let content = decision.reply ?? '';
    let blocked = null;
    if (!content) {
      const outcome = await chatOnce({
        messages: context.messages,
        ctx: {
          userId: user.userId,
          scene: message.scene,
          groupId: message.groupId,
          message,
          requestText: message.text ?? null,
        },
      });
      content = outcome.content ?? '';
      blocked = outcome.blocked ?? null;
    }

    // 要动敏感工具、被口令拦住了：把问话发出去，记住这轮等口令答完接着办
    if (blocked) {
      if (blocked.replyText) await services.reply.progress({ chat, text: blocked.replyText });
      pendingAuthorizations.set(user.userId, { message, user, what: blocked.tool ?? null });
      await services.context.addTurn({
        scene: message.scene,
        userId: user.userId,
        groupId: message.groupId,
        role: 'user',
        content: context.meta?.userText ?? String(message.display ?? message.text ?? ''),
        name: message.sender.nickname,
      });
      logger?.operation?.({ actor: user.userId, action: 'chat_sensitive', ok: false, detail: { tool: blocked.tool ?? null, stage: blocked.stage ?? null } });
      return { replied: false, blocked: true };
    }

    const sent = await services.reply.send({ chat, text: content, hints, message });
    stats.replied += 1;

    await services.context.addTurn({ scene: message.scene, userId: user.userId, groupId: message.groupId, role: 'user', content: context.meta?.userText ?? String(message.display ?? message.text ?? ''), name: message.sender.nickname });
    // 表情包 / 表情是另走一条路发的：不写回来，她事后就不知道自己发过（真机那句「我发图了吗」）
    await services.context.addTurn({
      scene: message.scene,
      userId: user.userId,
      groupId: message.groupId,
      role: 'assistant',
      content: `${content}${sentExtrasNote(sent?.extras)}`,
      name: config.persona.name,
    });
    return { replied: true, sent };
  }

  async function startWork({ message, user, chat, decision }) {
    stats.works += 1;
    if (decision.mode === 'agent') stats.agentTasks += 1;
    const acks = decision.mode === 'agent' ? ACKS.agent : ACKS.work;
    const ack = restyle(acks[Math.floor(rng() * acks.length)], { persona: config.persona });
    await services.reply.progress({ chat, text: ack });

    const goal = decision.goal ?? message.display ?? message.text;
    // work 模式是「说一步做一步」，但一步就是一次工具调用，3 步连一次状态汇报都收不了尾；
    // 用单独的 config.agent.workMaxSteps（默认 8），与 config/agent.json、DEFAULTS.agent 保持一致。agent 模式照旧走 maxSteps。
    const maxSteps =
      decision.mode === 'agent'
        ? Number(config.agent.maxSteps ?? 24)
        : Number(config.agent.workMaxSteps ?? 8) || 8;

    const promise = services.agent
      .run({
        goal,
        userId: user.userId,
        scene: message.scene,
        groupId: message.groupId,
        maxSteps,
        onProgress: async (task, note) => {
          if (config.agent.reportProgress === false || !note) return;
          try {
            await services.reply.progress({ chat, text: truncate(stripMarkdown(String(note)), 120) });
          } catch (error) {
            childLog?.debug?.(t('brain.dispatcher.progressFailed'), error);
          }
        },
      })
      .then(async (task) => {
        const waiting = task.status === 'waiting';
        // 卡在验证上的那种要留着：等对方把暗号答上来还要接着办
        const waitingForAuth =
          waiting &&
          (task.waitReason === 'authorization' ||
            /verif/i.test(String(task.steps?.at(-1)?.error ?? task.error ?? '')));
        const text =
          task.status === 'cancelled'
            ? t('brain.dispatcher.cancelled')
            : task.result
              ? String(task.result)
              : t('brain.dispatcher.resultFailed', { reason: task.error ?? t('brain.dispatcher.unknownReason') });
        if (waitingForAuth) {
          pendingAuthorizations.set(user.userId, { message, user, taskId: task.id });
        }
        // agent/work 的最终结果走技术通道：不规整标点、不带表情
        await services.reply.result({ chat, text, mode: decision.mode === 'agent' ? 'agent' : 'work' });
        stats.replied += 1;
        await rememberTaskOutcome({ task, goal, message, user });
        logger?.operation?.({
          actor: 'ruohua',
          action: 'task_report',
          target: task.id,
          // 只有真失败(tool/模型没做成)才算 not ok；waiting / cancelled 不是失败
          ok: task.status !== 'failed',
          detail: { goal: truncate(goal, 80), status: task.status },
        });
      })
      .catch(async (error) => {
        childLog?.error?.(t('brain.dispatcher.taskFailed'), error);
        stats.errors += 1;
        await services.reply.send({ chat, text: t('brain.dispatcher.gaveUp') }).catch(() => {});
      });

    // 不 await：任务在后台跑，期间照常聊天
    void promise;
    return { started: true };
  }

  /**
   * 任务收尾后，把一句摘要记回发起它的那次对话：这件事是她自己做过的，下一轮她得记得。
   * 只记终态（done / failed）；还在跑的任务不往上下文里塞中间结果。
   */
  async function rememberTaskOutcome({ task, goal, message, user }) {
    if (!services.context?.addTurn) return null;
    if (task?.status !== 'done' && task?.status !== 'failed') return null;
    const result = String(task.result ?? task.error ?? '').trim() || t('brain.dispatcher.unknownReason');
    const summary = truncate(t('brain.dispatcher.taskSummary', { goal: truncate(String(goal ?? ''), 60), result }), TASK_SUMMARY_LIMIT);
    try {
      await services.context.addTurn({
        scene: message.scene,
        userId: user.userId,
        groupId: message.groupId,
        role: 'assistant',
        content: summary,
        name: config.persona.name,
      });
    } catch (error) {
      childLog?.debug?.(t('brain.dispatcher.taskSummaryFailed'), error);
      return null;
    }
    return summary;
  }

  /**
   * 收到表情包：管理员发的存进库，别人发的只记个印象。
   * 放在门槛之前（群里没 @ 机器人也学得到），并且不许它影响消息链路。
   */
  async function noteSticker(message) {
    const sticker = services.sticker;
    if (!sticker || sticker.enabled === false) return null;
    try {
      if (isAdmin(message.userId)) {
        const learned = await sticker.observe?.(message, { byAdmin: true });
        if (learned?.saved) {
          logger?.operation?.({ actor: message.userId, action: 'sticker_learn', ok: true, detail: { saved: learned.saved } });
        }
        return learned ?? null;
      }
      sticker.note?.(message);
      return null;
    } catch (error) {
      childLog?.debug?.(t('brain.dispatcher.stickerFailed'), error);
      return null;
    }
  }

  /** 回复之后的复盘：情绪、好感度、记忆。 */
  async function review({ message, user, replyText }) {
    let verdict = null;
    try {
      verdict = await judgeEmotion({
        llm: services.llm,
        persona: config.persona,
        config,
        deltaTable: config.emotion?.deltas,
        message: message.display ?? message.text,
        reply: replyText ?? '',
        history: await services.context.recent({ scene: message.scene, userId: user.userId, groupId: message.groupId }, 6),
      });
    } catch (error) {
      childLog?.debug?.(t('brain.dispatcher.emotionJudgeFailed'), error);
    }

    if (services.emotion) {
      try {
        if (verdict?.mood) {
          const minutes = config.emotion.mood?.moodDurationMinutes?.[verdict.mood] ?? config.emotion.mood?.decayMinutes ?? 90;
          await services.emotion.setMood(user.userId, verdict.mood, minutes);
        }
        await services.emotion.apply(user.userId, {
          event: verdict?.event ?? 'chat',
          delta: Number(verdict?.delta ?? 0),
          note: verdict?.reason ?? null,
        });
        await services.emotion.save();
      } catch (error) {
        childLog?.warn?.(t('brain.dispatcher.emotionUpdateFailed'), error);
      }
    }

    if (services.memory && config.memory?.enabled !== false) {
      try {
        await services.memory.ingest({
          userId: user.userId,
          scene: message.scene,
          messages: [
            { role: 'user', content: message.display ?? message.text, name: message.sender.nickname },
            { role: 'assistant', content: replyText ?? '', name: config.persona.name },
          ],
          hint: { importance: verdict?.importance ?? null },
        });
      } catch (error) {
        childLog?.warn?.(t('brain.dispatcher.memoryIngestFailed'), error);
      }
    }
  }

  async function processMessage(message, user, options = {}) {
    const chat = makeChat(message, user);
    const key = conversationKeyOf(message);

    // 1) 有未答的口令：先把这句当回答判一次
    if (services.security?.sessionState) {
      try {
        const session = services.security.sessionState(user.userId);
        if (session?.stage === 'challenge') {
          const verdict = await services.security.verify({
            userId: user.userId,
            scene: message.scene,
            groupId: message.groupId,
            action: session.action ?? 'unknown',
            message,
          });
          if (verdict.stage === 'challenge') {
            if (verdict.replyText) await services.reply.progress({ chat, text: verdict.replyText });
            return { verified: false };
          }
          if (verdict.stage !== 'passed') {
            if (verdict.stage === 'denied' || verdict.stage === 'expired') pendingAuthorizations.delete(user.userId);
            await services.reply.progress({ chat, text: verdict.replyText ?? t('brain.dispatcher.verdictGiveUp') });
            logger?.operation?.({ actor: user.userId, action: 'passphrase', ok: false, detail: { stage: verdict.stage } });
            return { verified: false };
          }
          logger?.operation?.({ actor: user.userId, action: 'passphrase', ok: true });
          const pending = pendingAuthorizations.get(user.userId);
          pendingAuthorizations.delete(user.userId);
          if (pending?.message) {
            await services.reply.progress({ chat, text: t('brain.dispatcher.resumePending') });
            return processMessage(pending.message, pending.user, { authorized: true });
          }
          await services.reply.progress({ chat, text: t('brain.dispatcher.awaitAnswer') });
          return { verified: true };
        }
      } catch (error) {
        childLog?.warn?.(t('brain.dispatcher.passphraseFailed'), error);
      }
    }

    // 2) 决策
    //    上一轮问过对方一句话、任务还挂在「等你回话」的，先收掉，别越积越多
    //    例外：正在等暗号（waitReason === 'authorization'）或刚记进 pendingAuthorizations 的那条，
    //    答对之后还要接着办，绝不收。
    try {
      const pendingTaskIds = new Set([...pendingAuthorizations.values()].map((item) => item.taskId).filter(Boolean));
      const waiting =
        services.tasks
          ?.list?.({ userId: user.userId, activeOnly: true })
          ?.filter((task) => task.status === 'waiting') ?? [];
      for (const task of waiting) {
        if (task.waitReason === 'authorization' || pendingTaskIds.has(task.id)) {
          childLog?.debug?.(t('brain.dispatcher.keepWaiting', { id: task.id }));
          continue;
        }
        services.tasks.finish(task.id, { status: 'cancelled', error: t('brain.dispatcher.superseded') });
        childLog?.debug?.(t('brain.dispatcher.dropWaiting', { id: task.id }));
      }
    } catch (error) {
      childLog?.debug?.(t('brain.dispatcher.dropWaitingFailed'), error);
    }

    let decision = null;
    try {
      decision = await decide({
        llm: services.llm,
        config,
        message,
        user,
        scene: message.scene,
        tools: services.tools,
        logger: childLog,
        extraNote: taskFactsNote({ tasks: services.tasks, userId: user.userId }),
      });
    } catch (error) {
      childLog?.error?.(t('brain.dispatcher.decisionError'), error);
      stats.errors += 1;
      decision = { mode: 'chat', goal: null, reply: null, style: 'chat', sensitive: [], confidence: 0.2, reason: 'error', tool: null };
      await services.reply.progress({ chat, text: t('brain.dispatcher.decisionFailed') }).catch(() => {});
      return { error: true };
    }

    // 3) 敏感操作不在这里预检：
    //    decision.sensitive 只是模型自报的猜测（19:15 只是要个状态汇报、19:29 只是要识图，都被它撞上过暗号）。
    //    真正的防线在 runner 执行 sensitive 工具之前那次 security.verify，口令只在真要动敏感工具时出现。
    //    options.authorized（口令通过后重跑那次）照旧保留：重跑直接进执行链，由 security 的频率窗口决定不再质询。

    // 4) 执行
    if (decision.mode === 'command' && decision.command) {
      return handleCommand({ command: decision.command, message, user, chat });
    }
    if (decision.mode === 'work' || decision.mode === 'agent') {
      const result = await startWork({ message, user, chat, decision });
      await review({ message, user, replyText: '' });
      return result;
    }

    const result = await chatReply({ message, user, chat, decision });
    if (result.replied) await review({ message, user, replyText: result.sent?.texts?.join('') ?? '' });
    return result;
  }

  async function handleMessage(message) {
    stats.received += 1;
    if (!message) return null;
    // 表情包先过一遍：管理员发的入库，别人发的只记印象。这一步只学不回复，也不占回复的并发额度
    await noteSticker(message);
    const gate = shouldHandle(message);
    if (!gate.ok) {
      childLog?.debug?.(t('brain.dispatcher.skipMessage', { why: gate.why }), { userId: message.userId, groupId: message.groupId });
      stats.skipped += 1;
      return null;
    }

    const role = roleOf(message.userId);
    const user = {
      userId: message.userId,
      nickname: message.sender?.card || message.sender?.nickname || String(message.userId),
      role,
      scene: message.scene,
      groupId: message.groupId,
    };

    logger?.conversation?.({
      scene: message.scene,
      userId: message.userId,
      groupId: message.groupId,
      direction: 'in',
      text: message.display || message.text,
      name: user.nickname,
      meta: { role, messageId: message.messageId },
    });

    if (services.security?.noteMessage) {
      try {
        const verdict = await services.security.noteMessage({
          userId: message.userId,
          scene: message.scene,
          groupId: message.groupId,
          text: message.display || message.text,
          message,
        });
        if (verdict?.alerted) {
          logger?.operation?.({ actor: message.userId, action: 'suspicion_alert', ok: true, detail: { suspicion: verdict.suspicion, reasons: verdict.reasons } });
        }
      } catch (error) {
        childLog?.warn?.(t('brain.dispatcher.suspicionFailed'), error);
      }
    }

    services.autonomy?.noteActivity?.({ scene: message.scene, userId: message.userId, groupId: message.groupId });

    await acquire();
    try {
      stats.handled += 1;
      return await enqueue(conversationKeyOf(message), () => processMessage(message, user));
    } finally {
      release();
    }
  }

  async function handleNotice(notice) {
    if (!notice) return null;
    childLog?.debug?.(t('brain.dispatcher.noticeEvent', { type: notice.notice_type ?? 'unknown' }), { userId: notice.user_id, groupId: notice.group_id });
    return null;
  }

  /** 主动/定时发言统一出口。 */
  async function speak({ target, text, reason = null }) {
    const chat = {
      scene: target.scene ?? (target.groupId ? 'group' : 'private'),
      userId: target.userId ?? null,
      groupId: target.groupId ?? null,
      sendTo: (t, content) => onebot.sendTo({ scene: t.scene ?? target.scene, userId: t.userId ?? target.userId, groupId: t.groupId ?? target.groupId ?? null }, content),
      uploadFile: ({ file, name }) => onebot.uploadFile({ scene: target.scene, userId: target.userId, groupId: target.groupId, file, name }),
    };
    const hints = services.emotion?.hints?.(target.userId) ?? null;
    const result = await services.reply.send({ chat, text: restyle(text, { persona: config.persona }), hints, skipExpression: false });
    logger?.operation?.({ actor: 'ruohua', action: 'proactive_speak', target: String(target.userId ?? target.groupId), ok: true, detail: { reason } });
    return result;
  }

  return {
    handleMessage,
    handleNotice,
    handleCommand,
    processMessage,
    runPrompt,
    speak,
    shouldHandle,
    stats: () => ({ ...stats, running, waiting: waitQueue.length, conversations: activeConversations.size }),
    waitForIdle: async () => {
      while (activeConversations.size) {
        await Promise.allSettled([...activeConversations.values()]);
        await sleep(10);
        if (running === 0 && waitQueue.length === 0 && activeConversations.size === 0) break;
      }
    },
  };
}
