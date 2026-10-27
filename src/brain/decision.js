/**
 * 决策：这条消息该怎么处理。
 *   command —— 明确的指令（/状态、/任务、/停止、/忘了……）
 *   chat    —— 闲聊，直接回话
 *   work    —— 传统工作模式：说一步做一步，做完就结束
 *   agent   —— agent 工作模式：给个目标，自己拆步骤、调工具、看结果、再决定
 *
 * 先走便宜的规则快路径（短句闲聊、斜杠指令），剩下的交给一次轻量模型判定。
 */

import { charLength } from '../util/text.js';
import { describeQuoted } from '../onebot/segments.js';
import { t } from '../i18n/index.js';

// 关键词表整段放一个键、用 \n 分行（见 docs/I18N.md 第 3 节）
const AGENT_HINTS = t('brain.decision.agentHints').split('\n');

const WORK_HINTS = t('brain.decision.workHints').split('\n');

// 命令别名：中文别名按命令一条键，一行一个
const COMMAND_ALIASES = {
  status: t('brain.decision.command.status').split('\n'),
  tasks: t('brain.decision.command.tasks').split('\n'),
  stop: t('brain.decision.command.stop').split('\n'),
  forget: t('brain.decision.command.forget').split('\n'),
  help: t('brain.decision.command.help').split('\n'),
  selfcheck: t('brain.decision.command.selfcheck').split('\n'),
  remember: t('brain.decision.command.remember').split('\n'),
  schedule: t('brain.decision.command.schedule').split('\n'),
  reset: t('brain.decision.command.reset').split('\n'),
};

const SLASH_ALIAS = /^\//;

const COMMANDS = [
  { name: 'status', aliases: aliasForms('/status', ...COMMAND_ALIASES.status) },
  { name: 'tasks', aliases: aliasForms('/tasks', ...COMMAND_ALIASES.tasks) },
  { name: 'stop', aliases: aliasForms('/stop', ...COMMAND_ALIASES.stop) },
  { name: 'forget', aliases: aliasForms('/forget', ...COMMAND_ALIASES.forget) },
  { name: 'help', aliases: aliasForms('/help', ...COMMAND_ALIASES.help) },
  { name: 'selfcheck', aliases: aliasForms('/selfcheck', ...COMMAND_ALIASES.selfcheck) },
  { name: 'remember', aliases: aliasForms('/remember', ...COMMAND_ALIASES.remember) },
  { name: 'schedule', aliases: aliasForms('/schedule', ...COMMAND_ALIASES.schedule) },
  { name: 'reset', aliases: aliasForms('/reset', ...COMMAND_ALIASES.reset) },
];

/**
 * 别名集：带「/」的照旧（后面可以跟参数），去掉「/」的裸词只认整条消息正好等于它。
 * 裸词绝不做包含匹配——「我现在的状态不太好」不是命令。
 */
export function aliasForms(...aliases) {
  const out = [];
  for (const raw of aliases) {
    const alias = String(raw ?? '').trim();
    if (!alias || out.includes(alias)) continue;
    out.push(alias);
    if (!SLASH_ALIAS.test(alias)) continue;
    const bare = alias.replace(SLASH_ALIAS, '').trim();
    if (bare && !out.includes(bare)) out.push(bare);
  }
  return out;
}

export function matchCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const [head] = raw.split(/\s+/);
  const lower = head.toLowerCase();
  for (const command of COMMANDS) {
    for (const alias of command.aliases) {
      const needle = alias.toLowerCase();
      // 裸词（没有前导「/」）：只有整条消息正好是这个词才算，避免日常说话被当成命令
      if (!SLASH_ALIAS.test(needle)) {
        if (raw.toLowerCase() === needle) return { name: command.name, args: '', raw };
        continue;
      }
      if (needle === lower) return { name: command.name, args: raw.slice(head.length).trim(), raw };
    }
  }
  return null;
}

function looksLikeQuickChat(text) {
  const length = charLength(text);
  if (length === 0) return true;
  if (length > 24) return false;
  return ![...AGENT_HINTS, ...WORK_HINTS].some((hint) => text.includes(hint));
}

/** 规则快路径；返回 null 表示要问模型。 */
export function quickDecide({ message, user }) {
  const text = String(message?.display ?? message?.text ?? '').trim();
  if (!text) {
    return {
      mode: message?.images?.length || message?.records?.length ? 'work' : 'chat',
      goal: null,
      reply: null,
      reason: 'empty_text',
      confidence: 0.5,
      tool: null,
      style: 'chat',
      sensitive: [],
    };
  }
  const command = matchCommand(text);
  if (command) {
    return { mode: 'command', command, reason: 'slash_command', confidence: 1, style: 'chat', sensitive: [], goal: null, reply: null };
  }
  if (user?.role !== 'owner' && looksLikeQuickChat(text) === false) {
    // 普通用户也可能让干活，但先交给模型判定
    return null;
  }
  if (looksLikeQuickChat(text)) {
    return { mode: 'chat', reason: 'short_quick_chat', confidence: 0.7, style: 'chat', sensitive: [], goal: null, reply: null, tool: null };
  }
  return null;
}

const DECISION_SCHEMA = t('brain.decision.schema');

export async function decide({ llm, config, message, user, scene, tools, logger, extraNote = null }) {
  const quick = quickDecide({ message, user });
  if (quick) return quick;

  const text = String(message?.display ?? message?.text ?? '').trim();
  const toolNames = tools ? [...tools.keys()] : [];
  const system = [
    t('brain.decision.system.intro'),
    t('brain.decision.system.modeChat'),
    t('brain.decision.system.modeWork'),
    t('brain.decision.system.modeAgent'),
    user?.role === 'owner' ? t('brain.decision.system.owner') : t('brain.decision.system.member'),
    scene === 'group' ? t('brain.decision.system.group') : t('brain.decision.system.private'),
    t('brain.decision.system.noFabricate'),
    toolNames.length
      ? t('brain.decision.system.tools', { names: toolNames.slice(0, 40).join('\u3001') })
      : t('brain.decision.system.noTools'),
    t('brain.decision.system.onlyJson'),
    DECISION_SCHEMA,
  ].join('\n');

  const quotedNote = describeQuoted(message?.quoted);
  const prompt = [
    message?.images?.length ? t('brain.decision.prompt.image') : null,
    message?.records?.length ? t('brain.decision.prompt.voice') : null,
    quotedNote ? t('brain.decision.prompt.quoted', { quoted: quotedNote }) : null,
    extraNote,
    t('brain.decision.prompt.userSaid', { text }),
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await llm.chat({
      role: 'decision',
      json: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = result.json ?? safeParse(result.content);
    const mode = ['chat', 'work', 'agent'].includes(parsed?.mode) ? parsed.mode : 'chat';
    const decision = {
      mode,
      goal: parsed?.goal ? String(parsed.goal) : mode === 'chat' ? null : text,
      style: parsed?.style === 'work' ? 'work' : 'chat',
      needsTools: Boolean(parsed?.needs_tools),
      sensitive: Array.isArray(parsed?.sensitive) ? parsed.sensitive.map(String) : [],
      reply: parsed?.reply ? String(parsed.reply) : null,
      confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : 0.5,
      reason: parsed?.reason ? String(parsed.reason) : 'llm_judge',
      tool: null,
    };
    if (mode === 'chat' && !decision.reply) decision.mode = 'chat';
    return decision;
  } catch (error) {
    logger?.warn?.(t('brain.decision.failed'), error);
    return {
      mode: 'chat',
      goal: null,
      style: 'chat',
      needsTools: false,
      sensitive: [],
      reply: null,
      confidence: 0.3,
      reason: 'decision_failed',
      tool: null,
    };
  }
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export { AGENT_HINTS, WORK_HINTS, COMMANDS };
