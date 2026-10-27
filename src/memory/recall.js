/**
 * 记忆召回与打分。
 *
 * 记忆强度借鉴 ReMe 的思路（重要性 × 时间衰减 × 访问次数）：
 * - relevance 相关性：优先用向量余弦（由调用方传入的 similarity 函数），没有就退化为
 *   关键词 / 字符重合度；
 * - recency 新鲜度：按创建时间指数衰减，半衰期取 config.memory.temporary.halfLifeHours，
 *   被想起过的记忆半衰期加倍延长（访问次数越多越难忘）；永久记忆不随时间变淡；
 * - importance 重要性：由提炼时打的分数决定。
 */

import { t } from '../i18n/index.js';
import { clamp } from '../util/common.js';

export const DEFAULT_WEIGHTS = { relevance: 0.5, recency: 0.3, importance: 0.2 };
export const DEFAULT_HALF_LIFE_HOURS = 72;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 比对用的归一化：小写、去掉标点与空白。 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 取词：中文取二字片段（短句补整体），英文数字取单词。 */
function toTerms(normalized) {
  const out = new Set();
  if (!normalized) return out;
  const runs = normalized.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]+|[a-z0-9_]+/g) ?? [];
  for (const run of runs) {
    if (/^[a-z0-9_]+$/.test(run)) {
      if (run.length >= 2) out.add(run);
      continue;
    }
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    if (run.length <= 3) out.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 关键词 / 字符重合度（0..1）：Dice 系数 + 包含关系加成。 */
export function keywordSimilarity(a, b) {
  const left = normalizeForMatch(a);
  const right = normalizeForMatch(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const setA = toTerms(left);
  const setB = toTerms(right);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const term of setA) {
    if (setB.has(term)) shared += 1;
  }
  const dice = (2 * shared) / (setA.size + setB.size);
  let containment = 0;
  if (left.includes(right) || right.includes(left)) {
    const short = Math.min(left.length, right.length);
    const long = Math.max(left.length, right.length);
    containment = 0.5 + 0.5 * (short / long);
  }
  return clamp(Math.max(dice, containment), 0, 1);
}

/** 时间衰减因子 0..1：半衰期越长越难忘，被访问过的记忆衰减更慢。 */
export function recencyFactor(record, { now = Date.now(), halfLifeHours = DEFAULT_HALF_LIFE_HOURS } = {}) {
  const createdAt = Number(record?.createdAt);
  const ageHours = Number.isFinite(createdAt) ? Math.max(0, (now - createdAt) / HOUR_MS) : 0;
  const halfLife = Number(halfLifeHours) > 0 ? Number(halfLifeHours) : DEFAULT_HALF_LIFE_HOURS;
  const accessCount = Math.max(0, Math.trunc(Number(record?.accessCount)) || 0);
  const effectiveHalfLife = halfLife * (1 + Math.log1p(accessCount));
  return clamp(0.5 ** (ageHours / effectiveHalfLife), 0, 1);
}

/** 记忆强度：重要性 × 时间衰减（巩固时判断该不该忘掉）。 */
export function memoryStrength(record, { now = Date.now(), halfLifeHours = DEFAULT_HALF_LIFE_HOURS } = {}) {
  const importance = Number(record?.importance);
  return clamp(Number.isFinite(importance) ? importance : 0, 0, 1) * recencyFactor(record, { now, halfLifeHours });
}

function relevanceOf(record, query, similarity) {
  const content = String(record?.content ?? '');
  const text = String(query ?? '').trim();
  if (!text) return 0.5; // 没有查询词时不做相关性区分
  if (typeof similarity === 'function') {
    try {
      const value = similarity(text, content);
      if (typeof value === 'number' && Number.isFinite(value)) return clamp(value, 0, 1);
    } catch {
      /* 相似度函数出错就退回关键词比对 */
    }
  }
  return keywordSimilarity(text, content);
}

/**
 * 单条记忆的综合分数：relevance × W + recency × W + importance × W。
 * 永久记忆的 recency 权重为 0（不随时间变淡）。
 */
export function scoreRecord(record, { query = '', now = Date.now(), weights = null, similarity = null, halfLifeHours = DEFAULT_HALF_LIFE_HOURS } = {}) {
  const merged = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const importance = Number(record?.importance);
  const recencyWeight = record?.kind === 'permanent' ? 0 : merged.recency ?? 0;
  return (
    (merged.relevance ?? 0) * relevanceOf(record, query, similarity)
    + recencyWeight * recencyFactor(record, { now, halfLifeHours })
    + (merged.importance ?? 0) * (Number.isFinite(importance) ? clamp(importance, 0, 1) : 0)
  );
}

/**
 * 召回：只在该 userId 自己的记忆里找（私聊与群聊之间不串别人的隐私记忆）。
 * 命中后更新 accessCount / lastAccessAt（先算分再更新，避免这次召回给自己加分）。
 */
export async function recall(store, { userId, scene = null, query = '', topK = null, now = Date.now(), similarity = null, weights = null, minScore = null, halfLifeHours = null, logger = null } = {}) {
  const log = logger ?? store?.logger ?? null;
  if (!store || userId === undefined || userId === null) return [];
  const memoryConfig = store.config?.memory ?? {};
  const recallConfig = memoryConfig.recall ?? {};
  const limit = Math.max(0, Math.trunc(Number(topK ?? recallConfig.topK ?? 12)) || 0);
  if (!limit) return [];
  const threshold = Number(minScore ?? recallConfig.minScore ?? 0.15);
  const finalWeights = { ...DEFAULT_WEIGHTS, ...(recallConfig.weights ?? {}), ...(weights ?? {}) };
  const halfLife = Number(halfLifeHours ?? memoryConfig.temporary?.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS);

  try {
    await store.load(userId);
    const candidates = store.list(userId, {});
    const scored = candidates
      .map((record) => ({ record, score: scoreRecord(record, { query, now, weights: finalWeights, similarity, halfLifeHours: halfLife }) }))
      .filter((item) => item.score >= threshold)
      .sort(
        (a, b) =>
          b.score - a.score
          || (b.record.importance ?? 0) - (a.record.importance ?? 0)
          || (a.record.createdAt ?? 0) - (b.record.createdAt ?? 0),
      )
      .slice(0, limit);

    const hits = [];
    for (const item of scored) {
      const accessCount = (Number(item.record.accessCount) || 0) + 1;
      const updated = await store.update(userId, item.record.id, { accessCount, lastAccessAt: now });
      hits.push({ ...(updated ?? { ...item.record, accessCount, lastAccessAt: now }), score: item.score, scene: item.record.scene ?? scene });
    }
    return hits;
  } catch (error) {
    log?.warn?.(t('memory.recall.failed', { message: error.message }), error);
    return [];
  }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (!normA || !normB) return 0;
  return clamp(dot / Math.sqrt(normA * normB), 0, 1);
}

/**
 * 用侧车的 /embed 取向量并算余弦；侧车不可用时返回 null（调用方退回关键词比对）。
 * 返回的相似度函数是同步的：预置过向量的文本走余弦，其余退回字符重合度。
 */
export async function embedSimilarity(sidecar, texts = []) {
  if (!sidecar || typeof sidecar.embed !== 'function') return null;
  const list = [];
  const seen = new Set();
  for (const item of Array.isArray(texts) ? texts : []) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
  }
  if (!list.length) return null;

  let vectors = null;
  try {
    vectors = await sidecar.embed(list);
  } catch {
    return null;
  }
  if (!Array.isArray(vectors)) return null;

  const cache = new Map();
  list.forEach((text, index) => {
    if (Array.isArray(vectors[index]) && vectors[index].length) cache.set(text, vectors[index]);
  });
  if (!cache.size) return null;

  return (a, b) => {
    const left = typeof a === 'string' ? a.trim() : '';
    const right = typeof b === 'string' ? b.trim() : '';
    const vectorA = cache.get(left);
    const vectorB = cache.get(right);
    if (vectorA && vectorB) return cosine(vectorA, vectorB);
    return keywordSimilarity(left, right);
  };
}

export { HOUR_MS, DAY_MS };
