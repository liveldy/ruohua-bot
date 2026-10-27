/**
 * 人设提示词：把身份、当前情绪、对这个人的亲疏、场景与任务模式拼成给模型看的系统提示。
 * 输出是中文、分小节的自然语言，不是 JSON。
 */

import { t } from '../i18n/index.js';
import { formatTime } from '../util/time.js';

const ROLE_TEXT = {
  owner: t('persona.prompt.role.owner'),
  admin: t('persona.prompt.role.admin'),
  member: t('persona.prompt.role.member'),
};

const MODE_TEXT = {
  chat: [t('persona.prompt.mode.chat.line1'), t('persona.prompt.mode.chat.line2')],
  work: [t('persona.prompt.mode.work.line1'), t('persona.prompt.mode.work.line2'), t('persona.prompt.mode.work.line3')],
  agent: [
    t('persona.prompt.mode.agent.line1'),
    t('persona.prompt.mode.agent.line2'),
    t('persona.prompt.mode.agent.line3'),
    t('persona.prompt.mode.agent.line4'),
  ],
};

const SCENE_TEXT = {
  private: [t('persona.prompt.scene.private.line1'), t('persona.prompt.scene.private.line2')],
  group: [
    t('persona.prompt.scene.group.line1'),
    t('persona.prompt.scene.group.line2'),
    t('persona.prompt.scene.group.line3'),
  ],
};

function list(items) {
  return items.filter(Boolean).map((item) => `- ${item}`).join('\n');
}

function styleSection(persona) {
  const style = persona?.style ?? {};
  const punctuation = style.punctuation ?? {};
  const catchphrases = Array.isArray(style.catchphrases) ? style.catchphrases.filter(Boolean) : [];
  const habits = Array.isArray(style.habits) ? style.habits.filter(Boolean) : [];
  const forbidden = Array.isArray(style.forbidden) ? style.forbidden.filter(Boolean) : [];
  const maxChars = Number(style.segments?.maxChars);

  const lines = [
    t('persona.prompt.style.short'),
    Number.isFinite(maxChars) && maxChars > 0
      ? t('persona.prompt.style.lengthLimit')
      : t('persona.prompt.style.lengthPlain'),
    style.noMarkdown === false
      ? t('persona.prompt.style.layoutLoose')
      : t('persona.prompt.style.layoutStrict'),
    punctuation.rule ? String(punctuation.rule) : t('persona.prompt.style.punctuation'),
    forbidden.length
      ? t('persona.prompt.style.forbidden', { list: forbidden.join('\u3001') })
      : t('persona.prompt.style.forbiddenDefault'),
    catchphrases.length ? t('persona.prompt.style.catchphrases', { list: catchphrases.join('\u3001') }) : null,
    habits.length ? t('persona.prompt.style.habits', { list: habits.join('\uFF1B') }) : null,
  ];
  return t('persona.prompt.section.style', { items: list(lines) });
}

function expressionSection(persona) {
  const expressions = persona?.expressions ?? {};
  const preferred = Array.isArray(expressions.preferred) ? expressions.preferred.filter((id) => Number.isFinite(Number(id))) : [];
  const maxSame = Number(expressions.maxConsecutiveSame);
  const lines = [
    t('persona.prompt.expression.rule'),
    preferred.length ? t('persona.prompt.expression.preferred', { list: preferred.join('\u3001') }) : null,
    t('persona.prompt.expression.usage'),
    Number.isFinite(maxSame) && maxSame > 0 ? t('persona.prompt.expression.maxSame', { max: maxSame }) : null,
    t('persona.prompt.expression.lowMood'),
  ];
  return t('persona.prompt.section.expression', { items: list(lines) });
}

/**
 * 现在的时间。真要出过事：问她「昨天是什么日期」，她只能回「查不到，我这边拿不到日期」——
 * 聊天上下文里从来没有时间，她连今天几号都不知道。时间不是记忆，是每次说话都该知道的事实。
 */
function timeSection(now) {
  const date = new Date(Number.isFinite(now) ? now : Date.now());
  const weekdays = t('common.time.weekdays');
  return t('persona.prompt.section.time', {
    items: list([
      t('persona.prompt.time.now', {
        time: formatTime(date.getTime(), { withSeconds: false }),
        weekday: weekdays.charAt(date.getDay()) || '',
      }),
      t('persona.prompt.time.hint'),
    ]),
  });
}

function moodSection(emotion, persona) {
  if (!emotion) {
    return t('persona.prompt.moodSection.calm');
  }
  const mood = emotion.mood ?? t('persona.prompt.mood.default');
  const tone = emotion.hints?.tone ?? persona?.style?.tone?.[mood] ?? null;
  const affection = Number(emotion.affection);
  const label = emotion.label ?? null;
  const gap = emotion.hints?.segmentGapMs;
  const maxSegments = Number(emotion.hints?.maxSegments);
  const replyChance = Number(emotion.hints?.replyChance);

  const lines = [
    t('persona.prompt.mood.line.mood', { mood }),
    Number.isFinite(affection)
      ? label
        ? t('persona.prompt.mood.line.affectionLabel', { value: Math.round(affection), label })
        : t('persona.prompt.mood.line.affection', { value: Math.round(affection) })
      : null,
    tone ? t('persona.prompt.mood.line.tone', { tone }) : null,
    Array.isArray(gap) && gap.length >= 2
      ? t('persona.prompt.mood.line.gap', { min: (gap[0] / 1000).toFixed(1), max: (gap[1] / 1000).toFixed(1) })
      : null,
    Number.isFinite(maxSegments) ? t('persona.prompt.mood.line.maxSegments', { max: maxSegments }) : null,
    Number.isFinite(replyChance) && replyChance < 1 ? t('persona.prompt.mood.line.replyChance') : null,
  ];
  return t('persona.prompt.section.mood', { items: list(lines) });
}

function relationSection(persona, user) {
  if (!user) return null;
  const role = user.role === 'owner' || user.role === 'admin' ? user.role : 'member';
  const roleText = ROLE_TEXT[role];
  const roleNote = persona?.roles?.[role] ?? persona?.roles?.[role === 'admin' ? 'owner' : role] ?? {};
  const name = user.nickname ? `${user.nickname}` : t('persona.prompt.relation.anonymous');
  const lines = [
    user.userId != null
      ? t('persona.prompt.relation.personWithId', { name, userId: user.userId })
      : t('persona.prompt.relation.person', { name }),
    t('persona.prompt.relation.role', { role: roleText }),
  ];
  if (roleNote.address) lines.push(t('persona.prompt.relation.address', { address: roleNote.address }));
  if (roleNote.closeness) lines.push(t('persona.prompt.relation.closeness', { closeness: roleNote.closeness }));
  return t('persona.prompt.section.relation', { items: list(lines) });
}

/** 手上有工具时加这一节：能查的就去查，别拿「我查不到」糊弄。 */
function toolSection() {
  return t('persona.prompt.section.tools', {
    items: list([
      t('persona.prompt.tool.fetchFirst'),
      t('persona.prompt.tool.noFabricate'),
      t('persona.prompt.tool.hideMechanics'),
      t('persona.prompt.tool.askBeforeHeavy'),
    ]),
  });
}

/**
 * 拼系统提示词。
 * @param {{ persona?: object, emotion?: object|null, memory?: string[], user?: object, scene?: string, mode?: string, extra?: string, tools?: boolean, now?: number }} opts
 * @returns {string}
 */
export function buildSystemPrompt({ persona, emotion, memory, user, scene, mode, extra, tools = false, now = Date.now() } = {}) {
  const p = persona ?? {};
  const name = p.name ?? t('persona.prompt.defaultName');
  const sections = [];

  const identity = [
    p.basePrompt ? String(p.basePrompt).trim() : null,
    p.identity ? t('persona.prompt.identity.identity', { identity: String(p.identity).trim() }) : null,
    p.selfReference ? t('persona.prompt.identity.selfReference', { self: p.selfReference }) : null,
    t('persona.prompt.identity.human'),
    t('persona.prompt.identity.noMeta'),
  ];
  sections.push(t('persona.prompt.section.identity', { items: list(identity) }));

  sections.push(timeSection(now));

  if (tools) sections.push(toolSection());

  sections.push(moodSection(emotion, p));

  const relation = relationSection(p, user);
  if (relation) sections.push(relation);

  const memories = (Array.isArray(memory) ? memory : []).filter((item) => typeof item === 'string' && item.trim());
  sections.push(
    memories.length
      ? t('persona.prompt.section.memory', { items: list(memories.map((item) => item.trim())) })
      : t('persona.prompt.section.memoryEmpty'),
  );

  sections.push(styleSection(p));
  sections.push(expressionSection(p));

  const sceneKey = scene === 'group' ? 'group' : scene === 'private' ? 'private' : null;
  if (sceneKey) sections.push(t('persona.prompt.section.scene', { items: list(SCENE_TEXT[sceneKey]) }));

  const modeKey = MODE_TEXT[mode] ? mode : 'chat';
  sections.push(t('persona.prompt.section.mode', { items: list(MODE_TEXT[modeKey]) }));

  sections.push(
    t('persona.prompt.section.habits', {
      items: list([
        t('persona.prompt.habit.reportFirst'),
        t('persona.prompt.habit.briefResult'),
        t('persona.prompt.habit.keepPromise'),
        t('persona.prompt.habit.askWhenUnsure'),
        t('persona.prompt.habit.speakUp'),
        t('persona.prompt.habit.chatNotDoc'),
      ]),
    }),
  );

  if (extra && String(extra).trim()) {
    sections.push(t('persona.prompt.section.extra', { items: String(extra).trim() }));
  }

  return t('persona.prompt.lead', { name, body: sections.join('\n\n') });
}
