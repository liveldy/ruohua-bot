/**
 * 情感引擎：每个用户的好感度与情绪，带衰减、持久化与给回复链路用的 hints。
 */

import fs from 'node:fs';
import path from 'node:path';
import { t } from '../i18n/index.js';
import { clamp, round } from '../util/common.js';
import { readJson, writeJsonAtomic } from '../util/io.js';
import { moodBias } from '../persona/expressions.js';

const DEFAULT_MOODS = [
  t('emotion.engine.mood.calm'),
  t('emotion.engine.mood.happy'),
  t('emotion.engine.mood.angry'),
  t('emotion.engine.mood.wronged'),
  t('emotion.engine.mood.tired'),
  t('emotion.engine.mood.caring'),
];
const DEFAULT_LABELS = [{ min: 0, label: t('emotion.label.stranger') }];
const DEFAULT_DELTAS = {
  praise: 3,
  thanks: 2,
  share: 1.5,
  chat: 0.2,
  helpful: 1,
  ignore: -1.5,
  command: -0.3,
  insult: -6,
  harass: -4,
  suspect: -3,
  apology: 2,
};

function normalizeRange(range) {
  const list = Array.isArray(range) ? range.map(Number).filter(Number.isFinite) : [];
  if (list.length < 2) return [0, 100];
  const low = Math.min(list[0], list[1]);
  const high = Math.max(list[0], list[1]);
  return [low, high];
}

function normalizeLabels(labels) {
  const list = (Array.isArray(labels) ? labels : [])
    .filter((item) => item && Number.isFinite(Number(item.min)) && typeof item.label === 'string')
    .map((item) => ({ min: Number(item.min), label: item.label }));
  const source = list.length ? list : DEFAULT_LABELS;
  return [...source].sort((a, b) => b.min - a.min);
}

function normalizeState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const users = {};
  const incoming = data.users && typeof data.users === 'object' ? data.users : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!value || typeof value !== 'object') continue;
    users[String(key)] = { ...value, userId: String(value.userId ?? key) };
  }
  return { users, lastDecayAt: Number.isFinite(Number(data.lastDecayAt)) ? Number(data.lastDecayAt) : null };
}

function readStateSync(file) {
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 创建情感引擎。stateFile 缺省为 `<dataDir>/emotion.json`。
 * 构造时同步读一次盘，同时暴露 `ready` Promise 给异步方法 await。
 */
export function createEmotionEngine({ config, logger, stateFile, rng = Math.random } = {}) {
  const cfg = config?.emotion ?? {};
  const persona = config?.persona ?? {};
  const moods = Array.isArray(cfg.moods) && cfg.moods.length ? [...cfg.moods] : [...DEFAULT_MOODS];
  const defaultMood = cfg.defaultMood ?? moods[0];
  const deltas = { ...DEFAULT_DELTAS, ...(cfg.deltas ?? {}) };
  const [affLo, affHi] = normalizeRange(cfg.affectionRange);
  const labels = normalizeLabels(cfg.labels);
  const decay = cfg.decay ?? {};
  const moodCfg = cfg.mood ?? {};
  const frequency = cfg.frequency ?? {};
  const initialAffection = cfg.initialAffection ?? {};
  const admins = Array.isArray(config?.security?.admins) ? config.security.admins : [];
  const rand = typeof rng === 'function' ? rng : Math.random;
  const file = stateFile ?? (config?.dataDir ? path.join(config.dataDir, 'emotion.json') : null);

  const initial = readStateSync(file);
  const state = normalizeState(initial);
  let dirty = false;

  // 同步读失败（文件不存在或被占用）时，用异步读兜底。
  const ready = initial
    ? Promise.resolve(state)
    : (async () => {
        let data = null;
        try {
          data = await readJson(file, null);
        } catch {
          data = null;
        }
        if (data) {
          const next = normalizeState(data);
          state.users = next.users;
          state.lastDecayAt = next.lastDecayAt;
        }
        return state;
      })();

  const durationMinutes = (mood) => {
    const minutes = Number(moodCfg.moodDurationMinutes?.[mood]);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
    const fallback = Number(moodCfg.decayMinutes);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 90;
  };

  const labelFor = (affection) => {
    for (const item of labels) {
      if (affection >= item.min) return item.label;
    }
    return labels[labels.length - 1]?.label ?? t('emotion.label.stranger');
  };

  const moodFromDelta = (delta) => {
    const table = moodCfg.thresholds?.deltaToMood;
    if (!table || typeof table !== 'object' || !Number.isFinite(delta) || delta === 0) return null;
    const entries = Object.entries(table)
      .map(([key, mood]) => ({ threshold: Number(key), mood }))
      .filter((item) => Number.isFinite(item.threshold) && typeof item.mood === 'string');
    if (!entries.length) return null;
    if (delta > 0) {
      const hit = entries.filter((item) => item.threshold > 0 && delta >= item.threshold);
      if (!hit.length) return null;
      return hit.reduce((best, item) => (item.threshold > best.threshold ? item : best)).mood;
    }
    const hit = entries.filter((item) => item.threshold < 0 && delta <= item.threshold);
    if (!hit.length) return null;
    return hit.reduce((best, item) => (item.threshold < best.threshold ? item : best)).mood;
  };

  const resolveRole = (userId, explicit) => {
    if (explicit === 'owner' || explicit === 'admin' || explicit === 'member') {
      return explicit === 'admin' ? 'owner' : explicit;
    }
    if (admins.some((id) => String(id) === String(userId))) return 'owner';
    return 'member';
  };

  const freshUser = (userId, role) => {
    const base = Number(initialAffection[role]);
    const affection = Number.isFinite(base) ? base : Number(initialAffection.member ?? 15);
    return {
      userId: String(userId),
      role,
      affection: clamp(affection, affLo, affHi),
      mood: defaultMood,
      moodSince: null,
      moodUntil: null,
      interactions: 0,
      lastSeenAt: null,
      lastDecayAt: null,
      notes: [],
    };
  };

  const rebaseIfUntouched = (user, role) => {
    // 还没真正互动过时，按新知道的角色重新给初始好感度（例如先 get 后 apply 带上了 role）
    if (!role || (user.interactions ?? 0) > 0) return;
    const next = resolveRole(user.userId, role);
    if (next === user.role) return;
    user.role = next;
    user.affection = clamp(Number(initialAffection[next] ?? initialAffection.member ?? 15), affLo, affHi);
  };

  const ensure = (userId, role) => {
    const key = String(userId);
    let user = state.users[key];
    if (!user) {
      user = freshUser(key, resolveRole(key, role));
      state.users[key] = user;
      dirty = true;
    } else {
      rebaseIfUntouched(user, role);
    }
    if (user.notes == null) user.notes = [];
    return user;
  };

  const view = (user) => ({
    userId: user.userId,
    affection: user.affection,
    mood: user.mood ?? defaultMood,
    moodSince: user.moodSince ?? null,
    moodUntil: user.moodUntil ?? null,
    interactions: user.interactions ?? 0,
    lastSeenAt: user.lastSeenAt ?? null,
    label: labelFor(user.affection),
    role: user.role ?? 'member',
  });

  const engine = {
    ready,
    stateFile: file,
    rng: rand,
    get(userId) {
      return view(ensure(userId));
    },

    async apply(userId, { event, delta, note, at, role } = {}) {
      await ready;
      const stamp = at != null && Number.isFinite(Number(at)) ? Number(at) : Date.now();
      const user = ensure(userId, role);
      const tableDelta = event != null && deltas[event] != null ? Number(deltas[event]) : null;
      let amount = tableDelta != null ? tableDelta : Number(delta);
      if (!Number.isFinite(amount)) amount = 0;

      user.affection = clamp(round(user.affection + amount, 2), affLo, affHi);
      user.interactions = (user.interactions ?? 0) + 1;
      user.lastSeenAt = stamp;
      if (note != null && String(note).trim()) {
        user.notes = [...(user.notes ?? []), { at: stamp, text: String(note) }].slice(-20);
      }

      const mood = moodFromDelta(amount);
      let moodChanged = false;
      if (mood) {
        user.mood = mood;
        user.moodSince = stamp;
        user.moodUntil = stamp + durationMinutes(mood) * 60000;
        moodChanged = true;
      } else if (user.moodUntil != null && stamp >= user.moodUntil) {
        user.mood = defaultMood;
        user.moodSince = stamp;
        user.moodUntil = null;
        moodChanged = true;
      }
      dirty = true;
      return { ...view(user), delta: round(amount, 2), event: event ?? null, moodChanged };
    },

    async setMood(userId, mood, minutes) {
      await ready;
      const user = ensure(userId);
      const wanted = typeof mood === 'string' ? mood.trim() : '';
      const next = moods.includes(wanted) ? wanted : defaultMood;
      const span = Number(minutes);
      const spanMinutes = Number.isFinite(span) && span > 0 ? span : durationMinutes(next);
      const now = Date.now();
      user.mood = next;
      user.moodSince = now;
      // 默认心情不设到期时间，靠 tick 回落；显式给了时长才计时
      user.moodUntil = next === defaultMood && !(Number.isFinite(span) && span > 0) ? null : now + spanMinutes * 60000;
      dirty = true;
      return view(user);
    },

    /** 好感度按半衰期向 decay.toward 衰减；情绪到期回落到 defaultMood。 */
    async tick(now) {
      await ready;
      const stamp = now != null && Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const halfLifeHours = Number(decay.halfLifeHours) > 0 ? Number(decay.halfLifeHours) : 168;
      const toward = Number.isFinite(Number(decay.toward)) ? Number(decay.toward) : 40;
      const minIntervalMs = (Number.isFinite(Number(decay.minIntervalMinutes)) ? Number(decay.minIntervalMinutes) : 30) * 60000;

      let decayed = 0;
      let moodReset = 0;
      for (const user of Object.values(state.users)) {
        const last = user.lastDecayAt ?? null;
        if (last == null || stamp - last >= minIntervalMs) {
          const hours = last == null ? 0 : (stamp - last) / 3600000;
          if (hours > 0) {
            const factor = 0.5 ** (hours / halfLifeHours);
            const next = clamp(round(toward + (user.affection - toward) * factor, 2), affLo, affHi);
            if (next !== user.affection) {
              user.affection = next;
              decayed += 1;
            }
          }
          user.lastDecayAt = stamp;
          dirty = true;
        }
        if (user.moodUntil != null && stamp >= user.moodUntil) {
          user.mood = defaultMood;
          user.moodSince = stamp;
          user.moodUntil = null;
          moodReset += 1;
          dirty = true;
        }
      }
      state.lastDecayAt = stamp;
      return { at: stamp, decayed, moodReset };
    },

    /** 回复链路用的节奏参数：随情绪变碎、变少、变冷淡。 */
    hints(userId) {
      const user = ensure(userId);
      const mood = user.mood ?? defaultMood;
      const freq = frequency[mood] ?? {};
      const segments = persona?.style?.segments ?? {};
      const gap = Array.isArray(segments.gapMs) ? segments.gapMs.map(Number) : [300, 1200];
      const scale = Number.isFinite(Number(freq.segmentGapScale)) ? Number(freq.segmentGapScale) : 1;
      const baseMax = Number.isFinite(Number(segments.maxSegments)) ? Math.trunc(Number(segments.maxSegments)) : 5;
      const multiplier = Number.isFinite(Number(freq.frequencyMultiplier)) ? Number(freq.frequencyMultiplier) : 1;
      const maxSegments =
        multiplier > 1 ? baseMax + 1 : multiplier < 1 ? Math.max(1, Math.floor(baseMax * multiplier)) : baseMax;
      const faceBase = Number(persona?.expressions?.stickerChance);
      const stickerBase = Number.isFinite(faceBase) ? faceBase : 0.16;

      return {
        segmentGapMs: [
          Math.max(60, Math.round((Number.isFinite(gap[0]) ? gap[0] : 300) * scale)),
          Math.max(120, Math.round((Number.isFinite(gap[1]) ? gap[1] : 1200) * scale)),
        ],
        maxSegments: Math.max(1, maxSegments),
        tone: persona?.style?.tone?.[mood] ?? null,
        stickerChance: clamp(stickerBase * moodBias(mood).sticker, 0, 1),
        replyChance: Number.isFinite(Number(freq.replyChance)) ? Number(freq.replyChance) : 1,
        frequencyMultiplier: multiplier,
        mood,
        affection: user.affection,
        label: labelFor(user.affection),
      };
    },

    async save() {
      await ready;
      if (!file) return null;
      try {
        await writeJsonAtomic(file, {
          version: 1,
          updatedAt: Date.now(),
          lastDecayAt: state.lastDecayAt ?? null,
          users: state.users,
        });
        dirty = false;
        logger?.debug?.(t('emotion.engine.stateSaved'), { file, users: Object.keys(state.users).length });
        return file;
      } catch (error) {
        logger?.warn?.(t('emotion.engine.stateSaveFailed'), { file, error: String(error?.message ?? error) });
        return null;
      }
    },

    /** 全部用户状态（数组，按好感度降序），供状态查询。 */
    snapshot() {
      return Object.values(state.users)
        .map((user) => ({ ...view(user), notes: (user.notes ?? []).map((note) => ({ ...note })) }))
        .sort((a, b) => b.affection - a.affection);
    },

    /** 清掉某个用户的状态；不传 userId 时清空全部。 */
    reset(userId) {
      if (userId == null) {
        const count = Object.keys(state.users).length;
        state.users = {};
        dirty = true;
        return count;
      }
      const key = String(userId);
      const existed = Boolean(state.users[key]);
      delete state.users[key];
      if (existed) dirty = true;
      return existed;
    },

    isDirty() {
      return dirty;
    },
  };

  return engine;
}
