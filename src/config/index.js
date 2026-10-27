/**
 * 配置装载：config/*.json（按模块分文件）+ .env / 环境变量覆盖。
 * 缺失的配置项用内置默认值补齐；关键配置非法时抛 ConfigError，宁可启动失败也不带病运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { t } from '../i18n/index.js';

export class ConfigError extends Error {
  constructor(problems, rootDir) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(t('config.error.header', { root: rootDir, list: list.join('\n- ') }));
    this.name = 'ConfigError';
    this.problems = list;
    this.rootDir = rootDir;
  }
}

/** 内置默认值：config 文件缺失也能起来。 */
const DEFAULTS = {
  bot: {
    name: t('config.default.botName'),
    version: '0.1.0',
    logLevel: 'info',
    locale: 'zh-CN',
    dataDir: 'data',
    onebot: {
      mode: 'forward',
      wsUrl: 'ws://127.0.0.1:3001',
      accessToken: '',
      reversePort: 3002,
      reversePath: '/onebot',
      httpUrl: 'http://127.0.0.1:3000',
      httpPort: 3003,
      heartbeatTimeoutMs: 90000,
      reconnect: { minDelayMs: 1000, maxDelayMs: 30000, factor: 1.8 },
      requestTimeoutMs: 10000,
      selfId: 0,
    },
    behavior: {
      privateAutoReply: true,
      groupRequireAt: true,
      groupWhitelist: [],
      privateWhitelist: [],
      blacklist: [],
      replyDebounceMs: 300,
      cooldownMs: 0,
      maxConcurrentReplies: 4,
      typingDelayPerCharMs: 55,
      typingDelayMaxMs: 3500,
      ignoreSelf: true,
      replyToUnknownPrivate: true,
      // 群里引用机器人自己发的消息，也算「在跟机器人说话」
      replyToBotCountsAsAt: true,
    },
    context: { recentMessages: 20, maxChars: 6000, persist: true },
    greeting: { enabled: true, text: t('config.default.greeting') },
  },
  model: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    visionModel: '',
    temperature: 1.15,
    maxTokens: 2048,
    timeoutMs: 120000,
    stream: true,
    retry: { times: 2, baseDelayMs: 800 },
    roles: {},
    balance: { enabled: false, url: '', currency: 'CNY' },
    offline: false,
  },
  persona: {
    name: t('config.default.personaName'),
    selfReference: '\u6211',
    identity: '',
    basePrompt: t('config.default.basePrompt'),
    style: {
      noMarkdown: true,
      // 标点这类程序要用的字符不是文字，用转义写（见 docs/I18N.md）
      punctuation: {
        prefer: '\uFF0C',
        allowed: ['\uFF0C', '\u3002', '\uFF1F', '\uFF01', '\u2026'],
        avoid: ['\uFF1B', '\uFF1A'],
        rule: '',
      },
      segments: { minChars: 1, maxChars: 26, maxSegments: 5, gapMs: [280, 1500] },
      maxCharsBeforeFile: 800,
      tone: {},
      catchphrases: [],
      habits: [],
      forbidden: [],
    },
    expressions: {
      stickerDir: 'stickers',
      stickerChance: 0.16,
      faceChance: 0.35,
      maxConsecutiveSame: 3,
      preferred: [],
      emojiToFace: {},
      kaomojiToFace: {},
    },
    roles: {},
  },
  emotion: {
    enabled: true,
    defaultMood: t('config.default.mood.calm'),
    moods: [
      t('config.default.mood.calm'),
      t('config.default.mood.happy'),
      t('config.default.mood.angry'),
      t('config.default.mood.wronged'),
      t('config.default.mood.tired'),
      t('config.default.mood.caring'),
    ],
    initialAffection: { owner: 60, member: 15 },
    affectionRange: [0, 100],
    deltas: { praise: 3, thanks: 2, share: 1.5, chat: 0.2, ignore: -1.5, insult: -6 },
    decay: { halfLifeHours: 168, toward: 40, minIntervalMinutes: 30 },
    mood: { decayMinutes: 90, moodDurationMinutes: {}, thresholds: {} },
    frequency: {},
    labels: [{ min: 0, label: t('config.default.label.stranger') }],
  },
  memory: {
    enabled: true,
    perUser: true,
    temporary: { capacity: 400, halfLifeHours: 72, minScore: 0.12, maxAgeDays: 60 },
    permanent: { capacity: 200, minImportance: 0.75, keywords: [], neverForget: true },
    recall: { topK: 12, weights: { relevance: 0.5, recency: 0.3, importance: 0.2 }, minScore: 0.15 },
    consolidate: { intervalMinutes: 30, batch: 60, mergeSimilarity: 0.92, summaryMaxChars: 120 },
    extract: { enabled: true, maxItemsPerTurn: 3, minChars: 6 },
  },
  security: {
    admins: [],
    passphrase: {
      enabled: true,
      pool: [],
      maxAgeMinutes: 15,
      minIntervalMinutes: 20,
      answerAttempts: 3,
      allowLlmChallenge: true,
      style: '',
    },
    sensitive: { requireVerification: true, actions: [] },
    suspicion: { enabled: true, notifyAdmin: true, threshold: 0.6, keywords: [], llmJudge: false, reportCooldownMinutes: 5 },
    boundary: {
      mode: 'sandbox',
      workspaceRoot: '.',
      allowPaths: [],
      denyPaths: [],
      denyNamePatterns: ['.env', '.vault.toml', '.project_config.toml'],
      maxReadBytes: 1048576,
      maxWriteBytes: 262144,
      shell: { enabled: false, timeoutMs: 90000, maxOutputBytes: 60000, denyPatterns: [], allowedRoots: ['.'] },
    },
  },
  autonomy: {
    enabled: true,
    scheduler: { enabled: true, tickSeconds: 20, maxTasks: 200 },
    idle: {
      enabled: true,
      checkIntervalSeconds: 60,
      idleAfterMinutes: 45,
      cooldownMinutes: 25,
      maxPerDay: 12,
      activities: ['recall', 'observe'],
      activityWeights: {},
    },
    proactive: {
      enabled: true,
      targets: [],
      minIntervalMinutes: 90,
      maxPerDay: 8,
      quietHours: ['23:30', '07:30'],
      resumeGreeting: true,
    },
  },
  agent: {
    enabled: true,
    maxSteps: 24,
    workMaxSteps: 8,
    chatTools: true,
    chatMaxSteps: 3,
    maxConcurrent: 3,
    stepTimeoutMs: 120000,
    taskTimeoutMs: 900000,
    allowParallelTools: false,
    reportProgress: true,
    progressEverySteps: 6,
    interruptible: true,
    resultAsFileThreshold: 800,
    toolResultMaxChars: 4000,
    systemNote: '',
  },
  web: {
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
    token: '',
    allowRemote: false,
    openBrowser: false,
  },
  sticker: {
    enabled: true,
    dir: 'stickers',
    indexFile: 'data/stickers/index.json',
    learnFromAdmins: true,
    learnFromOthers: false,
    autoMeaning: true,
    allowedRoots: [],
    sendChance: 0.16,
    cooldownMs: 120000,
    standalone: true,
    maxItems: 500,
    maxFileBytes: 2097152,
    tags: [],
  },
  tasks: { enabled: true, tasks: [] },
};

/** 极简 .env 解析：KEY=VALUE，支持引号与 # 注释。 */
export function loadEnvFile(filePath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const idx = text.indexOf('=');
    if (idx <= 0) continue;
    const key = text.slice(0, idx).trim();
    let value = text.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

function readModuleConfig(rootDir, name, problems) {
  const file = path.join(rootDir, 'config', `${name}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    problems.push(t('config.problem.parse', { name, message: error.message }));
    return {};
  }
}

function toInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(text)) return false;
  return fallback;
}

/** 把环境变量覆盖到配置对象上。 */
function applyEnv(config, env) {
  const onebot = config.bot.onebot;
  if (env.ONEBOT_MODE) onebot.mode = String(env.ONEBOT_MODE).trim();
  if (env.ONEBOT_WS_URL) onebot.wsUrl = String(env.ONEBOT_WS_URL).trim();
  if (env.ONEBOT_ACCESS_TOKEN !== undefined) onebot.accessToken = String(env.ONEBOT_ACCESS_TOKEN);
  if (env.ONEBOT_REVERSE_PORT) onebot.reversePort = toInt(env.ONEBOT_REVERSE_PORT, onebot.reversePort);
  if (env.ONEBOT_HTTP_URL) onebot.httpUrl = String(env.ONEBOT_HTTP_URL).trim();

  if (env.MODEL_BASE_URL) config.model.baseUrl = String(env.MODEL_BASE_URL).trim();
  if (env.MODEL_API_KEY) config.model.apiKey = String(env.MODEL_API_KEY).trim();
  if (env.MODEL_NAME) config.model.model = String(env.MODEL_NAME).trim();
  if (env.MODEL_VISION_NAME) config.model.visionModel = String(env.MODEL_VISION_NAME).trim();

  if (env.ADMIN_QQ) {
    const ids = String(env.ADMIN_QQ)
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => toInt(item, null))
      .filter((item) => item !== null);
    if (ids.length) config.security.admins = ids;
  }

  if (env.LOG_LEVEL) config.bot.logLevel = String(env.LOG_LEVEL).trim();
  if (env.WEB_ENABLED !== undefined) config.web.enabled = toBool(env.WEB_ENABLED, config.web.enabled);
  if (env.WEB_HOST) config.web.host = String(env.WEB_HOST).trim();
  if (env.WEB_PORT) config.web.port = toInt(env.WEB_PORT, config.web.port);
  if (env.WEB_TOKEN !== undefined) config.web.token = String(env.WEB_TOKEN);
  if (env.WEB_ALLOW_REMOTE !== undefined) config.web.allowRemote = toBool(env.WEB_ALLOW_REMOTE, config.web.allowRemote);
  if (env.BOUNDARY_MODE) config.security.boundary.mode = String(env.BOUNDARY_MODE).trim();
  if (env.SIDECAR_ENABLED !== undefined) {
    config.sidecar = mergeDeep(config.sidecar ?? {}, { enabled: toBool(env.SIDECAR_ENABLED, true) });
  }
  if (env.SIDECAR_URL) config.sidecar.url = String(env.SIDECAR_URL).trim();
  if (env.SIDECAR_AUTOSTART !== undefined) config.sidecar.autostart = toBool(env.SIDECAR_AUTOSTART, true);
  if (env.SIDECAR_PYTHON) config.sidecar.python = String(env.SIDECAR_PYTHON).trim();
  return config;
}

function validate(config, problems) {
  if (!config.model.baseUrl) problems.push(t('config.validate.baseUrl'));
  if (!config.model.model) problems.push(t('config.validate.model'));
  if (!Array.isArray(config.security.admins) || config.security.admins.length === 0) {
    problems.push(t('config.validate.admins'));
  }
  const mode = config.bot.onebot.mode;
  if (!['forward', 'reverse', 'http'].includes(mode)) {
    problems.push(t('config.validate.onebotMode', { mode }));
  }
  if (mode === 'forward' && !/^wss?:\/\//.test(config.bot.onebot.wsUrl)) {
    problems.push(t('config.validate.wsUrl', { url: config.bot.onebot.wsUrl }));
  }
  if (config.security.passphrase.enabled && !config.security.passphrase.pool.length) {
    problems.push(t('config.validate.passphrase'));
  }
  if (config.web?.enabled !== false) {
    const port = Number(config.web?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(t('config.validate.webPort', { port: config.web?.port }));
    }
    if (port === 3001 || port === 3002 || port === 3003 || port === 8765) {
      problems.push(t('config.validate.webPortClash', { port }));
    }
    if (!config.web?.allowRemote) config.web.host = '127.0.0.1'; // 不开远程访问就只监听本机
  }
  return problems;
}

let cached = null;

function envValue(env, ...names) {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== '') return env[name];
  }
  return undefined;
}

/**
 * 装载配置。
 * @param {{ rootDir?: string, env?: Record<string,string>, overrides?: object, useEnvFile?: boolean }} opts
 */
export function loadConfig({ rootDir = process.cwd(), env = process.env, overrides = {}, useEnvFile = true } = {}) {
  const absoluteRoot = path.resolve(rootDir);
  const problems = [];
  const fileEnv = useEnvFile ? loadEnvFile(path.join(absoluteRoot, '.env')) : {};
  const mergedEnv = { ...fileEnv, ...env };
  // 兼容两种写法：DEEPSEEK_API_KEY 也可作为 MODEL_API_KEY
  const apiKey = envValue(mergedEnv, 'MODEL_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY');
  if (apiKey !== undefined) mergedEnv.MODEL_API_KEY = apiKey;

  const config = {
    rootDir: absoluteRoot,
    env: mergedEnv,
  };
  for (const name of Object.keys(DEFAULTS)) {
    config[name] = mergeDeep(DEFAULTS[name], readModuleConfig(absoluteRoot, name, problems));
  }

  config.sidecar = mergeDeep(
    {
      enabled: true,
      url: 'http://127.0.0.1:8765',
      autostart: true,
      python: 'python',
      script: path.join(absoluteRoot, 'python', 'sidecar.py'),
      host: '127.0.0.1',
      port: 8765,
      timeoutMs: 8000,
      screenshotDir: path.join(absoluteRoot, 'data', 'screenshots'),
    },
    config.sidecar ?? {},
  );

  applyEnv(config, mergedEnv);
  const finalConfig = mergeDeep(config, overrides);

  const dataDir = path.resolve(absoluteRoot, finalConfig.bot.dataDir ?? 'data');
  finalConfig.dataDir = dataDir;
  finalConfig.logDir = path.join(dataDir, 'logs');
  finalConfig.memoryDir = path.join(dataDir, 'memory');
  finalConfig.stickerDir = path.resolve(
    absoluteRoot,
    finalConfig.sticker?.dir ?? finalConfig.persona.expressions.stickerDir ?? 'stickers',
  );
  finalConfig.stickerIndexFile = path.resolve(
    absoluteRoot,
    finalConfig.sticker?.indexFile ?? path.join('data', 'stickers', 'index.json'),
  );
  finalConfig.boundaryRoot = path.resolve(absoluteRoot, finalConfig.security.boundary.workspaceRoot ?? '.');
  finalConfig.offline = Boolean(finalConfig.model.offline);

  validate(finalConfig, problems);
  if (problems.length) throw new ConfigError(problems, absoluteRoot);

  cached = finalConfig;
  return finalConfig;
}

/** 重新装载上一次装载过的配置目录。 */
export function reloadConfig({ env = process.env, overrides = {} } = {}) {
  const rootDir = cached?.rootDir ?? process.cwd();
  return loadConfig({ rootDir, env, overrides });
}

export function currentConfig() {
  return cached;
}
