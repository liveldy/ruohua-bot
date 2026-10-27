/**
 * 自检（模块四 · 系统）：启动后跑一遍，把结果汇报给管理员。
 *
 * 检查项：配置文件、数据目录可写、模型 API Key、模型接口连通、OneBot 连接、Python 侧车、
 * 日志目录、沙箱边界、口令池、Node 版本、磁盘剩余。
 * 判定：level 'fail' 的项会把整份自检判为不通过；'warn' 只提醒（比如离线、未连接、拿不到状态），
 * 单看某一项是否正常用 item.ok（ok 仅当 level === 'ok'）。
 *
 * phase：
 *   'startup'（默认）—— 只查不用网络就能定论的项，连 QQ 之前跑；
 *   'runtime' —— 全查，包括 OneBot 连接 / Python 侧车 / 模型接口连通，连上之后再跑。
 * 分两趟是因为第一趟跑的时候还没连接、侧车还没起，硬查只会误报「未连接」「不可用」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from '../i18n/index.js';
import { truncate } from '../util/text.js';

const MIN_FREE_BYTES = 200 * 1024 * 1024;
const MIN_NODE_MAJOR = 20;

function firstLine(text, max = 200) {
  const line = String(text ?? '').split(/\r?\n/).find((item) => item.trim()) ?? '';
  return truncate(line.trim(), max);
}

function humanBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return t('system.selfcheck.unknown');
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function createSelfCheck({ config, logger, services = {} } = {}) {
  const log = logger ?? null;

  async function run({ offline = false, phase = 'runtime' } = {}) {
    const startedAt = Date.now();
    const withNetwork = phase !== 'startup';
    const items = [];
    const add = (name, level, detail, hint = null) => {
      items.push({ name, ok: level === 'ok', level, detail, hint });
    };

    const dataDir = config?.dataDir ?? path.resolve(process.cwd(), 'data');
    const logDir = config?.logDir ?? path.join(dataDir, 'logs');
    const configDir = path.join(config?.rootDir ?? process.cwd(), 'config');
    const isOffline = Boolean(offline || config?.offline);

    // 1. 配置文件
    try {
      const names = (await fs.readdir(configDir)).filter((name) => name.endsWith('.json'));
      if (!names.length) {
        add(
          t('system.selfcheck.item.config'),
          'warn',
          t('system.selfcheck.config.none', { dir: configDir }),
          t('system.selfcheck.config.noneHint'),
        );
      } else {
        const broken = [];
        for (const name of names) {
          try {
            JSON.parse(await fs.readFile(path.join(configDir, name), 'utf8'));
          } catch {
            broken.push(name);
          }
        }
        if (broken.length) {
          add(
            t('system.selfcheck.item.config'),
            'fail',
            t('system.selfcheck.config.broken', { list: broken.join('\u3001') }),
            t('system.selfcheck.config.brokenHint'),
          );
        } else {
          add(
            t('system.selfcheck.item.config'),
            'ok',
            t('system.selfcheck.config.ok', { count: names.length, list: names.join('\u3001') }),
          );
        }
      }
    } catch (error) {
      add(
        t('system.selfcheck.item.config'),
        'warn',
        t('system.selfcheck.config.readFailed', { dir: configDir, reason: error.code ?? error.message }),
        t('system.selfcheck.config.readFailedHint'),
      );
    }

    // 2. 数据目录可写（真的写一个临时文件再删掉）
    try {
      const probe = path.join(dataDir, `.selfcheck-${process.pid}-${Date.now()}.tmp`);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(probe, 'ok', 'utf8');
      const back = await fs.readFile(probe, 'utf8');
      await fs.unlink(probe);
      if (back !== 'ok') throw new Error(t('system.selfcheck.dataDir.probeMismatch'));
      add(t('system.selfcheck.item.dataDir'), 'ok', t('system.selfcheck.dataDir.ok', { dir: dataDir }));
    } catch (error) {
      add(
        t('system.selfcheck.item.dataDir'),
        'fail',
        t('system.selfcheck.dataDir.failed', { dir: dataDir, reason: error.code ?? error.message }),
        t('system.selfcheck.dataDir.hint'),
      );
    }

    // 3. 模型 API Key
    const apiKey = String(config?.model?.apiKey ?? config?.env?.MODEL_API_KEY ?? '').trim();
    if (apiKey) {
      add(t('system.selfcheck.item.apiKey'), 'ok', t('system.selfcheck.apiKey.ok', { length: apiKey.length }));
    } else {
      add(
        t('system.selfcheck.item.apiKey'),
        'warn',
        t('system.selfcheck.apiKey.missing'),
        t('system.selfcheck.apiKey.hint'),
      );
    }

    // 4. 模型接口连通（离线时跳过；网络不通只提醒，不判整份自检失败）
    if (!withNetwork) {
      /* 启动那一趟不查，等连上再查 */
    } else if (isOffline) {
      add(
        t('system.selfcheck.item.model'),
        'warn',
        t('system.selfcheck.model.offline'),
        t('system.selfcheck.model.offlineHint'),
      );
    } else if (typeof services.llm?.chat !== 'function') {
      add(
        t('system.selfcheck.item.model'),
        'warn',
        t('system.selfcheck.model.missingClient'),
        t('system.selfcheck.model.missingClientHint'),
      );
    } else {
      try {
        const began = Date.now();
        await services.llm.chat({
          role: 'judge',
          json: false,
          stream: false,
          maxTokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        });
        add(
          t('system.selfcheck.item.model'),
          'ok',
          t('system.selfcheck.model.ok', {
            model: config?.model?.model ?? t('system.selfcheck.model.unknownName'),
            ms: Date.now() - began,
          }),
        );
      } catch (error) {
        add(
          t('system.selfcheck.item.model'),
          'warn',
          t('system.selfcheck.model.failed', { reason: error?.code ?? error?.message ?? error }),
          t('system.selfcheck.model.failedHint'),
        );
      }
    }

    // 5. OneBot 连接
    if (!withNetwork) {
      /* 启动那一趟还没连，不查 */
    } else if (!services.onebot) {
      add(
        t('system.selfcheck.item.onebot'),
        'warn',
        t('system.selfcheck.onebot.missingClient'),
        t('system.selfcheck.onebot.missingClientHint'),
      );
    } else {
      try {
        const status = typeof services.onebot.status === 'function' ? await services.onebot.status() : null;
        if (status?.connected) {
          add(
            t('system.selfcheck.item.onebot'),
            'ok',
            status.selfId
              ? t('system.selfcheck.onebot.connectedAs', { selfId: status.selfId })
              : t('system.selfcheck.onebot.connected'),
          );
        } else {
          add(
            t('system.selfcheck.item.onebot'),
            'warn',
            t('system.selfcheck.onebot.disconnected', {
              mode: config?.bot?.onebot?.mode ?? t('system.selfcheck.unknown'),
            }),
            t('system.selfcheck.onebot.disconnectedHint'),
          );
        }
      } catch (error) {
        add(
          t('system.selfcheck.item.onebot'),
          'fail',
          t('system.selfcheck.onebot.statusFailed', { reason: error?.message ?? error }),
          t('system.selfcheck.onebot.statusFailedHint'),
        );
      }
    }

    // 6. Python 侧车
    if (!withNetwork) {
      /* 启动那一趟侧车还没起，不查 */
    } else if (config?.sidecar?.enabled === false) {
      add(
        t('system.selfcheck.item.sidecar'),
        'warn',
        t('system.selfcheck.sidecar.disabled'),
        t('system.selfcheck.sidecar.disabledHint'),
      );
    } else if (!services.sidecar) {
      add(
        t('system.selfcheck.item.sidecar'),
        'warn',
        t('system.selfcheck.sidecar.missingClient'),
        t('system.selfcheck.sidecar.missingClientHint'),
      );
    } else {
      try {
        const probe =
          (typeof services.sidecar.probe === 'function' ? await services.sidecar.probe() : null) ??
          (typeof services.sidecar.health === 'function' ? await services.sidecar.health() : null);
        if (probe?.ok) {
          const features = probe.features ? Object.entries(probe.features).filter(([, on]) => on).map(([key]) => key) : [];
          add(
            t('system.selfcheck.item.sidecar'),
            'ok',
            t('system.selfcheck.sidecar.ok', {
              version: probe.version ?? t('system.selfcheck.sidecar.versionUnknown'),
              features: features.length
                ? t('system.selfcheck.sidecar.features', { list: features.join('/') })
                : '',
            }),
          );
        } else {
          add(
            t('system.selfcheck.item.sidecar'),
            'warn',
            t('system.selfcheck.sidecar.unavailable', {
              error: probe?.error ?? t('system.selfcheck.sidecar.noResponse'),
            }),
            t('system.selfcheck.sidecar.unavailableHint'),
          );
        }
      } catch (error) {
        add(
          t('system.selfcheck.item.sidecar'),
          'warn',
          t('system.selfcheck.sidecar.probeFailed', { reason: error?.message ?? error }),
          t('system.selfcheck.sidecar.probeFailedHint'),
        );
      }
    }

    // 7. 日志目录
    try {
      const probe = path.join(logDir, `.selfcheck-${process.pid}-${Date.now()}.tmp`);
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(probe, 'ok', 'utf8');
      await fs.unlink(probe);
      add(t('system.selfcheck.item.logDir'), 'ok', t('system.selfcheck.logDir.ok', { dir: logDir }));
    } catch (error) {
      add(
        t('system.selfcheck.item.logDir'),
        'warn',
        t('system.selfcheck.logDir.failed', { dir: logDir, reason: error.code ?? error.message }),
        t('system.selfcheck.logDir.hint'),
      );
    }

    // 8. 沙箱边界
    const boundaryMode = config?.security?.boundary?.mode ?? 'sandbox';
    const boundary = services.security?.boundary ?? services.boundary ?? null;
    try {
      const described = boundary?.describe?.();
      if (boundaryMode === 'trusted') {
        add(
          t('system.selfcheck.item.boundary'),
          'warn',
          firstLine(described) || t('system.selfcheck.boundary.trusted'),
          t('system.selfcheck.boundary.trustedHint'),
        );
      } else if (described) {
        add(t('system.selfcheck.item.boundary'), 'ok', firstLine(described));
      } else {
        add(
          t('system.selfcheck.item.boundary'),
          'warn',
          t('system.selfcheck.boundary.missing'),
          t('system.selfcheck.boundary.missingHint'),
        );
      }
    } catch (error) {
      add(
        t('system.selfcheck.item.boundary'),
        'warn',
        t('system.selfcheck.boundary.describeFailed', { reason: error?.message ?? error }),
        t('system.selfcheck.boundary.describeFailedHint'),
      );
    }

    // 9. 口令池
    const passphrase = config?.security?.passphrase ?? {};
    const pool = (passphrase.pool ?? []).filter((item) => String(item ?? '').trim());
    if (passphrase.enabled === false) {
      add(
        t('system.selfcheck.item.passphrase'),
        'warn',
        t('system.selfcheck.passphrase.disabled'),
        t('system.selfcheck.passphrase.disabledHint'),
      );
    } else if (!pool.length) {
      add(
        t('system.selfcheck.item.passphrase'),
        'fail',
        t('system.selfcheck.passphrase.empty'),
        t('system.selfcheck.passphrase.emptyHint'),
      );
    } else {
      add(
        t('system.selfcheck.item.passphrase'),
        'ok',
        t('system.selfcheck.passphrase.ok', {
          count: pool.length,
          shortest: Math.min(...pool.map((item) => String(item).trim().length)),
        }),
      );
    }

    // 10. Node 版本
    const nodeMajor = Number(String(process.versions.node).split('.')[0]);
    if (nodeMajor >= MIN_NODE_MAJOR) {
      add(t('system.selfcheck.item.node'), 'ok', `v${process.versions.node}`);
    } else {
      add(
        t('system.selfcheck.item.node'),
        'fail',
        t('system.selfcheck.node.tooOld', { version: process.versions.node }),
        t('system.selfcheck.node.hint', { min: MIN_NODE_MAJOR }),
      );
    }

    // 11. 磁盘剩余
    try {
      const fsInfo = await fs.statfs(dataDir);
      const free = Number(fsInfo.bsize) * Number(fsInfo.bavail);
      if (free < MIN_FREE_BYTES) {
        add(
          t('system.selfcheck.item.disk'),
          'warn',
          t('system.selfcheck.disk.low', { free: humanBytes(free), dir: dataDir }),
          t('system.selfcheck.disk.lowHint'),
        );
      } else {
        add(
          t('system.selfcheck.item.disk'),
          'ok',
          t('system.selfcheck.disk.ok', { free: humanBytes(free), dir: dataDir }),
        );
      }
    } catch (error) {
      add(
        t('system.selfcheck.item.disk'),
        'warn',
        t('system.selfcheck.disk.failed', { reason: error?.message ?? error }),
        t('system.selfcheck.disk.failedHint'),
      );
    }

    const failed = items.filter((item) => item.level === 'fail').length;
    const warned = items.filter((item) => item.level === 'warn').length;
    const passed = items.length - failed - warned;
    const parts = [t('system.selfcheck.summary.partOk', { count: passed })];
    if (warned) parts.push(t('system.selfcheck.summary.partWarn', { count: warned }));
    if (failed) parts.push(t('system.selfcheck.summary.partFail', { count: failed }));
    const summary = t('system.selfcheck.summary.head', {
      status: failed ? t('system.selfcheck.summary.failed') : t('system.selfcheck.summary.passed'),
      parts: parts.join('\uFF0C'),
      tail: withNetwork ? '' : t('system.selfcheck.summary.startupTail'),
    });

    const report = { ok: failed === 0, phase, startedAt, durationMs: Date.now() - startedAt, items, summary };
    log?.[failed ? 'warn' : 'info']?.(summary, { failed, warned });
    return report;
  }

  return { run };
}
