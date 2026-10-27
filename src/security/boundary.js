/**
 * 边界限定（模块三）：限定工作区域与命令权限。
 *
 * 两种模式：
 *  - sandbox（默认）：只允许在 workspaceRoot 内活动，另有 allowPaths 白名单、
 *    denyPaths 目录黑名单、denyNamePatterns 文件名黑名单，命令执行还要过 shell.denyPatterns
 *    并按 shell.enabled 决定是否放行。
 *  - trusted：完全信任模式，彻底放行 —— 越界路径、密钥文件（.env / .ssh / id_rsa 等）
 *    和任何命令都不再拦截，因为这一模式的语义就是「把机器交给它，不再设防」。
 *    配置里的拒绝名单在 trusted 下不生效，仅在单人本机使用且清楚后果时才切过去。
 */

import path from 'node:path';
import { t } from '../i18n/index.js';
import { findDeniedPattern } from './guard.js';

export class BoundaryError extends Error {
  constructor(message, { code = 'boundary_violation', path: target = null, detail = null } = {}) {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
    this.path = target;
    this.detail = detail;
  }
}

/** 目标是否在 base 目录内（含 base 自身）。 */
function isInside(target, base) {
  if (!base) return false;
  const rel = path.relative(base, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 文件名黑名单匹配：
 *  - 支持 * ? 通配
 *  - 完全同名
 *  - 前缀加边界：'id_rsa' 命中 'id_rsa.pub'、'credentials' 命中 'credentials.json'，
 *    但不会命中 'id_rsax'；'.env' 命中 '.env' / '.env.local'。
 */
function matchName(name, pattern) {
  const raw = String(pattern ?? '').trim();
  if (!raw) return false;
  const lower = String(name ?? '').toLowerCase();
  const pat = raw.toLowerCase();
  if (pat.includes('*') || pat.includes('?')) return globToRegExp(pat).test(lower);
  if (lower === pat) return true;
  if (!lower.startsWith(pat)) return false;
  const next = lower.charAt(pat.length);
  return next === '' || next === '.' || next === '-' || next === '_' || next === ' ';
}

export function createBoundary({ config, logger } = {}) {
  const cfg = config?.security?.boundary ?? {};
  const mode = String(cfg.mode ?? 'sandbox').toLowerCase();
  const root = path.resolve(
    config?.boundaryRoot ?? path.join(config?.rootDir ?? process.cwd(), cfg.workspaceRoot ?? '.'),
  );
  const allowPaths = (cfg.allowPaths ?? []).map((item) => path.resolve(root, String(item))).filter(Boolean);
  const denyPaths = (cfg.denyPaths ?? []).map((item) => path.resolve(root, String(item))).filter(Boolean);
  const denyNamePatterns = (cfg.denyNamePatterns ?? []).map((item) => String(item)).filter(Boolean);
  const shell = cfg.shell ?? {};
  const maxReadBytes = Number(cfg.maxReadBytes ?? 1048576);
  const maxWriteBytes = Number(cfg.maxWriteBytes ?? 262144);

  const trusted = mode === 'trusted';

  /** 解析并校验路径，返回绝对路径；越界或命中名单抛 BoundaryError。 */
  function checkPath(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new BoundaryError(t('security.boundary.emptyPath'), { code: 'empty_path' });
    const absolute = path.resolve(root, raw);

    // trusted：完全信任，不做任何边界检查，直接放行
    if (trusted) return absolute;

    const allowed = isInside(absolute, root) || allowPaths.some((base) => isInside(absolute, base));
    if (!allowed) {
      throw new BoundaryError(t('security.boundary.outOfBounds', { path: absolute, root }), {
        code: 'out_of_bounds',
        path: absolute,
        detail: { root, allowPaths },
      });
    }

    for (const denied of denyPaths) {
      if (absolute === denied || isInside(absolute, denied)) {
        throw new BoundaryError(t('security.boundary.deniedPath', { path: denied }), {
          code: 'denied_path',
          path: absolute,
          detail: { denied },
        });
      }
    }

    const segments = absolute.split(/[\\/]+/).filter(Boolean);
    for (const segment of segments) {
      for (const pattern of denyNamePatterns) {
        if (matchName(segment, pattern)) {
          throw new BoundaryError(t('security.boundary.deniedName', { segment, pattern }), {
            code: 'denied_name',
            path: absolute,
            detail: { segment, pattern },
          });
        }
      }
    }

    return absolute;
  }

  /** 命令是否可执行，可执行时原样返回。 */
  function checkCommand(command) {
    const cmd = String(command ?? '');
    if (!cmd.trim()) throw new BoundaryError(t('security.boundary.emptyCommand'), { code: 'empty_command' });

    // trusted：完全信任，不做任何检查
    if (trusted) return cmd;

    if (shell.enabled === false) {
      throw new BoundaryError(t('security.boundary.shellDisabled'), {
        code: 'shell_disabled',
      });
    }

    // 匹配规则见 guard.js 的 findDeniedPattern：带正则语法的条目按词边界走，
    // 其余按原样子串（不 trim），所以 "format C:" 拦得住、"/format:list" 不再误伤。
    const denied = findDeniedPattern(cmd, shell.denyPatterns ?? []);
    if (denied) {
      throw new BoundaryError(t('security.boundary.deniedCommand', { pattern: denied }), {
        code: 'denied_command',
        detail: { pattern: denied },
      });
    }
    return cmd;
  }

  /** 读写大小限制（额外能力，供 agent 工具使用）。 */
  function checkSize(kind, bytes) {
    if (trusted) return Number(bytes ?? 0);
    const size = Number(bytes ?? 0);
    const limit = kind === 'write' ? maxWriteBytes : maxReadBytes;
    if (Number.isFinite(size) && size > limit) {
      throw new BoundaryError(
        kind === 'write'
          ? t('security.boundary.tooLargeWrite', { size, limit })
          : t('security.boundary.tooLargeRead', { size, limit }),
        {
          code: 'too_large',
          detail: { kind, size, limit },
        },
      );
    }
    return size;
  }

  /** 人类可读的边界说明。 */
  function describe() {
    const lines = [];
    if (trusted) {
      lines.push(t('security.boundary.describe.trustedMode'));
      lines.push(t('security.boundary.describe.root', { root }));
      lines.push(t('security.boundary.describe.noLimit'));
      return lines.join('\n');
    }
    lines.push(t('security.boundary.describe.sandboxMode'));
    lines.push(t('security.boundary.describe.root', { root }));
    lines.push(
      t('security.boundary.describe.allowPaths', {
        list: allowPaths.length ? allowPaths.join('\u3001') : t('security.boundary.describe.none'),
      }),
    );
    lines.push(
      t('security.boundary.describe.denyPaths', {
        list: denyPaths.length ? denyPaths.join('\u3001') : t('security.boundary.describe.none'),
      }),
    );
    lines.push(
      t('security.boundary.describe.denyNames', {
        list: denyNamePatterns.length ? denyNamePatterns.join('\u3001') : t('security.boundary.describe.none'),
      }),
    );
    lines.push(
      t('security.boundary.describe.sizeLimits', {
        readKb: Math.round(maxReadBytes / 1024),
        writeKb: Math.round(maxWriteBytes / 1024),
      }),
    );
    lines.push(
      shell.enabled === false
        ? t('security.boundary.describe.shellOff')
        : t('security.boundary.describe.shellOn', {
            list: (shell.denyPatterns ?? []).join('\u3001') || t('security.boundary.describe.none'),
          }),
    );
    return lines.join('\n');
  }

  const boundary = {
    mode,
    root,
    trusted,
    checkPath,
    checkCommand,
    checkSize,
    describe,
  };

  logger?.debug?.(t('security.boundary.ready'), { mode, root });
  return boundary;
}
