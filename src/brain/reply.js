/**
 * 回复流水线：把模型吐出的一大段，变成 QQ 里像人一样的一条条短消息。
 *   restyle（去 Markdown、规整标点）→ 需要时改成发文件 → 切分成短消息 → 配表情 → 带打字间隔逐条发。
 */

import path from 'node:path';
import { randomInt, sleep } from '../util/common.js';
import { charLength, stripMarkdown, truncate } from '../util/text.js';
import { ensureDir, writeTextAtomic } from '../util/io.js';
import { formatTime } from '../util/time.js';
import { faceSegment, imageSegment } from '../onebot/segments.js';
import { restyle, splitMessages, shouldSendAsFile, toFileContent } from '../persona/style.js';
import { pickExpression, resolveEmoji } from '../persona/expressions.js';
import { t } from '../i18n/index.js';

/** Windows 绝对路径 → OneBot 能认的 file:// URI。 */
export function toFileUri(filePath) {
  const absolute = path.resolve(filePath).replace(/\\/g, '/');
  return absolute.startsWith('/') ? `file://${absolute}` : `file:///${absolute}`;
}

/** 表情包在上下文里怎么称呼：标题优先，其次含义，都没有就说「一张表情包」。 */
function stickerLabel(item) {
  const text = String(item?.title ?? '').trim() || String(item?.meaning ?? '').trim();
  return truncate(text, 24);
}

/**
 * 正文之外**又单独发出去**的东西（表情包 / QQ 表情 / 贴图），写成一句给对话上下文的话。
 *
 * 真机上出过的事：她发完文字又单独甩了一张表情包，对方问「你为什么要发这个图」，
 * 她却答「我发图了吗」「我没发过图啊」——因为写回上下文的只有正文那几段文字，
 * 表情包走的是另一条发送路径，她事后完全不知道自己发过。她自己发过什么，得让她记得。
 *
 * @param {Array<{ kind: string, label?: string }>} extras send() 返回的那份
 * @returns {string} 没有额外东西时是空串
 */
export function sentExtrasNote(extras = []) {
  const lines = [];
  for (const extra of Array.isArray(extras) ? extras : []) {
    if (extra?.kind === 'sticker') {
      const label = String(extra.label ?? '').trim();
      lines.push(label ? t('brain.reply.sentStickerNote', { label }) : t('brain.reply.sentStickerPlain'));
    } else if (extra?.kind === 'face') {
      lines.push(t('brain.reply.sentFaceNote'));
    } else if (extra?.kind === 'image') {
      lines.push(t('brain.reply.sentImageNote'));
    }
  }
  return lines.join('');
}

export function createReplyPipeline({ config, persona, emotion, logger, rng = Math.random, sticker = null } = {}) {
  const childLog = logger?.child ? logger.child('reply') : logger;
  const behavior = config.bot.behavior ?? {};
  const outboxDir = path.join(config.dataDir, 'outbox');

  const state = {
    sent: 0,
    files: 0,
    expressions: 0,
    recentFaces: [],
    recentStickers: [],
  };

  async function sendSegments(chat, segments, { message = null } = {}) {
    const { sendTo } = chat;
    const data = await sendTo({ scene: chat.scene, userId: chat.userId, groupId: chat.groupId }, segments);
    state.sent += 1;
    logger?.conversation?.({
      scene: chat.scene,
      userId: chat.userId,
      groupId: chat.groupId,
      direction: 'out',
      text: segments
        .map((segment) => (segment.type === 'text' ? segment.data.text : `[${segment.type}]`))
        .join(''),
      name: config.persona.name,
      meta: { messageId: data?.message_id ?? null },
    });
    return data;
  }

  /** 打字间隔：字数越多等得越久，但有个上限。 */
  function typingDelay(text, hints) {
    const perChar = behavior.typingDelayPerCharMs ?? 55;
    const max = behavior.typingDelayMaxMs ?? 3500;
    const scale = hints?.segmentGapScale ?? 1;
    return Math.min(max, Math.round(charLength(text) * perChar * scale));
  }

  async function gapMs(hints) {
    const range = hints?.segmentGapMs ?? persona.style?.segments?.gapMs ?? [280, 1200];
    return randomInt(range[0], range[1], rng);
  }

  /**
   * 长文本走文件：写进 outbox 再上传。`send` 与 `result` 共用这一段，别写两份。
   * @param {{ chat: object, text: string, mode?: string }} params text 是原始正文（保留 Markdown，写进文件用）
   */
  async function deliverAsFile({ chat, text, mode = 'chat' }) {
    const fileName = `${config.persona.name}-${formatTime(Date.now(), { withDate: true }).replace(/[: ]/g, '-')}.md`;
    const filePath = path.join(outboxDir, fileName);
    await ensureDir(outboxDir);
    await writeTextAtomic(filePath, toFileContent(text));
    state.files += 1;
    const head = mode === 'agent' ? t('brain.reply.fileHead.agent') : t('brain.reply.fileHead.chat');
    const headText = restyle(head, { persona, emotion: null });
    await sendSegments(chat, [{ type: 'text', data: { text: headText } }]);
    try {
      await chat.uploadFile?.({ file: filePath, name: fileName });
    } catch (error) {
      childLog?.warn?.(t('brain.reply.uploadFailed'), error);
      await sendSegments(chat, [{ type: 'text', data: { text: t('brain.reply.uploadFallback') } }]);
    }
    logger?.operation?.({ actor: 'ruohua', action: 'send_file', target: fileName, ok: true, detail: { scene: chat.scene } });
    return { sentMessages: 1, texts: [headText], filePath, expressions: 0, extras: [] };
  }

  /**
   * 挑一张表情包。pick() 内部已经掷过 sendChance，这里绝不再乘一次；
   * 功能关着、库空、全在冷却、服务没接上 → null（退回老的表情兜底）。
   */
  async function pickSticker({ text, hints }) {
    if (!sticker || sticker.enabled === false) return null;
    try {
      return await sticker.pick({
        text,
        mood: hints?.mood ?? null,
        affection: hints?.affection ?? null,
        recentStickers: state.recentStickers,
        rng,
      });
    } catch (error) {
      childLog?.debug?.(t('brain.reply.stickerPickFailed'), error);
      return null;
    }
  }

  /** 表情包单独发一条：正文已经发完了才走这里，绝不与文字挤在同一条消息里。 */
  async function sendPickedSticker(chat, item, hints) {
    await sleep(await gapMs(hints));
    try {
      const sent = await sticker.send(chat, { scene: chat.scene, userId: chat.userId, groupId: chat.groupId }, item);
      if (!sent?.ok) {
        childLog?.debug?.(t('brain.reply.stickerSendFailed', { reason: sent?.error ?? t('brain.reply.unknownReason') }), { id: item?.id ?? null });
        return false;
      }
      state.recentStickers.push(item.path ?? item.file ?? item.id);
      state.recentStickers = state.recentStickers.slice(-6);
      state.expressions += 1;
      return true;
    } catch (error) {
      childLog?.debug?.(t('brain.reply.stickerSendFailed', { reason: error?.message ?? error }), { id: item?.id ?? null });
      return false;
    }
  }

  /**
   * 把一条回复发出去。
   * @param {{ chat: object, text: string, mode?: string, asFile?: boolean, hints?: object, message?: object }} params
   */
  async function send({ chat, text, mode = 'chat', asFile = false, hints = null, message = null, skipExpression = false }) {
    const raw = String(text ?? '').trim();
    if (!raw) return { sentMessages: 0, texts: [], filePath: null, expressions: 0, extras: [] };

    const styled = restyle(raw, { persona, emotion: hints ? { hints } : null });
    if (!styled.trim()) return { sentMessages: 0, texts: [], filePath: null, expressions: 0, extras: [] };

    const needFile = asFile || shouldSendAsFile(styled, { persona });
    if (needFile) return deliverAsFile({ chat, text: raw, mode });

    const parts = splitMessages(styled, { persona, emotion: hints ? { hints } : null, rng });
    const texts = [];
    // 正文之外单独发出去的东西：调用方拿它写回对话上下文，好让她记得自己发过什么
    const extras = [];
    let expressions = 0;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const { text: cleanText, faces } = resolveEmoji(part, persona);
      const segments = [];
      if (cleanText.trim()) segments.push({ type: 'text', data: { text: cleanText.trim() } });
      for (const face of faces) segments.push(faceSegment(face));
      if (segments.length) {
        if (index > 0) await sleep(await gapMs(hints));
        else await sleep(typingDelay(part, hints));
        await sendSegments(chat, segments, { message });
        texts.push(cleanText.trim());
      }

      // 偶尔单独补一个表情 / 表情包：库里挑得到就发一张表情包（单独一条），挑不到才退回原来的表情
      if (!skipExpression && index === parts.length - 1) {
        const item = await pickSticker({ text: cleanText, hints });
        if (item && (await sendPickedSticker(chat, item, hints))) {
          expressions += 1;
          extras.push({ kind: 'sticker', label: stickerLabel(item) });
        } else {
          const expression = pickExpression({
            persona,
            emotion: hints ? { hints } : null,
            rng,
            context: { recentFaces: state.recentFaces, recentStickers: state.recentStickers },
            config,
            stickerDir: config.stickerDir,
          });
          if (expression) {
            if (expression.type === 'face') {
              state.recentFaces.push(expression.id);
              state.recentFaces = state.recentFaces.slice(-6);
            } else {
              state.recentStickers.push(expression.file);
              state.recentStickers = state.recentStickers.slice(-6);
            }
            await sleep(await gapMs(hints));
            const segment = expression.type === 'face' ? faceSegment(expression.id) : imageSegment(toFileUri(expression.file));
            try {
              await sendSegments(chat, [segment]);
              expressions += 1;
              state.expressions += 1;
              extras.push({ kind: expression.type === 'face' ? 'face' : 'image' });
            } catch (error) {
              childLog?.debug?.(t('brain.reply.expressionFailed'), error);
            }
          }
        }
      }
    }

    return { sentMessages: texts.length, texts, filePath: null, expressions, extras };
  }

  /**
   * 工作类：只发简短进度（不切分、不带表情、不动标点）。
   * 状态汇报里有时间戳和接口地址，标点规整会把「18:10:54」写成「18，10，54」，所以这里只去 Markdown。
   */
  async function progress({ chat, text }) {
    const clean = stripMarkdown(String(text ?? '')).replace(/[ \t]+\n/g, '\n').trim();
    if (!clean) return null;
    return sendSegments(chat, [{ type: 'text', data: { text: clean } }]);
  }

  /**
   * 技术通道：agent / work 的最终结果。
   * 只去 Markdown，保留换行、冒号、URL 与代码缩进；不带表情、不做聊天式标点规整、不切成短消息；
   * 太长照旧走「写成文件」那条路（与 send 共用 deliverAsFile）。
   * @param {{ chat: object, text: string, mode?: 'agent'|'work' }} params
   */
  async function result({ chat, text, mode = 'agent' }) {
    const raw = String(text ?? '').trim();
    if (!raw) return { sentMessages: 0, texts: [], filePath: null, expressions: 0, extras: [] };
    const clean = stripMarkdown(raw).replace(/[ \t]+\n/g, '\n').trim();
    if (!clean) return { sentMessages: 0, texts: [], filePath: null, expressions: 0, extras: [] };
    if (shouldSendAsFile(clean, { persona })) return deliverAsFile({ chat, text: raw, mode });
    await sendSegments(chat, [{ type: 'text', data: { text: clean } }]);
    return { sentMessages: 1, texts: [clean], filePath: null, expressions: 0, extras: [] };
  }

  return {
    send,
    progress,
    result,
    toFileUri,
    state: () => ({ ...state }),
  };
}
