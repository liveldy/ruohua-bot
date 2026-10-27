/** 地基单元测试：配置、文本工具、时间工具、消息段、决策规则。 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { ConfigError, loadConfig, loadEnvFile } from '../../src/config/index.js';
import { charLength, chunkByLength, normalizePunctuation, splitSentences, stripMarkdown } from '../../src/util/text.js';
import { formatDuration, inQuietHours, nextRunAt, parseDuration, parseTimeSpec } from '../../src/util/time.js';
import { extractImages, extractText, hasAt, normalizeMessage, segmentsToPlain, toMessageContent } from '../../src/onebot/segments.js';
import { matchCommand, quickDecide } from '../../src/brain/decision.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  TEMP_DIRS.length = 0;
});

test('配置装载：默认值 + env 覆盖', async () => {
  const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: '10001,10002', MODEL_API_KEY: 'k' }, useEnvFile: false });
  assert.deepEqual(config.security.admins, [10001, 10002]);
  assert.equal(config.model.apiKey, 'k');
  assert.equal(config.bot.onebot.mode, 'forward');
  assert.equal(config.dataDir, path.join(ROOT, 'data'));
  assert.ok(config.memory.recall.topK > 0);
});

test('配置装载：缺管理员时抛 ConfigError', async () => {
  assert.throws(() => loadConfig({ rootDir: ROOT, env: {}, useEnvFile: false }), (error) => {
    assert.equal(error.name, 'ConfigError');
    assert.ok(error.problems.some((item) => item.includes('admins')));
    return true;
  });
});

test('配置装载：测试覆盖（overrides）能改任意字段', () => {
  const config = loadConfig({
    rootDir: ROOT,
    env: { ADMIN_QQ: '10001' },
    useEnvFile: false,
    overrides: { bot: { behavior: { groupRequireAt: false } }, memory: { recall: { topK: 3 } } },
  });
  assert.equal(config.bot.behavior.groupRequireAt, false);
  assert.equal(config.memory.recall.topK, 3);
  // 未覆盖的字段保留
  assert.equal(config.bot.behavior.privateAutoReply, true);
});

test('.env 解析：注释、引号、空行', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruohua-env-'));
  TEMP_DIRS.push(dir);
  const file = path.join(dir, '.env');
  await fs.writeFile(file, '# 注释\nA=1\nB="two words"\n\nC=\'three\'\nD=\n', 'utf8');
  const env = loadEnvFile(file);
  assert.equal(env.A, '1');
  assert.equal(env.B, 'two words');
  assert.equal(env.C, 'three');
  assert.equal(env.D, '');
  assert.deepEqual(loadEnvFile(path.join(dir, 'nope.env')), {});
});

test('文本：去 Markdown', () => {
  const source = '# 标题\n\n**加粗**和*斜体*，还有 `代码`\n\n- 列表项\n\n> 引用\n\n[链接](http://a.b)\n';
  const out = stripMarkdown(source);
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('**'));
  assert.ok(!out.includes('`'));
  assert.ok(out.includes('加粗'));
  assert.ok(out.includes('列表项'));
  assert.ok(out.includes('链接'));
});

test('文本：标点规整（分号降级、去尾句号）', () => {
  assert.equal(normalizePunctuation('今天有事；明天再说。'), '今天有事，明天再说');
  assert.equal(normalizePunctuation('好的！！！！！'), '好的！！');
  assert.equal(normalizePunctuation('嗯。。。'), '嗯');
});

test('文本：切句与长度计量', () => {
  assert.deepEqual(splitSentences('我来了。你走吗？'), ['我来了。', '你走吗？']);
  assert.equal(charLength('你好 world'), 3); // 两个汉字 + 一个英文词
  assert.ok(chunkByLength('一二三四五六七八九十', 4).every((chunk) => chunk.length <= 4));
});

test('时间：时长解析与调度描述', () => {
  assert.equal(parseDuration('30m'), 30 * 60 * 1000);
  assert.equal(parseDuration('2小时'), 2 * 3600 * 1000);
  const now = new Date('2026-10-26T10:00:00').getTime();
  assert.deepEqual(parseTimeSpec('+30m', now), { type: 'once', at: now + 30 * 60 * 1000, everyMs: 30 * 60 * 1000 });
  assert.deepEqual(parseTimeSpec('每天08:00', now), { type: 'daily', time: '08:00' });
  assert.equal(parseTimeSpec('胡说八道', now), null);
  const daily = parseTimeSpec('每天08:00', now);
  assert.equal(nextRunAt(daily, now), new Date('2026-10-27T08:00:00').getTime());
  assert.equal(formatDuration(3680000), '1小时1分钟');
  assert.equal(inQuietHours(['23:30', '07:30'], new Date('2026-10-26T02:00:00').getTime()), true);
  assert.equal(inQuietHours(['23:30', '07:30'], new Date('2026-10-26T12:00:00').getTime()), false);
});

test('消息段：解析群聊消息（数组格式）', () => {
  const message = normalizeMessage({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 42,
    self_id: 10000,
    user_id: 20001,
    group_id: 30001,
    time: 1761000000,
    sender: { user_id: 20001, nickname: '小明', card: '小明同学', role: 'member' },
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 在吗' } },
      { type: 'image', data: { file: 'abc.jpg', url: 'http://x/y.jpg' } },
      { type: 'face', data: { id: '14' } },
    ],
  });
  assert.equal(message.scene, 'group');
  assert.equal(message.groupId, 30001);
  assert.equal(message.userId, 20001);
  assert.equal(message.isAt, true);
  assert.equal(extractText(message.segments), ' 在吗');
  assert.equal(extractImages(message.segments).length, 1);
  assert.equal(message.display, '@10000 在吗[图片][表情14]');
});

test('消息段：解析 CQ 码字符串格式与私聊', () => {
  const message = normalizeMessage({
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    self_id: 10000,
    user_id: 20002,
    time: 1761000000,
    sender: { user_id: 20002, nickname: '小红' },
    raw_message: '看看[CQ:image,file=x.png][CQ:face,id=5]这个',
  });
  assert.equal(message.scene, 'private');
  assert.equal(message.groupId, null);
  assert.equal(message.text, '看看这个');
  assert.equal(message.images.length, 1);
  assert.equal(message.faces[0], '5');
  assert.equal(hasAt(message.segments, 10000), false);
});

test('消息段：构造发送内容', () => {
  const segments = toMessageContent('你好', { replyTo: 7 });
  assert.deepEqual(segments, [
    { type: 'reply', data: { id: '7' } },
    { type: 'text', data: { text: '你好' } },
  ]);
  assert.equal(segmentsToPlain(segments), '[回复]你好');
});

test('决策：斜杠指令与短句闲聊走快路径', () => {
  assert.equal(matchCommand('/状态')?.name, 'status');
  assert.equal(matchCommand('/stop')?.name, 'stop');
  assert.equal(matchCommand('普通聊天'), null);
  const command = quickDecide({ message: { text: '/任务' }, user: { role: 'owner' } });
  assert.equal(command.mode, 'command');
  const chat = quickDecide({ message: { text: '在吗' }, user: { role: 'member' } });
  assert.equal(chat.mode, 'chat');
  // 长句/带活儿的句子不做快路径判定，交给模型
  assert.equal(quickDecide({ message: { text: '帮我整理一下桌面上所有关于这个项目的资料并写个总结' }, user: { role: 'owner' } }), null);
});
