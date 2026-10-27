import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config/index.js';
import { expressionPreference, pickExpression, resolveEmoji } from '../../src/persona/expressions.js';
import { seededRandom } from '../../src/util/common.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const config = loadConfig({ rootDir: ROOT, env: { ADMIN_QQ: '10001' } });
const persona = config.persona;

/** 本文件建过的临时目录，跑完统一删掉，别在 %TEMP% 里留一地。 */
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
  TEMP_DIRS.length = 0;
});

function makeStickerDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruohua-stickers-'));
  TEMP_DIRS.push(dir);
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  return dir;
}

test('resolveEmoji 把 emoji 换成 QQ 表情 id 并从文本里去掉', () => {
  const { text, faces } = resolveEmoji('好开心😊，谢谢你啦😂', persona);
  assert.deepEqual(faces, [14, 5]);
  assert.ok(!text.includes('😊') && !text.includes('😂'), text);
  assert.ok(text.includes('好开心') && text.includes('谢谢你啦'), text);
});

test('resolveEmoji 处理带变体选择符的 emoji（❤️）', () => {
  const { text, faces } = resolveEmoji('谢谢你❤️', persona);
  assert.deepEqual(faces, [66]);
  assert.ok(!text.includes('❤'), text);
  assert.ok(text.includes('谢谢你'), text);
});

test('resolveEmoji 把颜文字换成表情 id', () => {
  const { text, faces } = resolveEmoji('(＾▽＾) 我在的', persona);
  assert.deepEqual(faces, [14]);
  assert.ok(!text.includes('▽'), text);
  assert.ok(text.includes('我在的'), text);
});

test('resolveEmoji 没有映射的 emoji 也去掉，不留字符', () => {
  const { text, faces } = resolveEmoji('走了🦄', persona);
  assert.deepEqual(faces, []);
  assert.equal(text, '走了');
});

test('resolveEmoji 不误删中文括号里的内容', () => {
  const { text, faces } = resolveEmoji('（明天开会）记得带上笔记本', persona);
  assert.deepEqual(faces, []);
  assert.ok(text.includes('明天开会'), text);
  assert.ok(text.includes('记得带上笔记本'), text);
});

test('expressionPreference 按 preferred 排序', () => {
  assert.deepEqual(expressionPreference(persona, null), persona.expressions.preferred);
});

test('expressionPreference 生气时冷落笑脸、抬出别的表情', () => {
  const list = expressionPreference(persona, { mood: '生气' });
  assert.ok(list.includes(11), JSON.stringify(list));
  assert.ok(list.indexOf(11) < list.indexOf(14), '生气的表情应排在笑脸前面');
  assert.ok(list.indexOf(13) < list.indexOf(14));
});

test('expressionPreference 开心时笑脸排最前', () => {
  const list = expressionPreference(persona, { mood: '开心' });
  assert.equal(list[0], 14);
  assert.equal(new Set(list).size, list.length, '不应有重复');
  assert.deepEqual(expressionPreference(persona, { mood: '平静' }), persona.expressions.preferred);
});

test('pickExpression 在固定 rng 下可复现', () => {
  const draw = () => {
    const rng = seededRandom(20261026);
    return Array.from({ length: 5 }, () => pickExpression({ persona, emotion: null, rng }));
  };
  assert.deepEqual(draw(), draw());
});

test('pickExpression 概率区间：低落时几乎挑不中表情包，平静时会挑中', () => {
  const dir = makeStickerDir(['a.png', 'b.gif', 'note.txt']);
  const calm = pickExpression({ persona, emotion: null, rng: () => 0.05, stickerDir: dir });
  assert.equal(calm?.type, 'sticker', JSON.stringify(calm));
  assert.ok(calm.file.endsWith('.png') || calm.file.endsWith('.gif'), calm.file);

  const angry = pickExpression({ persona, emotion: { mood: '生气' }, rng: () => 0.05, stickerDir: dir });
  assert.equal(angry?.type, 'face', JSON.stringify(angry));
});

test('pickExpression 表情包目录为空或不存在时退回表情或 null', () => {
  const empty = makeStickerDir([]);
  const missing = path.join(os.tmpdir(), 'ruohua-not-exists-dir-xyz');
  for (const dir of [empty, missing]) {
    const result = pickExpression({ persona, emotion: null, rng: () => 0.05, stickerDir: dir });
    assert.equal(result?.type, 'face', JSON.stringify(result));
  }
  const none = pickExpression({ persona, emotion: null, rng: () => 0.99, stickerDir: missing });
  assert.equal(none, null);
});

function seqRng(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

test('pickExpression 连续相同会被限制', () => {
  const first = pickExpression({ persona, emotion: null, rng: seqRng([0.4, 0]) }); // 0.4 落表情区间，0 选偏好第一位
  assert.equal(first.type, 'face');
  assert.equal(first.id, 14);
  const repeated = pickExpression({
    persona,
    emotion: null,
    rng: seqRng([0.4, 0]),
    context: { recentFaces: [14, 14, 14] },
  });
  assert.equal(repeated.type, 'face');
  assert.notEqual(repeated.id, 14, '连发三次同一个表情后不该再挑它');

  const dir = makeStickerDir(['a.png', 'b.png']);
  const plain = pickExpression({ persona, emotion: null, stickerDir: dir, rng: seqRng([0.01, 0]) });
  assert.equal(plain?.type, 'sticker');
  assert.equal(path.basename(plain.file), 'a.png');
  const afterSame = pickExpression({
    persona,
    emotion: null,
    stickerDir: dir,
    rng: seqRng([0.01, 0]),
    context: { recentStickers: [plain.file, plain.file, plain.file] },
  });
  assert.equal(path.basename(afterSame.file), 'b.png', '连发三次同一个表情包后换一个');
});

test('pickExpression 用 config.stickerDir 找表情包', () => {
  const dir = makeStickerDir(['one.png']);
  const result = pickExpression({ persona, emotion: null, rng: () => 0.01, config: { ...config, stickerDir: dir } });
  assert.equal(result?.type, 'sticker');
  assert.equal(result.file, path.join(dir, 'one.png'));
});

test('pickExpression 用 hints.stickerChance 覆盖基础概率', () => {
  const dir = makeStickerDir(['one.png']);
  const noSticker = pickExpression({
    persona,
    emotion: { mood: '平静', hints: { stickerChance: 0 } },
    rng: () => 0.0,
    stickerDir: dir,
  });
  assert.equal(noSticker?.type, 'face', JSON.stringify(noSticker));
});

test('pickExpression 没有可用表情配置时返回 null', () => {
  const result = pickExpression({ persona: { expressions: { preferred: [] } }, emotion: null, rng: () => 0.4 });
  assert.equal(result, null);
});
