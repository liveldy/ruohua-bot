# 接上 NapCat（QQ 协议端）

若华不直接连腾讯服务器，它通过 [NapCat](https://napneko.github.io/) 以 **OneBot 11** 收发 QQ 消息。本机装在 `D:\Desktop\NapCat\NapCat.52230.Shell`，启动器 `napcat.bat`。

## 方式一：正向 WebSocket（默认，推荐）

若华主动去连，NapCat 里配一个 WebSocket **服务端**。

1. 启动 `D:\Desktop\NapCat\NapCat.52230.Shell\napcat.quick.bat`，登录你的 QQ。
2. NapCat WebUI（默认 <http://127.0.0.1:6099>）→ 网络配置 → 新建 → WebSocket 服务器：主机 `127.0.0.1`、端口 `3001`、消息格式 `array`、心跳 `30000`、Token 自己定一串。
3. 把 Token 写进 `.env`：`ONEBOT_MODE=forward`、`ONEBOT_WS_URL=ws://127.0.0.1:3001`、`ONEBOT_ACCESS_TOKEN=你的token`。
   想各走各的就另开一个端口（比如 3011），改 `ONEBOT_WS_URL` 里的端口。

## 方式二：反向 WebSocket

若华起服务端，NapCat 主动连过来。

1. `.env`：`ONEBOT_MODE=reverse`、`ONEBOT_REVERSE_PORT=3002`、`ONEBOT_ACCESS_TOKEN=你的token`。
2. 先启动若华（`start.bat`），再到 NapCat WebUI 新增「WebSocket **客户端**」：URL `ws://127.0.0.1:3002/onebot`，Token 同上，消息格式 `array`。

## 方式三：HTTP

`.env` 里 `ONEBOT_MODE=http`，NapCat 里配 HTTP 服务端指向 `ONEBOT_HTTP_URL`（默认 `http://127.0.0.1:3000`）。实现最简，但事件是拉取的，实时性差，不推荐。

## 接上了怎么确认

1. `node src/main.js`（或双击 `start.bat`），日志里出现 `已连上 OneBot 服务端 ws://127.0.0.1:3001` 与 `登录账号 3xxxxxxxx（昵称）`。
2. 用另一个 QQ 号私聊它，或把它拉进群后 @ 它。
3. `data/logs/conversation-*.jsonl` 里能看到你的消息与它的回复。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 日志一直「准备重连」 | Token 不对、NapCat 里那条 WebSocket 服务器没启用，或端口写错 |
| 收到消息但不回 | 群聊默认要 @ 它；或群号不在 `groupWhitelist`（空=全部允许）；或你在 `blacklist` 里 |
| 回复了但发不出去 | NapCat 掉线，`data/logs/app-*.jsonl` 里有 API 报错 |
| 想换 QQ 号 | 重新登录 NapCat 即可，若华这边不用改（`self_id` 自动取） |

用常用 QQ 号挂协议端有被风控的风险，建议**用小号**，也不要在它上面聊敏感内容。
