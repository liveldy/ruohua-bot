# 若华 · 模块接口约定

模块之间的契约：签名与返回结构不轻易改，要加能力就在模块内加字段。改动理由与历史见 git 与各模块注释，这里只写当前有效的形状。

通用约定：

- 全 ESM，Node.js ≥ 20；唯一运行时依赖 `ws`（只在 OneBot 连接层）。
- 面向用户的文字一律走本地化键 `t('命名空间.键')`，不写进程序文件（见 [docs/I18N.md](I18N.md)）；`src/**`、`web/**`、`python/**` 里不出现中文。
- 时间统一毫秒时间戳；IO 全异步；持久化写在 `data/` 下，写文件用原子替换（临时文件 + rename）。
- 日志用注入的 `logger`，模块里不直接 `console.log`；单测在 `tests/**/*.test.js`（`node:test` + `node:assert/strict`），不联网、不连真 QQ。

## 1. 配置 `src/config/index.js`

- `loadConfig({ rootDir, env, overrides, useEnvFile })` → `Config`；`reloadConfig({ env, overrides })` → `Config`；`currentConfig()` → `Config | null`；`loadEnvFile(filePath)` → `Record<string,string>`；`ConfigError`（`name === 'ConfigError'`，带 `problems: string[]`）。
- `Config` = `config/*.json` 的字段（`bot model persona emotion memory security autonomy agent sticker web tasks`）+ 派生绝对路径（`rootDir dataDir logDir memoryDir stickerDir stickerIndexFile boundaryRoot`）+ `env` / `offline` / `sidecar`。
- 缺的配置文件用内置默认补齐、不抛错；`model.baseUrl` / `model.model` 为空、`security.admins` 为空、`onebot.mode` 非法、启用口令但口令池为空 → `ConfigError`。
- env 覆盖：`MODEL_BASE_URL|MODEL_API_KEY|MODEL_NAME|MODEL_VISION_NAME`、`ONEBOT_*`、`ADMIN_QQ`（逗号分隔）、`LOG_LEVEL`、`WEB_*`、`BOUNDARY_MODE`、`SIDECAR_*`；`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 可当 `MODEL_API_KEY`。

## 2. 本地化 `src/i18n/index.js`

- `t(key, params)` / `has(key)` / `keys()` / `table()` / `i18n()` / `configureI18n({ locale, localeDir, overrideFile })` / `localeOverridePath(rootDir)` / `createI18n({...})` / `loadBuiltinTables(locale, dir)` / `DEFAULT_LOCALE`。
- 默认文字 `src/i18n/locales/zh-CN/<命名空间>.json`（扁平键、值为字符串、键以命名空间开头）；`data/locales/zh-CN.json` 是管理员覆盖，优先于默认。`t` 同步，找不到键返回键本身并记账。
- 占位符 `{名字}`，参数传对象，键必须是字面量；`python/i18n.py` 是行为一致的读取器；守卫 `node tools/dev/check-i18n.mjs`。

## 3. 日志与工具 `src/logging/logger.js`、`src/util/`

- `createLogger({ level, dir, name })` → `Logger`：`debug|info|warn|error(msg, meta?)`、`child(name)`、`flush()`、`file()`、`operation({actor, action, target, ok, detail})`、`conversation({scope, userId, groupId, direction, text, meta})`；另有 `childLogger(logger, name)`、`createNullLogger()`。
- `io.js`：`readJson` `writeJsonAtomic` `writeTextAtomic` `readJsonl` `appendJsonl` `rewriteJsonl` `ensureDir` `fileExists` `removeFile` `listFiles`。
- `text.js`：`stripMarkdown` `normalizePunctuation` `truncate` `charLength` `splitSentences` `estimateTokens` `chunkByLength` `decodeProcessOutput`。
- `time.js`：`formatTime` `formatDuration` `parseDuration` `parseTimeSpec` `nextRunAt` `inQuietHours`；`common.js`：`sleep` `sleepRandom` `shortId` `pickWeighted` `randomInt` `seededRandom` `clamp` `round` `EventBus`；`console.js`：`utf8Env` `consoleStart` `ensureConsoleLauncher`（面板拉起进程用，见 [docs/WEB.md](WEB.md)）。

## 4. OneBot `src/onebot/`

- `createOneBotClient({ config, logger, events })` → `OneBotClient`（EventEmitter）：`start()` / `stop()` / `isConnected()` / `api(action, params, { timeoutMs })` → `data`（失败抛 `OneBotError`）、`sendTo({scene, userId, groupId}, content)` → `{ message_id }`、`sendPrivate / sendGroup / poke / deleteMessage / uploadFile({scene, userId, groupId, file, name}) / getLoginInfo / getVersionInfo / getStatus / getFriendList / getGroupList`。
- `messageCache()` → `{ capacity, size, entries: [{ messageId, text, userId, nickname, time }] }`；`status()` → `{ connected, status, mode, connectedAt, attempts, messagesIn, messagesOut, loginInfo, lastError }`；事件 `'message' | 'notice' | 'request' | 'meta' | 'connected' | 'disconnected' | 'error'`。
- `Message`（`segments.normalizeMessage`）= `{ messageId, time /* ms */, selfId, scene: 'private'|'group', subType, userId, groupId /* 私聊 null */, sender: { userId, nickname, card, role }, segments, text, display, images, faces, files, records, isAt, quoted, raw }`。
- `display` 是给对话日志与记忆沉淀看的正文；`quoted` = `{ messageId, userId, nickname, text, time, resolved }`，来源依次是 reply 段自带字段 → 客户端最近消息缓存 → `get_msg` 补查（失败只把 `resolved` 置 false，不抛错）。**`quoted` 只进提示词，不进 `display`。**
- 其余导出：`textSegment/atSegment/faceSegment/imageSegment/replySegment/fileSegment`、`extractText|Images|Faces|Files|Records|Reply`、`hasAt`、`segmentsToPlain`、`toMessageContent`、`quotesSelf`、`describeQuoted`、`conversationKey(Of)`、`toTimestampMs`。
- 断线按 `bot.onebot.reconnect` 指数退避重连，同一时刻只有一个重连定时器；重复 warn 与重连播报各自按窗口节流（`logDedupWindowMs` / `reconnectLogWindowMs`）。

## 5. 模型 `src/llm/client.js`

- `createLLMClient({ config, logger })` → `LLMClient`：`chat({ messages, tools, role, model, temperature, maxTokens, stream, json, onDelta, timeoutMs, signal })` → `{ content, toolCalls: [{ id, name, arguments, raw, index, finishReason, argumentsError }], json, usage: { promptTokens, completionTokens, totalTokens }, model, finishReason, raw }`；`role` ∈ `'chat'|'decision'|'judge'|'memory'|'agent'`，对应 `config.model.roles` 里的采样参数。
- `vision({ prompt, images, model })` → `string`；`usageTotals()` / `resetUsage()` / `balance()`；只读属性 `modelName`、`visionModelName`（可能 null）、`visionTargetName`（真去看图时用的那个）。
- 失败自动重试 2 次，仍失败抛 `LLMError`（`code`：`timeout|network_error|upstream_error|upstream_unavailable|offline|vision_unsupported`）。**`argumentsError === 'json_parse_failed'` 表示这轮参数被截断（多半 `finish_reason: 'length'`）：调用方必须当作失败，不要执行这道 call。**
- `visionModel` 留空就用主模型看图；主模型与 `visionModel` 都为空才抛 `vision_unsupported`。

## 6. 人格与情感 `src/persona/`、`src/emotion/`

- `buildSystemPrompt({ persona, emotion, memory, user, scene, mode, extra, tools = false, now })` → `string`：`tools: true` 才加【手上的工具】那一节，`now`（毫秒）写进「【现在的时间】」。
- `restyle(text, { persona })` / `splitMessages(text, { persona, emotion })` / `shouldSendAsFile(text, { persona })` / `toFileContent(text)` / `resolveEmoji(text, persona)` / `pickExpression({ persona, emotion, rng, context, config, stickerDir })` / `expressionPreference(persona, emotion)`。
- `createEmotionEngine({ config, logger, stateFile, rng })`：`get(userId)` → `{ userId, affection, mood, moodSince, moodUntil, interactions, lastSeenAt, label }`、`apply(userId, { event, delta, note, at })`、`setMood(userId, mood, minutes)`、`tick(now)`、`hints(userId)`、`save()`、`snapshot()`、`reset(userId)`。
- `judgeEmotion({ llm, persona, message, reply, history, config, deltaTable })` → `{ mood, delta, event, reason, importance }`（`importance` ∈ [0,1]，表示这段对话值不值得记）；`emotion` 形参统一为 `{ mood, affection, hints: { segmentGapMs, maxSegments, tone, stickerChance } }` 或 `null`。

## 7. 记忆 `src/memory/`

- `createMemoryService({ config, llm, sidecar, logger, dir })`：`ingest({ userId, scene, messages, hint })` → 新条目数组、`recall({ userId, scene, query, topK })` → `[{ id, kind, content, importance, score, createdAt }]`、`remember({ userId, scene, content, kind, importance, tags })`、`forget({ id | query })`、`list(userId, { kind })`、`consolidate(now)` → `{ dropped, promoted, merged }`、`stats()`、`personaFacts(userId)` → `string[]`，另有 `store` / `dir` / `ready()`。
- 永久 / 临时同一把尺子（`ingest` 与 `consolidate` 共用）：`importance ≥ memory.permanent.minImportance`（0.75），或命中 `permanent.keywords` 且 `importance ≥ keywordMinImportance`（0.5）；`item.forceKind` 是硬指令。
- 存储 `data/memory/<userId>.jsonl`，字段 `{ id, userId, scene, kind, content, importance, tags, createdAt, updatedAt, accessCount, lastAccessAt, source, vector? }`。

## 8. 干活 `src/agent/`

- 工具执行 `src/agent/execute.js`（agent 循环与聊天工具环共用同一份）：`createToolExecutor({ config, tools, logger, services })` → `{ execute, executeCalls, list, schemas, has, names }`；`execute(call, ctx)` → `{ id, name, args, result?, text, observation, error?, blocked?, status?, replyText? }`。
- **敏感工具的两步验证与单步超时（`agent.stepTimeoutMs`，默认 120000）都在这里；** 参数被截断不执行、未知工具如实回；`executeCalls` 按 `agent.allowParallelTools` 决定并行或串行。
- 任务表 `src/agent/tasks.js`：`createTaskRegistry({ logger, dir, maxSteps })` → `{ create, get, list({userId, activeOnly}), active, update, addStep, finish(id, { result, error, status, waitReason }), cancel, signalOf, save, load, ready, stats }`；`countRounds(steps)` → 轮次口径（同一个 index 只算一步）。
- `Task` = `{ id, goal, scene, userId, groupId, status: 'running'|'waiting'|'done'|'failed'|'cancelled', steps: [{ index, thought, tool, args, result, error, at }], rounds, result, error, waitReason, createdAt, updatedAt, progress, note }`；`waitReason` 取 `'authorization' | 'answer' | null`，只有 `waiting` 时有值；`rounds` / `progress` / `/任务` / `runner.describe` 共用一个口径。
- agent 循环 `src/agent/runner.js`：`createAgentRunner({ config, llm, tools, logger, tasks, services })` → `{ run, followUp, cancel, status, describe, stats, runningIds }`；`run({ goal, userId, scene, groupId, onProgress, maxSteps, message, onTask })` → `Task`。
- 循环「思考 → 选工具 → 执行 → 观察」，工具异常只作为观察回灌、不终止任务；`maxSteps` 缺省 `agent.maxSteps`（24），work 模式由 dispatcher 传 `agent.workMaxSteps`（8）；并发受 `agent.maxConcurrent`（3）限制。
- **步数用尽**：先做一次不带 tools 的收尾请求，把已有观察汇总成 `task.result`；拿到内容按 `done` 收尾，汇总也失败才 `failed`。`ask_user` → `waiting`（`'answer'`），被口令拦住 → `waiting`（`'authorization'`）。
- 工具表 `src/agent/tools/index.js`：`createTools({ config, services, fetch })` → `Map<string, Tool>`、`toOpenAiTools(tools)`；`Tool` = `{ name, description, parameters /* JSON Schema */, sensitive, action, async run(args, ctx) }`，`ctx` = `{ userId, scene, groupId, taskId, task, message, services, logger, signal }`。
- `TOOL_NAMES`：`shell read_file write_file list_dir search_files screen_capture see_image web_fetch web_search memory_write memory_search schedule_task list_tasks system_status send_file send_expression ask_user finish`；工具抛错用 `ToolError`（`name === 'ToolError'`，带 `code`）。
- `config/security.json` 的 `sensitive.actions` = `shell file_write file_delete process system_setting send_file self_modify`：**读文件与联网不在其中，不要口令**；`sensitive: true` 的工具执行前必须过 `SecurityGuard.verify`。
- 聊天工具环 `src/brain/chat.js`：`createChatToolLoop({ config, llm, tools, logger, services })` → `{ run, enabled, maxSteps, toolNames() }`；`run({ messages, ctx, signal })` → `{ content, steps, blocked? }`，`blocked` = `{ tool, replyText, stage }`。
- 聊天里不建任务台账、不汇报进度，也**不给 `finish` / `ask_user`**；开关 `agent.chatTools`（默认 true）、上限 `agent.chatMaxSteps`（默认 3），用满步数后再问一次（不给工具）让它拿已有的东西把话说圆。

## 9. 安全 `src/security/`

- `createSecurityGuard({ config, llm, logger, notify, rng })` → `{ isAdmin, isSensitive, verify, noteMessage, sessionState, reset, adminIds }`；`verify({ userId, scene, groupId, action, message, request })` → `{ ok, stage: 'denied'|'challenge'|'expired'|'passed', reason, challenge?, replyText }`。
- `request` 有值 = 新请求；`request == null` 且会话里挂着质询 = 用户在回答上一句问话。`sessionState(userId).stage` 取 `'challenge'|'passed'|'idle'|'expired'`，dispatcher 靠它判断「这句是不是对暗号的回答」；**问话里不出现口令的字符、字数或数字线索。**
- `config.security.passphrase` 管频率 `minIntervalMinutes` 与有效期 `maxAgeMinutes`；`config.security.sensitive.requireVerification` 为 false 可整体关掉验证。
- `noteMessage({ userId, scene, groupId, text, message })` → `{ suspicion: 0..1, alerted, reasons }`；`findDeniedPattern(command, patterns)`（模块级）：条目含 `\ * + ? ( | [ ^ $` 之一按正则解释，其余按原样子串且不 trim。
- `createBoundary({ config, logger })` → `{ mode, root, trusted, checkPath, checkCommand, checkSize, describe }`，`checkPath` 越界抛 `BoundaryError`；边界有两种挂法 `services.security.boundary` 与 `services.boundary`（`main.js` 用后者）。`config/security.json` 的 `boundary.allowPaths` 含 `D:/Desktop`。

## 10. 自主性 `src/autonomy/`

- `createScheduler({ config, logger, dir, deliver, services })` → `{ start, stop, tick, save, list, get, create, remove, enable, runNow, stats, file, running }`；条目 `{ id, name, type: 'once'|'interval'|'daily', at, every, time, target, prompt, enabled, lastRunAt, nextRunAt, runCount }`，落盘 `data/schedule.json`，按 `autonomy.scheduler.tickSeconds` 轮询。
- `createAutonomy({ config, llm, logger, persona, emotion, memory, scheduler, services, deliver })` → `{ start, stop, tick(now), noteActivity({scene, userId, groupId}), snapshot(), running, scheduler }`。
- `deliver({ target, prompt, task })` 由外层注入：到点把 `prompt` 当用户消息送进大脑，结果发到 `target`（`{ scene, userId, groupId }`）。

## 11. 感知 `src/perception/`

- `createSidecarClient({ config, logger })` → `{ health, probe, embed(texts), similar(a, b), screenshot({path, monitor}), asr(file), score(items, now), consolidate(payload), ensureStarted, stop, available, lastHealth, lastError, pid, enabled, url }`。
- `createVisionService({ llm, sidecar, logger, config })` → `{ describeImages({images, prompt, userId}), seeScreen({prompt}), transcribe({file}), visionEnabled }`；`createScreenService({ config, sidecar, logger })` → `{ capture({path}), lastPath, screenshotDir }`。
- 图片来源 `image-source.js`：`createImageSourceResolver({ roots, extra, logger, home })` → `{ resolve(source), resolveAll(sources), roots(), stats() }`、`protocolImageRoots({ home, extra })`。协议端（NapCat）给的 `file` 只有裸文件名，真身在它的缓存目录（`<文档>/Tencent Files/<QQ号>/nt_qq/nt_data`，如 `Emoji/emoji-recv/<年月>/Ori/<hash>.jpg`）——**名字大小写不一致，比较时统一小写**；远端地址 / base64 / 带目录的路径原样放行。表情包与上下文都用它，它探到的目录同时并进表情包库的允许目录。
- 侧车不可用时全部返回 `null` / 降级，只打一次 warn，不抛错；`available` 是三态 `null`（没探过）/ `true` / `false`。识图失败分两类各提醒一次：图读不到（`perception.vision.checkImageRead`）与模型看不到图（`perception.vision.checkVisionModel`）。
- `noVisionText()` 与常量 `NO_VISION_TEXT` 同义，判断请用函数（常量是模块加载那一刻的值）。

## 12. 系统 `src/system/`

- `createSelfCheck({ config, logger, services })` → `{ run({ offline, phase }) }`；报告 = `{ ok, phase, startedAt, durationMs, items: [{ name, ok, level, detail, hint }], summary }`。
- `createStatusReporter({ config, logger, services })` → `{ report() → string }`；汇报里每一句都要有真实取到的值撑着，取不到就写「查不到」，不许推测。

## 13. 大脑 `src/brain/`

- 上下文 `context.js`：`createContextBuilder({ config, persona, emotion, memory, logger, dir, vision })` → `{ build, addTurn, recent, clear, keyOf, history, stats }`；`build({ message, user, scene, mode, extraNote, includeHistory, sticker, vision, tools })` → `{ system, messages, meta: { key, userText, affection, mood, hints, quoted, memoryIds, recalled, tokens } }`。
- `meta.userText` 是渲染过的用户正文（表情包含义、图片描述都在里面）：**写回对话历史必须复用它，别再识一次图**。`build({ tools: true })` 才会在系统提示里加【手上的工具】那一节。
- `renderUserText(message, { sticker, vision, config, logger })` → 渲染过的正文：库里的表情包写「[表情包：含义]」，认不出的图交给 `vision` 写成「[图片：描述]」（一条消息最多 2 张），`message.display` 本身不变。另导出 `taskFactsNote({ tasks, userId })` → `string | null`（这个人当前在跑 / 在等的任务，没有就明说没有）、`conversationKeyOf({ scene, userId, groupId })`。
- 决策 `decision.js`：`decide({ llm, config, message, user, scene, tools, logger, extraNote })` → `{ mode: 'chat'|'work'|'agent'|'command', reply, goal, command: { name, args }, tool, sensitive, style, reason, confidence }`；`matchCommand(text)` → `{ name, args, raw } | null`、`aliasForms(...aliases)` → `string[]`。
- 命令别名：带 `/` 的按第一个词匹配、后面可跟参数；去掉 `/` 的裸词**只有整条消息正好等于它才算命中**，绝不做包含匹配。
- 回复 `reply.js`：`createReplyPipeline({ config, persona, emotion, logger, rng, sticker })` → `{ send, progress, result, toFileUri, state }`；`send({ chat, text, mode, message, hints, skipExpression })` → `{ sentMessages, texts, filePath, expressions, extras }`；`result({ chat, text, mode })` 与 `progress({ chat, text })` 走技术通道（只去 Markdown，保留换行 / 冒号 / URL / 缩进）。
- `chat` 当 OneBot 客户端用（它有 `sendTo` 与 `uploadFile`）；`extras`（`{ kind: 'sticker'|'face'|'image', label? }`）只记真发出去的，调用方要用 `content + sentExtrasNote(sent.extras)` 写回上下文，否则她事后会否认自己发过图。表情包挑到就单独发一条纯图，`sticker.pick(...)` 内部已掷过 `sendChance`，调用方不再乘。
- 分发 `dispatcher.js`：`createDispatcher({ config, logger, onebot, services, rng })` → `{ handleMessage, handleNotice, handleCommand, processMessage, runPrompt, speak, shouldHandle, stats, waitForIdle }`；链路是表情包 → 门槛 → 记录 → 可疑行为 → 情感 / 记忆 → 上下文 → 决策 → 执行 → 回复 → 复盘。
- 群聊门槛：`behavior.groupRequireAt !== false` 时要求 @ 或消息里带机器人名字；**引用机器人自己发的消息也算在跟它说话**（`behavior.replyToBotCountsAsAt`，默认 true）。私聊不受影响。
- `chatReply` / `runPrompt` 通过 `main.js` 装配的 `services.chat` 带工具聊天（`context.build` 传 `tools: true`）；任务收尾（`done` / `failed`）写一句 ≤ 500 字摘要回上下文。
- `services` 是 `main.js` 组装的聚合对象：`{ config, logger, llm, onebot, security, boundary, emotion, memory, tasks, screen, vision, imageSource, sticker, tools, agent, chat, context, reply, status, dispatcher, scheduler, autonomy, selfcheck, notify, persona, startedAt }`。

## 14. 控制面板 `src/web/`

- `createWebServer({ config, logger, services, options })` → `{ start, stop, info }`；`start()` → `{ host, port, url }`，**端口上已经是另一个若华面板时返回 `{ port: null, url: null, existing }` 且不开监听**。
- 面板只有一个：跟着 `src/main.js` 起（`--no-web` 关掉），端口取 `config/web.json` 的 `port`（默认 8787），被别的东西占着才顺延；没有 `services` 的 standalone 形态只留给测试。
- `src/web/services.js`：`createServiceManager({...})` 管 `panel / node / napcat / ruohua / sidecar` 五个服务；另有 `PANEL_PORT_FROM = 8787`、`PANEL_PORT_TO = 8795`、`probePanel`、`probePanels`、`openInBrowser`。`src/web/env.js` 管 `.env` 表单：`MASK`、`envView`、`mergeEnvMasked`、`applyEnvUpdate`（`********` 表示这项不改）。HTTP 接口与前端约定见 [docs/WEB.md](WEB.md)。

## 15. 入口 `src/main.js`

- `parseArgs → configureI18n → loadConfig → createLogger → 组装 services → 自检（startup）→ 控制面板 → onebot.start() → dispatcher 注册事件 → 自检（runtime）→ scheduler.start() → autonomy.start() → 等消息`；SIGINT / SIGTERM 时保存情感与任务、巩固记忆、关连接后退出。
- 参数：`--config-dir --offline --no-sidecar --no-autonomy --no-web --web-port --dry-run --log-level`。

## 16. 侧车 `python/sidecar.py`（仅标准库）

- `python python/sidecar.py --host 127.0.0.1 --port 8765 [--data-dir data]`。
- `GET /health` → `{ ok, service, version, python, platform, features }`；`GET /screenshot?path=&monitor=` → `{ ok, path, width, height }`。
- `POST /embed` → `{ ok, vectors, dim, count }`、`/similar` → `{ ok, score }`、`/score` → `{ ok, scores }`、`/consolidate` → `{ keep, promote, drop, merge }`；`/asr`、`/ocr` 缺依赖时 `{ ok: false, error }`。
- 任何异常都返回 JSON 错误，不留 500 空响应。

## 17. 表情包与开发工具

- `src/sticker/`（契约见 [docs/STICKERS.md](STICKERS.md)）：`await createStickers({ config, logger, llm, vision, dir })` → `{ observe, note, pick, send, describe, learn, list, get, remove, stats, notes, load, enabled, dir, library }`；索引条目落盘 `data/stickers/index.json`，字段 `{ id, file, ext, bytes, title, meaning, tags, addedBy, addedAt, usedCount, lastUsedAt, sourceHash, origin }`。
- `tools/dev/`：`mock-onebot.js`（假 NapCat，`POST /inject`、`GET /sent`）、`mock-llm.js`（假 OpenAI 兼容接口，`GET /usage`）；`check-encoding.mjs`、`check-i18n.mjs` 是体检脚本。测试 `npm test` 跑 `tests/**/*.test.js`，不联网、不连真 QQ。

## 18. 其他文档

[docs/FEATURES.md](FEATURES.md) · [docs/ARCHITECTURE.md](ARCHITECTURE.md) · [docs/USAGE.md](USAGE.md) · [docs/CONFIG.md](CONFIG.md)

[docs/I18N.md](I18N.md) · [docs/STICKERS.md](STICKERS.md) · [docs/WEB.md](WEB.md) · [docs/NAPCAT.md](NAPCAT.md) · [docs/DEVELOPMENT.md](DEVELOPMENT.md) · [python/README.md](../python/README.md) · [tools/dev/README.md](../tools/dev/README.md)
