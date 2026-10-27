/**
 * 情感判定：一次轻量 LLM 调用，判断这轮对话的情绪走向、好感度增量与记忆价值。
 * 任何异常都回退到 fallback，绝不抛错。
 */

import { t } from '../i18n/index.js';
import { clamp, round } from '../util/common.js';
import { truncate } from '../util/text.js';

const FALLBACK = Object.freeze({ mood: null, delta: 0, event: 'chat', reason: 'fallback', importance: 0.3 });

const DEFAULT_EVENTS = ['praise', 'thanks', 'share', 'chat', 'helpful', 'ignore', 'command', 'insult', 'harass', 'suspect', 'apology'];
const DEFAULT_MOODS = [
  t('emotion.judge.mood.calm'),
  t('emotion.judge.mood.happy'),
  t('emotion.judge.mood.angry'),
  t('emotion.judge.mood.wronged'),
  t('emotion.judge.mood.tired'),
  t('emotion.judge.mood.caring'),
];

const EVENT_HINT = {
  praise: t('emotion.judge.eventHint.praise'),
  thanks: t('emotion.judge.eventHint.thanks'),
  share: t('emotion.judge.eventHint.share'),
  chat: t('emotion.judge.eventHint.chat'),
  helpful: t('emotion.judge.eventHint.helpful'),
  ignore: t('emotion.judge.eventHint.ignore'),
  command: t('emotion.judge.eventHint.command'),
  insult: t('emotion.judge.eventHint.insult'),
  harass: t('emotion.judge.eventHint.harass'),
  suspect: t('emotion.judge.eventHint.suspect'),
  apology: t('emotion.judge.eventHint.apology'),
};

function eventList({ events, deltaTable, config, persona }) {
  const explicit = Array.isArray(events) ? events.filter((item) => typeof item === 'string') : [];
  if (explicit.length) return explicit;
  const table =
    (deltaTable && typeof deltaTable === 'object' && deltaTable) ||
    config?.emotion?.deltas ||
    persona?.emotion?.deltas ||
    persona?.emotionDeltas ||
    null;
  if (table && typeof table === 'object') {
    const keys = Object.keys(table);
    if (keys.length) return keys;
  }
  return DEFAULT_EVENTS;
}

function moodList({ config, persona }) {
  const fromConfig = config?.emotion?.moods ?? persona?.emotion?.moods;
  return Array.isArray(fromConfig) && fromConfig.length ? fromConfig : DEFAULT_MOODS;
}

function deltaTableOf({ deltaTable, config, persona }) {
  const table = deltaTable ?? config?.emotion?.deltas ?? persona?.emotion?.deltas ?? persona?.emotionDeltas ?? null;
  return table && typeof table === 'object' ? table : {};
}

function formatHistory(history) {
  if (!Array.isArray(history) || !history.length) return '';
  return history
    .slice(-8)
    .map((item) => {
      if (typeof item === 'string') return item;
      const name = item?.name ?? (item?.role === 'assistant' ? t('emotion.judge.selfName') : t('emotion.judge.otherName'));
      return t('emotion.judge.historyLine', { name, text: truncate(String(item?.content ?? ''), 200) });
    })
    .filter(Boolean)
    .join('\n');
}

function parseJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * @param {{ llm: object, persona?: object, message?: string|object, reply?: string, history?: any[], config?: object, events?: string[] }} opts
 * @returns {Promise<{ mood: string|null, delta: number, event: string, reason: string, importance: number }>}
 */
export async function judgeEmotion({ llm, persona, message, reply, history, config, events, deltaTable } = {}) {
  try {
    if (!llm || typeof llm.chat !== 'function') return { ...FALLBACK };

    const eventKeys = eventList({ events, deltaTable, config, persona });
    const moodKeys = moodList({ config, persona });
    const table = deltaTableOf({ deltaTable, config, persona });
    const messageText = typeof message === 'string' ? message : String(message?.text ?? '');
    const replyText = String(reply ?? '');
    const historyText = formatHistory(history);

    const system = [
      t('emotion.judge.system.intro'),
      t('emotion.judge.system.output'),
      t('emotion.judge.system.fields', { events: eventKeys.join(' / '), moods: moodKeys.join(' / ') }),
      t('emotion.judge.system.eventMeaning', {
        list: eventKeys.map((key) => `${key}=${EVENT_HINT[key] ?? key}`).join('\uFF1B'),
      }),
      table && Object.keys(table).length ? t('emotion.judge.system.deltaTable', { table: JSON.stringify(table) }) : '',
      t('emotion.judge.system.noChange'),
    ]
      .filter(Boolean)
      .join('\n');

    const user = [
      historyText ? t('emotion.judge.user.history', { history: historyText }) : '',
      t('emotion.judge.user.message', { message: truncate(messageText, 600) }),
      replyText ? t('emotion.judge.user.reply', { reply: truncate(replyText, 600) }) : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await llm.chat({
      role: 'judge',
      json: true,
      temperature: 0.2,
      maxTokens: 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user || t('emotion.judge.user.empty') },
      ],
    });

    const parsed = result?.json ?? parseJson(result?.content);
    if (!parsed || typeof parsed !== 'object') return { ...FALLBACK };

    let event = typeof parsed.event === 'string' ? parsed.event.trim() : '';
    if (!eventKeys.includes(event)) event = eventKeys.includes('chat') ? 'chat' : eventKeys[0] ?? 'chat';

    let delta = Number(parsed.delta);
    if (!Number.isFinite(delta)) {
      const fallbackDelta = Number(table[event]);
      delta = Number.isFinite(fallbackDelta) ? fallbackDelta : 0;
    }
    delta = clamp(round(delta, 2), -10, 10);

    const mood = typeof parsed.mood === 'string' && moodKeys.includes(parsed.mood.trim()) ? parsed.mood.trim() : null;
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? truncate(parsed.reason.trim(), 120) : 'fallback';
    let importance = Number(parsed.importance);
    if (!Number.isFinite(importance)) importance = FALLBACK.importance;
    importance = clamp(round(importance, 3), 0, 1);

    return { mood, delta, event, reason, importance };
  } catch {
    return { ...FALLBACK };
  }
}
