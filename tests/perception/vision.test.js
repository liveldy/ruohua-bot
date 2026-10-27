/** 视觉服务：无视觉模型时给人话而不是抛错；识图/看屏幕/转写都走降级。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createVisionService, NO_VISION_TEXT, noVisionText } from '../../src/perception/vision.js';
import { makeConfig, makeLogger } from './helpers.js';

function makeLlm({ enabled = true, answer = '图里是一只猫', error = null, mainModel = null } = {}) {
  const calls = [];
  return {
    calls,
    visionModelName: enabled ? 'test-vision' : null,
    visionTargetName: enabled ? 'test-vision' : mainModel,
    async vision({ prompt, images }) {
      calls.push({ prompt, images });
      if (error) throw error;
      return answer;
    },
  };
}

const fakeScreen = (result) => ({ capture: async () => result, lastPath: result?.path ?? null });

test('没有视觉模型时返回一句中文说明，不抛错', async () => {
  const llm = makeLlm({ enabled: false });
  const vision = createVisionService({ llm, sidecar: null, logger: makeLogger(), config: makeConfig() });

  const text = await vision.describeImages({ images: [{ url: 'http://x/1.png' }], userId: 42 });
  assert.equal(text, NO_VISION_TEXT);
  assert.equal(llm.calls.length, 0, '没有视觉模型就不该去调模型');
  assert.equal(vision.visionEnabled, false);
});

test('llm.vision 抛 vision_unsupported 时同样返回说明文字', async () => {
  const llm = makeLlm({ error: Object.assign(new Error('未配置视觉模型'), { code: 'vision_unsupported' }) });
  const vision = createVisionService({ llm, sidecar: null, logger: makeLogger(), config: makeConfig() });
  assert.equal(await vision.describeImages({ images: ['http://x/1.png'] }), NO_VISION_TEXT);
});

test('识图失败（其他错误）也不抛错，返回可读文字，并留一句「怎么修」', async () => {
  const llm = makeLlm({ error: new Error('上游 500') });
  const logger = makeLogger();
  const vision = createVisionService({ llm, sidecar: null, logger, config: makeConfig() });
  const text = await vision.describeImages({ images: ['http://x/1.png'], userId: 7 });
  assert.equal(typeof text, 'string');
  assert.match(text, /出了点问题/);
  assert.equal(logger.records.warn.length, 2, '一条失败、一条怎么办');
  assert.match(logger.records.warn[0], /上游 500/);
  assert.match(logger.records.warn[1], /visionModel/);

  // 怎么修这句只提醒一次，别把日志刷满
  await vision.describeImages({ images: ['http://x/2.png'] });
  assert.equal(logger.records.warn.length, 3);
});

test('图本身读不到（ENOENT）时提示指向文件，不是「换个能看图的模型」', async () => {
  const logger = makeLogger();
  const vision = createVisionService({
    llm: makeLlm({ error: new Error("ENOENT: no such file or directory, open 'D:\\Desktop\\RuoHua_Bot\\3147A15D.jpg'") }),
    sidecar: null,
    logger,
    config: makeConfig(),
  });

  const text = await vision.describeImages({ images: [{ path: 'D:\\Desktop\\RuoHua_Bot\\3147A15D.jpg' }] });
  assert.equal(typeof text, 'string');
  assert.equal(logger.records.warn.length, 2, '一条失败、一条怎么办');
  assert.match(logger.records.warn[1], /读不到/, '要说清是图读不到');
  assert.match(logger.records.warn[1], /跟模型没关系/, '要明说这不是模型的锅');
  assert.equal(
    /把 config\/model\.json 的 visionModel 指到/.test(logger.records.warn[1]),
    false,
    '别给「换个能看图的模型」那条建议',
  );

  // 「读不到」与「模型不支持图片」各提醒一次，互不顶替
  await vision.describeImages({ images: ['http://x/2.png'] });
  assert.equal(logger.records.warn.length, 3);
  const vision2 = createVisionService({ llm: makeLlm({ error: new Error('上游 500') }), sidecar: null, logger, config: makeConfig() });
  await vision2.describeImages({ images: ['http://x/3.png'] });
  assert.match(logger.records.warn.at(-1), /visionModel/, '模型类的失败还是要提醒看模型');
});

test('没单独配 visionModel 就用主模型识图（DeepSeek 这类模型自己能看图）', async () => {
  const llm = makeLlm({ enabled: false, mainModel: 'deepseek-chat', answer: '一张笑脸。' });
  const vision = createVisionService({ llm, sidecar: null, logger: makeLogger(), config: makeConfig() });

  assert.equal(vision.visionEnabled, true, '主模型也算「能看图」');
  assert.equal(await vision.describeImages({ images: ['http://x/1.png'] }), '一张笑脸。');
  assert.equal(llm.calls.length, 1);
  assert.equal(noVisionText(), NO_VISION_TEXT, '常量与函数取的是同一条文字');
  assert.match(noVisionText(), /看不到图/);
});

test('有视觉模型时把 http url 和本地路径一起交给模型', async () => {
  const llm = makeLlm({ answer: '一只猫躺在键盘上。' });
  const vision = createVisionService({ llm, sidecar: null, logger: makeLogger(), config: makeConfig() });

  const text = await vision.describeImages({
    images: [{ url: 'http://x/a.png' }, { path: 'C:\\tmp\\b.bmp' }, '/tmp/c.jpg'],
    prompt: '这是什么',
  });
  assert.equal(text, '一只猫躺在键盘上。');
  assert.deepEqual(llm.calls[0].images, ['http://x/a.png', 'C:\\tmp\\b.bmp', '/tmp/c.jpg']);
  assert.equal(llm.calls[0].prompt, '这是什么');
});

test('一条图片都没有时说明原因，不调模型', async () => {
  const llm = makeLlm({});
  const vision = createVisionService({ llm, sidecar: null, logger: makeLogger(), config: makeConfig() });
  assert.match(await vision.describeImages({ images: [] }), /没收到图片/);
  assert.equal(llm.calls.length, 0);
});

test('模型答了个空字符串也有话回', async () => {
  const llm = makeLlm({ answer: '   ' });
  const vision = createVisionService({ llm, sidecar: null, logger: makeLogger(), config: makeConfig() });
  assert.match(await vision.describeImages({ images: ['a.png'] }), /没看出/);
});

test('seeScreen：截图成功后把截图丢给视觉模型', async () => {
  const llm = makeLlm({ answer: '屏幕上开着编辑器。' });
  const vision = createVisionService({
    llm,
    sidecar: null,
    logger: makeLogger(),
    config: makeConfig(),
    screen: fakeScreen({ path: 'C:\\tmp\\screen.bmp', width: 1920, height: 1080, via: 'sidecar' }),
  });
  const text = await vision.seeScreen({ prompt: '看看屏幕' });
  assert.equal(text, '屏幕上开着编辑器。');
  assert.deepEqual(llm.calls[0].images, ['C:\\tmp\\screen.bmp']);
  assert.equal(llm.calls[0].prompt, '看看屏幕');
});

test('seeScreen：截图失败返回说明文字，不抛错', async () => {
  const llm = makeLlm({});
  const vision = createVisionService({
    llm,
    sidecar: null,
    logger: makeLogger(),
    config: makeConfig(),
    screen: fakeScreen(null),
  });
  const text = await vision.seeScreen();
  assert.match(text, /截不了屏/);
  assert.equal(llm.calls.length, 0);
});

test('transcribe 走侧车；不可用时返回 null', async () => {
  const asrCalls = [];
  const sidecar = { asr: async (file) => { asrCalls.push(file); return ' 你好呀 '; } };
  const vision = createVisionService({ llm: makeLlm({}), sidecar, logger: makeLogger(), config: makeConfig() });
  assert.equal(await vision.transcribe({ file: 'C:\\tmp\\a.wav' }), '你好呀');
  assert.deepEqual(asrCalls, ['C:\\tmp\\a.wav']);

  const silent = createVisionService({ llm: null, sidecar: { asr: async () => null }, logger: makeLogger(), config: makeConfig() });
  assert.equal(await silent.transcribe({ file: 'a.wav' }), null);

  const none = createVisionService({ llm: null, sidecar: null, logger: makeLogger(), config: makeConfig() });
  assert.equal(await none.transcribe({ file: 'a.wav' }), null);
  assert.equal(await none.transcribe({}), null);
});
