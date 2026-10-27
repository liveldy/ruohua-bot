#!/usr/bin/env node
/**
 * 若华 —— 入口。
 * 装载配置 → 自检 → 组装各模块 → 连 NapCat → 启动定时任务与自主性 → 等消息。
 *
 * 用法：
 *   node src/main.js                 正常启动
 *   node src/main.js --dry-run       只自检，不连 QQ
 *   node src/main.js --offline       跳过模型接口连通检查
 *   node src/main.js --no-web        不起控制面板
 *   node src/main.js --log-level debug
 */

import path from 'node:path';
import process from 'node:process';
import { ConfigError, loadConfig } from './config/index.js';
import { configureI18n, i18n, localeOverridePath, t, DEFAULT_LOCALE } from './i18n/index.js';
import { createLogger } from './logging/logger.js';
import { createLLMClient } from './llm/client.js';
import { createOneBotClient } from './onebot/client.js';
import { createEmotionEngine } from './emotion/engine.js';
import { createMemoryService } from './memory/service.js';
import { createTaskRegistry } from './agent/tasks.js';
import { createAgentRunner } from './agent/runner.js';
import { createTools } from './agent/tools/index.js';
import { createSecurityGuard } from './security/guard.js';
import { createBoundary } from './security/boundary.js';
import { createScheduler } from './autonomy/scheduler.js';
import { createAutonomy } from './autonomy/autonomy.js';
import { createSidecarClient } from './perception/sidecar.js';
import { createVisionService } from './perception/vision.js';
import { createImageSourceResolver } from './perception/image-source.js';
import { createScreenService } from './perception/screen.js';
import { createSelfCheck } from './system/selfcheck.js';
import { createStatusReporter } from './system/status.js';
import { createWebServer } from './web/server.js';
import { createStickers } from './sticker/index.js';
import { createContextBuilder } from './brain/context.js';
import { createChatToolLoop } from './brain/chat.js';
import { createReplyPipeline } from './brain/reply.js';
import { createDispatcher } from './brain/dispatcher.js';

function parseArgs(argv) {
  const args = { configDir: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--config-dir') args.configDir = argv[++i];
    else if (item === '--offline') args.offline = true;
    else if (item === '--no-sidecar') args.noSidecar = true;
    else if (item === '--no-autonomy') args.noAutonomy = true;
    else if (item === '--no-web') args.noWeb = true;
    else if (item === '--web-port') args.webPort = Number(argv[++i]);
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--log-level') args.logLevel = argv[++i];
    else if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(t('boot.help.usage'));
    return 0;
  }

  // 先把本地化装起来：配置模块自己的默认文字与校验提示也要能走管理员改过的覆盖文件
  configureI18n({ locale: DEFAULT_LOCALE, overrideFile: localeOverridePath(args.configDir) });

  let config;
  try {
    config = loadConfig({ rootDir: args.configDir });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (config.bot.locale && config.bot.locale !== DEFAULT_LOCALE) {
    configureI18n({ locale: config.bot.locale, overrideFile: localeOverridePath(args.configDir, config.bot.locale) });
  }
  if (args.logLevel) config.bot.logLevel = args.logLevel;
  if (args.offline) config.offline = true;
  if (args.noSidecar) config.sidecar.enabled = false;

  const logger = createLogger({ level: config.bot.logLevel, dir: config.logDir, name: 'ruohua' });
  logger.info(t('boot.starting', { root: config.rootDir }));

  const startedAt = Date.now();
  const services = { config, logger };

  // —— 组装模块（services 这个对象是共享引用，边建边填，解决循环依赖）——
  const llm = createLLMClient({ config, logger });
  const sidecar = createSidecarClient({ config, logger });
  const boundary = createBoundary({ config, logger });
  const onebot = createOneBotClient({ config, logger });
  const notify = async ({ title, text }) => {
    logger.warn(t('boot.alarm.title', { title }), { text });
    const admins = config.security.admins ?? [];
    if (!admins.length) return;
    try {
      const info = onebot.loginInfo?.();
      if (!info) return;
      await onebot.sendPrivate(admins[0], t('boot.alarm.message', { title, text }));
    } catch (error) {
      logger.warn(t('boot.alarm.sendFailed'), error);
    }
  };
  const security = createSecurityGuard({ config, llm, logger, notify });
  const emotion = createEmotionEngine({ config, logger, stateFile: path.join(config.dataDir, 'emotion.json') });
  const memory = createMemoryService({ config, llm, sidecar, logger, dir: config.memoryDir });
  const tasks = createTaskRegistry({ logger, dir: config.dataDir });
  const screen = createScreenService({ config, sidecar, logger });
  const vision = createVisionService({ llm, sidecar, logger, config });
  // 协议端（NapCat）给的图片只有裸文件名，真身在它自己的缓存目录里 —— 装一个解析器，表情包与识图都用它
  const imageSource = createImageSourceResolver({
    logger,
    extra: Array.isArray(config.sticker?.allowedRoots)
      ? config.sticker.allowedRoots.map((item) => path.resolve(config.rootDir ?? process.cwd(), item))
      : [],
  });

  Object.assign(services, {
    llm,
    sidecar,
    boundary,
    onebot,
    security,
    emotion,
    memory,
    tasks,
    screen,
    vision,
    imageSource,
    persona: config.persona,
    startedAt,
  });

  // 表情包：管理员发的图片会存进库里并认出含义，合适的时候单独发一条（见 docs/STICKERS.md）
  if (config.sticker?.enabled !== false) {
    try {
      const sticker = await createStickers({ config, logger, llm, vision, imageSource });
      Object.assign(services, { sticker });
      logger.info(t('boot.sticker.ready', { count: sticker.stats?.().total ?? 0 }));
    } catch (error) {
      logger.warn(t('boot.sticker.failed', { error: error?.message ?? error }));
    }
  }

  const tools = createTools({ config, services });
  const agent = createAgentRunner({ config, llm, tools, logger, tasks, services });
  // 聊天里的工具环：问她什么她都能自己去查（文件 / 系统 / 联网），不只是干聊
  const chat = createChatToolLoop({ config, llm, tools, logger, services });
  const context = createContextBuilder({
    config,
    persona: config.persona,
    emotion,
    memory,
    logger,
    vision,
    imageSource,
  });
  const reply = createReplyPipeline({ config, persona: config.persona, emotion, logger, sticker: services.sticker });
  const status = createStatusReporter({ config, logger, services });

  Object.assign(services, { tools, agent, chat, context, reply, status, boundary });

  const dispatcher = createDispatcher({ config, logger, onebot, services });
  Object.assign(services, { dispatcher });

  const scheduler = createScheduler({
    config,
    logger,
    dir: config.dataDir,
    services,
    deliver: async ({ target, prompt, task }) => {
      logger.info(t('boot.scheduler.fired', { name: task?.name ?? prompt }));
      return dispatcher.runPrompt({ target, prompt });
    },
  });
  const autonomy = createAutonomy({
    config,
    llm,
    logger,
    persona: config.persona,
    emotion,
    memory,
    scheduler,
    services,
    deliver: async ({ target, text, reason }) => dispatcher.speak({ target, text, reason }),
  });
  const selfcheck = createSelfCheck({ config, logger, services });

  Object.assign(services, { scheduler, autonomy, selfcheck, notify });

  // 自检分两趟：连 QQ 之前先查配置/磁盘/密钥这些「不用网络也能定论」的；
  // 连上之后再查 OneBot 连接、侧车、模型连通，免得一启动就误报「未连接」。
  const runSelfCheck = async (phase) => {
    const report = await selfcheck.run({ offline: args.offline || config.offline, phase });
    for (const item of report.items.filter((entry) => entry.level !== 'ok')) {
      const line = item.hint
        ? t('boot.selfcheck.itemHint', { name: item.name, detail: item.detail, hint: item.hint })
        : t('boot.selfcheck.item', { name: item.name, detail: item.detail });
      logger[item.level === 'fail' ? 'error' : 'warn'](line);
    }
    return report;
  };

  const preflight = await runSelfCheck('startup');
  if (args.dryRun) {
    await logger.flush();
    return preflight.ok ? 0 : 1;
  }
  if (!preflight.ok) {
    logger.error(t('boot.selfcheck.blocked'));
    await logger.flush();
    return 1;
  }

  // —— 控制面板（配置 / 监视终端 / 实时调试）——
  let web = null;
  if (args.noWeb !== true && config.web?.enabled !== false) {
    try {
      web = createWebServer({ config, logger, services, options: { port: args.webPort } });
      Object.assign(services, { web });
      await web.start(); // 起来之后由控制面板自己记一行（含实际端口）
    } catch (error) {
      web = null;
      logger.error(t('boot.web.startFailed', { error: error?.message ?? error }));
    }
  }

  // —— 连接与事件 ——
  // 上线问候要带上自检结论，但第二趟自检（连接 / 侧车 / 模型连通）得等连上之后才准，
  // 所以这里等它一下再发：一条消息里把「上线了」和自检结论一起给管理者。
  // 等超时（15 秒）就先发问候语，结论留在日志里。
  let resolveReportReady;
  const reportReady = new Promise((resolve) => {
    resolveReportReady = resolve;
  });
  const waitReport = (timeoutMs = 15000) =>
    Promise.race([
      reportReady,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);

  onebot.on('message', (message) => {
    dispatcher.handleMessage(message).catch((error) => logger.error(t('boot.message.handleFailed'), error));
  });
  onebot.on('notice', (notice) => {
    dispatcher.handleNotice(notice).catch((error) => logger.debug(t('boot.notice.handleFailed'), error));
  });
  onebot.on('connected', async () => {
    const info = onebot.loginInfo?.();
    logger.info(t('boot.onebot.ready', { selfId: info?.user_id ?? '' }));
    if (config.bot.greeting?.enabled === false) return;
    const admins = config.security.admins ?? [];
    if (!admins.length) return;
    const ready = await waitReport();
    const text = ready ? `${config.bot.greeting?.text ?? ''}\n${ready.summary}`.trim() : config.bot.greeting?.text ?? '';
    if (!text) return;
    try {
      await onebot.sendPrivate(admins[0], text);
    } catch (error) {
      logger.debug(t('boot.greeting.failed'), error);
    }
  });
  // 断开/出错由 OneBot 客户端自己按窗口去重后记录（见 src/onebot/client.js），这里不再重复刷一行
  onebot.on('disconnected', () => logger.debug(t('boot.onebot.disconnected')));
  onebot.on('error', (error) => logger.debug(t('boot.onebot.error'), error));

  const sidecarReady = config.sidecar.enabled
    ? sidecar
        .ensureStarted?.()
        .then((ok) => {
          logger.info(ok ? t('boot.sidecar.ready') : t('boot.sidecar.degraded'));
          return ok;
        })
        .catch((error) => {
          logger.warn(t('boot.sidecar.startFailed'), error);
          return false;
        })
    : Promise.resolve(null);

  await onebot.start();

  // 等握手完成（正向 ws 才有意义），最多等这么久，等不到也照常往下走
  const waitForConnection = async (timeoutMs = 5000) => {
    if (config.bot.onebot.mode !== 'forward') return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (onebot.status?.().connected) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };
  await waitForConnection();
  await sidecarReady;

  const report = await runSelfCheck('runtime');
  resolveReportReady(report);
  if (report.items.some((entry) => entry.level === 'fail')) {
    logger.error(t('boot.selfcheck.runtimeFailed'));
  }

  if (!args.noAutonomy && config.autonomy.enabled) {
    scheduler.start();
    autonomy.start();
  }

  // —— 维护循环：情绪衰减、记忆巩固、状态落盘 ——
  const maintenance = setInterval(() => {
    emotion.tick().catch((error) => logger.debug(t('boot.emotion.tickFailed'), error));
    emotion.save().catch(() => {});
    tasks.save().catch(() => {});
  }, 60 * 1000);
  maintenance.unref?.();

  const consolidateTimer = setInterval(() => {
    memory.consolidate().catch((error) => logger.debug(t('boot.memory.consolidateFailed'), error));
  }, Math.max(5, config.memory.consolidate?.intervalMinutes ?? 30) * 60 * 1000);
  consolidateTimer.unref?.();

  const missing = i18n().missingKeys();
  if (missing.length) {
    // \u3001 是顿号：程序要用的分隔符，不是文字
    logger.warn(t('boot.i18n.missing', { count: missing.length, keys: missing.slice(0, 10).join('\u3001') }));
  }
  logger.info(t('boot.online'));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(t('boot.shutdown.start', { signal }));
    clearInterval(maintenance);
    clearInterval(consolidateTimer);
    try {
      autonomy.stop();
      scheduler.stop();
    } catch (error) {
      logger.debug(t('boot.shutdown.autonomyFailed'), error);
    }
    try {
      await web?.stop?.();
    } catch (error) {
      logger.debug(t('boot.shutdown.webFailed'), error);
    }
    try {
      await Promise.allSettled([emotion.save(), tasks.save(), memory.consolidate()]);
    } catch (error) {
      logger.debug(t('boot.shutdown.persistFailed'), error);
    }
    try {
      await onebot.stop();
    } catch (error) {
      logger.debug(t('boot.shutdown.onebotFailed'), error);
    }
    try {
      await sidecar.stop?.();
    } catch (error) {
      logger.debug(t('boot.shutdown.sidecarFailed'), error);
    }
    await logger.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error(t('boot.unhandledRejection'), reason));

  return new Promise(() => {});
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((error) => {
    console.error(t('boot.fatal'), error);
    process.exitCode = 1;
  });
