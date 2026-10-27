#!/usr/bin/env node
/**
 * 模拟 NapCat —— OneBot 11 正向 WebSocket 服务端（同进程附带 HTTP 控制接口）。
 *
 *   node tools/dev/mock-onebot.js --port 3901 --http-port 3902 [--token xxx] [--self-id 10000] [--quiet]
 *
 * 用途：本地开发与测试时替代真实 NapCat，不连 QQ：
 *   - ws://<host>:<port>            与 src/onebot/client.js 的 forward 模式对接（echo 应答 / 事件推送）
 *   - http://<host>:<http-port>     控制接口：注入消息、读机器人发出的消息、推 notice、看健康状态
 *
 * 协议细节见 tools/dev/README.md。
 */

import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { atSegment, extractText, faceSegment, textSegment, toMessageContent } from '../../src/onebot/segments.js';

const OPEN = WebSocket.OPEN;

const HELP = `用法：node tools/dev/mock-onebot.js [选项]

选项：
  --port <n>        WebSocket 端口（默认 3001，与 config/bot.json 的 onebot.wsUrl 一致）
  --http-port <n>   HTTP 控制端口（默认 port + 1）
  --token <s>       要求 Authorization: Bearer <s>，不传则不校验
  --self-id <n>     机器人 QQ 号（默认 10000）
  --host <ip>       监听地址（默认 127.0.0.1）
  --heartbeat <ms>  心跳 meta_event 间隔，0 表示不推（默认 0）
  --quiet           不打日志
  -h, --help        显示本帮助
`;

export function parseArgs(argv = []) {
  const options = { port: 3001, httpPort: null, token: '', selfId: 10000, host: '127.0.0.1', heartbeatMs: 0, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === '--port' || arg === '-p') options.port = Number(value());
    else if (arg === '--http-port') options.httpPort = Number(value());
    else if (arg === '--token') options.token = String(value() ?? '');
    else if (arg === '--self-id') options.selfId = Number(value());
    else if (arg === '--host') options.host = String(value() ?? '');
    else if (arg === '--heartbeat' || arg === '--heartbeat-ms') options.heartbeatMs = Number(value());
    else if (arg === '--quiet' || arg === '-q') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (String(arg).startsWith('-')) throw new Error(`未知参数：${arg}`);
  }
  if (options.httpPort === null) options.httpPort = options.port + 1;
  for (const key of ['port', 'httpPort', 'heartbeatMs']) {
    if (!Number.isInteger(options[key]) || options[key] < 0 || options[key] > 65535) {
      throw new Error(`参数 ${key} 非法：${options[key]}`);
    }
  }
  if (options.port === 0) throw new Error('--port 不能为 0');
  if (options.httpPort === 0) throw new Error('--http-port 不能为 0');
  if (!Number.isInteger(options.selfId)) throw new Error(`--self-id 非法：${options.selfId}`);
  return options;
}

class ActionError extends Error {
  constructor(wording, retcode = 1404) {
    super(wording);
    this.wording = wording;
    this.retcode = retcode;
  }
}

export function createMockOneBot(rawOptions = {}) {
  const options = { ...parseArgs([]), ...rawOptions };
  const log = options.quiet ? () => {} : (...args) => console.log('[mock-onebot]', ...args);
  const state = {
    connections: new Set(),
    sent: [],
    received: [],
    messagesById: new Map(),
    actions: {},
    unsupported: 0,
    messageSeq: 1000,
    startedAt: Date.now(),
  };

  const friends = options.friends ?? [
    { user_id: 10001, nickname: '小林', remark: '' },
    { user_id: 10002, nickname: '张三', remark: '' },
  ];
  const groups = options.groups ?? [
    { group_id: 20001, group_name: '若华测试群', member_count: 3, max_member_count: 200 },
  ];
  const members = options.members ?? [
    { user_id: 10001, nickname: '小林', card: '', role: 'owner' },
    { user_id: 10002, nickname: '张三', card: '三哥', role: 'member' },
    { user_id: options.selfId, nickname: '若华', card: '', role: 'member' },
  ];

  const nextMessageId = () => {
    state.messageSeq += 1;
    return state.messageSeq;
  };

  const toSegments = (message) => {
    if (Array.isArray(message)) return message.map((segment) => ({ type: String(segment.type), data: { ...(segment.data ?? {}) } }));
    if (message === undefined || message === null || message === '') return [];
    return toMessageContent(String(message));
  };

  /** 所有发送类动作都记进内存，供 GET /sent 断言。 */
  function recordSend({ action, scene, userId = null, groupId = null, message, extra = {} }) {
    const segments = toSegments(message);
    const entry = {
      at: Date.now(),
      action,
      scene,
      userId: userId === null || userId === undefined ? null : Number(userId),
      groupId: groupId === null || groupId === undefined ? null : Number(groupId),
      message: segments,
      text: extractText(segments),
      ...extra,
    };
    state.sent.push(entry);
    if (entry.messageId !== undefined) state.messagesById.set(String(entry.messageId), entry);
    log(`记录发送 ${action}`, { scene, userId: entry.userId, groupId: entry.groupId, text: entry.text });
    return entry;
  }

  function sendMessage({ action, scene, userId, groupId, message }) {
    const messageId = nextMessageId();
    recordSend({ action, scene, userId, groupId, message, extra: { messageId } });
    return { message_id: messageId };
  }

  /** OneBot 11 动作表。抛 ActionError 表示失败应答。 */
  const actions = {
    get_login_info() {
      return { user_id: options.selfId, nickname: '若华(mock)' };
    },
    get_version_info() {
      return {
        app_name: 'mock-onebot',
        app_version: '0.1.0',
        protocol_version: 'v11',
        app_full_name: 'mock-onebot (NapCat 模拟)',
        version: 'v11',
      };
    },
    get_status() {
      return {
        online: true,
        good: true,
        app_initialized: true,
        app_enabled: true,
        plugins_good: true,
        stat: { packet_received: Object.values(state.actions).reduce((a, b) => a + b, 0), packet_sent: state.sent.length + state.received.length, message_received: state.received.length, message_sent: state.sent.length },
      };
    },
    send_private_msg(params) {
      return sendMessage({ action: 'send_private_msg', scene: 'private', userId: params.user_id, message: params.message ?? params.messages });
    },
    send_group_msg(params) {
      return sendMessage({ action: 'send_group_msg', scene: 'group', groupId: params.group_id, message: params.message ?? params.messages });
    },
    send_msg(params) {
      const scene = params.message_type === 'group' || (params.message_type !== 'private' && params.group_id) ? 'group' : 'private';
      return sendMessage({
        action: 'send_msg',
        scene,
        userId: scene === 'private' ? params.user_id : params.user_id ?? null,
        groupId: scene === 'group' ? params.group_id : null,
        message: params.message ?? params.messages,
      });
    },
    delete_msg(params) {
      if (params.message_id === undefined || params.message_id === null) throw new ActionError('message_id 缺失');
      return {};
    },
    get_msg(params) {
      const key = String(params.message_id);
      const stored = state.messagesById.get(key);
      if (!stored) throw new ActionError(`消息不存在：${params.message_id}`);
      const segments = stored.message ?? [];
      return {
        message_id: Number(params.message_id),
        real_id: Number(params.message_id),
        time: Math.floor(stored.at / 1000),
        message_type: stored.scene,
        user_id: stored.userId,
        group_id: stored.groupId ?? undefined,
        sender: stored.sender ?? { user_id: stored.userId, nickname: '', card: '', role: 'member' },
        message: segments,
        raw_message: extractText(segments),
      };
    },
    get_friend_list() {
      return friends;
    },
    get_group_list() {
      return groups;
    },
    get_group_member_info(params) {
      const userId = Number(params.user_id);
      const found = members.find((member) => member.user_id === userId);
      if (found) return { group_id: Number(params.group_id), ...found, join_time: Math.floor(state.startedAt / 1000), last_sent_time: Math.floor(state.startedAt / 1000), level: '1', sex: 'unknown', age: 18, area: '', unfriendly: false, title: '' };
      return { group_id: Number(params.group_id), user_id: userId, nickname: `成员${userId}`, card: '', role: 'member', sex: 'unknown', age: 18 };
    },
    upload_private_file(params) {
      const name = params.name ?? String(params.file ?? '').split(/[\\/]/).pop();
      const messageId = nextMessageId();
      recordSend({
        action: 'upload_private_file',
        scene: 'private',
        userId: params.user_id,
        message: [{ type: 'file', data: { file: String(params.file ?? ''), name: String(name ?? '') } }],
        extra: { messageId, file: String(params.file ?? ''), name: String(name ?? '') },
      });
      return {};
    },
    upload_group_file(params) {
      const name = params.name ?? String(params.file ?? '').split(/[\\/]/).pop();
      const messageId = nextMessageId();
      recordSend({
        action: 'upload_group_file',
        scene: 'group',
        groupId: params.group_id,
        message: [{ type: 'file', data: { file: String(params.file ?? ''), name: String(name ?? '') } }],
        extra: { messageId, file: String(params.file ?? ''), name: String(name ?? '') },
      });
      return {};
    },
    friend_poke(params) {
      const messageId = nextMessageId();
      recordSend({
        action: 'friend_poke',
        scene: 'private',
        userId: params.user_id,
        message: [{ type: 'poke', data: { qq: String(params.user_id ?? '') } }],
        extra: { messageId },
      });
      return {};
    },
    group_poke(params) {
      const messageId = nextMessageId();
      recordSend({
        action: 'group_poke',
        scene: 'group',
        groupId: params.group_id,
        userId: params.user_id ?? null,
        message: [{ type: 'poke', data: { qq: String(params.user_id ?? '') } }],
        extra: { messageId },
      });
      return {};
    },
  };

  function buildFrame(action, params = {}, echo = null) {
    state.actions[action] = (state.actions[action] ?? 0) + 1;
    const handler = actions[action];
    if (!handler) {
      state.unsupported += 1;
      log(`不支持的 action：${action}`);
      return { status: 'failed', retcode: 1404, wording: 'unsupported action', data: null, echo };
    }
    try {
      const data = handler(params ?? {}) ?? {};
      return { status: 'ok', retcode: 0, data, echo };
    } catch (error) {
      const retcode = error instanceof ActionError ? error.retcode : 1200;
      log(`action ${action} 失败：${error.message}`);
      return { status: 'failed', retcode, wording: error.message, data: null, echo };
    }
  }

  function sendFrame(socket, payload) {
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      log('发送帧失败', error.message);
      return false;
    }
  }

  function broadcast(payload) {
    let delivered = 0;
    for (const socket of state.connections) {
      if (sendFrame(socket, payload)) delivered += 1;
    }
    return delivered;
  }

  function connectEvent() {
    return {
      time: Math.floor(Date.now() / 1000),
      self_id: options.selfId,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    };
  }

  function inject(body = {}) {
    const scene = body.scene === 'group' ? 'group' : 'private';
    const userId = Number(body.userId ?? body.user_id ?? (scene === 'group' ? 10002 : 10001));
    const groupId = scene === 'group' ? Number(body.groupId ?? body.group_id ?? groups[0]?.group_id ?? 20001) : null;
    const nickname = String(body.nickname ?? (scene === 'group' ? `群友${userId}` : `用户${userId}`));
    const segments = [];
    if (body.at) segments.push(atSegment(options.selfId));
    if (body.text !== undefined && body.text !== null && body.text !== '') segments.push(textSegment(body.text));
    for (const image of body.images ?? []) {
      const file = String(image);
      segments.push({ type: 'image', data: { file, url: /^https?:\/\//i.test(file) ? file : null } });
    }
    for (const face of body.faces ?? []) segments.push(faceSegment(face));
    if (Array.isArray(body.segments)) segments.push(...toSegments(body.segments));

    const messageId = nextMessageId();
    const rawTime = body.time === undefined ? Date.now() : Number(body.time);
    const event = {
      time: Math.floor(rawTime > 1e12 ? rawTime / 1000 : rawTime) || Math.floor(Date.now() / 1000),
      self_id: options.selfId,
      post_type: 'message',
      message_type: scene,
      sub_type: scene === 'group' ? 'normal' : 'friend',
      message_id: messageId,
      user_id: userId,
      raw_message: extractText(segments),
      font: 0,
      sender: {
        user_id: userId,
        nickname,
        card: scene === 'group' ? String(body.card ?? nickname) : '',
        role: String(body.role ?? 'member'),
        ...(body.sender ?? {}),
      },
      message: segments,
    };
    if (scene === 'group') event.group_id = groupId;
    if (body.raw && typeof body.raw === 'object') Object.assign(event, body.raw);

    const record = {
      at: Date.now(),
      action: 'inject',
      scene,
      userId,
      groupId,
      message: segments,
      text: extractText(segments),
      messageId,
      sender: event.sender,
    };
    state.received.push(record);
    state.messagesById.set(String(messageId), record);

    const delivered = broadcast(event);
    log(`注入 ${scene} 消息 ${messageId} → ${delivered} 个连接`, { userId, groupId, text: record.text });
    return { ok: true, messageId, delivered };
  }

  function pushNotice(body = {}) {
    const { notice_type: noticeType, ...rest } = body;
    const payload = {
      time: Math.floor(Date.now() / 1000),
      self_id: options.selfId,
      post_type: 'notice',
      notice_type: String(noticeType ?? 'unknown'),
      ...rest,
    };
    const delivered = broadcast(payload);
    log(`推送 notice ${payload.notice_type} → ${delivered} 个连接`);
    return { ok: true, delivered };
  }

  function filterSent(params = {}) {
    const scene = params.get?.('scene') ?? params.scene ?? null;
    const userId = params.get?.('userId') ?? params.get?.('user_id') ?? params.userId ?? null;
    const groupId = params.get?.('groupId') ?? params.get?.('group_id') ?? params.groupId ?? null;
    const limitRaw = params.get?.('limit') ?? params.limit ?? null;
    let rows = state.sent.filter((entry) => {
      if (scene && entry.scene !== scene) return false;
      if (userId !== null && userId !== undefined && userId !== '' && entry.userId !== Number(userId)) return false;
      if (groupId !== null && groupId !== undefined && groupId !== '' && entry.groupId !== Number(groupId)) return false;
      return true;
    });
    const limit = Number(limitRaw);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(-limit);
    return rows;
  }

  function health() {
    return {
      ok: true,
      service: 'mock-onebot',
      connections: state.connections.size,
      actions: { ...state.actions },
      unsupportedActions: state.unsupported,
      selfId: options.selfId,
      tokenRequired: Boolean(options.token),
      sentCount: state.sent.length,
      receivedCount: state.received.length,
      startedAt: state.startedAt,
      uptimeMs: Date.now() - state.startedAt,
    };
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          const failure = new Error(`请求体不是合法 JSON：${error.message}`);
          failure.statusCode = 400;
          reject(failure);
        }
      });
      req.on('error', reject);
    });
  }

  const controlServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }).end();
        return;
      }
      switch (route) {
        case 'GET /': {
          const text = ['mock-onebot 控制接口：', '  POST /inject  { scene, userId, groupId, text, images?, faces?, at?, nickname? }', '  GET  /sent?scene=&userId=&groupId=&limit=', '  DELETE /sent', '  POST /notice { notice_type, ... }', '  GET  /health'].join('\n');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`${text}\n`);
          return;
        }
        case 'GET /health':
          json(res, 200, health());
          return;
        case 'POST /inject':
          json(res, 200, inject(await readJson(req)));
          return;
        case 'GET /sent':
          json(res, 200, { ok: true, messages: filterSent(url.searchParams) });
          return;
        case 'DELETE /sent': {
          const before = state.sent.length;
          const keep = new Set(filterSent(url.searchParams));
          const hasFilter = ['scene', 'userId', 'user_id', 'groupId', 'group_id'].some((key) => url.searchParams.get(key));
          state.sent = hasFilter ? state.sent.filter((entry) => !keep.has(entry)) : [];
          log(`清空发送记录 ${before - state.sent.length} 条`);
          json(res, 200, { ok: true, removed: before - state.sent.length, messages: [] });
          return;
        }
        case 'POST /notice':
          json(res, 200, pushNotice(await readJson(req)));
          return;
        default:
          json(res, 404, { ok: false, error: 'not_found', route });
      }
    } catch (error) {
      json(res, error.statusCode ?? 400, { ok: false, error: error.message });
    }
  });

  const wsServer = new WebSocketServer({ noServer: true, clientTracking: false });
  const wsHttp = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' }).end('需要 WebSocket 升级\n');
  });

  wsHttp.on('upgrade', (request, socket, head) => {
    const header = request.headers.authorization ?? '';
    if (options.token && header !== `Bearer ${options.token}`) {
      log('token 不匹配，拒绝握手', { remote: request.socket.remoteAddress });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request));
  });

  wsServer.on('connection', (socket, request) => {
    state.connections.add(socket);
    log(`客户端接入（${request.socket.remoteAddress}），当前连接数 ${state.connections.size}`);
    socket.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(String(data));
      } catch {
        log('收到无法解析的消息帧，已忽略');
        return;
      }
      if (!payload || typeof payload !== 'object' || payload.action === undefined) return;
      const frame = buildFrame(String(payload.action), payload.params ?? {}, payload.echo ?? null);
      sendFrame(socket, frame);
    });
    socket.on('close', () => {
      state.connections.delete(socket);
      log(`客户端断开，当前连接数 ${state.connections.size}`);
    });
    socket.on('error', (error) => {
      state.connections.delete(socket);
      log('连接出错', error.message);
    });
    sendFrame(socket, connectEvent());
  });

  let heartbeatTimer = null;

  async function start() {
    await new Promise((resolve, reject) => {
      wsHttp.once('error', reject);
      wsHttp.listen(options.port, options.host, () => {
        wsHttp.off('error', reject);
        resolve();
      });
    });
    await new Promise((resolve, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(options.httpPort, options.host, () => {
        controlServer.off('error', reject);
        resolve();
      });
    });
    if (options.heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        broadcast({
          time: Math.floor(Date.now() / 1000),
          self_id: options.selfId,
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          status: { online: true, good: true },
          interval: options.heartbeatMs,
        });
      }, options.heartbeatMs);
      heartbeatTimer.unref?.();
    }
    log(`OneBot WS 已监听 ws://${options.host}:${options.port}${options.token ? '（需 token）' : ''}`);
    log(`控制接口已监听 http://${options.host}:${options.httpPort}`);
    return { wsUrl: `ws://${options.host}:${options.port}`, httpUrl: `http://${options.host}:${options.httpPort}` };
  }

  async function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const socket of state.connections) {
      try {
        socket.close();
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
    await new Promise((resolve) => wsHttp.close(() => resolve()));
    await new Promise((resolve) => controlServer.close(() => resolve()));
  }

  return {
    options,
    start,
    stop,
    health,
    inject,
    pushNotice,
    sent: () => [...state.sent],
    received: () => [...state.received],
    connections: () => state.connections.size,
    actionCounts: () => ({ ...state.actions }),
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[mock-onebot] ${error.message}`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  const mock = createMockOneBot(options);
  try {
    await mock.start();
  } catch (error) {
    console.error(`[mock-onebot] 启动失败：${error.message}`);
    console.error(`  端口 ${options.port}/${options.httpPort} 可能已被占用，换一个 --port 再试。`);
    process.exitCode = 1;
    return;
  }
  const shutdown = async () => {
    await mock.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((error) => {
    console.error('[mock-onebot] 未捕获错误', error);
    process.exitCode = 1;
  });
}
