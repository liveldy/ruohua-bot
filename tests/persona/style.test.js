import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config/index.js';
import { restyle, shouldSendAsFile, splitMessages, toFileContent } from '../../src/persona/style.js';
import { charLength } from '../../src/util/text.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function testConfig(overrides) {
  return loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: '10001' }, overrides });
}

const config = testConfig();
const persona = config.persona;

test('restyle 去 Markdown 并把标点规整成聊天语气', () => {
  const input = ['## 结果', '', '- **第一项**：做完了。', '- 第二项：还没。', '', '`代码` 也贴了。'].join('\n');
  const out = restyle(input, { persona });
  assert.ok(!out.includes('#'), `不该留标题记号：${out}`);
  assert.ok(!out.includes('*'), `不该留加粗记号：${out}`);
  assert.ok(!out.includes('：'), `冒号应降级成逗号：${out}`);
  assert.ok(!out.includes('：' && '；'));
  assert.ok(!/^-/m.test(out), `不该留列表符号：${out}`);
  assert.ok(!out.endsWith('。'), `结尾不该有句号：${out}`);
  assert.ok(out.includes('第一项'), `内容应保留：${out}`);
  assert.ok(out.includes('第二项'), `内容应保留：${out}`);
});

test('restyle 删禁语但只删短语本身，不吞整句', () => {
  // 这条只验「删短语、不吞整句」的机制，用自带禁语表，不依赖 config/persona.json 里到底列了哪些词
  // （「我无法」这类否定短语不在出厂禁语表里：删掉它会把意思说反）
  const forbiddenPersona = { ...persona, style: { ...persona.style, forbidden: ['作为一个AI', '我无法'] } };
  const out = restyle('作为一个AI，我无法帮你写这个脚本。', { persona: forbiddenPersona });
  assert.ok(!out.includes('作为一个AI'), out);
  assert.ok(!out.includes('我无法'), out);
  assert.ok(out.includes('帮你写这个脚本'), `正文应留下：${out}`);
  assert.ok(!out.startsWith('，'), `悬空逗号要去掉：${out}`);
});

test('restyle 整行只有禁语时整行删掉', () => {
  const out = restyle('有什么可以帮到你', { persona });
  assert.equal(out, '');
});

test('restyle 去掉 emoji 与颜文字，正常括号里的内容不丢', () => {
  const out = restyle('好耶😊！(＾▽＾)\n（明天开会）记得来', { persona });
  assert.ok(!out.includes('😊'), out);
  assert.ok(!out.includes('▽'), out);
  assert.ok(out.includes('好耶'), out);
  // 配置里 avoid 含「（）」，所以括号被去掉，但内容要留住
  assert.ok(out.includes('明天开会'), `括号内容应保留：${out}`);
  assert.ok(!out.includes('（'), `括号按人设 avoid 去掉：${out}`);
});

test('restyle 去掉多余空行与残留列表符号', () => {
  const out = restyle('甲\n\n\n\n乙\n\n・ 丙\n1. 丁', { persona });
  assert.ok(!/\n{3,}/.test(out), out);
  assert.ok(out.includes('甲'));
  assert.ok(!out.includes('・'));
  assert.ok(!/^1\./.test(out));
  assert.ok(out.includes('丙'));
  assert.ok(out.includes('丁'));
});

test('restyle 遇到空输入返回空串', () => {
  assert.equal(restyle('', { persona }), '');
  assert.equal(restyle('   \n  ', { persona }), '');
});

test('splitMessages 尊重空行分段，不合并', () => {
  const out = splitMessages('第一段的话\n\n第二段的话', { persona });
  assert.deepEqual(out, ['第一段的话', '第二段的话']);
});

test('splitMessages 长句会被切开且不超 maxChars', () => {
  const long = '我今天下午先去公司开个会，然后回来把那个脚本重新跑一遍，最后再把结果整理成文档发给你。';
  const out = splitMessages(long, { persona });
  assert.ok(out.length > 1, `长句应切开：${JSON.stringify(out)}`);
  for (const item of out) {
    assert.ok(charLength(item) <= persona.style.segments.maxChars, `超长：${item}`);
  }
  const joined = out.join('').replace(/\s/g, '');
  assert.equal(joined, long.replace(/\s/g, ''), '切开不能丢内容');
});

test('splitMessages 不超 maxSegments，多出来的并进最后一条而不是丢掉', () => {
  const text = '一句。二句。三句。四句。五句。六句。七句。八句。';
  const out = splitMessages(text, { persona });
  assert.ok(out.length <= persona.style.segments.maxSegments, JSON.stringify(out));
  const joined = out.join('').replace(/\s/g, '');
  assert.equal(joined, '一句。二句。三句。四句。五句。六句。七句。八句。');
});

test('splitMessages 随情绪变少、变碎', () => {
  const sentences = Array.from({ length: 6 }, (_, i) => `这是第${i + 1}句话，我特意写得长一点点好凑够长度。`);
  const text = sentences.join('');
  const calm = splitMessages(text, { persona, emotion: null });
  const angry = splitMessages(text, { persona, emotion: { mood: '生气', hints: { maxSegments: 2 } } });
  const happy = splitMessages(text, { persona, emotion: { mood: '开心', hints: { maxSegments: 6 } } });
  assert.equal(calm.length, persona.style.segments.maxSegments, JSON.stringify(calm));
  assert.equal(angry.length, 2, JSON.stringify(angry));
  assert.equal(happy.length, 6, JSON.stringify(happy));
  for (const [label, list] of [['calm', calm], ['angry', angry], ['happy', happy]]) {
    assert.equal(list.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), `${label} 合并不丢内容`);
  }
  assert.ok(angry[0].length > happy[0].length, '生气时更碎：每条更长、条数更少');
});

test('splitMessages 超上限时并进最后一两条，且不堆成一大坨', () => {
  const sentences = Array.from({ length: 6 }, (_, i) => `这是第${i + 1}句话，我特意写得长一点点好凑够长度。`);
  const text = sentences.join('');
  const out = splitMessages(text, { persona, emotion: { hints: { maxSegments: 3 } } });
  assert.equal(out.length, 3, JSON.stringify(out));
  assert.equal(out.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '合并不丢内容');
  assert.equal(out[0], sentences[0]);
  assert.ok(out[1].includes('这是第3句话'));
  assert.ok(out[2].includes('这是第6句话'));
  assert.ok(out[2].length < text.length / 2, '不该把所有内容堆在最后一条');
});

test('splitMessages 空行分段与超上限同时存在时，段内合并、段间不合并', () => {
  const sentences = Array.from({ length: 4 }, (_, i) => `这是第${i + 1}句话，我特意写得长一点点凑长度。`);
  const text = `${sentences.slice(0, 3).join('')}\n\n${sentences[3]}`;
  const out = splitMessages(text, { persona, emotion: { hints: { maxSegments: 2 } } });
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.ok(out[0].includes('这是第1句话') && out[0].includes('这是第3句话'), JSON.stringify(out));
  assert.equal(out[1], sentences[3], '空行后面的段落要原样独立');
});

test('splitMessages maxSegments 为 1 时并成一条', () => {
  const out = splitMessages('甲。乙。丙。', { persona, emotion: { hints: { maxSegments: 1 } } });
  assert.equal(out.length, 1);
  assert.equal(out[0].replace(/\s/g, ''), '甲。乙。丙。');
});

test('splitMessages 空输入返回空数组', () => {
  assert.deepEqual(splitMessages('', { persona }), []);
  assert.deepEqual(splitMessages('\n\n', { persona }), []);
});

test('shouldSendAsFile 按阈值判断长文本', () => {
  assert.equal(shouldSendAsFile('短消息', { persona }), false);
  const long = '字'.repeat(persona.style.maxCharsBeforeFile + 1);
  assert.equal(shouldSendAsFile(long, { persona }), true);
  assert.equal(shouldSendAsFile(long.replace('字', 'a'), { persona: { style: { maxCharsBeforeFile: 10 } } }), true);
});

test('toFileContent 带标题与时间戳并保留 Markdown', () => {
  const body = '# 分析\n\n- **要点**：都在';
  const out = toFileContent(body, { title: '任务结果', at: new Date(2026, 9, 26, 17, 42, 8).getTime() });
  assert.ok(out.startsWith('# 任务结果'), out);
  assert.ok(out.includes('2026-10-26 17:42:08'), out);
  assert.ok(out.includes('- **要点**：都在'), '正文的 Markdown 要保留');
  assert.ok(out.endsWith('\n'));
});
