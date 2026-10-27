/**
 * 工具层的通用零件：ToolError、入参校验、服务取用、路径边界、信号合并。
 * 工具里不要静默返回假数据：缺参数、缺服务、越界一律抛 ToolError。
 */

import { t } from '../../i18n/index.js';

export class ToolError extends Error {
  constructor(message, code = 'tool_error', details = null) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  array: (value) => Array.isArray(value),
  object: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
};

/**
 * 取一个参数。缺失或类型不符时抛 ToolError；给了 fallback 就用 fallback。
 * number 允许传数字字符串（模型经常这么干）。
 */
export function requireArg(args, name, { type = 'string', fallback = undefined, allowEmpty = false, label = null } = {}) {
  const shown = label ?? name;
  const raw = args?.[name];
  const missing = raw === undefined || raw === null || (type === 'string' && !allowEmpty && typeof raw === 'string' && !raw.trim());
  if (missing) {
    if (fallback !== undefined) return fallback;
    throw new ToolError(t('agent.error.missingArgument', { shown, name, type }), 'missing_argument', { argument: name });
  }
  if (type === 'number') {
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(num)) return num;
  }
  if (type === 'string' && typeof raw !== 'string') {
    return String(raw);
  }
  const check = TYPE_CHECKS[type];
  if (check && !check(raw)) {
    if (fallback !== undefined) return fallback;
    throw new ToolError(t('agent.error.invalidArgument', { shown, name, type }), 'invalid_argument', { argument: name });
  }
  return raw;
}

export function requireService(services, key, label = key) {
  const value = services?.[key];
  if (!value) throw new ToolError(t('agent.error.serviceUnavailable', { label }), 'service_unavailable', { service: key });
  return value;
}

/** 取服务的某个方法并绑定 this。 */
export function requireMethod(services, key, method, label = `${key}.${method}`) {
  const service = requireService(services, key, key);
  if (typeof service?.[method] !== 'function') {
    throw new ToolError(t('agent.error.serviceUnavailable', { label }), 'service_unavailable', { service: key, method });
  }
  return service[method].bind(service);
}

export function assertNotAborted(ctx) {
  if (ctx?.signal?.aborted) throw new ToolError(t('agent.error.aborted'), 'aborted');
}

export function resolveFetch(services, override = null) {
  const impl = override ?? services?.fetch ?? services?.http?.fetch ?? globalThis.fetch;
  if (typeof impl !== 'function') throw new ToolError(t('agent.error.fetchUnavailable'), 'fetch_unavailable');
  return impl;
}

/** 取沙箱边界（组装时可能挂在 services.security.boundary，也可能直接挂 services.boundary）。 */
export function boundaryOf(services) {
  const boundary = services?.security?.boundary ?? services?.boundary;
  if (!boundary || typeof boundary.checkPath !== 'function') {
    throw new ToolError(t('agent.error.serviceUnavailable', { label: 'security.boundary' }), 'service_unavailable', { service: 'security.boundary' });
  }
  return boundary;
}

/** 路径过边界检查，越界时把 BoundaryError 换成 ToolError（模型看得懂的话）。 */
export function safePath(boundary, target) {
  try {
    return boundary.checkPath(target);
  } catch (error) {
    throw new ToolError(t('agent.error.boundaryDenied', { message: error.message }), 'boundary_denied', {
      path: String(target),
      cause: error?.name ?? 'BoundaryError',
    });
  }
}

export function truncateWithNote(text, max, note = t('agent.error.truncated')) {
  const value = String(text ?? '');
  if (value.length <= max) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, max)}${t('agent.error.truncatedNote', { note, length: value.length })}`,
    truncated: true,
  };
}

/** 把多个 AbortSignal 合成一个：任一被 abort，结果就被 abort。 */
export function combineSignals(...signals) {
  const list = signals.filter((item) => item && typeof item.addEventListener === 'function');
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') {
    try {
      return AbortSignal.any(list);
    } catch {
      /* 落到下面的兜底实现 */
    }
  }
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
