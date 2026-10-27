/** 命令别名：带「/」的照旧（可跟参数），去掉「/」的裸词只认整条消息正好等于它，绝不做包含匹配。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchCommand, quickDecide } from '../../src/brain/decision.js';

test('裸词命令：整条消息正好是别名才算命中', () => {
  assert.equal(matchCommand('自检')?.name, 'selfcheck');
  assert.equal(matchCommand('  自检  ')?.name, 'selfcheck', '前后空白不算内容');
  assert.equal(matchCommand('状态')?.name, 'status');
  assert.equal(matchCommand('别做了')?.name, 'stop');
  assert.equal(matchCommand('帮助')?.name, 'help');
});

test('裸词命令不做包含匹配：日常说话不会被当成命令', () => {
  assert.equal(matchCommand('我现在的状态不太好'), null);
  assert.equal(matchCommand('帮我看看状态'), null);
  assert.equal(matchCommand('自检一下'), null, '多出来的字就不算命令了');
  assert.equal(matchCommand('任务怎么办'), null);
  assert.equal(matchCommand('你还在吗'), null);
});

test('带 / 的命令照旧，后面可以跟参数', () => {
  assert.deepEqual(matchCommand('/状态'), { name: 'status', args: '', raw: '/状态' });
  assert.equal(matchCommand('/记住 明天买牛奶')?.name, 'remember');
  assert.equal(matchCommand('/记住 明天买牛奶')?.args, '明天买牛奶');
  assert.equal(matchCommand('/schedule 每天08:00 提醒我喝水')?.args, '每天08:00 提醒我喝水');
});

test('quickDecide 认得裸词命令，日常说话仍然交给模型判', () => {
  const user = { userId: 10001, role: 'owner' };

  const command = quickDecide({ message: { display: '自检', text: '自检' }, user });
  assert.equal(command?.mode, 'command', `裸词「自检」该走命令：${JSON.stringify(command)}`);
  assert.equal(command.command.name, 'selfcheck');

  const chat = quickDecide({ message: { display: '我现在的状态不太好', text: '我现在的状态不太好' }, user });
  assert.notEqual(chat?.mode, 'command', `日常说话不是命令：${JSON.stringify(chat)}`);
});
