/** 回复流水线：技术通道 result —— 保留换行 / 冒号 / URL / 代码缩进，长文本走文件，不带表情。 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReplyPipeline, sentExtrasNote } from '../../src/brain/reply.js';
import { loadConfig } from '../../src/config/index.js';
import { createNullLogger } from '../../src/logging/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 每个测试都要一个临时数据目录；跑完必须收走，别把 %TEMP% 塞满
const tempDirs = [];
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.allSettled(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })));
});

async function makeConfig(overrides = {}) {
  const tmp = await tempDir('ruohua-reply-');
  return loadConfig({
    rootDir: ROOT,
    useEnvFile: false,
    overrides: { bot: { dataDir: tmp }, model: { apiKey: 'test-key' }, security: { admins: [10001] }, ...overrides },
  });
}

/** 假会话：记录发出去的每条文本与上传的文件。 */
function makeChat() {
  const texts = [];
  const files = [];
  const segments = [];
  return {
    texts,
    files,
    segments,
    scene: 'private',
    userId: 10001,
    groupId: null,
    async sendTo(_target, content) {
      segments.push(content);
      texts.push(content.map((segment) => (segment.type === 'text' ? segment.data.text : `[${segment.type}]`)).join(''));
      return { message_id: texts.length };
    },
    async uploadFile({ file, name }) {
      files.push({ file, name });
      return { ok: true };
    },
  };
}

function pipelineOf(config) {
  return createReplyPipeline({ config, persona: config.persona, emotion: null, logger: createNullLogger() });
}

const WORK_RESULT = [
  '状态汇报：',
  '启动时间 18:59:07',
  '',
  '  缩进两格的说明',
  'https://example.com/a?b=1&c=2',
  '```python',
  'def f():',
  '    return 1',
  '```',
].join('\n');

test('result：保留换行、冒号、URL 与代码缩进，不做聊天式标点规整', async () => {
  const config = await makeConfig();
  const reply = pipelineOf(config);
  const chat = makeChat();

  const sent = await reply.result({ chat, text: WORK_RESULT, mode: 'work' });

  assert.equal(chat.texts.length, 1, '技术通道不切分成多条');
  const text = chat.texts[0];
  assert.ok(text.includes('\n'), '换行要保留');
  assert.ok(text.includes('状态汇报：'), `冒号要保留：${text}`);
  assert.ok(text.includes('18:59:07'), `时间里的冒号不能被规整成逗号：${text}`);
  assert.ok(!text.includes('18，59'), '标点规整不该发生');
  assert.ok(text.includes('https://example.com/a?b=1&c=2'), 'URL 不能被破坏');
  assert.ok(text.includes('    return 1'), '代码缩进要保留');
  assert.ok(!text.includes('```'), 'Markdown 围栏还是要去掉');
  assert.ok(text.includes('  缩进两格的说明'), '普通缩进也要保留');
  assert.equal(chat.segments[0].length, 1, '只发一条纯文本，不夹表情');
  assert.equal(sent.expressions, 0);
  assert.equal(sent.filePath, null);
  assert.equal(reply.state().expressions, 0);
});

test('sentExtrasNote：正文之外单独发出去的东西，要有一句话讲给上下文听', () => {
  assert.equal(sentExtrasNote([]), '', '什么都没多发就别往上下文里塞字');
  assert.equal(sentExtrasNote(null), '');
  assert.match(sentExtrasNote([{ kind: 'sticker', label: '假笑一张' }]), /假笑一张/);
  assert.match(sentExtrasNote([{ kind: 'sticker' }]), /表情包/, '没标题没含义也要说清发过一张表情包');
  assert.match(sentExtrasNote([{ kind: 'face' }]), /表情/);
  assert.match(sentExtrasNote([{ kind: 'image' }]), /贴图/);
  // 一次说了话又发了表情包：两句都要在
  const both = sentExtrasNote([{ kind: 'face' }, { kind: 'sticker', label: '得意' }]);
  assert.match(both, /表情/);
  assert.match(both, /得意/);
});

test('result：太长时走「写成文件」那条路，正文保留原文', async () => {
  const config = await makeConfig();
  const reply = pipelineOf(config);
  const chat = makeChat();
  const long = `${WORK_RESULT}\n${'补充说明'.repeat(200)}`;

  const sent = await reply.result({ chat, text: long, mode: 'agent' });

  assert.ok(sent.filePath, '长文本应该落成文件');
  assert.equal(chat.files.length, 1, '文件要被上传');
  const body = await fs.readFile(sent.filePath, 'utf8');
  assert.ok(body.startsWith('# 工作结果'), '文件正文用统一的 toFileContent 格式');
  assert.ok(body.includes('18:59:07'), '文件里保留原样的正文');
  assert.ok(body.includes('```python'), '文件里保留 Markdown 原文');
  assert.equal(chat.texts[0], '弄好了，东西有点长，写成文件给你');
  assert.equal(reply.state().files, 1);
});

test('result：短结果直接发，空文本什么都不发', async () => {
  const config = await makeConfig();
  const reply = pipelineOf(config);
  const chat = makeChat();

  const sent = await reply.result({ chat, text: '看完了，机器一切正常。', mode: 'work' });
  assert.equal(sent.sentMessages, 1);
  assert.equal(chat.texts[0], '看完了，机器一切正常。');

  const empty = await reply.result({ chat, text: '   ', mode: 'work' });
  assert.equal(empty.sentMessages, 0);
  assert.equal(chat.texts.length, 1, '空文本不该再发东西');
});

test('send 的长文本分支与 result 共用同一套文件逻辑', async () => {
  const config = await makeConfig();
  const reply = pipelineOf(config);
  const chat = makeChat();
  const long = '甲'.repeat(900);

  const viaSend = await reply.send({ chat, text: long, mode: 'agent' });
  const viaResult = await reply.result({ chat, text: long, mode: 'agent' });

  assert.ok(viaSend.filePath && viaResult.filePath);
  assert.equal(chat.files.length, 2);
  for (const filePath of [viaSend.filePath, viaResult.filePath]) {
    const body = await fs.readFile(filePath, 'utf8');
    assert.ok(body.startsWith('# 工作结果'), `${filePath} 应该用同一套格式`);
  }
  assert.equal(chat.texts[0], chat.texts[1], '文件提示语一致');
});
