# 它是怎么转的

单进程、单账号：`node src/main.js` 把模块装配起来，连上协议端，剩下的事都在这条链上跑。

## 架构图

```
QQ 客户端  ←→  腾讯服务器
                    ↕
             NapCat（协议端，登录你的 QQ 号）
                    ↕  OneBot 11：正向 ws / 反向 ws / HTTP 上报
  ┌─────────────────┴──────────────────────────────────────────────┐
  │ 若华（Node.js）                                                 │
  │                                                                │
  │ onebot/          连接层：握手、收发、消息段解析                  │
  │   ↓                                                            │
  │ brain/dispatcher.js   入口，一条消息从这里进                    │
  │   ├─ sticker/            表情包：认得 / 学 / 挑 / 单独发一条      │
  │   ├─ security/           可疑行为检测 → 敏感操作两步验证、边界    │
  │   ├─ brain/context.js    上下文：人设 + 情感 + 记忆 + 近期对话     │
  │   ├─ brain/decision.js   决策：指令 / 闲聊 / 传统工作 / agent     │
  │   ├─ brain/chat.js       聊天里的工具环（能查文件 / 系统 / 联网）  │
  │   ├─ agent/runner.js     任务循环：想一步 → 执行 → 看结果 → 再决定 │
  │   │    └─ agent/execute.js   工具执行：超时、未知工具、敏感工具过验证 │
  │   ├─ brain/reply.js      回复：去 Markdown → 切短句 → 配表情 → 带停顿逐条发 │
  │   └─ emotion/ memory/    复盘：情绪判定 → 好感度 → 记忆沉淀       │
  │                                                                │
  │ autonomy/        定时任务 + 空闲活动 + 主动表达                  │
  │ persona/         人设提示词、语言风格、表情与表情包偏好           │
  │ perception/      视觉、屏幕、 Python 侧车客户端                  │
  │ system/          自检、状态汇报                                 │
  │ logging/         控制台 + app / conversation / operation 三种日志 │
  │ llm/client.js    模型客户端（流式、工具调用、多模态、用量、余额）  │
  │ web/ + web/      控制面板服务端与页面                            │
  └─────────────────┬──────────────────────────────────────────────┘
                    ↕ HTTP（本地）
         Python 侧车 python/sidecar.py
         向量 / 记忆打分 / 巩固建议 / 截屏 / 语音转写 / OCR
                    ↕ HTTPS
         模型接口（OpenAI 兼容：DeepSeek / OpenAI / vLLM …）
```

控制面板跟着主程序一起起，端口取 `config/web.json` 的 `port`（默认 8787）；`--no-web` 关掉它。

## 一条消息进来之后的流水线

`brain/dispatcher.js` 的 `handleMessage` 起头，`processMessage` 收尾。

| 步 | 谁 | 做什么 |
| --- | --- | --- |
| 1 | `sticker/` | 收到表情包先过一遍：管理员发的存进库并认含义，别人发的只记个印象。这一步只学不回复，也放在门槛之前（群里没 @ 也学得到） |
| 2 | `dispatcher.shouldHandle` | 门槛：自己的消息、黑名单、群白名单、群里要不要 @、私聊白名单与未知私聊 |
| 3 | `logging/` | 记一条对话日志（`conversation` 通道），带场景、昵称、角色、消息 id |
| 4 | `security/` | 可疑行为检测：关键词打分 + 可选的模型判定，越线就带昵称和号码汇报管理者 |
| 5 | `autonomy/` | 记一次「有人来过」，用于空闲判定 |
| 6 | `dispatcher` | 并发额度（默认 4）与同一会话串行排队；同一群里两条消息不会抢着回复 |
| 7 | `security/` | 上一轮有没答完的口令，先把这句当回答判一次；答对后接着办那件被拦下的事 |
| 8 | `dispatcher` | 收掉上一轮挂着问对方、等不到回话的任务（正在等暗号的不收） |
| 9 | `brain/decision.js` | 决策：`command`（斜杠指令）/ `chat`（闲聊）/ `work`（说一步做一步）/ `agent`（给目标自己拆）。先走便宜的规则快路径，剩下的交给一次轻量判定 |
| 10 | `brain/context.js` | 组装上下文：人设 + 情感 + 记忆 + 近期对话 + 手头在跑的任务事实 + 可用的工具表。只在真要回话或干活时才组装，走指令那条路不组装 |
| 11 | 执行 | 指令交给 `handleCommand`；工作类交给 `agent/runner.js` 在后台跑，不阻塞后续对话；闲聊先按情绪掷一次「回不回」，再走 `brain/chat.js` 的工具环 |
| 12 | `brain/reply.js` | 回复：去 Markdown、规整标点 → 太长就写成文件发 → 切成短句 → 带打字停顿逐条发出 → 最后一条之后单独补一个 QQ 表情或一张表情包（表情包自己一条消息） |
| 13 | `emotion/` `memory/` | 复盘：情绪判定 → 好感度变化 → 记忆沉淀。她把正文之外的额外发送也写回上下文，免得事后不知道自己发过图 |

任务跑完还会把一句摘要记回发起它的那次对话 —— 那件事是她自己做过的，下一轮她得记得。

## 目录结构

```
src/
  main.js            入口：装载配置 → 自检 → 组装模块 → 连 QQ → 起自主性
  config/            配置装载（config/*.json + .env 覆盖）
  i18n/              本地化：本地化键表与 t() / 键的存取
  util/              通用工具：文本、时间、原子写文件、子进程输出解码、控制台
  logging/           控制台 + app / conversation / operation 三种日志
  onebot/            连接（正向 / 反向 / HTTP）与消息段
  llm/               模型客户端（流式、工具调用、多模态、用量、余额）
  persona/           人设提示词、语言风格、分段、表情
  emotion/           好感度与情绪引擎、情绪判定
  memory/            记忆存储、召回、巩固（永久 / 临时）
  agent/             agent 循环、任务表、工具集、工具执行
  brain/             分发器、上下文、决策、聊天工具环、回复流水线
  security/          两步验证、可疑行为告警、边界
  autonomy/          定时任务、空闲活动、主动表达
  perception/        视觉、屏幕、Python 侧车客户端
  sticker/           表情包库与「认识 / 学 / 挑 / 发」
  system/            自检、状态汇报
  web/               控制面板服务端（配置 / 环境变量 / 本地化键 / 表情包 / 日志 / 调试）
web/                 控制面板前端（原生 JS，无需构建）
python/              侧车（仅标准库，可选能力按需装）+ 同一套本地化键的读取器
tools/dev/           假 NapCat、假模型接口 + 编码体检 + 本地化体检
stickers/            表情包图片本体
tests/               单元测试与端到端测试（按模块分目录，端到端在 tests/e2e/）
config/ .env.example 配置样例与 .env 样例
```

运行时的东西都在 `data/`：`memory/` 记忆（按人一个文件）、`emotion.json` 好感度与情绪、`context/` 近期对话、
`schedule.json` 定时任务、`tasks.json` 任务、`outbox/` 发出去的长文本、`logs/` 日志、`screenshots/` 截图、
`stickers/index.json` 表情包索引、`locales/zh-CN.json` 改过的文字、`config-backup/` 每次保存配置前的备份、
`autonomy.jsonl` 自主活动记录、`web/` 面板自己的状态与垫片。

相关：[她是什么样的](FEATURES.md) · [怎么用](USAGE.md) · [配置与数据](CONFIG.md) · [模块接口约定](INTERFACES.md) · [控制面板](WEB.md)
