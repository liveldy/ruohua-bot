#!/usr/bin/env node
/**
 * 本地化（i18n）。
 *
 * 规矩：程序文件里不出现任何面向用户的文字，一律写成 t('命名空间.键')。
 * 文字本身放在 src/i18n/locales/<locale>/<命名空间>.json，键是「命名空间.xxx」的扁平写法，
 * 占位符用 {name}。管理员在控制面板里改了本地化键就落到 data/locales/<locale>.json，
 * 那份覆盖文件优先于代码自带的默认文字。
 *
 * 用法：
 *   import { t } from '../i18n/index.js';
 *   t('brain.reply.sent', { count: 3 })
 *
 * 约束：
 *   - 键必须是字面量，不许拼字符串（tests/unit/i18n.test.js 会扫）。
 *   - t() 是同步的，模块顶层就能调。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 代码自带的默认文字目录：src/i18n/locales/<locale>/<命名空间>.json */
export const BUILTIN_LOCALE_DIR = path.join(HERE, 'locales');

/** 默认语言。 */
export const DEFAULT_LOCALE = 'zh-CN';

const PLACEHOLDER_RE = /\{(\w+)\}/g;

// 本模块自己的报错文字：直接读自己的本地化键文件，免得「读文字失败」的时候又在读文字
let selfTable = null;
function selfT(key, params) {
  if (selfTable === null) {
    selfTable = readJsonObject(path.join(BUILTIN_LOCALE_DIR, DEFAULT_LOCALE, 'i18n.json')) ?? {};
  }
  const text = Object.prototype.hasOwnProperty.call(selfTable, key) ? selfTable[key] : key;
  return interpolate(text, params);
}

function readJsonObject(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error(selfT('i18n.error.invalidJson', { file, message: error.message }));
    parseError.code = 'i18n_invalid_json';
    throw parseError;
  }
}

function listEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * 读某个语言的全部默认文字：目录下每个 <命名空间>.json 合成一张扁平表。
 * 文件名就是命名空间，键必须以「命名空间.」开头。
 */
export function loadBuiltinTables(locale, dir = BUILTIN_LOCALE_DIR) {
  const localeDir = path.join(dir, locale);
  const tables = {};
  const problems = [];
  for (const entry of listEntries(localeDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const namespace = path.basename(entry.name, '.json');
    const content = readJsonObject(path.join(localeDir, entry.name));
    if (!content) continue;
    for (const [key, value] of Object.entries(content)) {
      if (typeof value !== 'string') {
        problems.push(selfT('i18n.problem.notString', { file: `${locale}/${entry.name}`, key }));
        continue;
      }
      if (!key.startsWith(`${namespace}.`)) {
        problems.push(selfT('i18n.problem.namespace', { file: `${locale}/${entry.name}`, key, namespace }));
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(tables, key)) {
        problems.push(selfT('i18n.problem.duplicate', { file: `${locale}/${entry.name}`, key }));
        continue;
      }
      tables[key] = value;
    }
  }
  return { tables, problems };
}

function interpolate(text, params) {
  if (!params || typeof params !== 'object') return text;
  return text.replace(PLACEHOLDER_RE, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * 本地化器。一般用模块级的 t()；要隔离的场合（面板、测试）自己 createI18n()。
 */
export function createI18n({ locale = DEFAULT_LOCALE, localeDir = BUILTIN_LOCALE_DIR, overrideFile = null } = {}) {
  const builtin = loadBuiltinTables(locale, localeDir);
  const overrides = {};
  const missing = new Map(); // key → 命中次数

  if (overrideFile) {
    const saved = readJsonObject(overrideFile);
    if (saved) {
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === 'string') overrides[key] = value;
      }
    }
  }

  const currentLocale = locale;

  function lookup(key) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (Object.prototype.hasOwnProperty.call(builtin.tables, key)) return builtin.tables[key];
    return undefined;
  }

  function t(key, params) {
    const name = String(key ?? '');
    let text = lookup(name);
    if (text === undefined) {
      missing.set(name, (missing.get(name) ?? 0) + 1);
      text = name;
    }
    return interpolate(text, params);
  }

  return {
    locale: currentLocale,
    problems: builtin.problems,
    t,
    has: (key) => lookup(String(key ?? '')) !== undefined,
    /** 全部键（含默认与覆盖），按字典序。 */
    keys: () => [...new Set([...Object.keys(builtin.tables), ...Object.keys(overrides)])].sort(),
    /** 生效中的本地化键表。 */
    table: () => {
      const out = { ...builtin.tables };
      for (const [key, value] of Object.entries(overrides)) out[key] = value;
      return out;
    },
    /** 代码自带的默认文字。 */
    defaults: () => ({ ...builtin.tables }),
    overrides: () => ({ ...overrides }),
    /** 有一条覆盖：面板改文字用。 */
    set(key, value) {
      const name = String(key ?? '');
      if (!name) throw new Error(selfT('i18n.error.emptyKey'));
      const text = String(value ?? '');
      if (text === builtin.tables[name]) delete overrides[name];
      else overrides[name] = text;
      missing.delete(name);
      return this;
    },
    setMany(entries = {}) {
      for (const [key, value] of Object.entries(entries)) this.set(key, value);
      return this;
    },
    /** 撤回一条覆盖，回到代码默认文字。 */
    reset(key) {
      delete overrides[String(key ?? '')];
      return this;
    },
    resetAll() {
      for (const key of Object.keys(overrides)) delete overrides[key];
      return this;
    },
    /** 与默认文字不同的键。 */
    changedKeys: () =>
      Object.keys(overrides)
        .filter((key) => overrides[key] !== builtin.tables[key])
        .sort(),
    /** 查过的、但不存在的键。 */
    missingKeys: () => [...missing.keys()].sort(),
    missingDetail: () => [...missing.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    clearMissing() {
      missing.clear();
      return this;
    },
    /** 覆盖落盘：只写与默认不同的键，attr 之外的东西不动。 */
    save(file = overrideFile) {
      if (!file) throw new Error(selfT('i18n.error.noOverrideFile'));
      const data = {};
      for (const key of Object.keys(overrides).sort()) {
        if (overrides[key] !== builtin.tables[key]) data[key] = overrides[key];
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = `${JSON.stringify(data, null, 2)}\n`;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
      return { file, count: Object.keys(data).length, bytes: Buffer.byteLength(text) };
    },
    /** 覆盖文件被人改过：重新读一遍（面板保存后别的进程要跟上）。 */
    reload() {
      if (!overrideFile) return this;
      for (const key of Object.keys(overrides)) delete overrides[key];
      const saved = readJsonObject(overrideFile);
      if (saved) {
        for (const [key, value] of Object.entries(saved)) {
          if (typeof value === 'string') overrides[key] = value;
        }
      }
      return this;
    },
    /** 覆盖文件路径（可能为 null）。 */
    overrideFile: () => overrideFile,
  };
}

// ————————————————— 模块级单例 —————————————————
// 各模块直接 import { t }，不用一层层传本地化器。

let singleton = createI18n({ locale: DEFAULT_LOCALE });

/**
 * 给单例换语言 / 挂覆盖文件。main.js 在装载配置之后调一次。
 * @param {{ locale?: string, localeDir?: string, overrideFile?: string|null }} options
 */
export function configureI18n({ locale = DEFAULT_LOCALE, localeDir = BUILTIN_LOCALE_DIR, overrideFile = null } = {}) {
  singleton = createI18n({ locale, localeDir, overrideFile });
  return singleton;
}

export function i18n() {
  return singleton;
}

/** 当前语言的覆盖文件路径。 */
export function localeOverridePath(rootDir, locale = DEFAULT_LOCALE) {
  return path.join(path.resolve(rootDir), 'data', 'locales', `${locale}.json`);
}

/** 取文字。找不到就返回键本身，并记进 missing（面板/自检能看到）。 */
export function t(key, params) {
  return singleton.t(key, params);
}

export function has(key) {
  return singleton.has(key);
}

export function keys() {
  return singleton.keys();
}

export function table() {
  return singleton.table();
}

export default { t, has, keys, table, i18n, configureI18n, createI18n, DEFAULT_LOCALE };
