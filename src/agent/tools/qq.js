/**
 * 会话类工具：send_file（把成果文件发给用户）、send_expression（发个表情/表情包）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { faceSegment, imageSegment } from '../../onebot/segments.js';
import { pickExpression } from '../../persona/expressions.js';
import { assertNotAborted, boundaryOf, requireArg, requireMethod, safePath, ToolError } from './error.js';
import { t } from '../../i18n/index.js';

export function createQqTools({ config, services }) {
  /** 优先用注入的 persona 服务，没有就直接用 persona 模块（接口冻结）。 */
  function resolvePicker() {
    const persona = services?.persona;
    if (typeof persona?.pickExpression === 'function') return { pick: persona.pickExpression.bind(persona), personaConfig: persona.config ?? config?.persona ?? null };
    if (typeof persona?.expressions?.pickExpression === 'function') {
      return { pick: persona.expressions.pickExpression.bind(persona.expressions), personaConfig: persona.config ?? config?.persona ?? null };
    }
    return { pick: pickExpression, personaConfig: config?.persona ?? null };
  }

  async function sendFileRun(args, ctx) {
    assertNotAborted(ctx);
    const target = safePath(boundaryOf(services), requireArg(args, 'path', { type: 'string' }));
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ToolError(t('agent.qq.notFound', { path: target }), 'not_found', { path: target });
      throw new ToolError(t('agent.qq.readFailed', { message: error.message }), 'io_error', { path: target });
    }
    if (!stat.isFile()) throw new ToolError(t('agent.qq.notAFile', { path: target }), 'not_a_file', { path: target });
    const upload = requireMethod(services, 'onebot', 'uploadFile', 'onebot.uploadFile');
    const name = args?.name ? String(args.name) : path.basename(target);
    const result = await upload({
      scene: ctx?.scene ?? 'private',
      userId: ctx?.userId ?? null,
      groupId: ctx?.groupId ?? null,
      file: target,
      name,
    });
    return { ok: true, path: target, name, bytes: stat.size, result: result ?? null };
  }

  async function sendExpressionRun(args, ctx) {
    assertNotAborted(ctx);
    const sendTo = requireMethod(services, 'onebot', 'sendTo', 'onebot.sendTo');
    const type = args?.type ? String(args.type) : 'auto';
    let expression = null;
    if (type === 'face' && args?.id !== undefined && args?.id !== null) {
      expression = { type: 'face', id: String(args.id) };
    } else if (type === 'sticker' && args?.file) {
      expression = { type: 'sticker', file: String(args.file) };
    } else {
      const { pick, personaConfig } = resolvePicker();
      const context = { userId: ctx?.userId ?? null, scene: ctx?.scene ?? 'private', text: ctx?.message?.text ?? '' };
      // 挑表情是概率性的，多试两次，实在没有就算了
      for (let attempt = 0; attempt < 3 && !expression; attempt += 1) {
        expression = await pick({
          persona: personaConfig,
          emotion: null,
          rng: Math.random,
          context,
          config,
        });
      }
    }
    if (!expression || !expression.type) throw new ToolError(t('agent.qq.noExpression'), 'no_expression');
    const segment = expression.type === 'face' ? faceSegment(expression.id) : imageSegment(expression.file);
    const sent = await sendTo({ scene: ctx?.scene ?? 'private', userId: ctx?.userId ?? null, groupId: ctx?.groupId ?? null }, [segment]);
    return { ok: true, expression, sent: sent ?? null };
  }

  const sendFile = {
    name: 'send_file',
    description: t('agent.qq.sendFile.description'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: t('agent.qq.sendFile.path') },
        name: { type: 'string', description: t('agent.qq.sendFile.name') },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitive: true,
    action: 'send_file',
    run: sendFileRun,
  };

  const sendExpression = {
    name: 'send_expression',
    description: t('agent.qq.sendExpression.description'),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['auto', 'face', 'sticker'], description: t('agent.qq.sendExpression.type') },
        id: { type: 'string', description: t('agent.qq.sendExpression.id') },
        file: { type: 'string', description: t('agent.qq.sendExpression.file') },
      },
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: sendExpressionRun,
  };

  return [sendFile, sendExpression];
}
