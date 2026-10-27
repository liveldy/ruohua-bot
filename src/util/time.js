/** 时间处理：格式化、时长、自然语言时间解析（定时任务用）。 */

import { t } from '../i18n/index.js';

export function formatTime(ts = Date.now(), { withSeconds = true, withDate = true } = {}) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${withSeconds ? `:${pad(date.getSeconds())}` : ''}`;
  if (!withDate) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days) parts.push(t('common.time.days', { days }));
  if (hours) parts.push(t('common.time.hours', { hours }));
  if (minutes) parts.push(t('common.time.minutes', { minutes }));
  if (!days && !hours && !parts.length) parts.push(t('common.time.seconds', { seconds }));
  return parts.join('');
}

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** 解析 '10m' / '2h' / '1d' / '30s' → 毫秒；失败 null。 */
export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|\u79D2|\u5206|\u5206\u949F|\u5C0F\u65F6|\u5929)$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const table = { '\u79D2': 's', '\u5206': 'm', '\u5206\u949F': 'm', '\u5C0F\u65F6': 'h', '\u5929': 'd' };
  const key = table[unit] ?? unit;
  return Math.round(value * UNIT_MS[key]);
}

function parseClock(text) {
  const match = /^(\d{1,2})[:\uFF1A\u70B9](\d{1,2})?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 把自然语言时间描述规整成定时任务能用的调度描述。
 * 支持：'+30m'（一次性）、'10m' / 'every 10m'（周期）、'2026-10-27T09:00'（一次性）、
 * '每天08:00' / 'daily 08:00' / '08:00'（每天）。
 */
export function parseTimeSpec(spec, now = Date.now()) {
  const text = String(spec ?? '').trim();
  if (!text) return null;

  if (text.startsWith('+')) {
    const everyMs = parseDuration(text.slice(1));
    return everyMs == null ? null : { type: 'once', at: now + everyMs, everyMs };
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(text);
  if (iso) {
    const at = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    ).getTime();
    return Number.isFinite(at) ? { type: 'once', at } : null;
  }

  const clock = parseClock(text.replace(/^(\u6BCF\u5929|\u6BCF\u65E5|daily)\s*/i, ''));
  if (clock && /^(\u6BCF\u5929|\u6BCF\u65E5|daily)/i.test(text)) {
    return { type: 'daily', time: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` };
  }
  if (clock && /^\d{1,2}[:\uFF1A\u70B9]/.test(text)) {
    return { type: 'daily', time: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` };
  }

  const duration = parseDuration(text.replace(/^every\s+/i, ''));
  if (duration != null) return { type: 'interval', everyMs: duration };
  return null;
}

/** 给定调度描述，算出下一次触发时间。 */
export function nextRunAt(spec, from = Date.now()) {
  if (!spec) return null;
  if (spec.type === 'once') return spec.at ?? null;
  if (spec.type === 'interval') {
    const everyMs = spec.everyMs ?? 0;
    if (everyMs <= 0) return null;
    const last = spec.lastRunAt ?? null;
    if (last == null) return from + everyMs;
    const next = last + everyMs;
    return next <= from ? from + everyMs : next;
  }
  if (spec.type === 'daily') {
    const [hour, minute] = String(spec.time ?? '08:00').split(':').map(Number);
    const date = new Date(from);
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= from) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  return null;
}

/** '23:30' 这类静默时段判断，支持跨天（如 23:30 - 07:30）。 */
export function inQuietHours(quietHours, now = Date.now()) {
  if (!Array.isArray(quietHours) || quietHours.length < 2) return false;
  const toMinutes = (text) => {
    const [hour, minute] = String(text).split(':').map(Number);
    return (hour || 0) * 60 + (minute || 0);
  };
  const date = new Date(now);
  const current = date.getHours() * 60 + date.getMinutes();
  const start = toMinutes(quietHours[0]);
  const end = toMinutes(quietHours[1]);
  if (start === end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}
