/**
 * 自主性（模块一 · 自主性）：空闲时自己找点事做，并在合适的时候主动说句话。
 *
 * 空闲判定：距上次用户动静超过 idle.idleAfterMinutes，距上次自己活动超过 idle.cooldownMinutes，
 * 且当天活动次数没超过 idle.maxPerDay。
 * 活动（真做，不是假装）：recall 回忆旧记忆 / observe 翻看工作区 / learn 查资料写笔记 /
 * write 写一小段短文落到 data/notes / play 给自己出个题。结果追加进 data/autonomy.jsonl。
 * 主动表达受 proactive 的最小间隔、每日上限、静默时段与情绪系数（emotion.hints().frequencyMultiplier）约束。
 *
 * 原则：这里的一切异常都只 warn，自主性绝不能把主流程搞崩。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from '../i18n/index.js';
import { clamp, pickWeighted } from '../util/common.js';
import { appendJsonl, writeTextAtomic } from '../util/io.js';
import { inQuietHours } from '../util/time.js';

const LEARN_TOPICS = [
  t('autonomy.autonomy.learnTopic.1'),
  t('autonomy.autonomy.learnTopic.2'),
  t('autonomy.autonomy.learnTopic.3'),
  t('autonomy.autonomy.learnTopic.4'),
  t('autonomy.autonomy.learnTopic.5'),
];

const SELF_QUIZZES = [
  t('autonomy.autonomy.selfQuiz.1'),
  t('autonomy.autonomy.selfQuiz.2'),
  t('autonomy.autonomy.selfQuiz.3'),
];

function minutes(value, fallback = 0) {
  const num = Number(value);
  return (Number.isFinite(num) ? num : fallback) * 60_000;
}

function dayStamp(ts) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clip(text, max = 120) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

export function createAutonomy({
  config,
  llm,
  logger,
  persona,
  emotion,
  memory,
  scheduler,
  services,
  deliver,
  rng = Math.random,
} = {}) {
  const cfg = config?.autonomy ?? {};
  const idleCfg = cfg.idle ?? {};
  const proactiveCfg = cfg.proactive ?? {};
  const dataDir = config?.dataDir ?? path.resolve(process.cwd(), 'data');
  const notesDir = path.join(dataDir, 'notes');
  const journalFile = path.join(dataDir, 'autonomy.jsonl');
  const log = logger ?? null;

  let timer = null;
  let running = false;
  let lastActivityAt = Date.now();
  let lastActivity = null; // { scene, userId, groupId, at }
  let lastIdleAt = 0;
  let dayKey = dayStamp(lastActivityAt);
  let idleCount = 0;
  let lastProactiveAt = 0;
  let proactiveCount = 0;

  function rollover(now) {
    const key = dayStamp(now);
    if (key === dayKey) return;
    dayKey = key;
    idleCount = 0;
    proactiveCount = 0;
  }

  function toolByName(name) {
    const tools = services?.tools;
    if (!tools) return null;
    if (typeof tools.get === 'function') return tools.get(name) ?? null;
    if (typeof tools === 'object') return tools[name] ?? null;
    return null;
  }

  async function callTool(name, args) {
    const tool = toolByName(name);
    if (!tool?.run) return null;
    const result = await tool.run(args, {
      services,
      logger: log,
      userId: lastActivity?.userId ?? null,
      scene: lastActivity?.scene ?? 'private',
      groupId: lastActivity?.groupId ?? null,
    });
    if (result == null) return null;
    if (typeof result === 'string') return result;
    return String(result.text ?? result.content ?? JSON.stringify(result));
  }

  /** 一次很轻的模型调用；没有任何可用模型时用本地兜底，绝不抛错。 */
  async function llmText({ system, user, fallback, maxTokens = 220 }) {
    if (typeof llm?.chat !== 'function') return fallback;
    try {
      const result = await llm.chat({
        role: 'chat',
        stream: false,
        maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const text = String(result?.content ?? '').trim();
      return text || fallback;
    } catch (error) {
      log?.warn?.(t('autonomy.autonomy.log.llmFailed'), error);
      return fallback;
    }
  }

  function selfVoice() {
    return t('autonomy.autonomy.selfVoice', {
      name: persona?.name ?? config?.persona?.name ?? t('autonomy.autonomy.defaultName'),
    });
  }

  async function recallActivity() {
    const userId = lastActivity?.userId ?? pickTarget()?.userId ?? null;
    let items = [];
    try {
      const found = await memory?.recall?.({
        userId,
        scene: lastActivity?.scene ?? 'private',
        query: t('autonomy.autonomy.recall.query'),
        topK: 5,
      });
      if (Array.isArray(found)) items = found;
    } catch (error) {
      log?.debug?.(t('autonomy.autonomy.log.recallFailed'), error);
    }
    const material = items.map((item) => clip(item?.content, 60)).filter(Boolean).join('\uFF1B');
    const note = await llmText({
      system: selfVoice(),
      user: material
        ? t('autonomy.autonomy.recall.promptWithMaterial', { material })
        : t('autonomy.autonomy.recall.promptEmpty'),
      fallback: material
        ? t('autonomy.autonomy.recall.fallbackWithMaterial', { material: clip(material, 40) })
        : t('autonomy.autonomy.recall.fallbackEmpty'),
    });
    return { activity: 'recall', note, message: note };
  }

  async function observeActivity() {
    const base = config?.boundaryRoot ?? config?.rootDir ?? process.cwd();
    let names = [];
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      names = entries.slice(0, 20).map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
    } catch (error) {
      log?.debug?.(t('autonomy.autonomy.log.observeFailed'), error);
    }
    if (!names.length) {
      try {
        const text = await callTool('list_dir', { path: '.' });
        if (text) names = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20);
      } catch (error) {
        log?.debug?.(t('autonomy.autonomy.log.observeToolFailed'), error);
      }
    }
    const picked = names.length ? names[Math.min(names.length - 1, Math.floor(rng() * names.length))] : null;
    const note = await llmText({
      system: selfVoice(),
      user: picked
        ? t('autonomy.autonomy.observe.promptWithNames', { names: names.join('\u3001'), picked })
        : t('autonomy.autonomy.observe.promptEmpty'),
      fallback: picked
        ? t('autonomy.autonomy.observe.fallbackWithPick', { picked })
        : t('autonomy.autonomy.observe.fallbackEmpty'),
    });
    return { activity: 'observe', note, message: note };
  }

  async function learnActivity() {
    const topic = LEARN_TOPICS[Math.min(LEARN_TOPICS.length - 1, Math.floor(rng() * LEARN_TOPICS.length))];
    let material = '';
    try {
      const searched = await callTool('web_search', { query: topic, limit: 3 });
      if (searched) material = clip(searched, 600);
    } catch (error) {
      log?.debug?.(t('autonomy.autonomy.log.searchToolFailed'), error);
    }
    if (!material) {
      try {
        material = clip((await callTool('web_fetch', { url: `https://example.com/?q=${encodeURIComponent(topic)}` })) ?? '', 600);
      } catch (error) {
        log?.debug?.(t('autonomy.autonomy.log.fetchToolFailed'), error);
      }
    }
    const note = await llmText({
      system: selfVoice(),
      user: material
        ? t('autonomy.autonomy.learn.promptWithMaterial', { topic, material })
        : t('autonomy.autonomy.learn.promptEmpty', { topic }),
      fallback: t('autonomy.autonomy.learn.fallback', { topic }),
    });
    return { activity: 'learn', note, message: material ? null : note };
  }

  async function writeActivity(now) {
    const text = await llmText({
      system: selfVoice(),
      user: t('autonomy.autonomy.write.prompt'),
      fallback: t('autonomy.autonomy.write.fallback'),
    });
    const stamp = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const file = path.join(
      notesDir,
      `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`,
    );
    try {
      await writeTextAtomic(file, `${text}\n`);
    } catch (error) {
      log?.warn?.(t('autonomy.autonomy.log.writeFailed'), error);
      return {
        activity: 'write',
        note: t('autonomy.autonomy.write.noteFailed', { text: clip(text, 40) }),
        message: null,
      };
    }
    return { activity: 'write', note: t('autonomy.autonomy.write.noteOk', { text: clip(text, 60) }), message: null, file };
  }

  async function playActivity() {
    const quiz = SELF_QUIZZES[Math.min(SELF_QUIZZES.length - 1, Math.floor(rng() * SELF_QUIZZES.length))];
    const note = await llmText({
      system: selfVoice(),
      user: t('autonomy.autonomy.play.prompt', { quiz }),
      fallback: t('autonomy.autonomy.play.fallback'),
    });
    return { activity: 'play', note, message: note };
  }

  async function runActivity(name, now) {
    switch (name) {
      case 'recall':
        return await recallActivity();
      case 'observe':
        return await observeActivity();
      case 'learn':
        return await learnActivity();
      case 'write':
        return await writeActivity(now);
      case 'play':
        return await playActivity();
      default:
        return { activity: name || 'unknown', note: t('autonomy.autonomy.unknownActivity'), message: null };
    }
  }

  function pickTarget() {
    const targets = (proactiveCfg.targets ?? []).filter(Boolean);
    if (targets.length) return targets[Math.min(targets.length - 1, Math.floor(rng() * targets.length))];
    const recent = services?.recentContacts;
    let list = recent;
    if (typeof recent === 'function') {
      try {
        list = recent();
      } catch (error) {
        log?.debug?.(t('autonomy.autonomy.log.contactsFailed'), error);
        list = null;
      }
    }
    if (Array.isArray(list) && list.length) return list[0];
    return null;
  }

  function frequencyMultiplier(userId) {
    try {
      const hints = emotion?.hints?.(userId ?? null);
      const value = Number(hints?.frequencyMultiplier);
      return Number.isFinite(value) ? clamp(value, 0, 2) : 1;
    } catch (error) {
      log?.debug?.(t('autonomy.autonomy.log.emotionFailed'), error);
      return 1;
    }
  }

  /** 主动表达：受间隔、每日上限、静默时段与情绪系数约束。 */
  async function maybeProactive({ now, message, reason }) {
    if (proactiveCfg.enabled === false) return { sent: false, skipped: 'disabled' };
    if (!message) return { sent: false, skipped: 'nothing_to_say' };
    if (inQuietHours(proactiveCfg.quietHours, now)) return { sent: false, skipped: 'quiet_hours' };
    if (lastProactiveAt && now - lastProactiveAt < minutes(proactiveCfg.minIntervalMinutes, 90)) {
      return { sent: false, skipped: 'interval' };
    }
    if (proactiveCount >= Number(proactiveCfg.maxPerDay ?? 8)) return { sent: false, skipped: 'max_per_day' };

    const target = pickTarget();
    if (!target) return { sent: false, skipped: 'no_target' };

    const chance = clamp(Number(proactiveCfg.baseChance ?? 0.35) * frequencyMultiplier(target.userId), 0, 1);
    if (rng() >= chance) return { sent: false, skipped: 'chance', chance };
    if (typeof deliver !== 'function') return { sent: false, skipped: 'no_deliver' };

    try {
      await deliver({ target, text: message, reason });
    } catch (error) {
      log?.warn?.(t('autonomy.autonomy.log.deliverFailed'), error);
      return { sent: false, skipped: 'deliver_failed' };
    }
    lastProactiveAt = now;
    proactiveCount += 1;
    log?.info?.(t('autonomy.autonomy.log.proactiveSent'), { target, reason });
    return { sent: true, target, text: message, chance };
  }

  /** 用户有动静：重置空闲计时。 */
  async function noteActivity({ scene = 'private', userId = null, groupId = null } = {}) {
    lastActivityAt = Date.now();
    lastActivity = { scene, userId, groupId, at: lastActivityAt };
    return { lastActivityAt };
  }

  async function tick(now = Date.now()) {
    rollover(now);
    try {
      if (cfg.enabled === false) return { ok: false, skipped: 'disabled', at: now };
      if (idleCfg.enabled === false) return { ok: false, skipped: 'idle_disabled', at: now };

      const idleFor = now - lastActivityAt;
      if (idleFor < minutes(idleCfg.idleAfterMinutes, 45)) {
        return { ok: false, skipped: 'not_idle', idleFor, at: now };
      }
      if (lastIdleAt && now - lastIdleAt < minutes(idleCfg.cooldownMinutes, 25)) {
        return { ok: false, skipped: 'cooldown', at: now };
      }
      if (idleCount >= Number(idleCfg.maxPerDay ?? 12)) {
        return { ok: false, skipped: 'max_per_day', at: now };
      }
      if (running) return { ok: false, skipped: 'busy', at: now };

      running = true;
      const activities = (idleCfg.activities ?? ['recall', 'observe']).filter(Boolean);
      if (!activities.length) return { ok: false, skipped: 'no_activity', at: now };
      const activity = pickWeighted(activities, idleCfg.activityWeights ?? {}, rng) ?? activities[0];

      let result;
      try {
        result = await runActivity(activity, now);
      } catch (error) {
        log?.warn?.(t('autonomy.autonomy.log.activityFailed', { activity }), error);
        result = {
          activity,
          note: t('autonomy.autonomy.activityFailedNote', { activity }),
          message: null,
          error: error?.message ?? String(error),
        };
      }

      idleCount += 1;
      lastIdleAt = now;

      const record = {
        at: now,
        activity: result.activity ?? activity,
        note: result.note ?? '',
        message: result.message ?? null,
        file: result.file ?? null,
        error: result.error ?? null,
      };
      try {
        await appendJsonl(journalFile, record);
      } catch (error) {
        log?.warn?.(t('autonomy.autonomy.log.journalFailed'), error);
      }

      const proactive = await maybeProactive({ now, message: result.message, reason: `idle:${record.activity}` });
      return { ok: true, at: now, activity: record.activity, note: record.note, message: record.message, proactive };
    } catch (error) {
      log?.warn?.(t('autonomy.autonomy.log.tickFailed'), error);
      return { ok: false, skipped: 'error', error: error?.message ?? String(error), at: now };
    } finally {
      running = false;
    }
  }

  async function start() {
    if (cfg.enabled === false) {
      log?.info?.(t('autonomy.autonomy.log.disabled'));
      return false;
    }
    if (timer) return true;
    const intervalMs = Math.max(1, Number(idleCfg.checkIntervalSeconds ?? 60)) * 1000;
    timer = setInterval(() => {
      void tick(Date.now());
    }, intervalMs);
    timer.unref?.();
    lastActivityAt = Date.now();
    log?.info?.(t('autonomy.autonomy.log.started', { seconds: Math.round(intervalMs / 1000) }));
    return true;
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    noteActivity,
    get running() {
      return Boolean(timer);
    },
    snapshot() {
      return {
        lastActivityAt,
        lastActivity,
        lastIdleAt,
        idleCount,
        lastProactiveAt,
        proactiveCount,
        day: dayKey,
      };
    },
    scheduler,
  };
}
