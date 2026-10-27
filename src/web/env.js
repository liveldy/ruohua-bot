/**
 * 控制面板的 .env 字段表：分组、类型、脱敏，以及「读出来给表单 / 把表单写回去」两件事。
 *
 * 键的 label/desc 文字是 `web.env.<KEY>.label` / `web.env.<KEY>.desc`（见
 * src/i18n/locales/zh-CN/web.json）。这里只给键名和字段名，不给中文。
 *
 * 密钥字段（secret: true）照原样给真值 —— 表单默认把它按密码框打码，点「显示」才看得见明文。
 * 保存时若原样送回 MASK，仍按「这个值不改」处理（老前端 / 手改请求的兼容路径）。
 */

import { readEnvFile, writeEnvFile } from '../config/env.js';

/** 脱敏占位符：前端原样送回表示「这个值不改」。 */
export const MASK = '********';

/** .env 字段表：顺序就是表单里的顺序。 */
export const ENV_GROUPS = [
  {
    id: 'model',
    titleKey: 'web.env.group.model',
    fields: [
      { key: 'MODEL_BASE_URL', type: 'text', secret: false, example: 'https://api.deepseek.com/v1' },
      { key: 'MODEL_API_KEY', type: 'text', secret: true, example: null },
      { key: 'MODEL_NAME', type: 'text', secret: false, example: 'deepseek-chat' },
      { key: 'MODEL_VISION_NAME', type: 'text', secret: false, example: '' },
    ],
  },
  {
    id: 'onebot',
    titleKey: 'web.env.group.onebot',
    fields: [
      { key: 'ONEBOT_MODE', type: 'enum', options: ['forward', 'reverse', 'http'], secret: false, example: 'forward' },
      { key: 'ONEBOT_WS_URL', type: 'text', secret: false, example: 'ws://127.0.0.1:3001' },
      { key: 'ONEBOT_ACCESS_TOKEN', type: 'text', secret: true, example: null },
      { key: 'ONEBOT_REVERSE_PORT', type: 'number', secret: false, example: '3002' },
      { key: 'ONEBOT_HTTP_URL', type: 'text', secret: false, example: 'http://127.0.0.1:3000' },
    ],
  },
  {
    id: 'admin',
    titleKey: 'web.env.group.admin',
    fields: [{ key: 'ADMIN_QQ', type: 'text', secret: false, example: '' }],
  },
  {
    id: 'sidecar',
    titleKey: 'web.env.group.sidecar',
    fields: [
      { key: 'SIDECAR_ENABLED', type: 'boolean', secret: false, example: 'true' },
      { key: 'SIDECAR_URL', type: 'text', secret: false, example: 'http://127.0.0.1:8765' },
      { key: 'SIDECAR_AUTOSTART', type: 'boolean', secret: false, example: 'true' },
      { key: 'SIDECAR_PYTHON', type: 'text', secret: false, example: 'python' },
    ],
  },
  {
    id: 'log',
    titleKey: 'web.env.group.log',
    fields: [{ key: 'LOG_LEVEL', type: 'enum', options: ['debug', 'info', 'warn', 'error'], secret: false, example: 'info' }],
  },
  {
    id: 'web',
    titleKey: 'web.env.group.web',
    fields: [
      { key: 'WEB_ENABLED', type: 'boolean', secret: false, example: 'true' },
      { key: 'WEB_HOST', type: 'text', secret: false, example: '127.0.0.1' },
      { key: 'WEB_PORT', type: 'number', secret: false, example: '8787' },
      { key: 'WEB_TOKEN', type: 'text', secret: true, example: null },
      { key: 'WEB_ALLOW_REMOTE', type: 'boolean', secret: false, example: 'false' },
    ],
  },
  {
    id: 'sandbox',
    titleKey: 'web.env.group.sandbox',
    fields: [{ key: 'BOUNDARY_MODE', type: 'enum', options: ['sandbox', 'trusted'], secret: false, example: 'sandbox' }],
  },
];

/** 键 → 字段定义（快查）。 */
export const ENV_FIELDS = new Map(ENV_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, { ...field, group: group.id }])));

/** 全部键（按字段表顺序）。 */
export function envKeys() {
  return ENV_GROUPS.flatMap((group) => group.fields.map((field) => field.key));
}

export function envLabelKey(key) {
  return `web.env.${key}.label`;
}

export function envDescKey(key) {
  return `web.env.${key}.desc`;
}

function fieldView(field, values) {
  const present = Object.prototype.hasOwnProperty.call(values, field.key);
  const raw = present ? values[field.key] : '';
  return {
    key: field.key,
    labelKey: envLabelKey(field.key),
    descKey: envDescKey(field.key),
    type: field.type,
    options: field.options ?? null,
    secret: Boolean(field.secret),
    // 真值照给：密钥字段在这台机器的页面上本来就是明文可编辑的（「高级：直接编辑 .env 文本」也是全量），
    // 给 MASK 只会让「显示」按钮点开还是 ********，等于看不见。
    value: raw,
    set: present,
    example: field.secret ? null : field.example ?? null,
  };
}

/**
 * 读出 .env 的表单视图。
 * @param {string} file .env 的绝对路径
 */
export function envView(file) {
  const read = readEnvFile(file);
  const values = {};
  for (const entry of read.entries) values[entry.key] = entry.value;
  return {
    file: read.file,
    exists: read.exists,
    keys: envKeys(),
    groups: ENV_GROUPS.map((group) => ({
      key: group.id,
      titleKey: group.titleKey,
      fields: group.fields.map((field) => fieldView(field, values)),
    })),
  };
}

/** 表单送回的值：MASK 表示沿用旧值，其余（含空串）照写。 */
export function mergeEnvMasked(values = {}, previous = {}) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === MASK && Object.prototype.hasOwnProperty.call(previous, key)) {
      out[key] = previous[key];
      continue;
    }
    out[key] = value === null || value === undefined ? '' : String(value);
  }
  return out;
}

/**
 * 写回 .env：只动字段表里出现过的键，密钥字段的 MASK 回填旧值，写前备份。
 * @returns {{ file: string, changed: string[], backup: string|null, view: object }}
 */
export function applyEnvUpdate(file, values = {}, { backupDir = null, now = Date.now() } = {}) {
  const unknown = Object.keys(values ?? {}).filter((key) => !ENV_FIELDS.has(key));
  if (unknown.length) {
    const error = new Error(`unknown env keys: ${unknown.join(', ')}`);
    error.code = 'env_unknown_key';
    error.keys = unknown;
    throw error;
  }
  const read = readEnvFile(file);
  const previous = {};
  for (const entry of read.entries) previous[entry.key] = entry.value;

  const masked = mergeEnvMasked(values, previous);
  const result = writeEnvFile(file, masked, { backupDir, now });
  return {
    file: result.file,
    changed: result.changed,
    applied: result.applied,
    backup: result.backup,
    view: envView(file),
  };
}

export default { MASK, ENV_GROUPS, ENV_FIELDS, envKeys, envView, applyEnvUpdate, mergeEnvMasked };
