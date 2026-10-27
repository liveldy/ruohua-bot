/** 记忆模块测试的公共夹具：临时目录、配置、假日志 / 假模型 / 假侧车。 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNullLogger } from '../../src/logging/logger.js';

/** 这个文件里建过的临时目录，跑完由使用方调 cleanupTempDirs() 统一删掉。 */
const TEMP_DIRS = [];

export async function makeTempDir(prefix = 'ruohua-memory') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

/** 清掉本文件建过的临时目录（各测试文件用 node:test 的 after 挂钩调用）。 */
export async function cleanupTempDirs() {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
}

export const BASE_MEMORY = {
  enabled: true,
  perUser: true,
  temporary: { capacity: 400, halfLifeHours: 72, minScore: 0.12, maxAgeDays: 60, promoteAfterAccess: 4 },
  permanent: { capacity: 200, minImportance: 0.75, keywords: ['生日', '约定', '第一次'], neverForget: true },
  recall: { topK: 12, weights: { relevance: 0.5, recency: 0.3, importance: 0.2 }, minScore: 0.15 },
  consolidate: { intervalMinutes: 30, batch: 60, mergeSimilarity: 0.92, summaryMaxChars: 120 },
  extract: { enabled: true, maxItemsPerTurn: 3, minChars: 6 },
};

export function makeConfig({ memory = {}, ...rest } = {}) {
  return {
    persona: { name: '若华' },
    ...rest,
    memory: {
      ...BASE_MEMORY,
      ...memory,
      temporary: { ...BASE_MEMORY.temporary, ...(memory.temporary ?? {}) },
      permanent: { ...BASE_MEMORY.permanent, ...(memory.permanent ?? {}) },
      recall: { ...BASE_MEMORY.recall, ...(memory.recall ?? {}) },
      consolidate: { ...BASE_MEMORY.consolidate, ...(memory.consolidate ?? {}) },
      extract: { ...BASE_MEMORY.extract, ...(memory.extract ?? {}) },
    },
  };
}

export function makeLogger() {
  return createNullLogger();
}

/** 假模型：给定数组 / 字符串 / 函数（返回数组或 Error）。 */
export function makeLlm(items) {
  const calls = [];
  return {
    calls,
    async chat(params) {
      calls.push(params);
      const value = typeof items === 'function' ? items(params) : items;
      if (value instanceof Error) throw value;
      return {
        content: typeof value === 'string' ? value : JSON.stringify(value),
        json: value,
        toolCalls: [],
        usage: {},
        model: 'mock',
        finishReason: 'stop',
      };
    },
  };
}

/** 假侧车：字符袋向量（零依赖、确定性），够用来验证余弦相似度链路。 */
export function makeVector(text, dim = 64) {
  const vector = new Array(dim).fill(0);
  for (const char of String(text)) {
    vector[char.codePointAt(0) % dim] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function makeSidecar({ fail = false } = {}) {
  return {
    available: !fail,
    async embed(texts) {
      if (fail) return null;
      if (!Array.isArray(texts)) return null;
      return texts.map((text) => makeVector(text));
    },
  };
}

export async function readMemoryFile(dir, userId) {
  const raw = await fs.readFile(path.join(dir, `${userId}.jsonl`), 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
