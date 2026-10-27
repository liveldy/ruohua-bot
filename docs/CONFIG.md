# 配置与数据（CONFIG）

配置分两处：`config/*.json` 按模块拆开，密钥与机器相关的放 `.env`（已被 git 忽略）。两处都能在控制面板里改，
`config/*.json` 走「配置」页，`.env` 走「环境变量」页——改完即存，存前把旧文件备份到
`data/config-backup/`（配置是 `<名字>-<时间戳>.json`，`.env` 是 `env-<时间戳>`）。保存 `.env` 只改值、注释与顺序原样保留；
密钥字段显示成 `********`，留着不动就表示不改它。面板只列已有的文件，不会替你新建 `config/*.json`。

## config/*.json

| 文件 | 管什么 |
| --- | --- |
| `bot.json` | 机器人本体：名称、日志级别、`dataDir`、连接方式、群聊/私聊的回复门槛与黑白名单、并发与打字节奏、近期对话窗口 |
| `model.json` | 模型接口（地址、密钥、模型名）、看图用的 `visionModel`（留空＝用主模型）、采样参数、各角色的温度与 `maxTokens`、余额查询 |
| `persona.json` | 人设与说话风格：`basePrompt`、标点规则、分段上限、多长算长文本、口头禅与禁忌、表情与表情包偏好 |
| `emotion.json` | 好感度初始值与增减权重、衰减半衰期、情绪时长、各情绪对回复频率的影响、好感度档位名 |
| `memory.json` | 临时记忆容量与半衰期、永久记忆门槛与关键词、召回权重与条数、巩固频率、每轮提炼上限 |
| `security.json` | 管理者、暗号池与频率窗口、敏感动作清单、可疑行为关键词与阈值、沙箱边界（可读路径、命令开关与上限） |
| `autonomy.json` | 空闲判定与活动、主动发言的频率与静默时段、定时任务轮询 |
| `agent.json` | agent 模式的步数/并发/超时、进度汇报频率、结果转文件阈值、工具结果截断长度 |
| `sticker.json` | 表情包：开关、图片目录与索引路径、发送概率与冷却、管理员发的图是否自动入库、额外允许读取的目录 |
| `tasks.json` | 固定定时任务（`{ "enabled": true, "tasks": [] }`），启动时合并进调度器；对话里加的落在 `data/schedule.json` |
| `web.json` | 控制面板：开关、监听地址与端口、访问令牌、是否允许非本机访问、NapCat 的目录/启动器/WebUI 地址 |

缺失的配置项用代码里的默认值补齐（`src/config/index.js` 的 `DEFAULTS`）；关键项非法时会直接以配置错误退出：
`model.baseUrl`、`model.model`、管理员、`onebot.mode` 与 `wsUrl`、暗号池、面板端口（且不能撞 3001 / 3002 / 3003 / 8765）。

## .env

面板「环境变量」页按这七组排：

| 分组 | 键 |
| --- | --- |
| 模型接口 | `MODEL_BASE_URL` `MODEL_API_KEY` `MODEL_NAME` `MODEL_VISION_NAME` |
| OneBot / NapCat | `ONEBOT_MODE` `ONEBOT_WS_URL` `ONEBOT_ACCESS_TOKEN` `ONEBOT_REVERSE_PORT` `ONEBOT_HTTP_URL` |
| 管理员 | `ADMIN_QQ` |
| Python 侧车 | `SIDECAR_ENABLED` `SIDECAR_URL` `SIDECAR_AUTOSTART` `SIDECAR_PYTHON` |
| 日志 | `LOG_LEVEL` |
| 控制面板 | `WEB_ENABLED` `WEB_HOST` `WEB_PORT` `WEB_TOKEN` `WEB_ALLOW_REMOTE` |
| 沙箱边界 | `BOUNDARY_MODE`（`sandbox` / `trusted`） |

几条口径：

- `.env` 与进程环境变量都会盖在 `config/*.json` 上（`src/config/index.js` 的 `applyEnv`），所以同一个开关改哪边都行。
- 模型密钥也认 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 这两个名字。
- `ADMIN_QQ` 会覆盖 `config/security.json` 的 `admins`，多个号用逗号或空格隔开。
- 没开 `allowRemote` 时面板只监听 `127.0.0.1`；要让外面访问，得同时开 `WEB_ALLOW_REMOTE` 并设 `WEB_TOKEN`，否则接口没有鉴权。细节见 [WEB](WEB.md)。

## data/ 运行时目录

运行产出的根目录，路径由 `config/bot.json` 的 `dataDir` 决定：

| 路径 | 是什么 |
| --- | --- |
| `memory/<QQ号>.jsonl` | 记忆，一人一个文件，一行一条 |
| `emotion.json` | 好感度与情绪 |
| `schedule.json` | 运行时的定时任务（`/定时` 加的写这里） |
| `tasks.json` | agent 任务表：状态、步骤、结果 |
| `context/<会话>.jsonl` | 近期对话，`private_<QQ号>.jsonl` / `group_<群号>.jsonl` |
| `outbox/` | 她发出去的长文本（第一次用到才建） |
| `logs/` | 应用、操作、对话三种日志（按天一个文件）＋ `sidecar.log` |
| `screenshots/` | 截屏 |
| `stickers/index.json` | 表情包索引 |
| `locales/<语言>.json` | 在面板里改过的文字（第一次用到才建） |
| `config-backup/` | 每次保存配置前的备份 |
| `web/services.json` | 面板记下的服务与 pid |
| `autonomy.jsonl` | 空闲活动的流水：做了什么、说了什么、有没有出错 |

表情包图片本体不在 `data/` 里，在项目根的 `stickers/`（`config/sticker.json` 的 `dir`），索引是 `data/stickers/index.json`（`indexFile`）。

`data/`、`work/`、`reports/` 都是运行产出，不参与编码体检，也不该进版本库。

相关：[怎么用](USAGE.md) · [它是怎么转的](ARCHITECTURE.md) · [控制面板](WEB.md) · [模块接口约定](INTERFACES.md)
