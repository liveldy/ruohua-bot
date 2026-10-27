# 开发与测试（DEVELOPMENT）

不联网、不连 QQ 就能把整套跑起来：单测都是本地的，端到端用假协议端与假模型接口。

## 跑测试

```bash
npm test                              # 全部单测与端到端
node --test "tests/unit/*.test.js"    # 只跑地基（配置、文本、消息段、模型客户端、本地化、编码）
node --test "tests/e2e/*.test.js"     # 端到端
npm run e2e                           # 同上
```

Node 24 的测试运行器不再把目录当成「一堆测试文件」来扫（`node --test tests/unit` 会当成模块去加载，报
`Cannot find module`），所以脚本里一律用通配写法 `node --test "tests/**/*.test.js"`。
`tests/autonomy`、`tests/dev`、`tests/onebot`、`tests/perception`、`tests/system` 有 `index.js` 重新导出用例，目录形式对它们仍然可用。

## 端到端在测什么

`tests/e2e/bot.test.js` 真起一个 `src/main.js` 子进程，协议端用 `tools/dev/mock-onebot.js`（假 NapCat 的 WebSocket 服务端），
模型接口用 `tests/e2e/fake-llm.js`（进程内的假模型，按请求特征路由），在临时目录里跑一份自己的配置，验证：

- 闲聊被切成多条短消息发出，Markdown 与 emoji 被处理掉
- 好感度变化与记忆落库
- agent 任务真的调工具、跑完回报，任务落盘为 `done`
- 敏感操作被两步验证拦住：普通用户直接婉拒且什么都没执行，管理员对暗号通过后才真执行
- `/状态` 报运行情况，`/定时` 写进 `schedule.json`

假协议端与假模型各自的参数、控制接口、脚本写法见 [tools/dev/README](../tools/dev/README.md)。

## 体检

```bash
node tools/dev/check-i18n.mjs          # 写死的中文、用了却没定义的键、面板页面没走 data-i18n
node tools/dev/check-encoding.mjs      # UTF-8 无 BOM、行尾、批处理纯 ASCII + CRLF
```

两条都有对应的守卫用例（`tests/unit/i18n.test.js`、`tests/unit/encoding.test.js`），`npm test` 里会一起跑。

## 编码约定

全项目统一 **UTF-8（无 BOM）+ LF**；只有一个例外：`*.bat` / `*.cmd` 必须是**纯 ASCII + CRLF**。

原因很实在：cmd.exe 按控制台代码页（简体中文是 GBK）读批处理，UTF-8 的中文会被拆成半截字符，cmd 算错行偏移后
从行中间开始执行，于是冒出 `'dp0"' 不是内部或外部命令` 这种莫名的错，中文回显也全是乱码。所以批处理里只写英文，
中文提示交给 Node 打印，批处理开头 `chcp 65001` 保证回显正常。

```bash
node tools/dev/check-encoding.mjs         # 体检：列出文件、规则、原因
node tools/dev/check-encoding.mjs --fix   # 修 BOM 与行尾（只动换行，不碰内容）
node tools/dev/check-encoding.mjs data    # 也可以只扫某个目录
```

`data/`、`work/`、`reports/` 是运行产出（含子进程回显，天然是 CRLF），不体检。
面板与工具起的子进程按同一套规矩办（`src/util/console.js`）：环境里带 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，
Windows 上启动服务走一个已设成 65001 的新控制台，垫片是运行期生成的 `data/web/console-utf8.bat`（纯 ASCII + CRLF）。

## 本地化约定

程序文件里**不出现任何面向用户的文字**，一律写成 `t('命名空间.键')`；管理员在面板的「本地化键」页改，
改完落到 `data/locales/zh-CN.json`，覆盖优先于代码自带的默认文字。

```js
import { t } from '../i18n/index.js';
t('agent.runner.progress', { done: 3, total: 24 });
```

键必须写在 `src/i18n/locales/zh-CN/<命名空间>.json` 里，扁平键、一个命名空间一个文件。
规矩全文与命名空间清单见 [I18N](I18N.md)。

## 离线手跑一套假服务

不接真 QQ、不花钱，手动灌一条消息看整条链路：

```bash
node tools/dev/mock-onebot.js --port 3901 --http-port 3902 &   # 假 NapCat
node tools/dev/mock-llm.js --port 3903 &                       # 假模型
# .env 里指过去（ADMIN_QQ 照旧要填）：
#   ONEBOT_WS_URL=ws://127.0.0.1:3901
#   MODEL_BASE_URL=http://127.0.0.1:3903/v1   MODEL_NAME=mock-chat
node src/main.js
```

```bash
# 灌一条私聊消息进去
curl -X POST http://127.0.0.1:3902/inject -H "Content-Type: application/json" \
     -d '{"scene":"private","userId":10001,"text":"在吗"}'
curl http://127.0.0.1:3902/sent      # 看她回了什么
curl http://127.0.0.1:3902/health    # 连接数与各动作调用次数
```

两个 mock 都是独立进程，`SIGINT` / `SIGTERM` 会优雅退出。端口别写死，用空闲端口；被占用时它们直接报错退出。

相关：[它是怎么转的](ARCHITECTURE.md) · [模块接口约定](INTERFACES.md) · [本地化](I18N.md) · [开发工具](../tools/dev/README.md)
