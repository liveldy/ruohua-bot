/**
 * OneBot 11 客户端（NapCat 协议端）。
 * 三种接入方式：
 *   forward —— 本项目作为 ws 客户端，连 NapCat 的 WebSocket 服务端（默认，NapCat 里配 websocketServers）
 *   reverse —— 本项目起 WebSocket 服务端，等 NapCat 的 websocketClients 连过来
 *   http    —— 本项目起 HTTP 上报服务端，通过 httpUrl 调 API
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { extractText, normalizeMessage, segmentsToPlain, toMessageContent } from './segments.js';
import { sleep, shortId } from '../util/common.js';
import { t } from '../i18n/index.js';

export class OneBotError extends Error {
  constructor(message, { action, retcode, data } = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = action;
    this.retcode = retcode;
    this.data = data;
  }
}

export function createOneBotClient({ config, logger, events = new EventEmitter() } = {}) {
  const onebotConfig = config.bot.onebot;
  const state = {
    socket: null,
    server: null,
    httpServer: null,
    status: 'idle', // idle | connecting | connected | disconnected | stopped
    pending: new Map(),
    loginInfo: null,
    connectedAt: null,
    lastEventAt: null,
    attempts: 0,
    stopped: false,
    messagesIn: 0,
    messagesOut: 0,
    lastError: null,
    heartbeatTimer: null,
    // 重连定时器：同一时刻只允许有一个（重复调度会被丢掉，见 scheduleReconnect）
    reconnectTimer: null,
    // 最近消息缓存：id → { text, userId, nickname, time }，用来还原文里只有 message_id 的引用
    recentMessages: new Map(),
  };

  const childLog = logger?.child ? logger.child('onebot') : logger;
  /** 缓存条数上限：bot.onebot.recentMessages，默认 200，满了按时间淘汰最旧的。 */
  const recentCapacity = Math.max(1, Math.trunc(Number(onebotConfig.recentMessages)) || 200);
  /** 缓存没命中时补查 get_msg 的超时，短一点，别拖住这条消息。 */
  const quoteLookupTimeoutMs = Math.max(200, Math.trunc(Number(onebotConfig.quoteLookupTimeoutMs)) || 3000);
  /**
   * 同一句 warn 的聚合窗口：窗口内只打一次，其余只计数，窗口翻篇时把次数并进下一条里；
   * 连接恢复时把没打完的计数一次性说清。
   * 默认 5 分钟 —— 协议端整点没开的时候，一分钟一行也还是刷屏。
   */
  const logWindowMs = Math.max(1000, Math.trunc(Number(onebotConfig.logDedupWindowMs)) || 300_000);
  /**
   * 重连这件事本身的播报节奏：第一次必报，之后每 reconnectLogWindowMs（默认 10 分钟）报一条，
   * 中间那些只计数（连上时一次结清）。原来每 30 秒重试一次就报一行，一小时能刷上百行。
   */
  const reconnectLogWindowMs = Math.max(1000, Math.trunc(Number(onebotConfig.reconnectLogWindowMs)) || 600_000);
  let reconnectLoggedAt = 0;
  let reconnectMuted = 0;
  /**
   * message → { since, count, error }：同类错误（例如协议端没起来时的 ECONNREFUSED）
   * 以前一秒能打七八行，现在一个窗口一行，剩下的攒着一起报。
   */
  const logThrottle = new Map();

  /** 把某个窗口里压下来的重复告警结清（保留计数，别把信息丢掉）。 */
  function flushThrottle(reason) {
    for (const [message, entry] of logThrottle) {
      if (!entry.count) continue;
      childLog?.info?.(t('onebot.client.throttleRepeat', { reason, message, count: entry.count }));
    }
    logThrottle.clear();
  }

  /** 去重版 warn：同一 message 在窗口内只 warn 一次；窗口翻篇时把次数并进这一条，不另起一行。 */
  function warnThrottled(message, error) {
    const now = Date.now();
    const entry = logThrottle.get(message);
    if (entry && now - entry.since < logWindowMs) {
      entry.count += 1;
      if (error) entry.error = error;
      return;
    }
    const repeat = entry?.count ?? 0;
    logThrottle.set(message, { since: now, count: 0, error: error ?? null });
    childLog?.warn?.(repeat ? `${message}${t('onebot.client.repeatInline', { count: repeat })}` : message, error ?? undefined);
  }

  /** 重连播报：按 reconnectLogWindowMs 压着报，中间静音的那些只累计次数。 */
  function noteReconnect({ delay, attempts }) {
    const now = Date.now();
    if (attempts > 1 && now - reconnectLoggedAt < reconnectLogWindowMs) {
      reconnectMuted += 1;
      return;
    }
    const text =
      delay >= 1000
        ? t('onebot.client.reconnectSeconds', { seconds: Math.round(delay / 1000), attempts })
        : t('onebot.client.reconnectMs', { ms: delay, attempts });
    childLog?.info?.(reconnectMuted ? t('onebot.client.reconnectMuted', { count: reconnectMuted, message: text }) : text);
    reconnectLoggedAt = now;
    reconnectMuted = 0;
  }

  /** 连接恢复：把压下来的重复日志与静音的重连次数结清并重置窗口（下次断线重新从「第一行」开始算）。 */
  function resetThrottleOnRecover() {
    flushThrottle(t('onebot.client.throttleWindowRecovered'));
    if (reconnectMuted > 0) {
      childLog?.info?.(t('onebot.client.reconnectRecovered', { count: reconnectMuted }));
      reconnectMuted = 0;
    }
    reconnectLoggedAt = 0;
  }

  function emit(name, payload) {
    try {
      events.emit(name, payload);
    } catch (error) {
      childLog?.error?.(t('onebot.client.eventError', { name }), error);
    }
  }

  /** 进缓存（收到即缓存）：同一 id 只留最新一份，超上限按时间淘汰最旧的。 */
  function rememberRecent(id, entry = {}) {
    if (id === null || id === undefined || id === '') return;
    const key = String(id);
    state.recentMessages.delete(key);
    state.recentMessages.set(key, {
      text: entry.text ?? '',
      userId: entry.userId ?? null,
      nickname: entry.nickname ?? null,
      time: entry.time ?? Date.now(),
    });
    while (state.recentMessages.size > recentCapacity) {
      const oldest = state.recentMessages.keys().next().value;
      state.recentMessages.delete(oldest);
    }
  }

  /** 取缓存；命中后提到最新，淘汰按「最久没用」算。 */
  function recallRecent(id) {
    if (id === null || id === undefined || id === '') return null;
    const key = String(id);
    const entry = state.recentMessages.get(key);
    if (!entry) return null;
    state.recentMessages.delete(key);
    state.recentMessages.set(key, entry);
    return entry;
  }

  function mergeQuoted(base, source, resolved) {
    return {
      messageId: base?.messageId ?? null,
      userId: source?.userId ?? base?.userId ?? null,
      nickname: source?.nickname ?? base?.nickname ?? null,
      text: (source?.text || base?.text) ?? null,
      time: source?.time ?? base?.time ?? null,
      resolved: Boolean(resolved),
    };
  }

  function toApiMessageId(id) {
    const num = Number(id);
    return Number.isFinite(num) ? num : id;
  }

  /**
   * reply 段只给了 message_id 时，去缓存里查，再退一步用 get_msg 补一次查询。
   * 查不到就 resolved:false —— 绝不抛错、绝不卡住这条消息。
   */
  async function resolveQuoted(message) {
    const base = message?.quoted ?? null;
    if (!base || base.resolved || !base.messageId) return base;
    try {
      const cached = recallRecent(base.messageId);
      if (cached) return mergeQuoted(base, cached, true);
      if (onebotConfig.quoteLookup === false || !isConnectedNow()) return mergeQuoted(base, null, false);
      const data = await api('get_msg', { message_id: toApiMessageId(base.messageId) }, { timeoutMs: quoteLookupTimeoutMs });
      const fetched = normalizeMessage(data ?? {});
      const entry = {
        text: fetched.display || fetched.text || '',
        userId: fetched.userId ?? null,
        nickname: fetched.sender?.nickname ?? null,
        time: fetched.time ?? null,
      };
      if (!entry.text && entry.userId === null && !entry.nickname) return mergeQuoted(base, null, false);
      rememberRecent(base.messageId, entry);
      return mergeQuoted(base, entry, true);
    } catch (error) {
      childLog?.debug?.(t('onebot.client.quoteLookupFailed', { messageId: base.messageId }), error);
      return mergeQuoted(base, null, false);
    }
  }

  function setStatus(next, detail) {
    if (state.status === next) return;
    state.status = next;
    childLog?.debug?.(t('onebot.client.statusChanged', { status: next }), detail);
    emit('status', { status: next, detail });
  }

  function rejectPending(error) {
    for (const [echo, pending] of state.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      state.pending.delete(echo);
    }
  }

  function handleFrame(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      childLog?.warn?.(t('onebot.client.badFrame'));
      return;
    }
    state.lastEventAt = Date.now();
    if (payload.echo !== undefined && payload.echo !== null && state.pending.has(payload.echo)) {
      const pending = state.pending.get(payload.echo);
      state.pending.delete(payload.echo);
      clearTimeout(pending.timer);
      if (payload.status === 'failed' || (payload.retcode !== undefined && payload.retcode !== 0)) {
        pending.reject(
          new OneBotError(
            t('onebot.client.apiFailed', {
              action: pending.action,
              retcode: payload.retcode,
              message: payload.message ?? payload.wording ?? '',
            }),
            {
              action: pending.action,
              retcode: payload.retcode,
              data: payload.data,
            },
          ),
        );
      } else {
        pending.resolve(payload.data ?? {});
      }
      return;
    }
    dispatchEvent(payload);
  }

  /** 事件是异步处理的（引用要查缓存 / get_msg），异常一律吞在这儿，不影响连接。 */
  function dispatchEvent(payload) {
    try {
      Promise.resolve(routeEvent(payload)).catch((error) => childLog?.error?.(t('onebot.client.eventHandleError'), error));
    } catch (error) {
      childLog?.error?.(t('onebot.client.eventHandleError'), error);
    }
  }

  async function routeEvent(payload) {
    switch (payload.post_type) {
      case 'message':
      case 'message_sent': {
        const message = normalizeMessage(payload);
        // 收到即缓存。机器人自己发出的（sendTo 也会缓存）最常被引用，message_sent 也算。
        rememberRecent(message.messageId, {
          text: message.display || message.text,
          userId: message.userId,
          nickname: message.sender?.nickname ?? null,
          time: message.time,
        });
        if (payload.post_type === 'message_sent' && payload.user_id === payload.self_id) return;
        state.messagesIn += 1;
        message.quoted = await resolveQuoted(message);
        childLog?.debug?.(t('onebot.client.messageIn', { scene: message.scene }), { userId: message.userId, groupId: message.groupId, text: message.display });
        emit('message', message);
        break;
      }
      case 'notice':
        emit('notice', payload);
        break;
      case 'request':
        emit('request', payload);
        break;
      case 'meta_event':
        if (payload.meta_event_type === 'lifecycle') {
          childLog?.info?.(t('onebot.client.lifecycle'), { sub_type: payload.sub_type });
        }
        emit('meta', payload);
        break;
      default:
        emit('other', payload);
    }
  }

  async function connectForward() {
    const { wsUrl, accessToken } = onebotConfig;
    // 同一时刻只连一个：正在连或已经连上就直接复用，别让心跳看门狗和重连定时器各起一个。
    const existing = state.socket;
    if (existing && existing.readyState <= WebSocket.OPEN) return existing;
    setStatus('connecting', wsUrl);
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    const socket = new WebSocket(wsUrl, { headers, handshakeTimeout: 8000 });
    state.socket = socket;
    /** 老 socket 晚到的 close/error 不该再影响当前连接（换了代际就丢）。 */
    const isCurrent = () => state.socket === socket;

    socket.on('open', async () => {
      if (!isCurrent()) return;
      state.attempts = 0;
      clearReconnectTimer(); // 已经连上，撤掉待重连的定时器
      state.connectedAt = Date.now();
      setStatus('connected', wsUrl);
      childLog?.info?.(t('onebot.client.forwardConnected', { url: wsUrl }));
      resetThrottleOnRecover();
      try {
        state.loginInfo = await api('get_login_info', {}, { timeoutMs: 5000 });
        childLog?.info?.(t('onebot.client.loginInfo', { userId: state.loginInfo?.user_id, nickname: state.loginInfo?.nickname ?? '' }));
      } catch (error) {
        childLog?.warn?.(t('onebot.client.loginInfoFailed'), error);
      }
      emit('connected', { mode: 'forward', url: wsUrl, loginInfo: state.loginInfo });
    });

    socket.on('message', (data) => handleFrame(String(data)));
    socket.on('error', (error) => {
      if (!isCurrent()) return;
      state.lastError = error;
      warnThrottled(t('onebot.client.socketError'), error);
      emit('error', error);
    });
    socket.on('close', () => {
      if (!isCurrent()) return;
      rejectPending(new OneBotError(t('onebot.client.disconnected')));
      state.socket = null;
      if (state.stopped) {
        setStatus('stopped');
        return;
      }
      setStatus('disconnected');
      emit('disconnected', { mode: 'forward' });
      scheduleReconnect();
    });
    return socket;
  }

  async function connectReverse() {
    const { reversePort, reversePath, accessToken } = onebotConfig;
    setStatus('connecting', `reverse:${reversePort}`);
    const server = new WebSocketServer({ port: reversePort, path: reversePath });
    state.server = server;
    server.on('connection', (socket, request) => {
      const header = request.headers.authorization ?? '';
      if (accessToken && header !== `Bearer ${accessToken}`) {
        childLog?.warn?.(t('onebot.client.reverseTokenMismatch'), { remote: request.socket.remoteAddress });
        socket.close(1008, 'invalid token');
        return;
      }
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        childLog?.warn?.(t('onebot.client.reverseReplace'));
        try {
          state.socket.close();
        } catch {
          /* 忽略 */
        }
      }
      state.socket = socket;
      state.connectedAt = Date.now();
      state.attempts = 0;
      setStatus('connected', `reverse:${reversePort}`);
      childLog?.info?.(t('onebot.client.reverseConnected', { port: reversePort, path: reversePath }));
      socket.on('message', (data) => handleFrame(String(data)));
      socket.on('close', () => {
        rejectPending(new OneBotError(t('onebot.client.disconnected')));
        if (state.socket === socket) state.socket = null;
        setStatus('disconnected');
        emit('disconnected', { mode: 'reverse' });
      });
      socket.on('error', (error) => {
        state.lastError = error;
        emit('error', error);
      });
      api('get_login_info', {}, { timeoutMs: 5000 })
        .then((info) => {
          state.loginInfo = info;
          emit('connected', { mode: 'reverse', loginInfo: info });
        })
        .catch((error) => childLog?.warn?.(t('onebot.client.loginInfoFailed'), error));
    });
    server.on('error', (error) => {
      state.lastError = error;
      childLog?.error?.(t('onebot.client.reverseServerError'), error);
      emit('error', error);
    });
    await new Promise((resolve) => server.once('listening', resolve));
    childLog?.info?.(t('onebot.client.reverseListening', { port: reversePort, path: reversePath }));
  }

  async function connectHttp() {
    const { httpPort } = onebotConfig;
    setStatus('connecting', `http:${httpPort}`);
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end('method not allowed');
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          state.lastEventAt = Date.now();
          dispatchEvent(payload);
        } catch (error) {
          childLog?.warn?.(t('onebot.client.httpParseFailed'), error);
        }
      });
    });
    state.httpServer = server;
    server.on('error', (error) => {
      state.lastError = error;
      childLog?.error?.(t('onebot.client.httpServerError'), error);
      emit('error', error);
    });
    await new Promise((resolve) => server.listen(httpPort, onebotConfig.host ?? '127.0.0.1', resolve));
    setStatus('connected', `http:${httpPort}`);
    childLog?.info?.(t('onebot.client.httpListening', { port: httpPort }));
    try {
      state.loginInfo = await api('get_login_info', {}, { timeoutMs: 5000 });
    } catch (error) {
      childLog?.warn?.(t('onebot.client.loginInfoFailed'), error);
    }
    emit('connected', { mode: 'http', loginInfo: state.loginInfo });
  }

  function clearReconnectTimer() {
    if (!state.reconnectTimer) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  /**
   * 排一次重连：**同一时刻只有一个定时器** —— 已经排上就直接返回，重复调用不再叠加。
   * 退避按 config.bot.onebot.reconnect 的 minDelayMs/maxDelayMs/factor 走，
   * 次数 state.attempts 在连上时清零。
   */
  function scheduleReconnect() {
    if (state.stopped) return null;
    if (state.reconnectTimer) return state.reconnectTimer;
    const { minDelayMs, maxDelayMs, factor } = onebotConfig.reconnect;
    const base = Math.max(1, Math.trunc(Number(minDelayMs)) || 1000);
    const cap = Math.max(base, Math.trunc(Number(maxDelayMs)) || base);
    const rate = Number(factor) > 0 ? Number(factor) : 1;
    state.attempts += 1;
    const delay = Math.min(cap, Math.round(base * rate ** (state.attempts - 1)));
    noteReconnect({ delay, attempts: state.attempts });
    const timer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.stopped) return;
      connectForward().catch((error) => {
        state.lastError = error;
        scheduleReconnect();
      });
    }, delay);
    timer.unref?.();
    state.reconnectTimer = timer;
    return timer;
  }

  /** 发一条 API 调用（ws 走 echo 匹配，http 走 HTTP POST）。 */
  async function api(action, params = {}, { timeoutMs = onebotConfig.requestTimeoutMs } = {}) {
    const mode = onebotConfig.mode;
    if (mode === 'http') {
      const response = await fetch(`${onebotConfig.httpUrl.replace(/\/$/, '')}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(onebotConfig.accessToken ? { Authorization: `Bearer ${onebotConfig.accessToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload.retcode ?? 0) !== 0) {
        throw new OneBotError(
          t('onebot.client.apiFailed', {
            action,
            retcode: payload.retcode ?? response.status,
            message: payload.message ?? '',
          }),
          {
            action,
            retcode: payload.retcode ?? response.status,
            data: payload.data,
          },
        );
      }
      return payload.data ?? {};
    }

    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new OneBotError(t('onebot.client.apiNotConnected', { action }), { action });
    }
    const echo = shortId('api');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(echo);
        reject(new OneBotError(t('onebot.client.apiTimeout', { action, timeoutMs }), { action }));
      }, timeoutMs);
      timer.unref?.();
      state.pending.set(echo, { resolve, reject, timer, action });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        state.pending.delete(echo);
        clearTimeout(timer);
        reject(
          error instanceof OneBotError
            ? error
            : new OneBotError(t('onebot.client.apiSendFailed', { action, message: error.message }), { action }),
        );
      }
    });
  }

  async function sendTo(target = {}, content) {
    const segments = toMessageContent(content, { replyTo: target.replyTo ?? null });
    const scene = target.scene ?? (target.groupId ? 'group' : 'private');
    const action = scene === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params =
      scene === 'group'
        ? { group_id: Number(target.groupId), message: segments }
        : { user_id: Number(target.userId), message: segments };
    const data = await api(action, params);
    state.messagesOut += 1;
    // 自己发出去的也进缓存：群友最常引用的就是机器人刚说过的那句话
    rememberRecent(data?.message_id, {
      text: segmentsToPlain(segments) || extractText(segments) || t('onebot.client.genericMessage'),
      userId: state.loginInfo?.user_id ?? onebotConfig.selfId ?? null,
      nickname: config.persona?.name ?? null,
      time: Date.now(),
    });
    return data;
  }

  /** 现在到底通不通（三种接入方式判断方式不同）。 */
  function isConnectedNow() {
    if (state.status !== 'connected') return false;
    if (onebotConfig.mode === 'http') return Boolean(state.httpServer?.listening);
    return Boolean(state.socket && state.socket.readyState === WebSocket.OPEN);
  }

  async function start() {
    state.stopped = false;
    const mode = onebotConfig.mode;
    if (mode === 'forward') await connectForward();
    else if (mode === 'reverse') await connectReverse();
    else if (mode === 'http') await connectHttp();
    else throw new OneBotError(t('onebot.client.unsupportedMode', { mode }));

    // 心跳看门狗：长时间没有任何事件且 socket 已死，就主动重连
    state.heartbeatTimer = setInterval(() => {
      if (state.stopped) return;
      const socket = state.socket;
      if (mode === 'forward' && (!socket || socket.readyState > WebSocket.OPEN)) {
        // 已经有重连计划在跑就等它，别再起一个 —— 否则每个心跳都新开一个 socket，
        // 每个 socket 失败又各排一次重连，一秒能排出十几次（真机日志里的 12/13/14 次就是这么来的）。
        if (state.reconnectTimer) return;
        warnThrottled(t('onebot.client.socketDead'));
        connectForward().catch((error) => {
          state.lastError = error;
          scheduleReconnect();
        });
        return;
      }
      const last = state.lastEventAt ?? state.connectedAt;
      if (last && Date.now() - last > onebotConfig.heartbeatTimeoutMs) {
        warnThrottled(t('onebot.client.heartbeatTimeout'));
        try {
          state.socket?.close();
        } catch {
          /* 忽略 */
        }
      }
    }, Math.max(5000, Math.min(30000, onebotConfig.heartbeatTimeoutMs / 3)));
    state.heartbeatTimer.unref?.();
  }

  async function stop() {
    state.stopped = true;
    clearReconnectTimer();
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    rejectPending(new OneBotError(t('onebot.client.stopped')));
    try {
      state.socket?.close();
    } catch {
      /* 忽略 */
    }
    try {
      state.server?.close();
    } catch {
      /* 忽略 */
    }
    try {
      state.httpServer?.close();
    } catch {
      /* 忽略 */
    }
    setStatus('stopped');
    await sleep(50);
  }

  return {
    events,
    on: (name, handler) => events.on(name, handler),
    off: (name, handler) => events.off(name, handler),
    start,
    stop,
    api,
    sendTo,
    sendPrivate: (userId, content, replyTo = null) => sendTo({ scene: 'private', userId, replyTo }, content),
    sendGroup: (groupId, content, replyTo = null) => sendTo({ scene: 'group', groupId, replyTo }, content),
    deleteMessage: (messageId) => api('delete_msg', { message_id: messageId }),
    getLoginInfo: () => api('get_login_info'),
    getVersionInfo: () => api('get_version_info'),
    getStatus: () => api('get_status'),
    getFriendList: () => api('get_friend_list'),
    getGroupList: () => api('get_group_list'),
    getGroupMemberInfo: (groupId, userId, noCache = true) =>
      api('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: noCache }),
    async uploadFile({ scene = 'private', userId, groupId, file, name = null }) {
      if (scene === 'group') {
        return api('upload_group_file', { group_id: Number(groupId), file, name: name ?? String(file).split(/[\\/]/).pop() });
      }
      return api('upload_private_file', { user_id: Number(userId), file, name: name ?? String(file).split(/[\\/]/).pop() });
    },
    /** 戳一戳：NapCat 支持 friend_poke / group_poke。 */
    async poke(target = {}) {
      if (target.scene === 'group') return api('group_poke', { group_id: Number(target.groupId), user_id: Number(target.userId) });
      return api('friend_poke', { user_id: Number(target.userId) });
    },
    isConnected: isConnectedNow,
    /** 最近消息缓存快照（引用还原用；也方便测试与排查）。 */
    messageCache: () => ({
      capacity: recentCapacity,
      size: state.recentMessages.size,
      entries: [...state.recentMessages.entries()].map(([messageId, entry]) => ({ messageId, ...entry })),
    }),
    status: () => ({
      connected: isConnectedNow(),
      status: state.status,
      mode: onebotConfig.mode,
      connectedAt: state.connectedAt,
      lastEventAt: state.lastEventAt,
      attempts: state.attempts,
      loginInfo: state.loginInfo,
      messagesIn: state.messagesIn,
      messagesOut: state.messagesOut,
      lastError: state.lastError ? String(state.lastError.message ?? state.lastError) : null,
    }),
    loginInfo: () => state.loginInfo,
  };
}
