/**
 * 状态汇报（模块四 · 系统）：把运行情况说成一段能直接发进聊天软件的中文文本。
 * 注意：不用 Markdown 表格，只用短句加换行 —— 聊天窗口不渲染 Markdown。
 *
 * 写作纪律：**每一句都得有真实取到的值撑着**。取不到就写「查不到」，
 * 不许推测、不许形容、不许把「构造这个汇报的时间」当成启动时间报出去。
 */

import { t } from '../i18n/index.js';
import { formatDuration, formatTime } from '../util/time.js';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 真实存在且能当数字用的值；拿不到返回 null（宁缺毋造）。 */
function realNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function safe(fn, fallback = null) {
  try {
    const result = await fn();
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

export function createStatusReporter({ config, logger, services = {} } = {}) {
  const createdAt = Date.now();
  const log = logger ?? null;

  async function report() {
    const llm = services.llm ?? null;
    const hasStartedAt = realNumber(services.startedAt) !== null;
    const startedAt = num(services.startedAt, createdAt);
    const now = Date.now();
    const lines = [];

    lines.push(
      t('system.status.header', {
        name: config?.bot?.name ?? t('system.status.defaultName'),
        time: formatTime(now),
      }),
    );
    // 启动时间只认传进来的那个值：没有就说查不到，不能拿本函数的创建时间顶替
    lines.push(
      hasStartedAt
        ? t('system.status.startedAt', { time: formatTime(startedAt) })
        : t('system.status.startedAtUnknown'),
    );
    lines.push(
      hasStartedAt
        ? t('system.status.uptime', { duration: formatDuration(now - startedAt) })
        : t('system.status.uptimeUnknown'),
    );

    // 模型
    const modelName = llm?.modelName ?? config?.model?.model ?? null;
    const baseUrl = llm?.baseUrl ?? config?.model?.baseUrl ?? '';
    const visionName = llm?.visionModelName ?? config?.model?.visionModel ?? '';
    lines.push(
      modelName
        ? visionName
          ? t('system.status.modelWithVision', { model: modelName, vision: visionName })
          : t('system.status.model', { model: modelName })
        : t('system.status.modelUnknown'),
    );
    if (baseUrl) lines.push(t('system.status.baseUrl', { url: baseUrl }));

    // 已用 token
    const usage = await safe(() => (typeof llm?.usageTotals === 'function' ? llm.usageTotals() : null));
    if (usage) {
      lines.push(
        t('system.status.usage', {
          total: num(usage.totalTokens),
          prompt: num(usage.promptTokens),
          completion: num(usage.completionTokens),
          requests: num(usage.requests),
          failed: num(usage.failed) ? t('system.status.usageFailed', { count: num(usage.failed) }) : '',
        }),
      );
    } else {
      lines.push(t('system.status.usageUnknown'));
    }

    // 余额
    const balance = await safe(() => (typeof llm?.balance === 'function' ? llm.balance() : null));
    if (balance && (balance.balance != null || balance.available != null)) {
      const amount =
        balance.balance == null
          ? t('system.status.balanceUnknownAmount')
          : `${balance.balance} ${balance.currency ?? ''}`.trim();
      lines.push(
        t('system.status.balance', {
          amount,
          unavailable: balance.available === false ? t('system.status.balanceUnavailable') : '',
        }),
      );
    } else {
      lines.push(t('system.status.balanceMissing'));
    }

    // 上下文占用
    if (typeof services.contextStats === 'function') {
      const ctx = await safe(() => services.contextStats());
      const used = ctx ? realNumber(ctx.tokens, ctx.used, ctx.usedTokens) : null;
      if (used === null) {
        lines.push(t('system.status.contextUnknown'));
      } else {
        const limit = realNumber(ctx.limit, ctx.max, ctx.maxTokens);
        lines.push(
          t('system.status.context', {
            used,
            limit: limit
              ? t('system.status.contextLimit', { limit, percent: Math.round((used / limit) * 100) })
              : '',
          }),
        );
      }
    } else {
      lines.push(t('system.status.contextUnknown'));
    }

    // 记忆
    const memoryStats = await safe(() => services.memory?.stats?.());
    if (memoryStats) {
      lines.push(
        t('system.status.memory', {
          temporary: num(memoryStats.temporary),
          permanent: num(memoryStats.permanent),
          users: num(memoryStats.users),
          last: memoryStats.lastConsolidateAt
            ? t('system.status.memoryLast', { time: formatTime(memoryStats.lastConsolidateAt) })
            : '',
        }),
      );
    } else {
      lines.push(t('system.status.memoryUnknown'));
    }

    // 任务
    let taskStats = await safe(() => services.tasks?.stats?.());
    if (!taskStats && typeof services.tasks?.list === 'function') {
      const list = await safe(() => services.tasks.list());
      if (Array.isArray(list)) {
        taskStats = {
          total: list.length,
          running: list.filter((task) => task?.status === 'running').length,
          waiting: list.filter((task) => task?.status === 'waiting').length,
        };
      }
    }
    if (taskStats) {
      lines.push(
        t('system.status.tasks', {
          total: num(taskStats.total),
          running: num(taskStats.running) ? t('system.status.tasksRunning', { count: num(taskStats.running) }) : '',
          waiting: num(taskStats.waiting) ? t('system.status.tasksWaiting', { count: num(taskStats.waiting) }) : '',
          done: num(taskStats.done) ? t('system.status.tasksDone', { count: num(taskStats.done) }) : '',
        }),
      );
    } else {
      lines.push(t('system.status.tasksUnknown'));
    }

    // 定时任务
    const scheduleStats = await safe(() => services.scheduler?.stats?.());
    if (scheduleStats) {
      lines.push(
        t('system.status.schedule', {
          enabled: num(scheduleStats.enabled),
          total: num(scheduleStats.total),
          next: scheduleStats.nextRunAt
            ? t('system.status.scheduleNext', {
                time: formatTime(scheduleStats.nextRunAt),
                name: scheduleStats.nextName ? t('system.status.scheduleNextName', { name: scheduleStats.nextName }) : '',
              })
            : '',
        }),
      );
    } else {
      lines.push(t('system.status.scheduleUnknown'));
    }

    // OneBot 连接
    if (!services.onebot) {
      lines.push(t('system.status.onebotMissing'));
    } else {
      const status = await safe(() => (typeof services.onebot.status === 'function' ? services.onebot.status() : null));
      if (status) {
        const state = status.connected ? t('system.status.onebotConnected') : t('system.status.onebotDisconnected');
        const login = await safe(() => services.onebot.getLoginInfo?.());
        if (login) {
          lines.push(
            t('system.status.onebot', {
              state,
              name: login.nickname ?? t('system.status.onebotAnonymous'),
              id: login.user_id ?? login.userId ?? t('system.status.unknown'),
            }),
          );
        } else {
          lines.push(t('system.status.onebotNoLogin', { state }));
        }
      } else {
        lines.push(t('system.status.onebotUnknown'));
      }
    }

    // 侧车
    if (config?.sidecar?.enabled === false) {
      lines.push(t('system.status.sidecarOff'));
    } else if (services.sidecar) {
      const health = await safe(() =>
        typeof services.sidecar.probe === 'function' ? services.sidecar.probe() : services.sidecar.health?.(),
      );
      // 只有拿到明确的 true/false 才下结论；探都没探过就说查不到，不替它编一个状态
      const ok = typeof health?.ok === 'boolean' ? health.ok : typeof services.sidecar.available === 'boolean' ? services.sidecar.available : null;
      lines.push(
        ok === null
          ? t('system.status.sidecarUnknown')
          : ok
            ? t('system.status.sidecarOk')
            : t('system.status.sidecarBad'),
      );
    } else {
      lines.push(t('system.status.sidecarMissing'));
    }

    // 情绪 / 好感度
    const snapshot = await safe(() => services.emotion?.snapshot?.());
    if (snapshot) {
      const list = Array.isArray(snapshot) ? snapshot : Object.values(snapshot);
      const records = list.filter(Boolean);
      if (!records.length) {
        lines.push(t('system.status.emotionEmpty'));
      } else {
        const parts = [t('system.status.emotionHeader', { count: records.length })];
        const affections = records.map((item) => realNumber(item.affection)).filter((value) => value !== null && value > 0);
        if (affections.length) {
          parts.push(
            t('system.status.emotionAverage', {
              value: Math.round(affections.reduce((sum, value) => sum + value, 0) / affections.length),
            }),
          );
        }
        const moods = new Map();
        for (const item of records) {
          const mood = typeof item.mood === 'string' && item.mood.trim() ? item.mood.trim() : null;
          if (mood) moods.set(mood, (moods.get(mood) ?? 0) + 1);
        }
        if (moods.size) {
          parts.push(
            t('system.status.emotionMoods', {
              list: [...moods.entries()]
                .map(([mood, count]) => t('system.status.emotionMoodEntry', { mood, count }))
                .join('\uFF0C'),
            }),
          );
        }
        lines.push(parts.join('\uFF0C'));
      }
    } else {
      lines.push(t('system.status.emotionUnknown'));
    }

    log?.debug?.(t('system.status.reporterReady'), { lines: lines.length });
    return lines.join('\n');
  }

  return { report };
}
