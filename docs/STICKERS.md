# 表情包（sticker）

图片形式的表情（png / jpg / gif / webp / bmp / apng），和 QQ 内置表情（`face` 段）是两回事：
**表情包单独一条消息**发出，不跟文字挤在一起。

```
src/sticker/library.js   存储层：图片文件 + data/stickers/index.json
src/sticker/service.js   业务层：认识 / 学 / 挑 / 发；index.js 入口，createStickers()
config/sticker.json      配置（键与 src/config/index.js 的默认值一致）
stickers/                图片（sticker_<短id>.<ext>），索引在 data/stickers/index.json
tests/sticker/*.test.js  单测（假 vision / 假 llm，不联网）
```

索引形状 `{ version: 1, items: [...] }`，条目（`path` 是读取时算出来的，不落盘）：

```js
{
  id: 'lz4k9f2a1b', file: 'sticker_lz4k9f2a1b.png', ext: '.png', bytes: 20480,
  title: '得意的猫',                            // 短标题，最多 12 个字；认不出来是 ''
  meaning: '画的是猫翘着尾巴，适合自夸的时候发',  // 内容描述；认不出来是 ''
  tags: ['得意', '开心'],                       // 时机 / 情绪关键词，最多 8 个
  addedBy: 10001, addedAt: 1761000000000, usedCount: 3, lastUsedAt: 1761000000000,
  sourceHash: '<sha256 hex>',                  // 图片内容的 sha256，去重用
  origin: 'admin',                             // admin | others | manual | file | url | buffer
}
```

## 接口

```js
import { createStickers } from './sticker/index.js';
const sticker = await createStickers({ config, logger, llm, vision });   // main.js 里装一次
```

`createStickers()` = `createStickerLibrary()` + `await library.load()` + `createStickerService()`，路径取
`config.stickerDir` / `config.stickerIndexFile`，要自己控制生命周期就分别用两个工厂。

| 成员 | 说明 |
| --- | --- |
| `enabled` | `config.sticker.enabled !== false` |
| `async observe(message, { byAdmin })` / `note(message)` | 看一条收到的消息 → `{ saved, items, duplicates, skipped? }`（没有图片段时 `null`）；非管理员发的只 `note` 一份印象 |
| `async pick({ text, mood, affection, recentStickers, rng })` | 挑一张 → item / null |
| `async send(onebot, target, item, { text })` | 发那一条 → `{ ok, seg, messageId?, mode?, error? }` |
| `async describe(fileOrUrl)` | → `{ title, meaning, tags }`，认不出来时三个值都是空的 |
| `async learn(source, { addedBy, origin, title, meaning, tags })` | 收一张（路径 / URL / `base64://` / Buffer）→ item / null |
| `list` `get` `remove` `stats` | 转给存储层；`stats()` 另带 `notes` / `describes` / `unreadable` / `enabled` |

## 学习

- **管理员发的自动入库**（`learnFromAdmins`，默认 true），别人发的默认只记印象，`learnFromOthers` 打开才入库。
  判定顺序：`observe(message, { byAdmin: true })` → `message.isAdmin / admin` → `message.role === 'owner'`
  → `message.userId` 在 `config.security.admins` 里；OneBot 上报的 `sender.role` 是 QQ 群身份，不算数。
- **认标题与含义**（`autoMeaning`，默认 true，调用方没给 `title` / `meaning` 时才做）：`vision.describeImages()`
  拿画面描述，再交给 `llm.chat({ role: 'memory', json: true })` 收成 `{ title, meaning, tags }`；`visionModel` 留空用主模型。
- **降级**：视觉不可用或模型不给 JSON → `title` 空着、`meaning` 用画面描述截断兜底（认不出来时三个值都空），只记 warn，不抛错。
- **去重按图片内容的 sha256**：重复入库只 `usedCount += 1`，不覆盖已有的标题与描述。
- **只读 `stickers/` 与 `data/` 下的本地文件，或 http(s) 下载**；越界一律拒绝。协议端（NapCat）给的 `file` 只有裸文件名，
  真身在它自己的缓存目录里：`src/perception/image-source.js` 会按 `<文档>/Tencent Files/<QQ号>/nt_qq/nt_data` 的目录形状把它找回来
  （名字大小写不一致，比较时统一小写），找到的目录自动并进允许目录，不用手工配 `allowedRoots`；
  协议端把图放在别处时才需要把那个目录写进 `allowedRoots`。读不进来的来源在识图之前就被挡下，次数记进 `stats().unreadable`。

## 挑选与发送

- `chance = clamp(sendChance × moodBias(mood).sticker × (1 + clamp((affection - 50) / 100, -0.3, 0.5)), 0, 1)`
  —— **`pick()` 内部已经掷过这个概率**，调用方不要再乘一次 `sendChance`；概率没过、空库、功能关着、全在冷却
  都返回 `null`，这时什么都别发。
- 候选先剔掉 `cooldownMs` 内本进程发过的与 `recentStickers` 里的，再按分加权随机：关键词池 = `tags` + `title`
  （`title` 为空就不算），情绪命中 `+4`、池里的词出现在正文里每个 `+3`，`usedCount` 越少、越久没发过，分越高；`meaning` 不参与打分。

发出的那一条是 `{ type: 'image', data: { file: 'file:///…/sticker_xxx.png' } }`：

| 调用 | 实际发出 |
| --- | --- |
| `send(onebot, target, item)` | 一条：`[image]` |
| `send(onebot, target, item, { text: '行' })`，`standalone: true`（默认） | 两条：先 `[text]`，再 `[image]` |
| `send(onebot, target, item, { text: '行' })`，`standalone: false` | 一条：`[text, image]` |

- `onebot` 就是 OneBot 客户端（用它的 `sendTo`），`target` 形如 `{ scene: 'group', groupId }` / `{ scene: 'private',
  userId }`。发送成功才算一次使用（`usedCount += 1`）并进入 `cooldownMs` 冷却；**失败降级**：没有 `sendTo`
  或者协议端报错 → `{ ok: false, seg, error }`，只记 warn，不抛。

## 配置（`config/sticker.json`）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `learnFromAdmins` / `learnFromOthers` | `true` / `false` | 谁发的表情包会入库 |
| `autoMeaning` | `true` | 入库时让模型认标题与描述 |
| `sendChance` / `cooldownMs` | `0.16` / `120000` | 基础概率（还要乘情绪偏置）/ 同一张的最小发送间隔 |
| `standalone` | `true` | 单独一条；`false` 才允许和文字合成一条 |
| `maxItems` / `maxFileBytes` | `500` / `2097152` | 库容量与单张大小上限（下载也按这个截） |
| `downloadTimeoutMs` / `allowedRoots` | `5000` / `[]` | 下载超时 / 额外放行的本地目录（协议端图片缓存） |

`dir` / `indexFile` 由 `config.stickerDir` / `config.stickerIndexFile` 决定；`tags` 是预留键，用来限定只学某些标签。

## 自测

```bash
node --test "tests/sticker/*.test.js"    # 本子系统
node tools/dev/check-i18n.mjs --quiet    # 本地化体检
cmd //c "npm test"                       # 全量
```
