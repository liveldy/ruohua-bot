# 表情包库

若华发出去的表情包图片住在这儿。它自己学下来的图命名为 `sticker_<短id>.<ext>`，
索引在 `data/stickers/index.json`（记着每张的标题、含义、标签、谁教的、用过几次）。
接口与接线见 [docs/STICKERS.md](../docs/STICKERS.md)。

## 图是从哪来的

- **它在群里自己学**：管理员发一张表情包，它把图存进这个目录、让视觉模型认一眼再收成标题与含义
  写进索引，同内容的图只记一次；别人发的默认不入库，只记印象（`learnFromOthers` 打开才学）。
- **你自己丢进来**：png / jpg / gif / webp / bmp 直接放进这个目录就行。这种图不在索引里，
  但一直能被老逻辑（`config/persona.json` 的 `expressions.stickerChance`）挑中；想让它带含义、
  进标签体系，走面板或 `service.learn(路径)` 收编一张。

## 怎么调

`config/sticker.json`：`enabled` 是总开关，`sendChance`（默认 0.16）是每次回复末尾发表情包的概率，
`cooldownMs`（默认 120000）是同一张的冷却，`standalone`（默认 `true`）让它**单独发一条**，
`maxItems`（默认 500）/ `maxFileBytes`（默认 2MB）是库容量与单张大小上限。

- 想让它少发：调小 `sendChance`，或把 `enabled` 置 `false`。
- 想清空：删掉目录里的图与 `data/stickers/index.json`（别删 `data/` 下别的东西）。
- 十到几十张就够，同一类情绪放一起更容易被固定选中；含义写得越准（「得意」「摆烂」「无语」）挑得越对，
  认不出含义的图以 `meaning: ''` 入库，在面板里补一句就行。
