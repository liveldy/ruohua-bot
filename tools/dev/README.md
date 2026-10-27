# tools/dev —— 开发与测试用的小工具

不连真 QQ、不调真模型就能把整套机器人跑起来。

| 脚本 | 用途 | 怎么跑 |
| --- | --- | --- |
| `mock-onebot.js` | 假协议端：OneBot 11 正向 WebSocket 服务端 + HTTP 控制接口 | `node tools/dev/mock-onebot.js --port 3901 --http-port 3902` |
| `mock-llm.js` | 假模型：OpenAI 兼容接口（`/v1/chat/completions`） | `node tools/dev/mock-llm.js --port 3903` |
| `check-i18n.mjs` | 本地化体检：写死的中文、缺失的键 | `node tools/dev/check-i18n.mjs [--quiet]` |
| `check-encoding.mjs` | 编码体检：UTF-8 无 BOM、行尾、批处理纯 ASCII | `node tools/dev/check-encoding.mjs [--json] [--fix]` |

两个 mock 都是独立进程，`SIGINT` / `SIGTERM` 会优雅退出；测试里 `kill()` 之后要等它真的退出。

## 假协议端 `mock-onebot.js`

| 参数 | 说明 |
| --- | --- |
| `--port` | WebSocket 端口（默认 3001，与 `config/bot.json` 的 `bot.onebot.wsUrl` 对齐） |
| `--http-port` | HTTP 控制端口（默认 `--port` + 1） |
| `--token` | 要求握手带 `Authorization: Bearer <token>`，不匹配回 401；不传则不校验 |
| `--self-id` | 机器人 QQ 号（默认 10000），也是 `@` 判定用的 id |
| `--host` / `--heartbeat` | 监听地址（默认 `127.0.0.1`）/ 心跳间隔毫秒（默认 0 = 不推） |
| `--quiet` | 不打任何日志 |

WebSocket 侧收到 `{ action, params, echo }` 就回 `{ status, retcode, data, echo }`；已实现
`get_login_info` `get_version_info` `get_status` `send_private_msg` `send_group_msg` `send_msg`
`delete_msg` `get_msg` `get_friend_list` `get_group_list` `get_group_member_info`
`upload_private_file` `upload_group_file` `friend_poke` `group_poke`，未知动作 `retcode: 1404`。

控制接口：

| 接口 | 说明 |
| --- | --- |
| `POST /inject` | 伪造一条消息事件推给所有连接 → `{ ok, messageId, delivered }` |
| `GET /sent?scene=&userId=&groupId=&limit=` | 读机器人发出去的消息（消息段 + 纯文本） |
| `DELETE /sent` | 清空全部，带参数时只清匹配的 |
| `POST /notice` | 推一条 notice 事件（`notice_type` 缺省为 `unknown`，其余字段原样透传） |
| `GET /health` | 连接数、各动作调用次数、`sentCount` / `receivedCount` |

`/inject` 的消息段顺序是 `[at] → [text] → [images] → [faces] → [segments]`；`scene` 默认 `private`，
`at: true` 会在最前面插入 `at(self_id)`，`images` 里 http(s) 的写进 `url`、其余 `url=null`。

## 假模型 `mock-llm.js`

```bash
node tools/dev/mock-llm.js --port 3903 [--script <file.json>] [--model mock-chat] [--chunk-size 8] [--quiet]
```

脚本也可以用环境变量 `RUOHUA_MOCK_LLM_SCRIPT=<file.json>` 给；文件读不出来时进程打印原因并以非 0 退出。

| 接口 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | 支持 `stream`、`tools`、`response_format.json_object` |
| `GET /v1/models` | 假模型列表：`--model`（默认 `mock-chat`）与 `mock-vision` |
| `GET /usage` | 计数、`byRole`、`lastRequest` / `lastResponse`（`source` 说明走了哪条分支） |
| `DELETE /usage` | 清空计数 |
| `POST /script` / `DELETE /script` | 运行时装载 / 卸载脚本 |
| `GET /health` / `GET /` | 状态 / 纯文本说明页 |

脚本形状（`rules` 按顺序匹配、`sequence` 按调用顺序消费、`default` 兜底）：

```jsonc
{
  "rules": [ { "match": "决策", "matchOn": "user", "content": "{\"mode\":\"chat\"}" } ],
  "sequence": [ { "content": "第一句" }, { "content": "收尾了", "finish_reason": "stop" } ],
  "default": { "content": "兜底答复" }
}
```

- 解析顺序：`rules`（第一条命中的）→ `sequence`（下一个未消费的）→ `default` → 内置默认应答；
  写 `"preferSequence": true` 改成先 `sequence` 再 `rules`；`POST /script` 会把 `sequence` 指针归零。
- 条目字段：`content`（正文）、`json`（对象则序列化，字符串则原样返回，可故意给坏 JSON）、
  `tool_calls`、`finish_reason`。
- `match` 不写 `matchType` 时，形如 `/正则/flags` 就当正则，否则当子串；`match` 为空命中任何请求。
- 不带脚本时看**最后一条 user 消息**回一段中文短回复，且**永远是纯文本**（即使请求要求 JSON），
  用来验证调用方的 JSON 解析容错。

## 在测试里怎么用

`tests/dev/harness.js` 已经把空闲端口、起进程、等就绪、`/inject`、`/sent`、kill 并等待退出实现好了：

```js
import { startMockOneBot, startMockLlm, httpJson, parseSse } from './harness.js';
```

- 端口别写死：用 `getFreePorts` 要空闲端口；两个 mock 端口被占用会直接报错退出。
- Node ≥ 22 的测试运行器不接受目录参数，用 `node --test "tests/dev/*.test.js"`（`tests/dev/index.js`
  重新导出，让 `node --test tests/dev` 也仍然可用）。
- 测试里不要有任何对外网络请求。

## 体检的结论口径

- **本地化体检** `check-i18n.mjs`：通过时打印 `✓ 本地化体检通过：没有写死的文字，用到的键都有文字。`
  且退出码 0；不通过 = `src` / `web` / `python` 里有写死的中文，或用了本地化键表里没有的键（退出码 1）。
  不加 `--quiet` 还会列出没被引用的键，那不算错。
- **编码体检** `check-encoding.mjs`：通过时打印 `编码体检通过：N 个文件全部合法 UTF-8 / 行尾统一`；
  不通过 = 带 BOM、非法 UTF-8、非 LF 行尾，或 `.bat` / `.cmd` 不是纯 ASCII + CRLF。`data/` `work/`
  `reports/` 是运行产出，不体检；`--fix` 只修行尾与 BOM，不碰内容。
