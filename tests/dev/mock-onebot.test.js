/**
 * tools/dev/mock-onebot.js 的单元测试：与 src/onebot/client.js 的真实协议对接。
 * mock 跑在子进程里，端口由系统分配（不依赖固定端口）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createOneBotClient } from '../../src/onebot/client.js';
import { normalizeMessage } from '../../src/onebot/segments.js';
import {
  collectEvents,
  delay,
  getFreePorts,
  httpJson,
  onceEvent,
  onebotConfig,
  openSocket,
  spawnMock,
  startMockOneBot,
  stubLogger,
  waitFor,
  waitForHealth,
} from './harness.js';

async function waitForConnections(mock, expected, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const health = await httpJson(`${mock.httpUrl}/health`);
    last = health.json;
    if (last?.connections === expected) return last;
    await delay(20);
  }
  throw new Error(`等待连接数=${expected} 超时，当前 ${JSON.stringify(last)}`);
}

test('mock-onebot：OneBot 11 正向 WS 服务端', async (t) => {
  const mock = await startMockOneBot({ token: 'secret-token', selfId: 10000 });

  try {
    await t.test('连上后主动推 lifecycle meta_event，并按键回 echo 应答', async () => {
      const probe = await openSocket(mock.wsUrl, { token: mock.token });
      try {
        const lifecycle = await waitFor(() => probe.frames.find((frame) => frame.post_type === 'meta_event'), { describe: 'lifecycle 事件' });
        assert.equal(lifecycle.meta_event_type, 'lifecycle');
        assert.equal(lifecycle.sub_type, 'connect');
        assert.equal(lifecycle.self_id, 10000);
        assert.ok(Number.isInteger(lifecycle.time));

        probe.send({ action: 'get_login_info', params: {}, echo: 'e-login' });
        const reply = await waitFor(() => probe.frames.find((frame) => frame.echo === 'e-login'), { describe: 'get_login_info 应答' });
        assert.equal(reply.status, 'ok');
        assert.equal(reply.retcode, 0);
        assert.equal(reply.data.user_id, 10000);
        assert.equal(typeof reply.data.nickname, 'string');

        probe.send({ action: 'no_such_action', params: {}, echo: 'e-bad' });
        const failed = await waitFor(() => probe.frames.find((frame) => frame.echo === 'e-bad'), { describe: '未知 action 应答' });
        assert.equal(failed.status, 'failed');
        assert.equal(failed.retcode, 1404);
        assert.equal(failed.wording, 'unsupported action');

        const health = (await httpJson(`${mock.httpUrl}/health`)).json;
        assert.equal(health.ok, true);
        assert.equal(health.connections, 1);
        assert.equal(health.tokenRequired, true);
        assert.ok(health.actions.get_login_info >= 1);
        assert.ok(health.actions.no_such_action >= 1);
      } finally {
        probe.close();
      }
      await waitForConnections(mock, 0);
    });

    await t.test('/inject 推送消息事件，normalizeMessage 后字段正确', async () => {
      const probe = await openSocket(mock.wsUrl, { token: mock.token });
      try {
        const privateBody = { scene: 'private', userId: 10001, text: '若华，在吗', nickname: '小林' };
        const injected = await httpJson(`${mock.httpUrl}/inject`, { method: 'POST', body: privateBody });
        assert.equal(injected.status, 200);
        assert.equal(injected.json.ok, true);
        assert.ok(Number.isInteger(injected.json.messageId));
        assert.equal(injected.json.delivered, 1);

        const frame = await waitFor(() => probe.frames.find((item) => item.message_id === injected.json.messageId), { describe: 'private 消息事件' });
        assert.equal(frame.post_type, 'message');
        assert.equal(frame.message_type, 'private');
        assert.equal(frame.self_id, 10000);
        assert.equal(frame.user_id, 10001);
        assert.equal(frame.sender.nickname, '小林');
        assert.equal(frame.sender.role, 'member');
        assert.ok(Math.abs(frame.time - Math.floor(Date.now() / 1000)) <= 2);

        const message = normalizeMessage(frame);
        assert.equal(message.scene, 'private');
        assert.equal(message.userId, 10001);
        assert.equal(message.groupId, null);
        assert.equal(message.text, '若华，在吗');
        assert.equal(message.isAt, false);
        assert.equal(message.sender.nickname, '小林');
        assert.deepEqual(message.segments, [{ type: 'text', data: { text: '若华，在吗' } }]);

        const groupBody = {
          scene: 'group',
          userId: 10002,
          groupId: 20001,
          text: '看这个',
          at: true,
          nickname: '张三',
          images: ['https://example.com/a.png', 'D:/tmp/b.png'],
          faces: [14],
        };
        const groupInjected = await httpJson(`${mock.httpUrl}/inject`, { method: 'POST', body: groupBody });
        assert.equal(groupInjected.json.delivered, 1);
        const groupFrame = await waitFor(() => probe.frames.find((item) => item.message_id === groupInjected.json.messageId), { describe: 'group 消息事件' });
        const groupMessage = normalizeMessage(groupFrame);
        assert.equal(groupMessage.scene, 'group');
        assert.equal(groupMessage.groupId, 20001);
        assert.equal(groupMessage.userId, 10002);
        assert.equal(groupMessage.isAt, true);
        assert.equal(groupMessage.text, '看这个');
        assert.equal(groupMessage.images.length, 2);
        assert.equal(groupMessage.images[0].url, 'https://example.com/a.png');
        assert.equal(groupMessage.images[1].url, null);
        assert.deepEqual(groupMessage.faces, ['14']);
        assert.equal(groupMessage.display, '@10000看这个[图片][图片][表情14]');

        // 无人连接时 delivered 为 0，但仍返回 ok
        const broadcastless = await httpJson(`${mock.httpUrl}/notice`, { method: 'POST', body: { notice_type: 'group_recall', group_id: 20001, user_id: 10002, operator_id: 10002, message_id: 77 } });
        assert.equal(broadcastless.status, 200);
        assert.equal(broadcastless.json.delivered, 1);
        const notice = await waitFor(() => probe.frames.find((item) => item.post_type === 'notice'), { describe: 'notice 事件' });
        assert.equal(notice.notice_type, 'group_recall');
        assert.equal(notice.group_id, 20001);
        assert.equal(notice.self_id, 10000);
      } finally {
        probe.close();
      }
      await waitForConnections(mock, 0);
    });

    await t.test('createOneBotClient 能连上、调 API、收发消息', async () => {
      const client = createOneBotClient({ config: onebotConfig({ wsUrl: mock.wsUrl, accessToken: mock.token }), logger: stubLogger() });
      try {
        const connected = onceEvent(client, 'connected');
        await client.start();
        const info = await connected;
        assert.equal(info.loginInfo.user_id, 10000);
        assert.equal(info.mode, 'forward');
        assert.equal(client.isConnected(), true);

        const status = await client.getStatus();
        assert.equal(status.online, true);
        const version = await client.getVersionInfo();
        assert.equal(version.protocol_version, 'v11');
        const friends = await client.getFriendList();
        assert.ok(Array.isArray(friends) && friends.some((row) => row.user_id === 10001));
        const groups = await client.getGroupList();
        assert.ok(groups.some((row) => row.group_id === 20001));
        const member = await client.getGroupMemberInfo(20001, 10002);
        assert.equal(member.user_id, 10002);
        assert.equal(member.nickname, '张三');

        const incoming = onceEvent(client, 'message');
        await httpJson(`${mock.httpUrl}/inject`, { method: 'POST', body: { scene: 'private', userId: 10001, text: '帮我看看日志' } });
        const message = await incoming;
        assert.equal(message.text, '帮我看看日志');
        assert.equal(message.userId, 10001);
        assert.equal(message.scene, 'private');

        const sent = await client.sendPrivate(10001, '知道了，我去看看');
        assert.ok(Number.isInteger(sent.message_id));
        const groupSent = await client.sendGroup(20001, [{ type: 'text', data: { text: '群里也说一声' } }], 12345);
        assert.ok(Number.isInteger(groupSent.message_id));
        await client.uploadFile({ scene: 'private', userId: 10001, file: 'D:/tmp/report.md', name: 'report.md' });
        await client.uploadFile({ scene: 'group', groupId: 20001, file: 'D:/tmp/note.txt' });
        await client.poke({ scene: 'group', groupId: 20001, userId: 10002 });
        await client.poke({ userId: 10001 });
        await client.deleteMessage(sent.message_id);

        const fetched = await client.api('get_msg', { message_id: sent.message_id });
        assert.equal(fetched.message_id, sent.message_id);
        assert.equal(fetched.raw_message, '知道了，我去看看');

        const sent1 = (await httpJson(`${mock.httpUrl}/sent`)).json;
        assert.equal(sent1.ok, true);
        assert.equal(sent1.messages.length, 6);
        const first = sent1.messages[0];
        assert.equal(first.action, 'send_private_msg');
        assert.equal(first.scene, 'private');
        assert.equal(first.userId, 10001);
        assert.equal(first.groupId, null);
        assert.equal(first.text, '知道了，我去看看');
        assert.deepEqual(first.message, [{ type: 'text', data: { text: '知道了，我去看看' } }]);
        assert.ok(Number.isInteger(first.at));

        const groupRow = sent1.messages[1];
        assert.equal(groupRow.scene, 'group');
        assert.equal(groupRow.groupId, 20001);
        assert.equal(groupRow.text, '群里也说一声');
        assert.deepEqual(groupRow.message[0], { type: 'reply', data: { id: '12345' } });

        const upload = sent1.messages[2];
        assert.equal(upload.action, 'upload_private_file');
        assert.equal(upload.file, 'D:/tmp/report.md');
        assert.equal(upload.name, 'report.md');
        assert.equal(upload.text, '');

        const groupUpload = sent1.messages[3];
        assert.equal(groupUpload.action, 'upload_group_file');
        assert.equal(groupUpload.name, 'note.txt');

        const groupPoke = sent1.messages[4];
        assert.equal(groupPoke.action, 'group_poke');
        assert.equal(groupPoke.groupId, 20001);
        assert.equal(sent1.messages[5].action, 'friend_poke');

        const filtered = (await httpJson(`${mock.httpUrl}/sent?scene=private&userId=10001`)).json.messages;
        assert.equal(filtered.length, 3);
        assert.ok(filtered.every((row) => row.scene === 'private' && row.userId === 10001));
        assert.deepEqual(
          filtered.map((row) => row.action),
          ['send_private_msg', 'upload_private_file', 'friend_poke'],
        );

        const limited = (await httpJson(`${mock.httpUrl}/sent?limit=1`)).json.messages;
        assert.equal(limited.length, 1);
        assert.equal(limited[0].action, 'friend_poke');

        await assert.rejects(
          () => client.api('definitely_not_an_action'),
          (error) => {
            assert.equal(error.name, 'OneBotError');
            assert.equal(error.retcode, 1404);
            return true;
          },
        );

        const cleared = await httpJson(`${mock.httpUrl}/sent`, { method: 'DELETE' });
        assert.equal(cleared.json.ok, true);
        assert.equal(cleared.json.removed, 6);
        assert.deepEqual((await httpJson(`${mock.httpUrl}/sent`)).json.messages, []);

        const health = (await httpJson(`${mock.httpUrl}/health`)).json;
        assert.equal(health.connections, 1);
        assert.ok(health.actions.get_login_info >= 1);
        assert.equal(health.unsupportedActions >= 1, true);
      } finally {
        await client.stop();
      }
      await waitForConnections(mock, 0);
      // stop() 之后不应再有重连（客户端已停止）
      const noise = await collectEvents(client.events, 'connected', { timeoutMs: 200 });
      assert.equal(noise.length, 0);
    });

    await t.test('token 不匹配时握手被拒', async () => {
      const socket = new WebSocket(mock.wsUrl, { headers: { Authorization: 'Bearer wrong-token' }, handshakeTimeout: 5000 });
      const outcome = await new Promise((resolve) => {
        let opened = false;
        const timer = setTimeout(() => resolve({ opened, timeout: true }), 4000);
        socket.once('open', () => {
          opened = true;
          clearTimeout(timer);
          resolve({ opened });
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          resolve({ opened, error: String(error.message) });
        });
        socket.once('close', (code) => {
          clearTimeout(timer);
          resolve({ opened, code });
        });
      });
      assert.equal(outcome.opened, false, `不应建立连接：${JSON.stringify(outcome)}`);
      if (outcome.error) assert.match(outcome.error, /401|Unauthorized/);
      try {
        socket.terminate();
      } catch {
        /* 忽略 */
      }
      const health = await waitForConnections(mock, 0);
      assert.equal(health.connections, 0);
    });

    await t.test('--quiet 不打日志', async () => {
      const [wsPort, httpPort] = await getFreePorts(2);
      const quiet = spawnMock('mock-onebot.js', ['--port', String(wsPort), '--http-port', String(httpPort), '--quiet']);
      try {
        const health = await waitForHealth(`http://127.0.0.1:${httpPort}/health`, quiet);
        assert.equal(health.ok, true);
        await delay(150);
        assert.equal(quiet.output().trim(), '');
      } finally {
        await quiet.stop();
      }
      assert.ok(quiet.exitInfo, '--quiet 的 mock 子进程应已退出');
    });
  } finally {
    await mock.stop();
    assert.ok(mock.exitInfo, 'mock-onebot 子进程应已退出');
  }
});
