/**
 * 表情包子系统入口：存储层（library）+ 业务层（service）。
 *
 * 接线见 docs/STICKERS.md：
 *   const sticker = await createStickers({ config, logger, llm, vision, imageSource });   // main.js 装一次
 *   await sticker.observe(message);   // dispatcher：管理员发的表情包存下来
 *   sticker.note(message);            // dispatcher：别人发的只记印象
 *   const item = await sticker.pick({ text, mood, affection });   // reply：挑一张
 *   if (item) await sticker.send(onebot, target, item);           // 表情包单独一条
 *
 * 想自己控制生命周期就分别用两个工厂：
 *   const library = createStickerLibrary({ dir, indexFile, logger, maxItems, maxFileBytes });
 *   await library.load();
 *   const service = createStickerService({ config, logger, llm, vision, library });
 */

import path from 'node:path';
import { t } from '../i18n/index.js';
import { createStickerLibrary, resolveStickerPaths } from './library.js';
import { createStickerService } from './service.js';

/** 配置里的相对路径按项目根算，绝对路径照原样。 */
function resolveAgainstRoot(value, config) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (path.isAbsolute(text)) return text;
  return path.resolve(config?.rootDir ?? process.cwd(), text);
}

export { createStickerLibrary, createStickerService, resolveStickerPaths };
export { sha256, STICKER_EXTENSIONS, INDEX_VERSION } from './library.js';
export { toStickerFileUri } from './service.js';

/**
 * 一行装好：建库 → 读索引 → 建服务。
 * @param {{ config: object, logger?: object|null, llm?: object|null, vision?: object|null, dir?: string|null,
 *           imageSource?: object|null }} options
 *   `imageSource`（src/perception/image-source.js）负责把协议端给的裸文件名还原成真路径；
 *   它探到的缓存目录同时并进库的允许目录，否则找回来的文件还是会被边界挡掉。
 */
export async function createStickers({ config, logger = null, llm = null, vision = null, dir = null, imageSource = null } = {}) {
  const paths = resolveStickerPaths({ config, dir });
  // 协议端缓存（NapCat 收到的图常落在它自己的目录里）要额外放行，默认仍然只有 data/ 与 stickers/
  const allowedRoots = Array.isArray(config?.sticker?.allowedRoots)
    ? config.sticker.allowedRoots.map((item) => resolveAgainstRoot(item, config))
    : [];
  if (imageSource?.roots) {
    try {
      for (const root of await imageSource.roots()) {
        if (root && !allowedRoots.includes(root)) allowedRoots.push(root);
      }
    } catch (error) {
      logger?.debug?.(t('sticker.log.learnFailed', { source: 'protocolRoots', reason: error?.message ?? error }));
    }
  }
  const library = createStickerLibrary({
    dir: paths.dir,
    indexFile: paths.indexFile,
    logger,
    maxItems: config?.sticker?.maxItems,
    maxFileBytes: config?.sticker?.maxFileBytes,
    rootDir: config?.rootDir ?? null,
    dataDir: config?.dataDir ?? null,
    downloadTimeoutMs: config?.sticker?.downloadTimeoutMs,
    allowedRoots,
  });
  await library.load();
  return createStickerService({
    config,
    logger,
    llm,
    vision,
    library,
    dir: paths.dir,
    resolveImage: imageSource ? (source) => imageSource.resolve(source) : null,
  });
}

export default { createStickers, createStickerLibrary, createStickerService };
