/**
 * 系统类工具：shell（跑命令，敏感）、screen_capture（截屏）、see_image（看图）、system_status（自报状态）。
 */

import { exec } from 'node:child_process';
import { utf8Env } from '../../util/console.js';
import { decodeProcessOutput } from '../../util/text.js';
import { assertNotAborted, boundaryOf, requireArg, requireMethod, requireService, safePath, ToolError, truncateWithNote } from './error.js';
import { t } from '../../i18n/index.js';

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}

function runCommand(command, { cwd, timeoutMs, maxOutputBytes, signal }) {
  return new Promise((resolve, reject) => {
    // 把 signal 交给 exec：取消时它会连进程树一起收掉，不必等子进程自己退出
    // 拿 Buffer 不要拿字符串：cmd 的中文输出是 GBK 字节，交给 decodeProcessOutput 按代码页判
    // env 里带 PYTHONUTF8 / PYTHONIOENCODING：不然 Python 按 locale（GBK）输出，
    // 中文要转一手、表情符号还会直接 UnicodeEncodeError（见 src/util/console.js）
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        encoding: 'buffer',
        windowsHide: true,
        env: utf8Env(process.env),
        maxBuffer: Math.max(maxOutputBytes * 4, 1024 * 1024),
        signal: signal ?? undefined,
      },
      (error, stdout, stderr) => {
        const merged = `${decodeProcessOutput(stdout)}${decodeProcessOutput(stderr)}`;
        const { text, truncated } = truncateWithNote(merged, maxOutputBytes);
        if (error && (error.name === 'AbortError' || signal?.aborted)) {
          reject(new ToolError(t('agent.system.aborted'), 'aborted', { command, output: text }));
          return;
        }
        if (error && (error.killed || error.signal)) {
          reject(
            new ToolError(t('agent.system.timeout', { timeout: timeoutMs }), 'timeout', {
              command,
              output: text,
            }),
          );
          return;
        }
        if (error) {
          if (error.code === 'ENOENT') {
            reject(new ToolError(t('agent.system.notFound', { command }), 'not_found', { command }));
            return;
          }
          resolve({
            ok: false,
            command,
            cwd,
            code: typeof error.code === 'number' ? error.code : 1,
            output: text,
            truncated,
          });
          return;
        }
        resolve({ ok: true, command, cwd, code: 0, output: text, truncated });
      },
    );
  });
}

export function createSystemTools({ config, services }) {
  const shellConfig = () => config?.security?.boundary?.shell ?? {};

  async function shellRun(args, ctx) {
    assertNotAborted(ctx);
    const command = requireArg(args, 'command', { type: 'string' });
    const shell = shellConfig();
    if (shell.enabled === false) {
      throw new ToolError(t('agent.system.shellDisabled'), 'shell_disabled');
    }
    const sandbox = boundaryOf(services);
    try {
      sandbox.checkCommand(command);
    } catch (error) {
      throw new ToolError(t('agent.system.commandDenied', { message: error.message }), 'command_denied', { command, cause: error?.name ?? null });
    }
    const cwd = safePath(sandbox, args?.cwd ? String(args.cwd) : (config?.boundaryRoot ?? config?.rootDir ?? process.cwd()));
    const configTimeout = Number(shell.timeoutMs ?? 30000) || 30000;
    const timeoutMs = clampNumber(args?.timeoutMs ?? configTimeout, 50, Math.max(configTimeout, 50));
    const maxOutputBytes = Math.max(200, Number(shell.maxOutputBytes ?? 20000) || 20000);
    return runCommand(command, { cwd, timeoutMs, maxOutputBytes, signal: ctx?.signal });
  }

  async function screenCaptureRun(args, ctx) {
    assertNotAborted(ctx);
    const screen = requireService(services, 'screen', 'screen');
    if (typeof screen.capture !== 'function') throw new ToolError(t('agent.system.serviceUnavailable', { label: 'screen.capture' }), 'service_unavailable');
    const target = args?.path ? safePath(boundaryOf(services), String(args.path)) : undefined;
    const shot = await screen.capture({ path: target, monitor: args?.monitor });
    if (!shot?.path) throw new ToolError(t('agent.system.captureFailed'), 'capture_failed');
    return {
      ok: true,
      path: shot.path,
      width: shot.width ?? null,
      height: shot.height ?? null,
      hint: t('agent.system.captureHint'),
    };
  }

  async function seeImageRun(args, ctx) {
    assertNotAborted(ctx);
    const raw = Array.isArray(args?.images) ? args.images : args?.path || args?.image ? [args.path ?? args.image] : [];
    const images = raw.map((item) => String(item)).filter(Boolean);
    if (!images.length) {
      throw new ToolError(t('agent.system.missingImages'), 'missing_argument', { argument: 'images' });
    }
    const describe = requireMethod(services, 'vision', 'describeImages', 'vision.describeImages');
    const normalized = images.map((item) => {
      if (/^(https?:|data:|base64:)/i.test(item)) return item;
      return safePath(boundaryOf(services), item);
    });
    const description = await describe({
      images: normalized,
      prompt: args?.prompt ? String(args.prompt) : t('agent.system.defaultVisionPrompt'),
      userId: ctx?.userId ?? null,
    });
    return { ok: true, images: normalized, description: String(description ?? '') };
  }

  async function systemStatusRun(_args, ctx) {
    assertNotAborted(ctx);
    const report = requireMethod(services, 'status', 'report', 'status.report');
    const text = await report();
    return { ok: true, status: String(text ?? '') };
  }

  const shell = {
    name: 'shell',
    description: t('agent.system.shell.description'),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: t('agent.system.shell.command') },
        cwd: { type: 'string', description: t('agent.system.shell.cwd') },
        timeoutMs: { type: 'number', description: t('agent.system.shell.timeoutMs') },
      },
      required: ['command'],
      additionalProperties: false,
    },
    sensitive: true,
    action: 'shell',
    run: shellRun,
  };

  const screenCapture = {
    name: 'screen_capture',
    description: t('agent.system.screenCapture.description'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: t('agent.system.screenCapture.path') },
        monitor: { type: 'number', description: t('agent.system.screenCapture.monitor') },
      },
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: screenCaptureRun,
  };

  const seeImage = {
    name: 'see_image',
    description: t('agent.system.seeImage.description'),
    parameters: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'string' }, description: t('agent.system.seeImage.images') },
        path: { type: 'string', description: t('agent.system.seeImage.path') },
        prompt: { type: 'string', description: t('agent.system.seeImage.prompt') },
      },
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: seeImageRun,
  };

  const systemStatus = {
    name: 'system_status',
    description: t('agent.system.systemStatus.description'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    sensitive: false,
    action: null,
    run: systemStatusRun,
  };

  return [shell, screenCapture, seeImage, systemStatus];
}
