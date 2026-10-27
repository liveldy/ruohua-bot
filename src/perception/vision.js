/**
 * 视觉服务：识图、看屏幕、听音频转写。
 *
 * 契约见 docs/INTERFACES.md 第 12 节：createVisionService({ llm, sidecar, logger, config })
 *   - async describeImages({ images, prompt, userId }) → string
 *   - async seeScreen({ prompt })
 *   - async transcribe({ file }) → string | null
 *
 * 这台机器没配视觉模型时，返回一句人话说明，而不是把异常抛给上层。
 */

import { createScreenService } from './screen.js';
import { t } from '../i18n/index.js';

/**
 * 文字都在模块加载时求值，会被面板后来改的文字「冻住」，所以这里一律用函数取。
 * `NO_VISION_TEXT` 只留给老调用方做等值比较，判断请用 `noVisionText()`。
 */
export const NO_VISION_TEXT = t('perception.vision.noVisionModel');
export const noVisionText = () => t('perception.vision.noVisionModel');
const noImageText = () => t('perception.vision.noImage');
const defaultImagePrompt = () => t('perception.vision.imagePrompt');
const defaultScreenPrompt = () => t('perception.vision.screenPrompt');

/**
 * 形如「文件读不到」的错误码：这类失败跟模型没关系，别把提示写成「换个能看图的模型」。
 * 真机日志里就有这么一条 —— 表情包的裸缓存文件名被当成路径，报 ENOENT，提示却指向 visionModel。
 */
const READ_ERROR_PATTERN = /ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EBUSY|ENAMETOOLONG/;

const isReadError = (message) => READ_ERROR_PATTERN.test(String(message ?? ''));

/** 图片可以是字符串，也可以是 { file, url, path }。 */
function normalizeImages(images) {
  const list = Array.isArray(images) ? images : images ? [images] : [];
  return list
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') return item.trim() || null;
      const picked = item.url || item.path || item.file;
      return picked ? String(picked) : null;
    })
    .filter(Boolean);
}

export function createVisionService({ llm = null, sidecar = null, logger = null, config = null, screen: injectedScreen = null } = {}) {
  const log = logger?.child ? logger.child('vision') : logger;
  let screenService = injectedScreen;
  /** 两类提示各自只提醒一次，别刷屏：「模型看不到图」与「图本身读不到」是两回事。 */
  let hintedNoVisionModel = false;
  let hintedReadFailure = false;

  function screen() {
    if (!screenService) screenService = createScreenService({ config, sidecar, logger });
    return screenService;
  }

  /**
   * 能看图吗：`visionModel` 留空就用主模型（DeepSeek 这类多模态主模型自己就能看图）。
   * @returns {string|null} 用来识图的模型名；null = 这台机器上看不了图
   */
  function visionTarget() {
    const target = llm?.visionTargetName ?? llm?.visionModelName ?? config?.model?.visionModel ?? llm?.modelName ?? config?.model?.model ?? null;
    return target ? String(target) : null;
  }

  function visionEnabled() {
    if (config?.vision?.enabled === false) return false;
    if (!llm?.vision) return false;
    return Boolean(visionTarget());
  }

  async function describeImages({ images = [], prompt = null, userId = null } = {}) {
    const list = normalizeImages(images);
    if (!list.length) return noImageText();
    if (!visionEnabled()) return noVisionText();
    try {
      const text = await llm.vision({ prompt: prompt || defaultImagePrompt(), images: list });
      const trimmed = String(text ?? '').trim();
      if (!trimmed) return t('perception.vision.emptyAnswer');
      return trimmed;
    } catch (error) {
      if (error?.code === 'vision_unsupported') return noVisionText();
      const message = error?.message ?? error;
      log?.warn?.(
        userId
          ? t('perception.vision.describeFailedForUser', { userId, error: message })
          : t('perception.vision.describeFailed', { error: message }),
      );
      // 报错原因分两种各说一次：文件读不到就别让人去翻 visionModel 了
      if (isReadError(message)) {
        if (!hintedReadFailure) {
          hintedReadFailure = true;
          log?.warn?.(t('perception.vision.checkImageRead', { error: message }));
        }
      } else if (!hintedNoVisionModel) {
        hintedNoVisionModel = true;
        log?.warn?.(t('perception.vision.checkVisionModel', { model: visionTarget() ?? '' }));
      }
      return t('perception.vision.describeUnknown');
    }
  }

  async function seeScreen({ prompt = null } = {}) {
    const shot = await screen().capture();
    if (!shot?.path) return t('perception.vision.screenUnavailable');
    return describeImages({ images: [{ path: shot.path }], prompt: prompt || defaultScreenPrompt() });
  }

  async function transcribe({ file = null } = {}) {
    const target = typeof file === 'object' && file !== null ? file.path ?? file.url ?? file.file : file;
    if (!target) return null;
    if (!sidecar?.asr) return null;
    try {
      const text = await sidecar.asr(target);
      return text ? String(text).trim() : null;
    } catch (error) {
      log?.warn?.(t('perception.vision.transcribeFailed', { error: error?.message ?? error }));
      return null;
    }
  }

  return {
    describeImages,
    seeScreen,
    transcribe,
    get visionEnabled() {
      return visionEnabled();
    },
  };
}
