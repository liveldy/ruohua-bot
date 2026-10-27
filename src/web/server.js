#!/usr/bin/env node
/**
 * 若华控制面板服务：配置页面 / 监视终端 / 实时调试。
 *
 * 契约（docs/WEB.md）：
 *   createWebServer({ config, logger, services, options }) → { start, stop, info }
 *   start() → { host, port, url }，端口被占就自动往后找空闲端口（默认 8787）
 *
 * 面板只有一个：跟着主程序（src/main.js）一起跑，地址由 config/web.json 的 port 决定；
 * 这里没有第二个「独立面板」入口，同一个端口上已经有一个若华面板时也不再另开一个。
 *
 * 只依赖 node:http / node:fs / 项目已有的 ws，不引入新依赖。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { timingSafeEqual as cryptoEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ensureDir, fileExists, listFiles, writeTextAtomic } from '../util/io.js';
import { formatDuration } from '../util/time.js';
import { configureI18n, i18n, localeOverridePath, t } from '../i18n/index.js';
import { PANEL_PORT_FROM, PANEL_PORT_TO, createServiceManager, openInBrowser, probePanel, probePanels } from './services.js';
import { ENV_FIELDS, applyEnvUpdate, envView, MASK } from './env.js';

export { MASK };

/** 被别的组件占着的端口，自动找端口时跳过（显式指定的那个端口不跳，先试）。 */
const RESERVED_PORTS = new Set([3001, 3002, 3003, 8765, 8899, 3901, 3902, 3903]);

/** 端口被占时最多往后找几个。 */
const MAX_PORT_ATTEMPTS = 20;

/**
 * 名字以这些词结尾的字段一律脱敏。
 * 只看结尾是有意的：`maxTokens` / `keywords` 这类中间带 token / key 的正常字段不能被盖住，
 * 不然表单里根本改不了它们的值。
 */
const SECRET_KEY = /(api[_-]?key|access[_-]?token|secret|password|passwd|token)$/i;

const LOG_CHANNELS = ['app', 'conversation', 'operation'];
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
const RECENT_MAX = 500;
const BACKLOG_MAX = 200;
const CAPTURE_MAX = 500;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TAIL_INTERVAL_MS = 1000;
const TAIL_LOOKBACK_BYTES = 64 * 1024;
const TAIL_MAX_READ_BYTES = 2 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 150;
const HEARTBEAT_INTERVAL_MS = 30000;
const CONFIG_NAME_RE = /^[a-z0-9_-]+$/;

/** 表情包 id / 文件名安全字符（路径参数一律先过这一关）。 */
const STICKER_ID_RE = /^[\w-]+$/;

/** 表情包图片的类型表（跟 src/sticker/library.js 的 STICKER_EXTENSIONS 对齐）。 */
const STICKER_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** 侧车调试白名单：只读/可重入的方法，stop 与 ensureStarted 不放进来。 */
const SIDECAR_METHODS = {
  health: (sidecar) => sidecar.health(),
  probe: (sidecar) => sidecar.probe(),
  embed: (sidecar, params) => sidecar.embed(Array.isArray(params) ? params : params?.texts ?? []),
  similar: (sidecar, params) => sidecar.similar(params?.a ?? '', params?.b ?? ''),
  screenshot: (sidecar, params) => sidecar.screenshot(params && typeof params === 'object' ? params : {}),
  asr: (sidecar, params) => sidecar.asr(typeof params === 'string' ? params : params?.path ?? params?.file ?? ''),
  score: (sidecar, params) => sidecar.score(params?.items ?? [], params?.now ?? Date.now()),
  consolidate: (sidecar, params) => sidecar.consolidate(params && typeof params === 'object' ? params : {}),
};

export const SIDECAR_ALLOWED = Object.freeze(Object.keys(SIDECAR_METHODS));

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

// ————————————————————————————————— 小工具 —————————————————————————————————

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function dayStamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 文件名安全的本地时间戳：2026-10-26T19-52-51-123。 */
function fileStamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  );
}

function normalizeLevel(level) {
  const name = String(level ?? 'info').toLowerCase();
  return LEVEL_RANK[name] ? name : 'info';
}

/** 定长比较，避免按字符提前返回；长度不同也照比完。 */
function timingSafeEqual(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  const length = Math.max(a.length, b.length, 1);
  const left = Buffer.alloc(length);
  const right = Buffer.alloc(length);
  a.copy(left);
  b.copy(right);
  const sameLength = a.length === b.length;
  return cryptoEqual(left, right) && sameLength;
}

function displayHost(host) {
  const text = String(host ?? '127.0.0.1');
  if (text === '0.0.0.0' || text === '::' || text === '') return '127.0.0.1';
  return text.includes(':') ? `[${text}]` : text;
}

function safe(fn, fallback = undefined) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

async function safeAsync(fn, fallback = undefined) {
  try {
    const value = await fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function withTimeout(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(fallback), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => done(value === undefined ? fallback : value),
      () => done(fallback),
    );
  });
}

/** 密钥脱敏：命中密钥名就把标量值换成占位符；对象/数组递归进去，里面的标量也一起盖住。 */
export function maskSecrets(value, key = '', forced = false) {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, key, forced));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = maskSecrets(childValue, childKey, forced || SECRET_KEY.test(childKey));
    }
    return out;
  }
  if (forced && value !== null && value !== undefined) return MASK;
  return value;
}

/** 保存时把占位符换回磁盘上的旧值：逐字段、逐数组元素比对，只有占位符才回填。 */
export function mergeMasked(next, previous) {
  if (next === MASK && previous !== undefined) return previous;
  if (Array.isArray(next)) {
    const prevList = Array.isArray(previous) ? previous : [];
    return next.map((item, index) => mergeMasked(item, prevList[index]));
  }
  if (next && typeof next === 'object') {
    const prevObject = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    const out = {};
    for (const [key, value] of Object.entries(next)) out[key] = mergeMasked(value, prevObject[key]);
    return out;
  }
  return next;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

// ————————————————————————— 配置字段元信息（表单用） —————————————————————————
/**
 * config/*.json 的字段表：给前端渲染表单用的类型 / 枚举 / 分组。
 *
 * 这里只是「默认值表长什么样」的副本（src/config/index.js 的 DEFAULTS 不对外导出，也不许改），
 * 类型记号：
 *   text / textarea / secret / number / boolean / list / json / enum:值1|值2
 * `json` 表示「这一坨是字典或数组套对象，整块按 JSON 编辑」，不再往下拆叶子。
 *
 * 本地化键是 web.field.<配置名>.<点号路径>.label / .desc，写在
 * src/i18n/locales/zh-CN/web.json；文件里有、这张表里没有的字段照样列出来，
 * 只是归到 group: 'other'、类型按值猜。
 */
const CONFIG_FIELDS_SCHEMA = {
  bot: {
    name: 'text',
    version: 'text',
    logLevel: 'enum:debug|info|warn|error',
    locale: 'text',
    dataDir: 'text',
    onebot: {
      mode: 'enum:forward|reverse|http',
      wsUrl: 'text',
      accessToken: 'secret',
      reversePort: 'number',
      reversePath: 'text',
      httpUrl: 'text',
      httpPort: 'number',
      heartbeatTimeoutMs: 'number',
      reconnect: { minDelayMs: 'number', maxDelayMs: 'number', factor: 'number' },
      requestTimeoutMs: 'number',
      selfId: 'number',
    },
    behavior: {
      privateAutoReply: 'boolean',
      groupRequireAt: 'boolean',
      groupWhitelist: 'list',
      privateWhitelist: 'list',
      blacklist: 'list',
      replyDebounceMs: 'number',
      cooldownMs: 'number',
      maxConcurrentReplies: 'number',
      typingDelayPerCharMs: 'number',
      typingDelayMaxMs: 'number',
      ignoreSelf: 'boolean',
      replyToUnknownPrivate: 'boolean',
      replyToBotCountsAsAt: 'boolean',
    },
    context: { recentMessages: 'number', maxChars: 'number', persist: 'boolean' },
    greeting: { enabled: 'boolean', text: 'textarea' },
  },
  model: {
    provider: 'text',
    baseUrl: 'text',
    apiKey: 'secret',
    model: 'text',
    visionModel: 'text',
    temperature: 'number',
    maxTokens: 'number',
    timeoutMs: 'number',
    stream: 'boolean',
    retry: { times: 'number', baseDelayMs: 'number' },
    roles: {
      chat: { temperature: 'number', maxTokens: 'number', stream: 'boolean' },
      decision: { temperature: 'number', maxTokens: 'number', stream: 'boolean' },
      judge: { temperature: 'number', maxTokens: 'number', stream: 'boolean' },
      memory: { temperature: 'number', maxTokens: 'number', stream: 'boolean' },
      agent: { temperature: 'number', maxTokens: 'number', stream: 'boolean' },
    },
    balance: { enabled: 'boolean', url: 'text', currency: 'text' },
    offline: 'boolean',
  },
  persona: {
    name: 'text',
    selfReference: 'text',
    identity: 'textarea',
    basePrompt: 'textarea',
    style: {
      noMarkdown: 'boolean',
      punctuation: { prefer: 'text', allowed: 'list', avoid: 'list', rule: 'textarea' },
      segments: { minChars: 'number', maxChars: 'number', maxSegments: 'number', gapMs: 'list' },
      maxCharsBeforeFile: 'number',
      tone: 'json',
      catchphrases: 'list',
      habits: 'list',
      forbidden: 'list',
    },
    expressions: {
      stickerDir: 'text',
      stickerChance: 'number',
      faceChance: 'number',
      maxConsecutiveSame: 'number',
      preferred: 'list',
      emojiToFace: 'json',
      kaomojiToFace: 'json',
    },
    roles: {
      owner: { address: 'textarea', closeness: 'textarea' },
      member: { address: 'textarea', closeness: 'textarea' },
    },
  },
  emotion: {
    enabled: 'boolean',
    defaultMood: 'text',
    moods: 'list',
    initialAffection: { owner: 'number', member: 'number' },
    affectionRange: 'list',
    deltas: {
      praise: 'number',
      thanks: 'number',
      share: 'number',
      chat: 'number',
      helpful: 'number',
      command: 'number',
      ignore: 'number',
      insult: 'number',
      harass: 'number',
      suspect: 'number',
      apology: 'number',
    },
    decay: { halfLifeHours: 'number', toward: 'number', minIntervalMinutes: 'number' },
    mood: { decayMinutes: 'number', moodDurationMinutes: 'json', thresholds: 'json' },
    frequency: 'json',
    labels: 'json',
  },
  memory: {
    enabled: 'boolean',
    perUser: 'boolean',
    temporary: {
      capacity: 'number',
      halfLifeHours: 'number',
      minScore: 'number',
      promoteAfterAccess: 'number',
      maxAgeDays: 'number',
    },
    permanent: {
      capacity: 'number',
      minImportance: 'number',
      keywordMinImportance: 'number',
      keywords: 'list',
      neverForget: 'boolean',
    },
    recall: { topK: 'number', weights: 'json', minScore: 'number' },
    consolidate: { intervalMinutes: 'number', batch: 'number', mergeSimilarity: 'number', summaryMaxChars: 'number' },
    extract: { enabled: 'boolean', maxItemsPerTurn: 'number', minChars: 'number' },
    _notes: 'list',
  },
  security: {
    admins: 'list',
    passphrase: {
      enabled: 'boolean',
      pool: 'list',
      maxAgeMinutes: 'number',
      minIntervalMinutes: 'number',
      answerAttempts: 'number',
      allowLlmChallenge: 'boolean',
      style: 'textarea',
      challengeRule: 'textarea',
    },
    sensitive: { requireVerification: 'boolean', actions: 'list', actionsWhy: 'textarea', verifyWhy: 'textarea' },
    suspicion: {
      enabled: 'boolean',
      notifyAdmin: 'boolean',
      threshold: 'number',
      keywords: 'list',
      llmJudge: 'boolean',
      reportCooldownMinutes: 'number',
    },
    boundary: {
      mode: 'enum:sandbox|trusted',
      workspaceRoot: 'text',
      allowPaths: 'list',
      allowPathsWhy: 'textarea',
      denyPaths: 'list',
      denyNamePatterns: 'list',
      maxReadBytes: 'number',
      maxWriteBytes: 'number',
      shell: {
        enabled: 'boolean',
        timeoutMs: 'number',
        maxOutputBytes: 'number',
        denyPatterns: 'list',
        denyPatternsHow: 'textarea',
        denyPatternsWhy: 'json',
        limitsWhy: 'list',
        allowedRoots: 'list',
      },
    },
  },
  autonomy: {
    enabled: 'boolean',
    scheduler: { enabled: 'boolean', tickSeconds: 'number', maxTasks: 'number' },
    idle: {
      enabled: 'boolean',
      checkIntervalSeconds: 'number',
      idleAfterMinutes: 'number',
      cooldownMinutes: 'number',
      maxPerDay: 'number',
      activities: 'list',
      activityWeights: 'json',
    },
    proactive: {
      enabled: 'boolean',
      targets: 'list',
      minIntervalMinutes: 'number',
      maxPerDay: 'number',
      quietHours: 'list',
      resumeGreeting: 'boolean',
    },
  },
  agent: {
    enabled: 'boolean',
    maxSteps: 'number',
    workMaxSteps: 'number',
    chatTools: 'boolean',
    chatMaxSteps: 'number',
    maxConcurrent: 'number',
    stepTimeoutMs: 'number',
    taskTimeoutMs: 'number',
    allowParallelTools: 'boolean',
    reportProgress: 'boolean',
    progressEverySteps: 'number',
    interruptible: 'boolean',
    resultAsFileThreshold: 'number',
    toolResultMaxChars: 'number',
    systemNote: 'textarea',
  },
  web: {
    enabled: 'boolean',
    host: 'text',
    port: 'number',
    token: 'secret',
    allowRemote: 'boolean',
    openBrowser: 'boolean',
    napcat: { dir: 'text', launcher: 'text', webuiUrl: 'text', onebotPort: 'number' },
  },
  sticker: {
    enabled: 'boolean',
    dir: 'text',
    indexFile: 'text',
    learnFromAdmins: 'boolean',
    learnFromOthers: 'boolean',
    autoMeaning: 'boolean',
    sendChance: 'number',
    cooldownMs: 'number',
    standalone: 'boolean',
    maxItems: 'number',
    maxFileBytes: 'number',
    downloadTimeoutMs: 'number',
    tags: 'list',
  },
  tasks: { enabled: 'boolean', tasks: 'json' },
};

/** 名字以这些词结尾的字段算密钥：只标出来，脱敏交给 maskSecrets。 */
const SECRET_NAME_RE = /(key|token|secret|password|passwd)$/i;

function guessFieldType(value, name) {
  if (SECRET_NAME_RE.test(String(name ?? ''))) return 'secret';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return value.every((item) => item === null || typeof item !== 'object') ? 'list' : 'json';
  if (value && typeof value === 'object') return 'json';
  if (typeof value === 'string') return value.includes('\n') || value.length > 60 ? 'textarea' : 'text';
  return 'text';
}

/**
 * 把「配置文件名 + 文件里的内容」摊平成表单字段。
 * 表里没有的字段也留着（group: 'other'，类型按值猜），一个都不丢。
 * @returns {Array<{ path: string, name: string, labelKey: string, descKey: string, type: string,
 *   options: string[]|null, value: any, secret: boolean, group: string }>}
 */
function configFields(name, content) {
  const schema = CONFIG_FIELDS_SCHEMA[name] ?? {};
  const rows = [];

  const emit = (prefix, token, value, known) => {
    const leaf = prefix[prefix.length - 1];
    const dotted = prefix.join('.');
    let type = 'text';
    let options = null;
    let secret = SECRET_NAME_RE.test(String(leaf));
    if (typeof token === 'string' && token.startsWith('enum:')) {
      type = 'enum';
      options = token.slice(5).split('|');
    } else if (token === 'secret') {
      type = 'secret';
      secret = true;
    } else if (typeof token === 'string' && token !== 'text' && token !== 'textarea') {
      type = token;
    } else if (token === 'textarea') {
      type = 'textarea';
    } else {
      type = guessFieldType(value, leaf);
    }
    if (secret) type = 'secret';
    rows.push({
      path: dotted,
      name: leaf,
      labelKey: `web.field.${name}.${dotted}.label`,
      descKey: `web.field.${name}.${dotted}.desc`,
      type,
      options,
      value: value === undefined ? null : value,
      secret,
      group: known ? name : 'other',
    });
  };

  const walk = (node, value, prefix, known) => {
    if (node === 'json') {
      emit(prefix.length ? prefix : ['*'], node, value, known);
      return;
    }
    const isObjectValue = value && typeof value === 'object' && !Array.isArray(value);
    if ((node && typeof node === 'object') || isObjectValue) {
      const children = node && typeof node === 'object' ? node : {};
      const source = isObjectValue ? value : {};
      const keys = [...new Set([...Object.keys(source), ...Object.keys(children)])];
      for (const key of keys) {
        const hasChild = Object.prototype.hasOwnProperty.call(children, key);
        const child = children[key];
        const childValue = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
        const path = [...prefix, key];
        if (!hasChild && childValue && typeof childValue === 'object' && Object.keys(childValue).length) {
          emit(path, 'json', childValue, false);
          continue;
        }
        if (!hasChild && childValue === undefined) continue;
        if (!hasChild && typeof childValue !== 'object') {
          emit(path, null, childValue, false);
          continue;
        }
        walk(child, childValue, path, known && hasChild);
      }
      return;
    }
    if (!prefix.length) return;
    emit(prefix, typeof node === 'string' ? node : null, value, known);
  };

  walk(schema, content && typeof content === 'object' && !Array.isArray(content) ? content : {}, [], true);
  return rows;
}

/** 字段值脱敏：secret 字段一律盖住（沿用 maskSecrets 的粒度）。 */
function maskFields(fields) {
  return fields.map((field) => (field.secret && field.value !== null && field.value !== undefined ? { ...field, value: MASK } : field));
}

// ————————————————————————— 出错与键 —————————————————————————

/** 带状态码的接口错误：文字一律走 t()，找不到的键会原样出现在响应里（体检会拦）。 */
function httpError(status, key, params = null) {
  const error = new Error(t(key, params ?? undefined));
  error.status = status;
  error.key = key;
  return error;
}

/** services.js 只抛 code + params，翻成人话在这儿做（键必须是字面量）。 */
const SERVICE_ERROR_KEYS = {
  unknown_service: 'web.service.error.unknownService',
  unknown_action: 'web.service.error.unknownAction',
  missing_file: 'web.service.error.missingFile',
  napcat_not_found: 'web.service.error.napcatNotFound',
  napcat_still_listening: 'web.service.error.napcatStillListening',
  napcat_stop_denied: 'web.service.error.napcatStopDenied',
  napcat_timeout: 'web.service.error.napcatTimeout',
  already_running: 'web.service.error.alreadyRunning',
  attached_self: 'web.service.error.attachedSelf',
  not_ours: 'web.service.error.notOurs',
  unverifiable: 'web.service.error.unverifiable',
  stop_failed: 'web.service.error.stopFailed',
  start_failed: 'web.service.error.startFailed',
  open_failed: 'web.service.error.openFailed',
  timeout: 'web.service.error.timeout',
  unavailable: 'web.service.error.unavailable',
};

const SERVICE_ERROR_STATUS = {
  unknown_service: 404,
  unknown_action: 400,
  missing_file: 404,
  napcat_not_found: 404,
  napcat_still_listening: 500,
  napcat_stop_denied: 403,
  napcat_timeout: 504,
  already_running: 409,
  attached_self: 409,
  not_ours: 409,
  unverifiable: 403,
  stop_failed: 500,
  start_failed: 502,
  open_failed: 500,
  timeout: 504,
  unavailable: 503,
};

function serviceHttpError(error) {
  const code = String(error?.code ?? 'unknown');
  const key = SERVICE_ERROR_KEYS[code] ?? 'web.service.error.unknown';
  const wrapped = httpError(SERVICE_ERROR_STATUS[code] ?? 500, key, error?.params ?? null);
  wrapped.code = code;
  return wrapped;
}

// ————————————————————————————————— 主体 —————————————————————————————————

/**
 * @param {{ config?: object, logger?: object, services?: object, options?: object }} params
 */
export function createWebServer({ config = null, logger = null, services = null, options = {} } = {}) {
  const webConfig = config?.web ?? {};
  // 面板只有一个：跟着主程序一起跑（services 由主程序注入，里头是真正的机器人状态）。
  // 没有 services 的形态只留给测试与二次开发当内部兜底，产品里没有第二个启动入口，也没有第二个端口。
  const mode = services && Object.keys(services).length ? 'attached' : 'standalone';
  const attachedPort = Number(pick(options.port, webConfig.port, 8787));
  const settings = {
    enabled: Boolean(pick(options.enabled, webConfig.enabled, true)),
    host: String(pick(options.host, webConfig.host, '127.0.0.1')),
    port: attachedPort,
    token: String(pick(options.token, webConfig.token, '') ?? ''),
    allowRemote: Boolean(pick(options.allowRemote, webConfig.allowRemote, false)),
    openBrowser: Boolean(pick(options.openBrowser, webConfig.openBrowser, false)),
  };
  const rootDir = path.resolve(pick(options.rootDir, config?.rootDir, process.cwd()));
  const dataDir = path.resolve(pick(options.dataDir, config?.dataDir, path.join(rootDir, 'data')));
  const logDir = path.resolve(pick(options.logDir, config?.logDir, path.join(dataDir, 'logs')));
  // 前端页面跟着代码走：用 --config-dir 换到别的目录时，那边不会有 web/，就回落到本模块旁边的 web/
  const moduleWebDir = path.resolve(fileURLToPath(new URL('../../web', import.meta.url)));
  const rootWebDir = path.join(rootDir, 'web');
  const webDir = existsSync(path.join(rootWebDir, 'index.html')) ? rootWebDir : moduleWebDir;
  const configDir = path.join(rootDir, 'config');
  const backupDir = path.join(dataDir, 'config-backup');
  const balanceTtlMs = Number(pick(options.balanceTtlMs, 5 * 60 * 1000));
  const sidecarTtlMs = Number(pick(options.sidecarTtlMs, 10 * 1000));
  const log = logger?.child ? logger.child('web') : logger;

  // 本地化键覆盖文件（面板「本地化键」页改的就是它）：主程序没配过就自己配一次
  const locale = String(config?.bot?.locale ?? 'zh-CN');
  const i18nFile = localeOverridePath(rootDir);
  if (options.configureI18n !== false) {
    try {
      if (i18n().overrideFile() !== i18nFile || i18n().locale !== locale) configureI18n({ locale, overrideFile: i18nFile });
    } catch (error) {
      log?.warn?.(t('web.i18n.configureFailed'), error);
    }
  }

  /** 服务管理器：面板能管的五个服务（面板自身 / Node / NapCat / 若华 / 侧车）。 */
  const serviceManager = createServiceManager({
    config,
    logger,
    services,
    mode,
    rootDir,
    dataDir,
    panelInfo: () => info(),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    now: options.now,
    spawnImpl: options.spawnImpl,
    processInfo: options.processInfo,
    kill: options.killImpl,
    startTimeoutMs: options.startTimeoutMs,
    pollMs: options.pollMs,
    listTtlMs: options.listTtlMs,
  });

  let server = null;
  let wss = null;
  let running = false;
  let boundHost = null;
  let boundPort = null;
  let currentUrl = null;
  let startedAt = 0;
  let entrySeq = 0;

  /** ws → filter */
  const clients = new Map();
  const recent = [];
  const dedupe = new Map();
  const captures = new Map(); // 调试请求期间的日志收集器

  let flushTimer = null;
  let heartbeatTimer = null;
  let tailTimer = null;
  let unsubscribeLogger = null;
  let balanceCache = { at: 0, value: null };
  let balanceInflight = null;
  let sidecarCache = { at: 0, value: null };
  let sidecarInflight = null;

  // ——————————————— 日志汇集 ———————————————

  function matchFilter(entry, filter) {
    if (!filter) return true;
    const threshold = LEVEL_RANK[filter.level] ?? LEVEL_RANK.debug;
    if ((LEVEL_RANK[entry.level] ?? LEVEL_RANK.info) < threshold) return false;
    if (filter.channel && filter.channel !== 'all' && entry.channel !== filter.channel) return false;
    if (filter.keyword) {
      const haystack = `${entry.name ?? ''} ${entry.message ?? ''} ${entry.meta ? JSON.stringify(entry.meta) : ''}`.toLowerCase();
      if (!haystack.includes(filter.keyword)) return false;
    }
    return true;
  }

  function pushEntry(entry) {
    if (!entry) return;
    entry.id = ++entrySeq;
    const key = `${entry.ts}|${entry.level}|${entry.name}|${entry.message}`;
    const now = Date.now();
    if (dedupe.has(key)) return;
    dedupe.set(key, now);
    if (dedupe.size > 400) {
      for (const [staleKey, at] of dedupe) if (now - at > 5000) dedupe.delete(staleKey);
    }

    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);

    for (const capture of captures.values()) {
      if (capture.length < CAPTURE_MAX) capture.push(entry);
    }

    for (const [socket, filter] of clients) {
      if (!matchFilter(entry, filter)) continue;
      socket.__pending.push(entry);
    }
    scheduleFlush();
  }

  function fromProcessEvent(event) {
    if (!event || typeof event !== 'object') return null;
    return {
      ts: Number(event.ts) || Date.now(),
      channel: 'app',
      level: normalizeLevel(event.level),
      name: String(event.name ?? 'ruohua'),
      message: String(event.message ?? ''),
      meta: event.meta ?? null,
      source: 'process',
    };
  }

  /** 文件里的一行 → 统一形状的日志条目。 */
  function parseLogLine(channel, line) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      return null;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const ts = Number(row.ts) || Date.now();
    if (channel === 'conversation') {
      const direction = row.direction === 'out' ? 'out' : 'in';
      return {
        ts,
        channel: 'conversation',
        level: 'info',
        name: row.name ? String(row.name) : t('web.logs.channel.conversation'),
        message: `${direction === 'out' ? '→' : '←'} ${String(row.text ?? '')}`,
        meta: {
          scene: row.scene ?? null,
          userId: row.userId ?? null,
          groupId: row.groupId ?? null,
          direction,
          ...(row.meta ?? {}),
        },
        source: 'file',
      };
    }
    if (channel === 'operation') {
      const ok = row.ok !== false;
      return {
        ts,
        channel: 'operation',
        level: ok ? 'info' : 'warn',
        name: t('web.logs.channel.operation'),
        message: t('web.logs.operationLine', { action: row.action ?? 'unknown', result: ok ? '' : t('web.logs.failedSuffix') }),
        meta: {
          actor: row.actor ?? null,
          actorName: row.actorName ?? null,
          action: row.action ?? null,
          target: row.target ?? null,
          ok,
          detail: row.detail ?? null,
          taskId: row.taskId ?? null,
          durationMs: row.durationMs ?? null,
        },
        source: 'file',
      };
    }
    return {
      ts,
      channel: 'app',
      level: normalizeLevel(row.level),
      name: String(row.name ?? 'ruohua'),
      message: String(row.message ?? row.msg ?? ''),
      meta: row.meta ?? null,
      source: 'file',
    };
  }

  /** 增量读日志文件：只认写完的整行，字节偏移不错位。 */
  async function readIncrement(channel, offsets) {
    const file = path.join(logDir, `${channel}-${dayStamp()}.jsonl`);
    let stat = null;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile()) return;

    let offset = offsets.get(file);
    if (offset === undefined) offset = Math.max(0, stat.size - TAIL_LOOKBACK_BYTES);
    if (stat.size < offset) offset = 0;
    if (stat.size - offset > TAIL_MAX_READ_BYTES) offset = stat.size - TAIL_MAX_READ_BYTES;
    if (stat.size === offset) {
      offsets.set(file, offset);
      return;
    }

    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(file, 'r');
    try {
      await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }

    const lastBreak = buffer.lastIndexOf(0x0a);
    if (lastBreak < 0) return; // 还没写完整行，下一轮再说
    const text = buffer.subarray(0, lastBreak).toString('utf8');
    offsets.set(file, offset + lastBreak + 1);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      pushEntry(parseLogLine(channel, line));
    }
  }

  function startTailer() {
    const offsets = new Map();
    const tick = async () => {
      for (const channel of LOG_CHANNELS) {
        try {
          await readIncrement(channel, offsets);
        } catch (error) {
          log?.debug?.(t('web.logs.readFailed', { channel }), error);
        }
      }
    };
    // 立刻来一轮：顺便把最近的日志当成回放内容塞进缓冲区
    tick().catch(() => {});
    tailTimer = setInterval(() => {
      tick().catch(() => {});
    }, TAIL_INTERVAL_MS);
    tailTimer.unref?.();
  }

  function stopTailer() {
    if (tailTimer) clearInterval(tailTimer);
    tailTimer = null;
  }

  // ——————————————— WebSocket ———————————————

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const [socket, filter] of clients) {
        if (!socket.__pending?.length) continue;
        const entries = socket.__pending;
        socket.__pending = [];
        send(socket, { type: 'logs', entries, filter });
      }
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  function send(socket, payload) {
    try {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    } catch (error) {
      log?.debug?.(t('web.logs.pushFailed'), error);
    }
  }

  function parseFilter(search) {
    const level = String(search.get('level') ?? 'debug').toLowerCase();
    const channel = String(search.get('channel') ?? 'all').toLowerCase();
    return {
      level: LEVEL_RANK[level] ? level : 'debug',
      channel: LOG_CHANNELS.includes(channel) ? channel : 'all',
      keyword: String(search.get('keyword') ?? '').trim().toLowerCase().slice(0, 120),
    };
  }

  function registerClient(socket, filter) {
    socket.__pending = [];
    socket.__alive = true;
    clients.set(socket, filter);

    socket.on('message', (data) => {
      let payload = null;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'ping') {
        send(socket, { type: 'pong', serverTime: Date.now() });
        return;
      }
      if (payload.type === 'filter') {
        const next = {
          level: LEVEL_RANK[String(payload.level ?? '').toLowerCase()] ? String(payload.level).toLowerCase() : 'debug',
          channel: LOG_CHANNELS.includes(String(payload.channel ?? '')) ? String(payload.channel) : 'all',
          keyword: String(payload.keyword ?? '').trim().toLowerCase().slice(0, 120),
        };
        clients.set(socket, next);
        send(socket, { type: 'filtered', filter: next });
      }
    });
    socket.on('pong', () => {
      socket.__alive = true;
    });
    socket.on('close', () => clients.delete(socket));
    // 客户端异常断开不能把服务带崩
    socket.on('error', () => clients.delete(socket));

    send(socket, {
      type: 'hello',
      mode,
      host: boundHost,
      port: boundPort,
      url: currentUrl,
      serverTime: Date.now(),
      filter,
      channels: LOG_CHANNELS,
      levels: Object.keys(LEVEL_RANK),
    });
    const backlog = recent.filter((entry) => matchFilter(entry, filter)).slice(-BACKLOG_MAX);
    if (backlog.length) send(socket, { type: 'logs', entries: backlog, backlog: true, filter });
  }

  function rejectSocket(socket, status, reason) {
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\n` +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n' +
          `X-Error: ${encodeURIComponent(reason)}\r\n\r\n`,
      );
    } catch {
      /* 忽略 */
    }
    try {
      socket.destroy();
    } catch {
      /* 忽略 */
    }
  }

  function handleUpgrade(request, socket, head) {
    let parsed = null;
    try {
      parsed = new URL(request.url, 'http://localhost');
    } catch {
      rejectSocket(socket, 400, 'Bad Request');
      return;
    }
    if (parsed.pathname !== '/ws/logs') {
      rejectSocket(socket, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(request, parsed)) {
      rejectSocket(socket, 401, 'Unauthorized');
      return;
    }
    if (!wss) {
      rejectSocket(socket, 503, 'Service Unavailable');
      return;
    }
    const filter = parseFilter(parsed.searchParams);
    try {
      wss.handleUpgrade(request, socket, head, (ws) => registerClient(ws, filter));
    } catch (error) {
      log?.warn?.(t('web.ws.handshakeFailed'), error);
      rejectSocket(socket, 400, 'Bad Request');
    }
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      for (const socket of clients.keys()) {
        if (socket.__alive === false) {
          try {
            socket.terminate();
          } catch {
            /* 忽略 */
          }
          clients.delete(socket);
          continue;
        }
        socket.__alive = false;
        try {
          socket.ping();
        } catch {
          clients.delete(socket);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  // ——————————————— 鉴权 ———————————————

  function isAuthorized(request, parsed) {
    if (!settings.token) return true;
    const fromQuery = parsed?.searchParams?.get('token') ?? null;
    const header = request.headers?.authorization ?? '';
    const fromHeader = /^Bearer\s+(.+)$/i.exec(String(header))?.[1] ?? null;
    const given = fromQuery ?? fromHeader;
    if (!given) return false;
    return timingSafeEqual(String(given), settings.token);
  }

  // ——————————————— 请求分发 ———————————————

  function sendJson(response, status, payload) {
    let body = '{}';
    try {
      body = JSON.stringify(payload ?? {});
    } catch {
      body = JSON.stringify({ ok: false, error: t('web.error.serialize') });
    }
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(body);
  }

  function fail(response, status, error) {
    sendJson(response, status, { ok: false, error: String(error) });
  }

  async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error(t('web.error.bodyTooLarge', { mb: Math.round(MAX_BODY_BYTES / 1024 / 1024) }));
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      const parseError = new Error(t('web.error.badJson', { message: error.message }));
      parseError.status = 400;
      throw parseError;
    }
  }

  async function handleRequest(request, response) {
    let parsed = null;
    try {
      parsed = new URL(request.url, 'http://localhost');
    } catch {
      fail(response, 400, t('web.error.badUrl'));
      return;
    }
    const pathname = parsed.pathname;

    if (pathname.startsWith('/api/')) {
      if (!isAuthorized(request, parsed)) {
        fail(response, 401, t('web.error.unauthorized'));
        return;
      }
      try {
        await handleApi(request, response, pathname, parsed);
      } catch (error) {
        const status = error.status ?? 500;
        const payload = error.payload ?? { ok: false, error: error.message ?? t('web.error.internal') };
        // 503 是「主程序没跑」这类预期情况，不当成故障刷错误日志
        if (status >= 500 && status !== 503) log?.error?.(t('web.api.failed', { path: pathname }), error);
        else log?.debug?.(t('web.api.softFailed', { path: pathname, status, error: payload.error }));
        if (!response.headersSent) sendJson(response, status, payload);
        else response.end();
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fail(response, 405, t('web.static.method'));
      return;
    }
    await serveStatic(request, response, decodeURIComponentSafe(pathname));
  }

  function decodeURIComponentSafe(text) {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  // ——————————————— 静态文件 ———————————————

  async function serveStatic(request, response, pathname) {
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname.includes('\0')) {
      fail(response, 400, t('web.static.badPath'));
      return;
    }
    const relative = pathname.replace(/^\/+/, '');
    const target = path.resolve(webDir, relative === '' ? 'index.html' : relative);
    const inside = path.relative(webDir, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      fail(response, 403, t('web.static.traversal'));
      return;
    }
    if (inside.split(path.sep).some((segment) => segment.startsWith('.'))) {
      fail(response, 403, t('web.static.hidden'));
      return;
    }
    const ext = path.extname(target).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(STATIC_TYPES, ext)) {
      fail(response, 403, t('web.static.type', { ext: ext || t('web.static.noExt') }));
      return;
    }

    let stat = null;
    try {
      stat = await fs.stat(target);
    } catch (error) {
      if (error.code === 'ENOENT') {
        fail(response, 404, t('web.static.notFound', { path: pathname }));
        return;
      }
      fail(response, 500, t('web.static.readFailed', { message: error.message }));
      return;
    }
    if (!stat.isFile()) {
      fail(response, 403, t('web.static.notFile'));
      return;
    }

    let body = null;
    try {
      body = await fs.readFile(target);
    } catch (error) {
      fail(response, 500, t('web.static.readFailed', { message: error.message }));
      return;
    }
    response.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  }

  // ——————————————— API ———————————————

  async function handleApi(request, response, pathname, parsed) {
    const method = String(request.method ?? 'GET').toUpperCase();

    if (pathname === '/api/status') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, await statusPayload());
    }

    if (pathname === '/api/peers') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, await peersPayload());
    }

    if (pathname === '/api/services') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, { ok: true, mode, services: await serviceManager.list() });
    }

    const serviceMatch = /^\/api\/services\/([^/]+)$/.exec(pathname);
    if (serviceMatch) {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      const serviceId = decodeURIComponentSafe(serviceMatch[1]);
      const body = await readJsonBody(request);
      return sendJson(response, 200, await runServiceAction(serviceId, body?.action));
    }

    if (pathname === '/api/env') {
      if (method === 'GET') return sendJson(response, 200, envPayload());
      if (method === 'PUT') return sendJson(response, 200, await saveEnv(await readJsonBody(request)));
      return fail(response, 405, t('web.error.onlyGetPut'));
    }

    if (pathname === '/api/i18n') {
      if (method === 'GET') return sendJson(response, 200, i18nPayload(parsed));
      if (method === 'PUT') return sendJson(response, 200, saveI18n(await readJsonBody(request)));
      return fail(response, 405, t('web.error.onlyGetPut'));
    }

    if (pathname === '/api/stickers') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, stickersPayload(parsed.searchParams));
    }

    const stickerFileMatch = /^\/api\/stickers\/([^/]+)\/file$/.exec(pathname);
    if (stickerFileMatch) {
      if (method !== 'GET' && method !== 'HEAD') return fail(response, 405, t('web.error.onlyGet'));
      return sendStickerFile(request, response, decodeURIComponentSafe(stickerFileMatch[1]));
    }

    const stickerMatch = /^\/api\/stickers\/([^/]+)$/.exec(pathname);
    if (stickerMatch) {
      const stickerId = decodeURIComponentSafe(stickerMatch[1]);
      if (method === 'GET') return sendJson(response, 200, stickerPayload(stickerId));
      if (method === 'PUT') return sendJson(response, 200, await saveSticker(stickerId, await readJsonBody(request)));
      if (method === 'DELETE') return sendJson(response, 200, await removeSticker(stickerId));
      return fail(response, 405, t('web.error.onlyGetPutDelete'));
    }

    const stickerDescribeMatch = /^\/api\/stickers\/([^/]+)\/describe$/.exec(pathname);
    if (stickerDescribeMatch) {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      return sendJson(response, 200, await describeSticker(decodeURIComponentSafe(stickerDescribeMatch[1])));
    }

    if (pathname === '/api/config') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, await listConfigs());
    }

    const configMatch = /^\/api\/config\/([^/]+)$/.exec(pathname);
    if (configMatch) {
      const name = decodeURIComponentSafe(configMatch[1]);
      if (!CONFIG_NAME_RE.test(name)) return fail(response, 400, t('web.config.badName'));
      if (method === 'GET') return sendJson(response, 200, await readConfig(name));
      if (method === 'PUT') return sendJson(response, 200, await saveConfig(name, await readJsonBody(request)));
      return fail(response, 405, t('web.error.onlyGetPut'));
    }

    if (pathname === '/api/tools') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, await toolsPayload());
    }

    if (pathname === '/api/tasks') {
      if (method !== 'GET') return fail(response, 405, t('web.error.onlyGet'));
      return sendJson(response, 200, tasksPayload());
    }

    if (pathname === '/api/tasks/stop') {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      return sendJson(response, 200, stopTask(await readJsonBody(request)));
    }

    if (pathname === '/api/debug/message') {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      return sendJson(response, 200, await debugMessage(await readJsonBody(request)));
    }

    if (pathname === '/api/debug/llm') {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      return sendJson(response, 200, await debugLlm(await readJsonBody(request)));
    }

    if (pathname === '/api/debug/tool') {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      return sendJson(response, 200, await debugTool(await readJsonBody(request)));
    }

    if (pathname === '/api/debug/sidecar') {
      if (method !== 'POST') return fail(response, 405, t('web.error.onlyPost'));
      return sendJson(response, 200, await debugSidecar(await readJsonBody(request)));
    }

    fail(response, 404, t('web.error.noRoute', { path: pathname }));
  }

  function requireService(value, what) {
    if (!value) {
      const error = new Error(t('web.error.needMain', { what }));
      error.status = 503;
      throw error;
    }
    return value;
  }

  // —— /api/peers ——

  /** 别的若华面板：扫 8787–8795，谁答 /api/status 谁就是。 */
  async function peersPayload() {
    const self = info();
    const peers = await safeAsync(
      () => serviceManager.probePanels({ from: PANEL_PORT_FROM, to: PANEL_PORT_TO, skip: self.port ? [self.port] : [] }),
      [],
    );
    return {
      ok: true,
      mode,
      self: self.port ? { url: self.url, port: self.port, mode } : null,
      peers: Array.isArray(peers) ? peers : [],
    };
  }

  // —— /api/services ——

  async function runServiceAction(id, action) {
    const name = String(action ?? '').trim();
    if (!name) throw httpError(400, 'web.service.error.missingAction');
    try {
      return await serviceManager.act(id, name);
    } catch (error) {
      throw serviceHttpError(error);
    }
  }

  // —— /api/env ——

  const envFile = path.join(rootDir, '.env');

  function relative(target) {
    return path.relative(rootDir, target).replace(/\\/g, '/');
  }

  function envPayload() {
    const view = envView(envFile);
    return {
      ok: true,
      mode,
      file: relative(envFile),
      exists: view.exists,
      keys: view.keys,
      groups: view.groups,
      note: t('web.env.note'),
    };
  }

  async function saveEnv(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'web.env.error.body');
    const values = body.values ?? {};
    if (typeof values !== 'object' || Array.isArray(values)) throw httpError(400, 'web.env.error.body');
    try {
      const result = applyEnvUpdate(envFile, values, { backupDir });
      logger?.operation?.({
        actor: 'web-panel',
        action: 'env_save',
        target: '.env',
        ok: true,
        detail: { changed: result.changed, backup: result.backup ? relative(result.backup) : null },
      });
      return {
        ok: true,
        file: relative(envFile),
        exists: result.view.exists,
        changed: result.changed,
        backup: result.backup,
        backupRelative: result.backup ? relative(result.backup) : null,
        groups: result.view.groups,
      };
    } catch (error) {
      if (error?.code === 'env_unknown_key') {
        throw httpError(400, 'web.env.error.unknownKey', { keys: (error.keys ?? []).join('\u3001') });
      }
      if (error?.code === 'env_bad_key') throw httpError(400, 'web.env.error.badKey', { key: error.key });
      throw error;
    }
  }

  // —— /api/i18n ——

  function i18nPayload(parsed) {
    const instance = i18n();
    const requested = String(parsed?.searchParams?.get('locale') ?? instance.locale);
    return {
      ok: true,
      locale: instance.locale,
      requestedLocale: requested,
      file: relative(instance.overrideFile() ?? i18nFile),
      keys: instance.keys(),
      values: instance.table(),
      defaults: instance.defaults(),
      overrides: instance.overrides(),
      missing: instance.missingKeys(),
    };
  }

  function saveI18n(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'web.i18n.error.body');
    const instance = i18n();
    const values = body.values ?? {};
    if (typeof values !== 'object' || Array.isArray(values)) throw httpError(400, 'web.i18n.error.body');
    const reset = Array.isArray(body.reset) ? body.reset.map((key) => String(key)) : [];
    const known = new Set(instance.keys());
    const unknown = [...new Set([...Object.keys(values), ...reset].filter((key) => !known.has(key)))];
    if (unknown.length) throw httpError(400, 'web.i18n.error.unknownKeys', { keys: unknown.join('\u3001') });
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') throw httpError(400, 'web.i18n.error.notString', { key });
      instance.set(key, value);
    }
    for (const key of reset) instance.reset(key);

    const target = instance.overrideFile() ?? i18nFile;
    const saved = instance.save(target);
    logger?.operation?.({
      actor: 'web-panel',
      action: 'i18n_save',
      target: relative(target),
      ok: true,
      detail: { saved: saved.count, reset: reset.length },
    });
    return {
      ok: true,
      locale: instance.locale,
      file: relative(target),
      saved: { file: saved.file, count: saved.count, bytes: saved.bytes },
      reset,
      values: instance.table(),
      overrides: instance.overrides(),
    };
  }

  // —— /api/stickers ——
  // 读、改含义、删图都在面板里做；「学一张」仍然是主程序的事（docs/STICKERS.md 4.4）。

  /** 图片地址：默认不带令牌，配了令牌就把令牌带上，好让前端直接丢进 <img src>。 */
  function stickerFileUrl(id) {
    const base = `/api/stickers/${encodeURIComponent(id)}/file`;
    return settings.token ? `${base}?token=${encodeURIComponent(settings.token)}` : base;
  }

  /** 索引条目 → 面板要的形状（不吐 sourceHash / path 这类内部字段）。 */
  function stickerItemView(item) {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id ?? '');
    return {
      id,
      title: String(item.title ?? ''),
      meaning: String(item.meaning ?? ''),
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : [],
      bytes: Number(item.bytes ?? 0) || 0,
      addedBy: item.addedBy ?? null,
      addedAt: item.addedAt ?? null,
      usedCount: Number(item.usedCount ?? 0) || 0,
      lastUsedAt: item.lastUsedAt ?? null,
      ext: item.ext ?? (path.extname(String(item.file ?? '')) || null),
      file: item.file ?? null,
      url: id ? stickerFileUrl(id) : null,
    };
  }

  function requireSticker() {
    const service = services?.sticker;
    if (!service) throw httpError(503, 'web.stickers.needMain');
    return service;
  }

  /** 独立模式 / 表情包关掉：给一个空壳，别 500，也别假装有东西。 */
  function stickerEmpty(note) {
    return { ok: true, mode, count: 0, total: 0, items: [], stats: null, notes: [], note };
  }

  function stickersPayload(searchParams) {
    const service = services?.sticker;
    if (!service?.list || !service?.stats) return stickerEmpty(t('web.stickers.needMain'));

    const tag = searchParams.get('tag') || null;
    const keyword = searchParams.get('keyword') || null;
    const offset = Math.max(0, Number(searchParams.get('offset')) || 0);
    const limit = Number(searchParams.get('limit'));
    const pageSize = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : null;
    const all = safe(() => service.list({ tag, keyword }), []);
    const page = safe(() => service.list({ tag, keyword, limit: pageSize, offset }), []);
    const items = (Array.isArray(page) ? page : []).map(stickerItemView).filter(Boolean);
    return {
      ok: true,
      mode,
      filter: { tag, keyword, limit: pageSize, offset },
      count: items.length,
      total: Array.isArray(all) ? all.length : items.length,
      items,
      stats: safe(() => service.stats(), null),
      notes: safe(() => service.notes?.(), []),
      note: null,
    };
  }

  function stickerPayload(id) {
    if (!STICKER_ID_RE.test(String(id ?? ''))) throw httpError(400, 'web.stickers.error.badId', { id });
    const service = requireSticker();
    const item = safe(() => service.get?.(id), null);
    if (!item) throw httpError(404, 'web.stickers.error.notFound', { id });
    return { ok: true, mode, item: stickerItemView(item), url: stickerFileUrl(id) };
  }

  async function saveSticker(id, body) {
    if (!STICKER_ID_RE.test(String(id ?? ''))) throw httpError(400, 'web.stickers.error.badId', { id });
    const service = requireSticker();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'web.stickers.error.body');

    const patch = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string') throw httpError(400, 'web.stickers.error.title');
      patch.title = body.title.trim();
    }
    if (body.meaning !== undefined) {
      if (typeof body.meaning !== 'string') throw httpError(400, 'web.stickers.error.meaning');
      patch.meaning = body.meaning.trim();
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) throw httpError(400, 'web.stickers.error.tags');
      patch.tags = body.tags.map((tag) => tag.trim()).filter(Boolean);
    }
    if (!Object.keys(patch).length) throw httpError(400, 'web.stickers.error.nothing');

    const library = service.library;
    if (typeof library?.update !== 'function') throw httpError(503, 'web.stickers.needMain');
    const item = await safeAsync(() => library.update(id, patch), null);
    if (!item) throw httpError(404, 'web.stickers.error.notFound', { id });
    logger?.operation?.({
      actor: 'web-panel',
      action: 'sticker_update',
      target: String(id),
      ok: true,
      detail: { fields: Object.keys(patch), tags: patch.tags?.length ?? null },
    });
    return { ok: true, mode, item: stickerItemView(item), url: stickerFileUrl(id) };
  }

  /**
   * 认一张表情包：让视觉模型看图，给出**标题 / 内容描述 / 时机标签**，只给建议、不落盘 ——
   * 面板拿到后填进表单，管理员看一眼再保存（`library.update` 才真写）。
   */
  async function describeSticker(id) {
    if (!STICKER_ID_RE.test(String(id ?? ''))) throw httpError(400, 'web.stickers.error.badId', { id });
    const service = requireSticker();
    if (typeof service.describe !== 'function') throw httpError(503, 'web.stickers.needMain');
    const item = safe(() => service.get?.(id), null);
    if (!item) throw httpError(404, 'web.stickers.error.notFound', { id });
    const target = item.path ?? null;
    if (!target) throw httpError(404, 'web.stickers.error.noFile', { id });
    const suggestion = await safeAsync(() => service.describe(target), null);
    if (!suggestion) throw httpError(503, 'web.stickers.error.describe');
    logger?.operation?.({
      actor: 'web-panel',
      action: 'sticker_describe',
      target: String(id),
      ok: true,
      detail: { title: suggestion.title ?? '', meaning: suggestion.meaning ?? '', tags: suggestion.tags?.length ?? 0 },
    });
    return {
      ok: true,
      mode,
      id: String(id),
      suggestion: {
        title: String(suggestion.title ?? ''),
        meaning: String(suggestion.meaning ?? ''),
        tags: Array.isArray(suggestion.tags) ? suggestion.tags.map((tag) => String(tag)) : [],
      },
    };
  }

  /**
   * 删一张表情包：索引记录与磁盘上的图一起删（`library.remove` 两件事都做）。
   * 删之前先留一份旧值，操作日志里好写清「删掉的是什么」。
   */
  async function removeSticker(id) {
    if (!STICKER_ID_RE.test(String(id ?? ''))) throw httpError(400, 'web.stickers.error.badId', { id });
    const service = requireSticker();
    if (typeof service.remove !== 'function') throw httpError(503, 'web.stickers.needMain');
    const item = safe(() => service.get?.(id), null);
    if (!item) throw httpError(404, 'web.stickers.error.notFound', { id });
    const removed = await safeAsync(() => service.remove(id), false);
    if (!removed) throw httpError(404, 'web.stickers.error.notFound', { id });
    logger?.operation?.({
      actor: 'web-panel',
      action: 'sticker_remove',
      target: String(id),
      ok: true,
      detail: { file: item.file ?? null, meaning: item.meaning ?? '' },
    });
    return { ok: true, mode, id: String(id), removed: true, total: safe(() => service.stats()?.total ?? null, null) };
  }

  /** 把图片本身吐出来：只认 stickers/ 目录里的文件，越界一律 403。 */
  async function sendStickerFile(request, response, id) {
    if (!STICKER_ID_RE.test(String(id ?? ''))) throw httpError(400, 'web.stickers.error.badId', { id });
    const service = requireSticker();
    const item = safe(() => service.get?.(id), null);
    if (!item) throw httpError(404, 'web.stickers.error.notFound', { id });

    const dirText = service.dir ?? service.library?.dir ?? null;
    const name = String(item.file ?? '');
    if (!dirText || !name) throw httpError(404, 'web.stickers.error.noFile', { id });
    const dir = path.resolve(String(dirText));
    const target = path.resolve(dir, name);
    const inside = path.relative(dir, target);
    if (inside.startsWith('..') || path.isAbsolute(inside) || inside === '') {
      throw httpError(403, 'web.stickers.error.outside');
    }

    const ext = path.extname(target).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(STICKER_TYPES, ext)) {
      throw httpError(403, 'web.stickers.error.type', { ext: ext || t('web.static.noExt') });
    }

    let body = null;
    try {
      body = await fs.readFile(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(404, 'web.stickers.error.noFile', { id });
      throw httpError(500, 'web.stickers.error.read', { message: error.message });
    }
    response.writeHead(200, {
      'Content-Type': STICKER_TYPES[ext],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  }

  // —— /api/status ——

  async function cachedBalance() {
    const llm = services?.llm;
    if (!llm?.balance) return null;
    if (Date.now() - balanceCache.at < balanceTtlMs) return balanceCache.value;
    if (balanceInflight) return balanceInflight;
    balanceInflight = (async () => {
      const value = await withTimeout(safeAsync(() => llm.balance()), 6000, null);
      balanceCache = { at: Date.now(), value: value ?? null };
      balanceInflight = null;
      return balanceCache.value;
    })();
    return balanceInflight;
  }

  async function cachedSidecarHealth() {
    const sidecar = services?.sidecar;
    if (!sidecar) return null;
    if (Date.now() - sidecarCache.at < sidecarTtlMs) return sidecarCache.value;
    if (sidecarInflight) return sidecarInflight;
    sidecarInflight = (async () => {
      const probe = safeAsync(() => (sidecar.probe ? sidecar.probe() : sidecar.health?.()));
      const value = await withTimeout(probe, 3000, null);
      sidecarCache = {
        at: Date.now(),
        value: value ?? null,
      };
      sidecarInflight = null;
      return sidecarCache.value;
    })();
    return sidecarInflight;
  }

  async function statusPayload() {
    const now = Date.now();
    const payload = {
      ok: true,
      mode,
      running,
      serverTime: now,
      web: {
        host: boundHost,
        port: boundPort,
        url: currentUrl,
        clients: clients.size,
        startedAt: startedAt || null,
        uptimeMs: startedAt ? now - startedAt : 0,
      },
      config: { rootDir, dataDir, logDir },
    };

    const botStartedAt = Number(services?.startedAt ?? 0);
    if (botStartedAt) {
      payload.bot = {
        startedAt: botStartedAt,
        uptimeMs: now - botStartedAt,
        uptimeText: safe(() => formatDuration(now - botStartedAt), ''),
      };
    }

    const onebot = await safeAsync(() => services?.onebot?.status?.());
    if (onebot) payload.onebot = onebot;

    const usage = await safeAsync(() => services?.llm?.usageTotals?.());
    if (usage) payload.llm = { usage, model: safe(() => services?.llm?.modelName ?? null) };
    const balance = await cachedBalance();
    if (balance) payload.llm = { ...(payload.llm ?? {}), balance };
    else if (payload.llm) payload.llm.balance = null;

    const sidecar = await cachedSidecarHealth();
    if (services?.sidecar) {
      payload.sidecar = {
        url: safe(() => services.sidecar.url ?? null),
        enabled: safe(() => services.sidecar.enabled ?? null),
        available: safe(() => services.sidecar.available ?? null),
        pid: safe(() => services.sidecar.pid ?? null),
        health: sidecar,
      };
    }

    if (services?.dispatcher?.stats) {
      const stats = await safeAsync(() => services.dispatcher.stats());
      if (stats) payload.dispatcher = stats;
    }
    if (services?.reply?.state) {
      const replyState = await safeAsync(() => services.reply.state());
      if (replyState) payload.reply = replyState;
    }
    if (services?.emotion?.snapshot) {
      const snapshot = await safeAsync(() => services.emotion.snapshot());
      const rows = Array.isArray(snapshot) ? snapshot : snapshot && typeof snapshot === 'object' ? Object.values(snapshot) : [];
      if (rows.length || snapshot !== undefined) {
        payload.emotion = {
          users: rows.length,
          sample: rows.slice(0, 5).map((row) => ({
            userId: row?.userId ?? null,
            affection: row?.affection ?? null,
            mood: row?.mood ?? null,
            label: row?.label ?? null,
          })),
        };
      }
    }
    if (services?.memory?.stats) {
      const stats = await safeAsync(() => services.memory.stats());
      if (stats) payload.memory = stats;
    }
    if (services?.tasks?.list) {
      const list = await safeAsync(() => services.tasks.list({}), []);
      const rows = Array.isArray(list) ? list : [];
      payload.tasks = {
        count: rows.length,
        active: rows.filter((task) => task?.status === 'running' || task?.status === 'waiting').length,
        stats: await safeAsync(() => services.tasks.stats?.()),
      };
    }
    if (services?.scheduler?.list) {
      const list = await safeAsync(() => services.scheduler.list(), []);
      payload.scheduler = { count: Array.isArray(list) ? list.length : 0 };
    }

    if (services?.sticker?.stats) {
      const stickerStats = await safeAsync(() => services.sticker.stats());
      if (stickerStats) {
        payload.sticker = {
          total: Number(stickerStats.total ?? 0) || 0,
          sent: Number(stickerStats.sent ?? 0) || 0,
          learned: Number(stickerStats.learned ?? 0) || 0,
        };
      }
    }

    if (services) {
      payload.modules = Object.keys(services)
        .filter((key) => key !== 'config' && services[key] != null)
        .sort();
    }
    payload.services = await safeAsync(() => serviceManager.overview(), null);
    if (mode === 'standalone') {
      payload.note = t('web.status.standaloneNote');
    }
    return payload;
  }

  // —— /api/config ——

  async function listConfigFiles() {
    const files = await listFiles(configDir, { filter: (file) => file.toLowerCase().endsWith('.json') });
    return files
      .map((file) => ({ name: path.basename(file, '.json'), file }))
      .filter((item) => CONFIG_NAME_RE.test(item.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function configPath(name) {
    return path.join(configDir, `${name}.json`);
  }

  async function readConfigFile(name) {
    const file = configPath(name);
    let text = null;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, file, text: null, content: null };
      throw error;
    }
    let content = null;
    let parseError = null;
    try {
      content = text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      parseError = error.message;
    }
    return { exists: true, file, text, content, parseError };
  }

  async function fileMeta(file, fallback = {}) {
    try {
      const stat = await fs.stat(file);
      return { size: stat.size, updatedAt: stat.mtimeMs };
    } catch {
      return fallback;
    }
  }

  async function listConfigs() {
    const files = await listConfigFiles();
    const rows = [];
    for (const item of files) {
      const read = await readConfigFile(item.name);
      const meta = await fileMeta(read.file);
      rows.push({
        name: item.name,
        file: `${path.relative(rootDir, read.file).replace(/\\/g, '/')}`,
        size: meta.size ?? null,
        updatedAt: meta.updatedAt ?? null,
        parseError: read.parseError ?? null,
        content: read.parseError ? null : maskSecrets(read.content ?? {}),
      });
    }
    return {
      ok: true,
      dir: path.relative(rootDir, configDir).replace(/\\/g, '/') || 'config',
      backupDir: path.relative(rootDir, backupDir).replace(/\\/g, '/'),
      files: rows,
      note: t('web.config.note'),
    };
  }

  async function readConfig(name) {
    const read = await readConfigFile(name);
    if (!read.exists) {
      const error = new Error(t('web.config.notFound', { name }));
      error.status = 404;
      throw error;
    }
    const meta = await fileMeta(read.file);
    return {
      ok: true,
      name,
      file: path.relative(rootDir, read.file).replace(/\\/g, '/'),
      size: meta.size ?? null,
      updatedAt: meta.updatedAt ?? null,
      parseError: read.parseError ?? null,
      content: read.parseError ? null : maskSecrets(read.content ?? {}),
      raw: read.parseError ? read.text : null,
      note: t('web.config.note'),
      fields: read.parseError ? [] : maskFields(configFields(name, read.content ?? {})),
    };
  }

  async function saveConfig(name, body) {
    const file = configPath(name);
    if (!(await fileExists(file))) {
      const error = new Error(t('web.config.noCreate', { name }));
      error.status = 404;
      throw error;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      const error = new Error(t('web.config.bodyObject'));
      error.status = 400;
      throw error;
    }

    const previous = await readConfigFile(name);
    if (previous.parseError) {
      const error = new Error(t('web.config.brokenOnDisk', { name, message: previous.parseError }));
      error.status = 409;
      throw error;
    }

    const merged = mergeMasked(cloneJson(body), previous.content ?? {});

    // 先备份旧文件，再原子写
    const backupFile = path.join(backupDir, `${name}-${fileStamp()}.json`);
    await ensureDir(backupDir);
    await fs.copyFile(file, backupFile);
    const text = `${JSON.stringify(merged, null, 2)}\n`;
    await writeTextAtomic(file, text);

    let levelChanged = null;
    const oldLevel = previous.content?.logLevel ?? null;
    const newLevel = merged?.logLevel ?? null;
    if (name === 'bot' && newLevel && newLevel !== oldLevel && logger?.setLevel) {
      try {
        logger.setLevel(newLevel);
        levelChanged = newLevel;
      } catch (error) {
        log?.warn?.(t('web.config.setLevelFailed'), error);
      }
    }

    logger?.operation?.({
      actor: 'web-panel',
      action: 'config_save',
      target: `config/${name}.json`,
      ok: true,
      detail: { backup: path.relative(rootDir, backupFile).replace(/\\/g, '/'), levelChanged },
    });
    log?.info?.(t('web.config.saved', { name, backup: path.relative(rootDir, backupFile).replace(/\\/g, '/') }));

    return {
      ok: true,
      name,
      file: path.relative(rootDir, file).replace(/\\/g, '/'),
      backup: backupFile,
      backupRelative: path.relative(rootDir, backupFile).replace(/\\/g, '/'),
      bytes: Buffer.byteLength(text),
      levelChanged,
      content: maskSecrets(merged),
    };
  }

  // —— /api/tools ——

  async function toolsPayload() {
    const tools = services?.tools;
    if (!tools) {
      return {
        ok: true,
        mode,
        count: 0,
        tools: [],
        note: t('web.tools.note'),
      };
    }
    const list = tools instanceof Map ? [...tools.values()] : Array.isArray(tools) ? tools : [];
    return {
      ok: true,
      mode,
      count: list.length,
      tools: list.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        sensitive: Boolean(tool.sensitive),
        action: tool.action ?? null,
        parameters: tool.parameters ?? null,
      })),
      allowedSidecarMethods: SIDECAR_ALLOWED,
    };
  }

  // —— /api/tasks ——

  function trimTask(task) {
    if (!task || typeof task !== 'object') return task ?? null;
    const result = task.result == null ? null : String(task.result);
    return {
      id: task.id,
      goal: task.goal,
      status: task.status,
      progress: task.progress,
      note: task.note ?? null,
      error: task.error ?? null,
      scene: task.scene,
      userId: task.userId,
      groupId: task.groupId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt ?? null,
      stepCount: Array.isArray(task.steps) ? task.steps.length : 0,
      steps: Array.isArray(task.steps)
        ? task.steps.slice(-10).map((step) => ({
            index: step.index,
            tool: step.tool ?? null,
            thought: step.thought ? String(step.thought).slice(0, 400) : null,
            error: step.error ?? null,
            at: step.at ?? null,
          }))
        : [],
      result: result && result.length > 2000 ? `${result.slice(0, 2000)}${t('web.tasks.truncated')}` : result,
      resultLength: result ? result.length : 0,
    };
  }

  function tasksPayload() {
    const registry = services?.tasks;
    if (!registry?.list) {
      return { ok: true, mode, count: 0, tasks: [], stats: null, note: t('web.tasks.note') };
    }
    const rows = safe(() => registry.list({}), []);
    const list = Array.isArray(rows) ? rows : [];
    return {
      ok: true,
      mode,
      count: list.length,
      active: list.filter((task) => task?.status === 'running' || task?.status === 'waiting').length,
      stats: safe(() => registry.stats?.(), null),
      tasks: list.slice(0, 50).map(trimTask),
    };
  }

  function stopTask(body) {
    const id = String(body?.id ?? '').trim();
    if (!id) {
      const error = new Error(t('web.tasks.needId'));
      error.status = 400;
      throw error;
    }
    const registry = requireService(services?.tasks, t('web.debug.service.tasks'));
    const task = safe(() => registry.get?.(id) ?? null);
    if (!task) {
      const error = new Error(t('web.tasks.notFound', { id }));
      error.status = 404;
      throw error;
    }
    const stopped = safe(() => services?.agent?.cancel?.(id) ?? registry.cancel?.(id) ?? null, null);
    logger?.operation?.({ actor: 'web-panel', action: 'task_stop', target: id, ok: Boolean(stopped) });
    return { ok: true, id, task: trimTask(stopped ?? registry.get?.(id) ?? task) };
  }

  // —— /api/debug/* ——

  /**
   * 在调用期间临时包住 onebot.sendTo：采集机器人真正发出去的内容。
   * dryRun 时，只拦「目标正好是这次模拟消息的会话」的发送，别的会话照常发出去，
   * 免得调试期间把真实的主动发言吞掉。并发调试用一条串行队列，不会互相抢钩子。
   */
  let hookChain = Promise.resolve();

  function withSendHook({ dryRun, target, outbound }, task) {
    const run = async () => {
      const onebot = services?.onebot;
      if (!onebot || typeof onebot.sendTo !== 'function') return task();
      const original = onebot.sendTo;
      let seq = 0;
      const wrapper = function wrappedSendTo(sendTarget = {}, content) {
        const scene = sendTarget.scene ?? (sendTarget.groupId ? 'group' : 'private');
        const record = {
          scene,
          userId: sendTarget.userId ?? null,
          groupId: sendTarget.groupId ?? null,
          segments: Array.isArray(content) ? content : [{ type: 'text', data: { text: String(content ?? '') } }],
          at: Date.now(),
        };
        outbound.push(record);
        const sameTarget =
          scene === target.scene &&
          String(record.userId ?? '') === String(target.userId ?? '') &&
          String(record.groupId ?? '') === String(target.groupId ?? '');
        if (dryRun && sameTarget) {
          seq += 1;
          return Promise.resolve({ message_id: `dry-run-${seq}`, dryRun: true });
        }
        return original.call(onebot, sendTarget, content);
      };
      onebot.sendTo = wrapper;
      try {
        return await task();
      } finally {
        if (onebot.sendTo === wrapper) onebot.sendTo = original;
      }
    };
    const next = hookChain.then(run, run);
    hookChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  function collectLogs() {
    const bucket = [];
    let active = true;
    captures.set(bucket, bucket);
    if (typeof logger?.onEvent !== 'function') captures.delete(bucket);
    const unsubscribe = typeof logger?.onEvent === 'function'
      ? logger.onEvent((event) => {
          if (!active) return;
          const entry = fromProcessEvent(event);
          if (entry && bucket.length < CAPTURE_MAX) bucket.push(entry);
        })
      : null;
    return {
      bucket,
      stop() {
        active = false;
        captures.delete(bucket);
        try {
          unsubscribe?.();
        } catch {
          /* 忽略 */
        }
      },
    };
  }

  function segmentsToText(segments = []) {
    return segments
      .map((segment) => {
        if (!segment || typeof segment !== 'object') return String(segment ?? '');
        if (segment.type === 'text') return String(segment.data?.text ?? '');
        if (segment.type === 'at') return t('web.debug.segment.at', { qq: segment.data?.qq ?? '' });
        if (segment.type === 'face') return t('web.debug.segment.face', { id: segment.data?.id ?? '' });
        if (segment.type === 'image') return t('web.debug.segment.image', { file: segment.data?.file ?? '' });
        return t('web.debug.segment.other', { type: segment.type });
      })
      .join('');
  }

  async function debugMessage(body = {}) {
    const dispatcher = requireService(services?.dispatcher?.handleMessage ? services.dispatcher : null, t('web.debug.service.dispatcher'));

    const scene = body.scene === 'group' ? 'group' : 'private';
    const userId = Number(body.userId);
    const groupId = scene === 'group' ? Number(body.groupId) : null;
    const nickname = String(
      body.nickname ?? (scene === 'group' ? t('web.debug.nick.group', { id: body.userId ?? '' }) : t('web.debug.nick.private', { id: body.userId ?? '' })),
    );
    const text = String(body.text ?? '');
    const images = Array.isArray(body.images) ? body.images.map((item) => String(item)).filter(Boolean) : [];
    const dryRun = Boolean(body.dryRun);

    if (!Number.isFinite(userId) || userId <= 0) {
      const error = new Error(t('web.debug.needUserId'));
      error.status = 400;
      throw error;
    }
    if (scene === 'group' && (!Number.isFinite(groupId) || groupId <= 0)) {
      const error = new Error(t('web.debug.needGroupId'));
      error.status = 400;
      throw error;
    }

    const botSelfId = Number(services?.onebot?.loginInfo?.()?.user_id ?? 0) || Number(config?.bot?.onebot?.selfId ?? 0) || 0;
    const selfId = botSelfId || userId;
    const segments = [];
    if (scene === 'group' && body.at !== false) segments.push({ type: 'at', data: { qq: String(selfId) } });
    for (const image of images) segments.push({ type: 'image', data: { file: image } });
    segments.push({ type: 'text', data: { text } });

    const raw = {
      post_type: 'message',
      message_type: scene,
      sub_type: scene === 'group' ? 'normal' : 'friend',
      message_id: null,
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
      user_id: userId,
      sender: { user_id: userId, nickname, card: null, role: null },
      message: segments,
      raw_message: text,
    };
    if (scene === 'group') raw.group_id = groupId;

    const { normalizeMessage } = await import('../onebot/segments.js');
    const message = normalizeMessage(raw);

    const outbound = [];
    const captured = collectLogs();
    const before = safe(() => services?.reply?.state?.() ?? null, null);
    const startedAtMs = Date.now();
    let result = null;
    let failure = null;
    try {
      result = await withSendHook({ dryRun, target: { scene, userId, groupId }, outbound }, () => dispatcher.handleMessage(message));
    } catch (error) {
      failure = error;
    } finally {
      captured.stop();
    }
    const elapsedMs = Date.now() - startedAtMs;
    const after = safe(() => services?.reply?.state?.() ?? null, null);

    const outboundView = outbound.map((record) => ({
      scene: record.scene,
      userId: record.userId,
      groupId: record.groupId,
      at: record.at,
      segments: record.segments,
      text: segmentsToText(record.segments),
    }));

    if (failure) {
      const error = new Error(t('web.debug.chainFailed', { message: failure.message }));
      error.status = 500;
      error.payload = {
        ok: false,
        error: error.message,
        elapsedMs,
        dryRun,
        logs: captured.bucket,
        outbound: outboundView,
        replyState: { before, after },
      };
      throw error;
    }

    return {
      ok: true,
      mode,
      dryRun,
      elapsedMs,
      request: { scene, userId, groupId, nickname, text, images, at: scene === 'group' ? body.at !== false : false },
      message: {
        scene: message.scene,
        userId: message.userId,
        groupId: message.groupId,
        isAt: message.isAt,
        text: message.text,
        display: message.display,
      },
      result,
      skipped: result === null || result === undefined,
      note:
        result === null || result === undefined
          ? t('web.debug.skippedNote')
          : null,
      outbound: outboundView,
      replyState: { before, after },
      logs: captured.bucket,
    };
  }

  async function debugLlm(body = {}) {
    const llm = requireService(services?.llm?.chat ? services.llm : null, t('web.debug.service.llm'));
    let messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages) {
      const prompt = body.prompt === undefined ? '' : String(body.prompt);
      messages = [{ role: String(body.messageRole ?? 'user'), content: prompt }];
    }
    if (!messages.length) {
      const error = new Error(t('web.debug.needPrompt'));
      error.status = 400;
      throw error;
    }
    const role = String(body.role ?? 'chat');
    const startedAtMs = Date.now();
    try {
      const result = await llm.chat({
        messages,
        role,
        json: Boolean(body.json),
        maxTokens: body.maxTokens === undefined || body.maxTokens === null || body.maxTokens === '' ? null : Number(body.maxTokens),
        model: body.model ? String(body.model) : null,
        temperature: body.temperature === undefined || body.temperature === null || body.temperature === '' ? null : Number(body.temperature),
        stream: false,
      });
      const content = String(result?.content ?? '');
      return {
        ok: true,
        role,
        model: result?.model ?? null,
        elapsedMs: Date.now() - startedAtMs,
        content,
        contentLength: content.length,
        finishReason: result?.finishReason ?? null,
        truncated: result?.finishReason === 'length',
        usage: result?.usage ?? null,
        json: result?.json ?? null,
        toolCalls: (result?.toolCalls ?? []).map((call) => ({ name: call.name, arguments: call.arguments })),
      };
    } catch (error) {
      const wrapped = new Error(t('web.debug.llmFailed', { code: error.code ?? error.name, message: error.message }));
      wrapped.status = 502;
      wrapped.payload = { ok: false, error: wrapped.message, code: error.code ?? null, elapsedMs: Date.now() - startedAtMs };
      throw wrapped;
    }
  }

  async function debugTool(body = {}) {
    const tools = requireService(services?.tools, t('web.debug.service.tools'));
    const name = String(body.name ?? '').trim();
    if (!name) {
      const error = new Error(t('web.debug.needToolName'));
      error.status = 400;
      throw error;
    }
    const tool = tools instanceof Map ? tools.get(name) : Array.isArray(tools) ? tools.find((item) => item?.name === name) : null;
    if (!tool) {
      const error = new Error(t('web.debug.toolNotFound', { name }));
      error.status = 404;
      throw error;
    }
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const adminId = Number(config?.security?.admins?.[0] ?? 0) || 10001;
    const ctx = {
      userId: Number(body.userId ?? adminId) || adminId,
      scene: body.scene === 'group' ? 'group' : 'private',
      groupId: body.scene === 'group' ? Number(body.groupId ?? 0) || null : null,
      taskId: 'web_debug',
      task: null,
      message: null,
      services,
      logger: log,
      signal: new AbortController().signal,
    };
    const startedAtMs = Date.now();
    try {
      const result = await tool.run(args, ctx);
      return {
        ok: true,
        name,
        sensitive: Boolean(tool.sensitive),
        action: tool.action ?? null,
        elapsedMs: Date.now() - startedAtMs,
        result: serializeResult(result),
      };
    } catch (error) {
      const wrapped = new Error(t('web.debug.toolFailed', { name, code: error.code ?? error.name, message: error.message }));
      wrapped.status = 400;
      wrapped.payload = {
        ok: false,
        error: wrapped.message,
        name,
        code: error.code ?? null,
        elapsedMs: Date.now() - startedAtMs,
      };
      throw wrapped;
    }
  }

  function serializeResult(result) {
    if (result === undefined) return null;
    try {
      JSON.stringify(result);
      return result;
    } catch {
      return String(result);
    }
  }

  async function debugSidecar(body = {}) {
    const sidecar = requireService(services?.sidecar, t('web.debug.service.sidecar'));
    const method = String(body.method ?? '').trim();
    if (!method) {
      const error = new Error(t('web.debug.needSidecarMethod'));
      error.status = 400;
      throw error;
    }
    const handler = SIDECAR_METHODS[method];
    if (!handler) {
      const error = new Error(t('web.debug.sidecarNotAllowed', { method, allowed: SIDECAR_ALLOWED.join('\u3001') }));
      error.status = 400;
      throw error;
    }
    const startedAtMs = Date.now();
    try {
      const result = await handler(sidecar, body.params ?? null);
      return {
        ok: true,
        method,
        elapsedMs: Date.now() - startedAtMs,
        result: serializeResult(result),
        available: safe(() => sidecar.available ?? null),
      };
    } catch (error) {
      const wrapped = new Error(t('web.debug.sidecarFailed', { method, message: error.message }));
      wrapped.status = 502;
      wrapped.payload = { ok: false, error: wrapped.message, method, elapsedMs: Date.now() - startedAtMs };
      throw wrapped;
    }
  }

  // ——————————————— 生命周期 ———————————————

  function listenOn(instance, host, port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        instance.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        instance.removeListener('error', onError);
        resolve();
      };
      instance.once('error', onError);
      instance.once('listening', onListening);
      instance.listen(port, host);
    });
  }

  async function start() {
    if (running) return { host: boundHost, port: boundPort, url: currentUrl };
    if (!settings.enabled) {
      const error = new Error(t('web.error.disabled'));
      error.code = 'web_disabled';
      throw error;
    }
    if (!LOCAL_HOSTS.has(settings.host) && !settings.allowRemote) {
      throw new Error(t('web.error.remoteHost', { host: settings.host }));
    }
    if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
      throw new Error(t('web.error.badPort', { port: settings.port }));
    }

    let lastError = null;
    const requested = settings.port;
    for (let attempt = 0; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? requested : requested + attempt;
      if (candidate > 65535) break;
      if (attempt > 0 && RESERVED_PORTS.has(candidate)) continue;
      const instance = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
          log?.error?.(t('web.api.requestFailed'), error);
          if (!response.headersSent) fail(response, 500, error.message ?? t('web.error.internal'));
          else response.end();
        });
      });
      try {
        await listenOn(instance, settings.host, candidate);
      } catch (error) {
        try {
          instance.close();
        } catch {
          /* 忽略 */
        }
        if (attempt < MAX_PORT_ATTEMPTS && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
          // 占着端口的是另一个若华面板时，这次就别再开一个了：真机上就是这么冒出「两个控制面板」的
          // —— 8787 被旧面板占着，新面板悄悄退到 8788，用户一启动程序就看到两个。
          // 如实记一行，这个进程不开面板（机器人本体照常跑）；占着的是别的东西才照旧退到下一个端口。
          if (attempt === 0) {
            const existing = await probePanel(candidate, { fetchImpl: globalThis.fetch });
            if (existing) {
              log?.warn?.(t('web.start.panelExists', { port: existing.port, url: existing.url }));
              running = false;
              return { host: settings.host, port: null, url: null, mode, existing };
            }
          }
          lastError = error;
          continue;
        }
        throw new Error(
          t('web.error.listenFailed', {
            host: settings.host,
            port: candidate,
            code: error.code ?? error.name,
            message: error.message,
          }),
          { cause: error },
        );
      }
      server = instance;
      // port 0 时由系统分配，得回头问它到底给了哪个
      boundPort = Number(instance.address()?.port ?? candidate);
      break;
    }
    if (!server) {
      throw new Error(
        t('web.error.noFreePort', { port: requested, attempts: MAX_PORT_ATTEMPTS, message: lastError?.message ?? 'unknown' }),
      );
    }

    boundHost = settings.host;
    currentUrl = `http://${displayHost(settings.host)}:${boundPort}`;
    startedAt = Date.now();
    running = true;

    server.on('error', (error) => log?.error?.(t('web.server.error'), error));
    server.on('clientError', (error, socket) => {
      log?.debug?.(t('web.server.clientError'), error);
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
    });

    wss = new WebSocketServer({ noServer: true, clientTracking: false });
    wss.on('error', (error) => log?.warn?.(t('web.ws.serverError'), error));
    server.on('upgrade', handleUpgrade);

    startHeartbeat();
    startTailer();

    if (typeof logger?.onEvent === 'function') {
      try {
        unsubscribeLogger = logger.onEvent((event) => pushEntry(fromProcessEvent(event)));
      } catch (error) {
        log?.warn?.(t('web.logs.subscribeFailed'), error);
      }
    }

    log?.info?.(t('web.start.up', { url: currentUrl, mode: mode === 'attached' ? t('web.mode.attached') : t('web.mode.standalone') }));
    if (settings.token) log?.info?.(t('web.start.token'));
    if (requested !== 0 && boundPort !== requested) log?.warn?.(t('web.start.portChanged', { from: requested, to: boundPort }));
    if (settings.openBrowser) {
      const opened = await openInBrowser(currentUrl);
      if (!opened) log?.warn?.(t('web.start.browserFailed', { url: currentUrl }));
    }

    return { host: boundHost, port: boundPort, url: currentUrl };
  }

  async function stop() {
    running = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (flushTimer) clearTimeout(flushTimer);
    heartbeatTimer = null;
    flushTimer = null;
    stopTailer();

    try {
      unsubscribeLogger?.();
    } catch {
      /* 忽略 */
    }
    unsubscribeLogger = null;

    for (const socket of clients.keys()) {
      try {
        socket.close(1001, t('web.ws.closeReason'));
      } catch {
        /* 忽略 */
      }
    }
    clients.clear();
    captures.clear();

    if (wss) {
      try {
        wss.close();
      } catch {
        /* 忽略 */
      }
      wss = null;
    }

    const closing = server;
    server = null;
    if (closing) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          closing.close(done);
        } catch {
          done();
        }
        try {
          closing.closeAllConnections?.();
        } catch {
          /* 忽略 */
        }
        const timer = setTimeout(done, 1000);
        timer.unref?.();
      });
    }
    startedAt = 0;
    log?.info?.(t('web.start.stopped'));
  }

  function info() {
    return {
      running,
      host: boundHost,
      port: boundPort,
      url: currentUrl,
      clients: clients.size,
      mode,
    };
  }

  return { start, stop, info };
}
