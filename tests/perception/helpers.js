/** 感知模块测试共用的假件：假配置、假日志、假 fetch。 */

import os from 'node:os';
import path from 'node:path';

export function makeConfig(overrides = {}) {
  const { sidecar: sidecarOverrides = {}, ...rest } = overrides;
  const dataDir = overrides.dataDir ?? path.join(os.tmpdir(), 'ruohua-perception-test');
  return {
    rootDir: process.cwd(),
    dataDir,
    logDir: path.join(dataDir, 'logs'),
    model: { visionModel: '' },
    memory: {
      temporary: { halfLifeHours: 72, minScore: 0.12 },
      permanent: { minImportance: 0.75 },
      consolidate: { mergeSimilarity: 0.92 },
    },
    ...rest,
    sidecar: {
      enabled: true,
      url: 'http://127.0.0.1:8765',
      autostart: false,
      python: 'python',
      script: 'python/sidecar.py',
      host: '127.0.0.1',
      port: 8765,
      timeoutMs: 500,
      screenshotDir: path.join(dataDir, 'screenshots'),
      ...sidecarOverrides,
    },
  };
}

/** 记账用的日志：不打印，只记录。 */
export function makeLogger() {
  const records = { debug: [], info: [], warn: [], error: [] };
  const logger = {};
  for (const level of Object.keys(records)) {
    logger[level] = (message) => records[level].push(String(message));
  }
  logger.child = () => logger;
  logger.records = records;
  return logger;
}

/**
 * 假 fetch：handler(url, options) 返回 { status?, body } 或直接抛 Error。
 * 返回的 fetch 上带 calls 数组，方便断言请求内容。
 */
export function makeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options, body: options.body ? JSON.parse(options.body) : null });
    const result = await handler(target, options);
    if (result instanceof Error) throw result;
    const status = result.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => result.body,
      text: async () => (typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? '')),
    };
  };
  fn.calls = calls;
  return fn;
}

/** 按路径派发的假 fetch。 */
export function makeRouter(handlers) {
  return makeFetch(async (url, options) => {
    const pathname = new URL(url).pathname;
    const handler = handlers[pathname];
    if (!handler) return { status: 404, body: { ok: false, error: 'not_found' } };
    return handler(url, options);
  });
}
