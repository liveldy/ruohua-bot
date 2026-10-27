/**
 * 记忆服务：把对话提炼成记忆（永久 / 临时）、召回、巩固。
 *
 * 记忆机制（对应需求文档「记忆机制」）：
 * - 永久记忆：刻骨铭心、富有意义的事，由她自己判断值不值得记 —— 这里体现为提炼时的
 *   importance（0..1）与 permanent.keywords；永久记忆不随时间变淡，也不被遗忘淘汰。
 * - 临时记忆：最近的事几乎全记得，随时间慢慢变淡、被遗忘；被反复想起的（accessCount）
 *   衰减更慢，达标后升为永久记忆。
 *
 * 健壮性：所有对外方法内部 try/catch，出错只 logger.warn 并返回安全值。
 */

import { t } from '../i18n/index.js';
import { clamp, round } from '../util/common.js';
import { charLength, truncate } from '../util/text.js';
import { createMemoryStore } from './store.js';
import { embedSimilarity, keywordSimilarity, memoryStrength, normalizeForMatch, recall as recallRecords } from './recall.js';

const MAX_PERSONA_FACTS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const EXTRACT_SYSTEM_PROMPT = t('memory.service.extractPrompt');

/** 从正文里尽量抠出 JSON（模型没走 json_object 时的兜底）。 */
export function tryParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = /[[{][\s\S]*[\]}]/.exec(cleaned);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/** 把模型返回的 JSON 规整成条目数组；无法识别时返回 null（交给退化作答）。 */
export function toItemList(payload) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === 'object');
  if (payload && typeof payload === 'object') {
    for (const key of ['items', 'memories', 'memories_list', 'list', 'data', 'result']) {
      if (Array.isArray(payload[key])) {
        return payload[key].filter((item) => item && typeof item === 'object');
      }
    }
    if (typeof payload.content === 'string' && payload.content.trim()) {
      return [{ content: payload.content, importance: payload.importance, tags: payload.tags }];
    }
    return [];
  }
  return null;
}

export function createMemoryService({ config, llm, sidecar, logger, dir } = {}) {
  const log = logger?.child ? logger.child('memory') : logger ?? null;
  const memoryConfig = config?.memory ?? {};
  const extractConfig = memoryConfig.extract ?? {};
  const temporaryConfig = memoryConfig.temporary ?? {};
  const permanentConfig = memoryConfig.permanent ?? {};
  const consolidateConfig = memoryConfig.consolidate ?? {};
  const personaName = config?.persona?.name ?? t('memory.service.defaultPersonaName');

  const store = createMemoryStore({ config, logger: log, dir });

  const warn = (message, error) => {
    log?.warn?.(message, error instanceof Error ? error : undefined);
  };

  const debug = (message) => {
    log?.debug?.(message);
  };

  let lastConsolidateAt = null;

  // 同步预装载，让 list()/stats()/personaFacts() 这类同步方法一开始就能看到数据；
  // 再异步补一次，覆盖同步读盘时还不存在的文件。
  try {
    store.loadAllSync();
  } catch (error) {
    warn(t('memory.service.loadSyncFailed'), error);
  }
  const ready = store.loadAll().catch((error) => {
    warn(t('memory.service.loadFailed'), error);
  });

  const minChars = Math.max(1, Math.trunc(Number(extractConfig.minChars)) || 6);
  const maxItems = Math.max(0, Math.trunc(Number(extractConfig.maxItemsPerTurn)) || 3);
  const minImportance = Number.isFinite(Number(permanentConfig.minImportance)) ? Number(permanentConfig.minImportance) : 0.75;
  /**
   * 「有理由」时的下限（keywordMinImportance，默认 minImportance 的 2/3＝0.5）：
   * 命中关键词或提炼方显式要求只是**理由**，不是够格的证明 —— 重要性和它得同时成立。
   */
  const keywordMinImportance = Number.isFinite(Number(permanentConfig.keywordMinImportance))
    ? clamp(Number(permanentConfig.keywordMinImportance), 0, 1)
    : round(minImportance * (2 / 3), 3);
  const halfLifeHours = Number(temporaryConfig.halfLifeHours) > 0 ? Number(temporaryConfig.halfLifeHours) : 72;
  const summaryMaxChars = Math.max(10, Math.trunc(Number(consolidateConfig.summaryMaxChars)) || 120);

  /**
   * 永久还是临时：两条路，都得够格。
   *  1) importance ≥ permanent.minImportance（0.75）——重要到这个份上，不需要关键词背书；
   *  2) 有理由（命中 permanent.keywords，或提炼方显式说要 permanent）**且** importance ≥
   *     permanent.keywordMinImportance（默认 0.5）。
   * 原来只要命中关键词就升永久，真机上一轮留下 13 条永久记忆，一半的 importance 只有 0.30~0.45
   * （「喜欢」「答应」「第一次」这类常用词撞上的），门槛等于没有，所以把两条改成「同时成立」。
   */
  function classifyKind(content, importance, { explicit = false } = {}) {
    const keywords = Array.isArray(permanentConfig.keywords) ? permanentConfig.keywords : [];
    const hitKeyword = keywords.some((keyword) => keyword && content.includes(String(keyword)));
    const score = Number.isFinite(Number(importance)) ? Number(importance) : 0;
    if (score >= minImportance) return 'permanent';
    if (!hitKeyword && !explicit) return 'temporary';
    return score >= keywordMinImportance ? 'permanent' : 'temporary';
  }

  /** 提炼方的心意：forceKind 是硬指令，item.kind=permanent 算「显式要求」（仍要过重要性下限）。 */
  function kindWish(item) {
    const forced = item?.forceKind;
    if (forced === 'permanent' || forced === 'temporary') return { kind: forced, explicit: forced === 'permanent' };
    if (item?.kind === 'permanent') return { kind: null, explicit: true };
    if (item?.kind === 'temporary') return { kind: 'temporary', explicit: false };
    return { kind: null, explicit: false };
  }

  /** hint.importance（情感判定）作为下界：很重要的事不许被记成低重要性。 */
  function resolveImportance(value, hint) {
    let importance = Number(value);
    if (!Number.isFinite(importance)) importance = 0.4;
    importance = clamp(importance, 0, 1);
    const floor = Number(hint?.importance);
    if (Number.isFinite(floor)) importance = Math.max(importance, clamp(floor, 0, 1));
    return round(importance, 3);
  }

  function normalizeTurns(messages) {
    const list = Array.isArray(messages) ? messages : messages === null || messages === undefined ? [] : [messages];
    const turns = [];
    for (const message of list) {
      if (message === null || message === undefined) continue;
      if (typeof message === 'string') {
        const text = message.trim();
        if (text) turns.push({ role: 'user', name: null, text });
        continue;
      }
      const raw = Array.isArray(message.content)
        ? message.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join(' ')
        : message.content ?? message.text ?? '';
      const text = String(raw).trim();
      if (!text) continue;
      turns.push({ role: message.role ?? 'user', name: message.name ?? null, text });
    }
    return turns;
  }

  function speakerOf(turn) {
    if (turn.role === 'assistant' || turn.role === 'bot' || turn.role === 'self') return personaName;
    if (turn.role === 'user') return turn.name ?? t('memory.service.otherParty');
    return turn.name ?? turn.role ?? t('memory.service.otherParty');
  }

  function lastUserText(turns) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].role === 'user') return turns[i].text;
    }
    return turns[turns.length - 1]?.text ?? '';
  }

  function buildExtractPrompt(turns, hint) {
    const lines = turns
      .map((turn) => t('memory.service.prompt.turn', { speaker: speakerOf(turn), text: turn.text }))
      .join('\n');
    const parts = [
      t('memory.service.prompt.dialogue', { lines }),
      t('memory.service.prompt.maxItems', { max: Math.max(1, maxItems) }),
    ];
    if (hint?.note) parts.push(t('memory.service.prompt.hint', { note: String(hint.note) }));
    return parts.join('\n\n');
  }

  function buildRecordSpec(item, { userId, scene, hint, source }) {
    const content = String(item?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!content) return null;
    if (charLength(content) < minChars) return null; // 太短不入库
    const importance = resolveImportance(item?.importance, hint);
    const wish = kindWish(item);
    const tags = Array.isArray(item?.tags)
      ? [...new Set(item.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 6)
      : [];
    return {
      userId,
      scene,
      // forceKind 原样照办（退化路径用它钉死 temporary）；否则按 classifyKind 的两条门槛判
      kind: wish.kind ?? classifyKind(content, importance, { explicit: wish.explicit }),
      content,
      importance,
      tags,
      source,
      vector: null,
    };
  }

  /** 提炼失败时的退化：把用户这句话本身记成一条临时记忆。 */
  function fallbackItems(turns, hint) {
    const text = lastUserText(turns);
    if (!text) return [];
    const floor = Number(hint?.importance);
    const importance = round(Math.max(0.25, Number.isFinite(floor) ? clamp(floor, 0, 1) : 0), 3);
    return [{ content: text, importance, forceKind: 'temporary' }];
  }

  async function extractItems(turns, hint) {
    if (extractConfig.enabled === false) return [];
    if (typeof llm?.chat !== 'function') return fallbackItems(turns, hint);
    let result;
    try {
      result = await llm.chat({
        role: 'memory',
        json: true,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
          { role: 'user', content: buildExtractPrompt(turns, hint) },
        ],
      });
    } catch (error) {
      warn(t('memory.service.extractCallFailed', { message: error.message }), error);
      return fallbackItems(turns, hint);
    }
    const payload = result?.json ?? tryParseJson(result?.content);
    const items = toItemList(payload);
    if (items === null) {
      warn(t('memory.service.extractUnparsable'));
      // 原始返回也留一笔（截断），不然事后没法判断是模型跑偏还是解析器的锅
      debug(t('memory.service.extractUnparsableRaw', { content: truncate(String(result?.content ?? ''), 600) }));
      return fallbackItems(turns, hint);
    }
    return items;
  }

  /** 有侧车时补上向量，失败就留空，不影响入库。 */
  async function attachVectors(records) {
    if (!records.length || typeof sidecar?.embed !== 'function') return;
    try {
      const vectors = await sidecar.embed(records.map((record) => record.content));
      if (!Array.isArray(vectors)) return;
      for (let i = 0; i < records.length; i += 1) {
        const vector = vectors[i];
        if (!Array.isArray(vector) || !vector.length) continue;
        records[i].vector = vector;
        await store.update(records[i].userId, records[i].id, { vector });
      }
    } catch (error) {
      warn(t('memory.service.embedFailed'), error);
    }
  }

  async function ingest({ userId, scene = 'private', messages = [], hint = null } = {}) {
    if (memoryConfig.enabled === false) return [];
    if (userId === undefined || userId === null) return [];
    try {
      await ready;
      const turns = normalizeTurns(messages);
      if (!turns.length) return [];
      const items = await extractItems(turns, hint);
      if (!items.length) return [];
      // 先滤掉太短 / 空的条目，再按上限截断，免得废条目占掉名额
      const specs = items
        .map((item) => buildRecordSpec(item, { userId, scene, hint, source: 'ingest' }))
        .filter(Boolean)
        .slice(0, Math.max(1, maxItems));
      const created = [];
      for (const spec of specs) {
        const record = await store.insert(userId, spec);
        if (record) created.push(record);
      }
      if (!created.length) return [];
      await attachVectors(created);
      await store.save(userId);
      return created;
    } catch (error) {
      warn(t('memory.service.ingestFailed'), error);
      return [];
    }
  }

  async function recallHits({ userId, scene = 'private', query = '', topK = null, similarity = null } = {}) {
    if (memoryConfig.enabled === false) return [];
    if (userId === undefined || userId === null) return [];
    try {
      await ready;
      await store.load(userId);
      let similarityFn = similarity;
      if (!similarityFn) {
        const texts = [String(query ?? '').trim(), ...store.list(userId, {}).map((record) => record.content)];
        similarityFn = await embedSimilarity(sidecar, texts);
      }
      const hits = await recallRecords(store, { userId, scene, query, topK, similarity: similarityFn });
      if (hits.length) await store.save(userId);
      return hits;
    } catch (error) {
      warn(t('memory.service.recallFailed'), error);
      return [];
    }
  }

  async function recall({ userId, scene = 'private', query = '', topK = null } = {}) {
    const hits = await recallHits({ userId, scene, query, topK });
    return hits.map((hit) => ({
      id: hit.id,
      kind: hit.kind,
      content: hit.content,
      importance: hit.importance,
      score: round(Number(hit.score) || 0, 4),
      createdAt: hit.createdAt,
    }));
  }

  async function remember({ userId, scene = 'private', content = '', kind = null, importance = null, tags = [] } = {}) {
    if (memoryConfig.enabled === false) return null;
    if (userId === undefined || userId === null) return null;
    try {
      await ready;
      const text = String(content ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const score = resolveImportance(importance ?? 0.5, null);
      const finalKind = kind === 'permanent' || kind === 'temporary' ? kind : classifyKind(text, score);
      let vector = null;
      try {
        const vectors = await sidecar?.embed?.([text]);
        if (Array.isArray(vectors?.[0]) && vectors[0].length) vector = vectors[0];
      } catch (error) {
        warn(t('memory.service.embedFailed'), error);
      }
      const record = await store.insert(userId, {
        userId,
        scene,
        kind: finalKind,
        content: text,
        importance: score,
        tags: Array.isArray(tags) ? tags : [],
        source: 'remember',
        vector,
      });
      await store.save(userId);
      return record;
    } catch (error) {
      warn(t('memory.service.rememberFailed'), error);
      return null;
    }
  }

  function matchesQuery(content, query) {
    const text = String(query ?? '').trim();
    if (!text) return false;
    const needle = normalizeForMatch(text);
    const haystack = normalizeForMatch(content);
    if (needle && haystack.includes(needle)) return true;
    return keywordSimilarity(text, content) >= 0.6;
  }

  async function forget({ id = null, query = null, userId = null } = {}) {
    if (memoryConfig.enabled === false) return { removed: 0, ids: [] };
    try {
      await ready;
      const removedIds = [];
      if (id) {
        const target = userId ?? (await store.all()).find((record) => record.id === String(id))?.userId ?? null;
        if (target !== null) {
          const ok = await store.remove(target, id);
          if (ok) {
            removedIds.push(String(id));
            await store.save(target);
          }
        }
        return { removed: removedIds.length, ids: removedIds };
      }
      if (!query) return { removed: 0, ids: [] };
      const candidates = userId !== null && userId !== undefined ? await store.load(userId) : await store.all();
      const owners = new Set();
      for (const record of candidates) {
        if (!matchesQuery(record.content, query)) continue;
        if (await store.remove(record.userId, record.id)) {
          removedIds.push(record.id);
          owners.add(record.userId);
        }
      }
      for (const owner of owners) await store.save(owner);
      return { removed: removedIds.length, ids: removedIds };
    } catch (error) {
      warn(t('memory.service.forgetFailed'), error);
      return { removed: 0, ids: [] };
    }
  }

  function list(userId, { kind = null } = {}) {
    try {
      return store.list(userId, { kind }).map((record) => ({
        id: record.id,
        userId: record.userId,
        scene: record.scene,
        kind: record.kind,
        content: record.content,
        importance: record.importance,
        tags: record.tags,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        accessCount: record.accessCount,
        lastAccessAt: record.lastAccessAt,
        source: record.source,
      }));
    } catch (error) {
      warn(t('memory.service.listFailed'), error);
      return [];
    }
  }

  async function consolidate(now = Date.now(), { similarity = null, batchSize = null } = {}) {
    const result = { dropped: 0, promoted: 0, merged: 0, scanned: 0 };
    if (memoryConfig.enabled === false) return result;
    try {
      await ready;
      const records = await store.all();
      const batchLimit = Math.max(1, Math.trunc(Number(batchSize ?? consolidateConfig.batch)) || 60);
      const batch = records
        .filter((record) => record.kind === 'temporary')
        .map((record) => ({ record, strength: memoryStrength(record, { now, halfLifeHours }) }))
        .sort((a, b) => a.strength - b.strength || (a.record.createdAt ?? 0) - (b.record.createdAt ?? 0))
        .slice(0, batchLimit)
        .map((item) => item.record);
      result.scanned = batch.length;

      const touched = new Set();
      const minScore = Number.isFinite(Number(temporaryConfig.minScore)) ? Number(temporaryConfig.minScore) : 0.12;
      const maxAgeDays = Number.isFinite(Number(temporaryConfig.maxAgeDays)) ? Number(temporaryConfig.maxAgeDays) : 60;
      const promoteAfterAccess = Math.max(1, Math.trunc(Number(temporaryConfig.promoteAfterAccess)) || 4);

      // 1) 遗忘：强度过低且太久没动过的临时记忆
      const survivors = [];
      for (const record of batch) {
        const strength = memoryStrength(record, { now, halfLifeHours });
        const ageDays = (now - (record.createdAt ?? now)) / DAY_MS;
        if (strength < minScore && ageDays > maxAgeDays) {
          if (await store.remove(record.userId, record.id)) result.dropped += 1;
          touched.add(String(record.userId));
          continue;
        }
        survivors.push(record);
      }

      // 2) 晋升：被反复想起且够重要的临时记忆升为永久（用的是和入库同一把尺子：classifyKind）
      for (const record of survivors) {
        if ((Number(record.accessCount) || 0) < promoteAfterAccess) continue;
        if (classifyKind(String(record.content ?? ''), record.importance) !== 'permanent') continue;
        const updated = await store.update(record.userId, record.id, { kind: 'permanent' });
        if (updated) {
          record.kind = 'permanent';
          result.promoted += 1;
          touched.add(String(record.userId));
        }
      }

      // 3) 合并：近似条目并成一条（保留永久身份、更长的内容、更高的重要性）
      const threshold = Number.isFinite(Number(consolidateConfig.mergeSimilarity)) ? Number(consolidateConfig.mergeSimilarity) : 0.92;
      const all = await store.all();
      const similarityFn = typeof similarity === 'function' ? similarity : await embedSimilarity(sidecar, all.map((record) => record.content));
      const simOf = (a, b) => {
        try {
          const value = similarityFn ? similarityFn(a, b) : keywordSimilarity(a, b);
          return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : keywordSimilarity(a, b);
        } catch {
          return keywordSimilarity(a, b);
        }
      };
      const byUser = new Map();
      for (const record of all) {
        const key = String(record.userId);
        if (!byUser.has(key)) byUser.set(key, []);
        byUser.get(key).push(record);
      }
      const deadIds = new Set();
      for (const record of survivors) {
        if (deadIds.has(record.id)) continue;
        const siblings = (byUser.get(String(record.userId)) ?? []).filter((other) => other.id !== record.id && !deadIds.has(other.id));
        const mate = siblings.find((other) => simOf(record.content, other.content) >= threshold);
        if (!mate) continue;
        const keep = record.kind === 'permanent' && mate.kind !== 'permanent'
          ? record
          : mate.kind === 'permanent' && record.kind !== 'permanent'
            ? mate
            : (mate.content?.length ?? 0) > (record.content?.length ?? 0)
              ? mate
              : record;
        const drop = keep.id === record.id ? mate : record;
        const content = (drop.content?.length ?? 0) > (keep.content?.length ?? 0) ? drop.content : keep.content;
        const updated = await store.update(keep.userId, keep.id, {
          content,
          importance: Math.max(Number(record.importance) || 0, Number(mate.importance) || 0),
          kind: keep.kind === 'permanent' || mate.kind === 'permanent' ? 'permanent' : 'temporary',
          tags: [...new Set([...(record.tags ?? []), ...(mate.tags ?? [])])],
          accessCount: (Number(record.accessCount) || 0) + (Number(mate.accessCount) || 0),
          createdAt: Math.min(record.createdAt ?? now, mate.createdAt ?? now),
          lastAccessAt: Math.max(record.lastAccessAt ?? 0, mate.lastAccessAt ?? 0) || null,
        });
        if (!updated) continue;
        await store.remove(drop.userId, drop.id);
        deadIds.add(drop.id);
        result.merged += 1;
        touched.add(String(keep.userId));
      }

      // 4) 容量：临时记忆按强度淘汰最弱的，永久记忆超容量时淘汰重要性最低的
      const tempCapacity = Math.trunc(Number(temporaryConfig.capacity));
      const permCapacity = Math.trunc(Number(permanentConfig.capacity));
      const afterMerge = await store.all();
      const grouped = new Map();
      for (const record of afterMerge) {
        const key = String(record.userId);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(record);
      }
      for (const [key, group] of grouped) {
        const temporaries = group.filter((record) => record.kind === 'temporary');
        if (Number.isFinite(tempCapacity) && temporaries.length > tempCapacity) {
          const weakest = temporaries
            .map((record) => ({ record, strength: memoryStrength(record, { now, halfLifeHours }) }))
            .sort((a, b) => a.strength - b.strength || (a.record.createdAt ?? 0) - (b.record.createdAt ?? 0))
            .slice(0, temporaries.length - tempCapacity);
          for (const item of weakest) {
            if (await store.remove(key, item.record.id)) result.dropped += 1;
          }
          touched.add(key);
        }
        const permanents = group.filter((record) => record.kind === 'permanent');
        if (Number.isFinite(permCapacity) && permanents.length > permCapacity) {
          const weakest = permanents
            .sort((a, b) => (a.importance ?? 0) - (b.importance ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
            .slice(0, permanents.length - permCapacity);
          for (const record of weakest) {
            // 永久记忆本该 neverForget，但容量是硬上限，超出时只能淘汰最不重要的
            warn(t('memory.service.overCapacity', { capacity: permCapacity, content: truncate(record.content, 20) }));
            if (await store.remove(key, record.id)) result.dropped += 1;
          }
          touched.add(key);
        }
      }

      for (const userId of touched) await store.save(userId);
      lastConsolidateAt = now;
      return result;
    } catch (error) {
      warn(t('memory.service.consolidateFailed'), error);
      return result;
    }
  }

  function stats() {
    try {
      return { ...store.stats(), lastConsolidateAt };
    } catch (error) {
      warn(t('memory.service.statsFailed'), error);
      return { temporary: 0, permanent: 0, users: 0, lastConsolidateAt };
    }
  }

  /** 永久记忆里适合写进人设的短句，按重要性排序。 */
  function personaFacts(userId) {
    try {
      return store
        .list(userId, { kind: 'permanent' })
        .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, MAX_PERSONA_FACTS)
        .map((record) => truncate(String(record.content ?? '').trim(), summaryMaxChars))
        .filter(Boolean);
    } catch (error) {
      warn(t('memory.service.personaFactsFailed'), error);
      return [];
    }
  }

  return {
    ingest,
    recall,
    remember,
    forget,
    list,
    consolidate,
    stats,
    personaFacts,
    ready: () => ready,
    store,
    dir: store.dir,
  };
}
