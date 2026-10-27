# 若华控制面板

一个长在若华身上的本地网页：改配置、改 `.env`、改本地化键、看日志、管服务、把消息和工具真的跑一遍；不用构建、不装新依赖，浏览器直接开。

## 启动

面板只有一个，跟着主程序一起起来：

```bash
node src/main.js          # 双击 start.bat / start-web.bat 等同于这一条
```

- 地址 `http://127.0.0.1:<端口>`，端口取 `config/web.json` 的 `port`（默认 `8787`），`.env` 的 `WEB_PORT` 能覆盖它。
- `--no-web` 不起面板，`--web-port <端口>` 换端口。
- 端口被占时往后 +1 重试（最多 20 次），并跳过 3001 / 3002 / 3003 / 8765 等保留端口。
- **占着端口的是另一个若华面板时不再开第二个**：`start()` 记一行 `web.start.panelExists` 告警，返回 `{ host, port: null, url: null, existing: { url, port, mode } }`（`info().running === false`），机器人本体照常跑，要用面板就开已经在跑的那一个；占端口的是别的东西才照旧 +1。

## `config/web.json`

```json
{
  "enabled": true, "host": "127.0.0.1", "port": 8787, "token": "",
  "allowRemote": false, "openBrowser": false,
  "napcat": {
    "dir": "D:/Desktop/NapCat/NapCat.52230.Shell", "launcher": "napcat.bat",
    "webuiUrl": "http://127.0.0.1:6099", "onebotPort": 3001
  }
}
```

- `enabled: false` → `start()` 直接抛错（`code: 'web_disabled'`），不会悄悄起一个半残的服务。
- `token` 非空时所有 `/api/*` 与 `/ws/*` 都要带 `?token=…` 或 `Authorization: Bearer …`，不对返回 401；静态页面不拦。
- `host` 不是本机地址时必须同时 `allowRemote: true`，否则拒绝启动。
- `openBrowser: true` 启动成功后用系统默认浏览器打开面板。
- `napcat.*` 是服务管理器找 NapCat 用的：装在哪、启动器叫什么、WebUI 与 OneBot 端口。

## 页签

| 页签 | 能干什么 |
| --- | --- |
| 主页面 | 运行状态与流水线；五个服务的卡片（状态、明细、动作按钮） |
| 配置 | 左列 `config/*.json`，每项只写「含义（文件名）」；右列按字段表渲染的表单（类型、枚举、密钥框、分组）或等宽 JSON 编辑，语法错误就地报行号；选中文件的大小、更新时间、备份目录在右列；字段表覆盖每个叶子字段（含 `agent.chatTools`、`agent.chatMaxSteps`），保存前备份、原子写 |
| 环境变量 | `.env` 按 7 组渲染（模型 / OneBot / 管理员 / 侧车 / 日志 / 面板 / 沙箱）；密钥字段默认密码框，点「显示」看明文 —— `/api/env` 返回的就是真值，打码只是页面的显示状态；送回 `********` 表示不改这一项；保存保留注释与键序，旧文件备份到 `data/config-backup/env-<时间戳>`；也可切到「直接编辑 .env 文本」 |
| 本地化键 | 当前语言的全部键，改一条即写进 `data/locales/zh-CN.json`，可逐条撤回；代码自带的文字永远在 |
| 表情包 | 列表、详情、改标题 / 内容描述 / 时机标签、删图、让模型认图 |
| 监视终端 | 日志两条来源（进程内订阅 + `data/logs/*-<日期>.jsonl` 增量），按级别 / 来源 / 关键字过滤，暂停只停显示 |
| 实时调试 | 模拟消息、模型直调、工具直调、侧车直调 |

## REST 接口

全部返回 JSON；出错用非 200 + `{ "ok": false, "error": "人话" }`。

| 方法 | 路径 | 关键请求 / 响应字段 |
| --- | --- | --- |
| GET | `/api/status` | `mode`、`running`、`web`、`config`、`bot`、`onebot`、`llm`、`sidecar`、`emotion`、`tasks`、`sticker`、`modules`、`services` 概览、`note`；取不到的项直接缺席，不 500 |
| GET | `/api/peers` | `self`、`peers[]`（扫 8787–8795，谁答 `/api/status` 谁算） |
| GET | `/api/services` | `mode`、`services[]`（见下节） |
| POST | `/api/services/:id` | `{ action }` → `{ ok, id, action, status, statusKey, detail, result, services, url }` |
| GET | `/api/config` | `dir`、`backupDir`、`files[{ name, file, size, updatedAt, parseError, content }]`（密钥已脱敏） |
| GET | `/api/config/:name` | 单个配置 + `raw`（解析失败时）+ `fields[]`：`{ path, labelKey, descKey, type, options, value, secret, group }` |
| PUT | `/api/config/:name` | 完整 JSON → `{ ok, backup, backupRelative, bytes, levelChanged, content }`；先校验、再备份、再原子写 |
| GET | `/api/env` | `file`、`exists`、`keys`、`groups[{ key, titleKey, fields[{ key, labelKey, descKey, type, options, secret, value, set }] }]` |
| PUT | `/api/env` | `{ values: { KEY: 值 } }` → `{ ok, changed[], backup, backupRelative, groups }`；只认字段表里的键 |
| GET | `/api/i18n` | `locale`、`keys`、`values`（生效中）、`defaults`（代码自带）、`overrides`、`missing` |
| PUT | `/api/i18n` | `{ values, reset[] }` → `{ saved: { file, count, bytes }, values, overrides }` |
| GET | `/api/tools` | `count`、`tools[{ name, description, sensitive, action, parameters }]` |
| GET | `/api/tasks` | `count`、`active`、`stats`、`tasks[]` |
| POST | `/api/tasks/stop` | `{ id }` → 停掉一个任务 |
| GET | `/api/stickers` | `?tag=&keyword=&limit=&offset=`；`items[]`、`count`（本页）、`total`（过滤后）、`stats`、`notes[]` |
| GET | `/api/stickers/:id` | `item`、`url`（可直接丢进 `<img src>`） |
| PUT | `/api/stickers/:id` | `{ title?, meaning?, tags? }`（至少给一个）→ `item`、`url` |
| DELETE | `/api/stickers/:id` | 索引记录与图片文件一起删 → `{ removed: true, total }` |
| POST | `/api/stickers/:id/describe` | 让模型认这张图 → `suggestion: { title, meaning, tags }`，不落盘 |
| GET | `/api/stickers/:id/file` | 图片本体，`Content-Type` 按扩展名，只认表情包目录里的文件 |
| POST | `/api/debug/message` | `{ scene, userId, nickname, groupId, text, images, at, dryRun }` → `message`、`result`、`outbound[]`、`replyState`、`logs[]`；`dryRun` 只拦这次会话的发送 |
| POST | `/api/debug/llm` | `{ messages \| prompt, role, json, maxTokens, model, temperature }` → `content`、`finishReason`、`usage`、`elapsedMs` |
| POST | `/api/debug/tool` | `{ name, args, scene?, groupId?, userId? }` → `result`、`elapsedMs`、`sensitive` |
| POST | `/api/debug/sidecar` | `{ method, params }`（白名单方法） |

`/ws/logs` 推日志：查询参数 `level` / `channel` / `keyword` / `token`，连上先推最近 200 条，之后约 150ms 一批；客户端可发 `{"type":"ping"}` 或 `{"type":"filter",...}` 运行时改过滤。

## 服务卡片与动作

`GET /api/services` 返回五个服务，形状统一：

```json
{ "id": "panel", "titleKey": "web.service.panel.title", "descKey": "web.service.panel.desc",
  "status": "running", "statusKey": "web.service.status.running", "note": null,
  "detail": [ { "labelKey": "web.service.panel.port", "value": 8787, "valueKey": null, "params": null } ],
  "actions": [ { "id": "check", "labelKey": "web.service.action.check", "primary": true } ] }
```

| 服务 | id | 状态怎么来的 | 动作 |
| --- | --- | --- | --- |
| 控制面板 | `panel` | 本进程（模式、地址、端口、日志订阅数、运行时长、工作目录） | `check` |
| Node.js 运行环境 | `node` | `process.version` / `execPath` / 平台 / 在不在 PATH | `check` |
| NapCat（QQ 协议端） | `napcat` | 目录与启动器在不在、有没有 napcat 进程、OneBot 端口通不通 | `check` `start` `stop` `open` |
| 若华主程序 | `ruohua` | 面板就在若华进程里，状态即本进程（启动时间、运行时长、OneBot 连接） | `check` `start` `stop` `restart` |
| Python 感知侧车 | `sidecar` | 配置里的地址 + HTTP 探活 | `check` `start` `stop` |

- `status` 取 `running` / `ok` / `stopped` / `unknown` / `warn`，`statusKey` 是对应的本地化键。
- `detail` 每项是 `{ labelKey, value, valueKey, params }`：**给了 `valueKey` 就按本地化文字渲染（`params` 是插值参数），前端不再看 `value`** —— 这样 `attached` / `standalone` 这类内部词不会露到界面上；`value` 只是兜底。
- 动作只走白名单，出错给错误码 + 状态码：`unknown_service` 404、`unknown_action` / 缺 action 400、`missing_file` / `napcat_not_found` 404、`already_running` / `attached_self` / `not_ours` 409、`unverifiable` / `napcat_stop_denied` 403、`napcat_still_listening` / `stop_failed` / `open_failed` 500、`start_failed` 502、`timeout` / `napcat_timeout` 504、`unavailable` 503。
- 超时分两档：通用动作 20 秒；NapCat 单独 180 秒（它要拉起整个 QQ，第一次登录尤其慢），超时报 `napcat_timeout`。
- 若华与侧车**只停面板自己记过 pid 的进程**（记在 `data/web/services.json`）：不是我们起的 → `not_ours`；pid 被系统回收、进程名字或启动时间对不上 → `unverifiable`。**NapCat 是例外，停它不问是谁起的**：按「占着 OneBot 端口的进程 → 记过的 pid → 进程名像 napcat 的」三路认，认到就停。
- 「启动」若华和用户双击一样跑 `start.bat`，成功判定是「冒出一个启动前没有的面板」。
- 每次动作都往操作日志（`channel: operation`，`actor: web-panel`）记一笔 `service_*`，失败也记；清单有 2.5 秒短缓存。

## 面板起的进程

`src/util/console.js` 的 `consoleStart()` 负责让服务跑在「UTF-8、看得见」的窗口里：

- Windows 上走 `cmd /c start "" /min <data/web/console-utf8.bat> <目标>`：垫片先把新控制台设成 `65001` 再跑目标，中文不再是乱码；窗口是最小化的，`cmd /K` 起的，服务退出后还在，留着最后一段输出。
- 有 `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` 时优先交给 Windows Terminal，没有才退回 conhost。
- **工作目录由 `RUOHUA_CWD` 环境变量带给垫片**（垫片里 `cd /d`）：Windows Terminal 不继承工作目录，而 `napcat.bat` 是用相对路径调兄弟文件的，目录不对就报 `'.\NapCatWinBootMain.exe' is not recognized`。
- 子进程环境带 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`；面板解析命令输出时按字节判 UTF-8 还是 GBK。

## 安全边界

- 默认只监听 `127.0.0.1`；要对外开必须显式 `allowRemote: true`（建议同时配 `token`）。
- `token` 定长比较，日志与错误里都不回显；配了令牌时 `/api/stickers/:id` 的 `url` 会带 `?token=…`，`<img src>` 才拿得到图。
- 静态文件自己做：禁路径穿越（含 `%2f`、`\`、隐藏文件）、限扩展名、正确 `Content-Type`。
- 配置读取一律脱敏；`.env` 通过字段表读写（只动表里的键），启动时不读 `.env` 也不把它列进配置页。
- 表情包取图只认库目录里的文件，越界 403，不认识的扩展名 403，id 只允许 `[\w-]+`。
- 服务动作只碰白名单，只杀自己记过的 pid，不认识的进程一律不动。
- 调试接口能调敏感工具（比如 `shell`）且不做额外两步验证 —— 面板本身靠「只监听本机 + 令牌」这条线把关。

## 自查

`cmd //c "npm test"`（全量）、`node --test "tests/web/*.test.js"`（面板接口与服务管理器）、`node tools/dev/check-i18n.mjs --quiet`（本地化体检）、`node tools/dev/check-encoding.mjs`（UTF-8 无 BOM + LF）。
