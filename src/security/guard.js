/**
 * 安全护栏（模块三）：敏感操作两步验证 + 可疑行为告警。
 *
 * 两步验证：
 *  1. 对方必须是 config.security.admins 里的管理者，否则婉言拒绝（不摆出系统报错的口吻）。
 *  2. 口令质询：问话由她自己发挥，口令藏在话里而不是直问；答案池是配置里的多个口令。
 *     用户在下一句自然语言里答对就通过；答错超过 answerAttempts 或超过 maxAgeMinutes 即作废。
 *  3. 通过后在 minIntervalMinutes 内免验证（记录 lastPassedAt）。
 *
 * 可疑行为：关键词打分 + 可选模型判定，超过阈值时经 notify 汇报管理员（带昵称与号码），
 * 同一用户在 reportCooldownMinutes 内不重复上报。
 *
 * 原则：fail-closed —— 任何内部异常都按「拒绝」处理；口令本身绝不写进问话与日志。
 */

import { t } from '../i18n/index.js';
import { clamp } from '../util/common.js';
import { truncate } from '../util/text.js';

/** 婉言拒绝：不出现「管理员 / 权限 / 系统错误」这类生硬说法。 */
const REFUSALS = [
  t('security.guard.refusal.1'),
  t('security.guard.refusal.2'),
  t('security.guard.refusal.3'),
];

const NUDGES = [t('security.guard.nudge.1'), t('security.guard.nudge.2'), t('security.guard.nudge.3')];

const TEXTS = {
  denied: t('security.guard.text.denied'),
  expired: t('security.guard.text.expired'),
  passed: t('security.guard.text.passed'),
  weakChallenge: t('security.guard.text.weakChallenge'),
};

/** 出题模板：只提「按约定的那句说」，**不给字数、不给首字、不给任何字符级线索**。
 *  —— 真机上出过「一句 4 个字的老暗号，头一个字是「芝」…」，等于把口令废掉一半。 */
const CHALLENGE_TEMPLATES = [
  () => t('security.guard.challenge.1'),
  () => t('security.guard.challenge.2'),
  () => t('security.guard.challenge.3'),
  () => t('security.guard.challenge.4'),
  () => t('security.guard.challenge.5'),
  () => t('security.guard.challenge.6'),
];

const NOISE = /[\s\uFF0C\u3002\uFF01\uFF1F\u3001\u2026,.!?~\uFF5E"'\u201C\u201D\u2018\u2019`\uFF08\uFF09()\[\]\u3010\u3011\u300A\u300B<>:\uFF1A;\uFF1B|/\\]/g;

/** 字数线索：阿拉伯/全角数字，或「四个字」「2 个字」这类说法。 */
const LENGTH_HINT = /[0-9\uFF10-\uFF19]|[\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341\u4E24]\s*\u4E2A?\s*\u5B57/;

/** 位置线索：头一个字、开头是、第几个字、半句、后半…（真机上那句「头一个字是「芝」」就是这类）。 */
const POSITION_HINT = /\u5934\u4E00\u4E2A\u5B57|\u5934\u5B57|\u7B2C\u4E00\u4E2A\u5B57|\u9996\u5B57|\u6253\u5934|\u5F00\u5934|\u7B2C\s*[\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u53410-9\uFF10-\uFF19]+\s*\u4E2A\u5B57|\u51E0\u4E2A\u5B57|\u534A\u53E5|\u524D\u534A|\u540E\u534A|\u524D\u4E00\u534A|\u540E\u4E00\u534A|\u6700\u540E\u4E00\u4E2A\u5B57|\u7ED3\u5C3E\u662F|\u672B\u5C3E\u662F/;

/** 引号里夹着的一两个字（「芝」「芝麻」），以及带引号的整句。matchAll 要求带 g。 */
const QUOTED_FRAGMENT = /[\u300C\u300E"\u201C'\u2018]([^\u300D\u300F"\u201D'\u2019]{1,4})[\u300D\u300F"\u201D'\u2019]/g;

/**
 * 问话里有没有字符级线索：字数、位置、口令的整句或**连续两个字以上**的片段。
 * 注意**不是**「一个口令里的字都不许出现」—— 口令里的字常常是常用字
 * （「明月几时有」的「有」、「芝麻开门」的「开」），连「我这儿有个老规矩」都会被误杀；
 * 真正泄题的是「几个字」「头一个字是 X」这种结构性提示，所以按这些判。
 */
function leaksPassphraseHint(text, pool) {
  const question = String(text ?? '');
  if (!question) return false;
  if (LENGTH_HINT.test(question) || POSITION_HINT.test(question)) return true;
  const norm = normalizeForMatch(question);
  for (const item of pool) {
    const key = normalizeForMatch(item);
    if (!key) continue;
    if (norm.includes(key)) return true; // 整句口令
    for (let i = 0; i + 2 <= key.length; i += 1) {
      if (norm.includes(key.slice(i, i + 2))) return true; // 连续两个字照抄
    }
  }
  for (const match of question.matchAll(QUOTED_FRAGMENT)) {
    const inner = normalizeForMatch(match[1]);
    if (!inner) continue;
    for (const item of pool) {
      const key = normalizeForMatch(item);
      if (key && key.includes(inner)) return true; // 引号里露出了一半截口令
    }
  }
  return false;
}

function normalizeId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeForMatch(text) {
  return String(text ?? '').toLowerCase().replace(NOISE, '');
}

function messageText(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  if (typeof message === 'object') return String(message.text ?? message.content ?? '');
  return String(message);
}

function pick(list, rng) {
  if (!Array.isArray(list) || !list.length) return null;
  const index = Math.min(list.length - 1, Math.floor(rng() * list.length));
  return list[index];
}

function tryJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
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

/** 回答里是否含口令本身或其关键片段（首/尾一半），命中返回那条口令。 */
function matchPassphrase(text, pool) {
  const norm = normalizeForMatch(text);
  if (!norm) return null;
  for (const item of pool) {
    const key = normalizeForMatch(item);
    if (!key) continue;
    if (norm.includes(key)) return item;
    if (key.length >= 3) {
      const size = Math.max(2, Math.ceil(key.length / 2));
      if (norm.includes(key.slice(0, size)) || norm.includes(key.slice(-size))) return item;
    }
  }
  return null;
}

/**
 * 命令黑名单的匹配（`config.security.boundary.shell.denyPatterns`，boundary.checkCommand 会调它）：
 *  - 条目里出现 `\` `*` `+` `?` `(` `|` `[` `^` `$` 之一 → 按**正则**处理（词边界 `\b` 只能这么写）；
 *  - 其余按**原样子串**处理，且**不做 trim** —— `"format "` 末尾那个空格本身就是词边界，
 *    以前 boundary 把它 trim 掉，`format` 于是连 `wmic ... /format:list` 都拦（真机上的原案）；
 *  - 命令先转小写再比（Windows 命令大小写不敏感）。
 */
const REGEX_HINT = /[\\*+?(\[|^$]/;

/** pattern → RegExp / 判定函数，避免每条命令都重新编译。 */
const denyMatcherCache = new Map();

function toDenyMatcher(pattern) {
  const raw = String(pattern ?? '');
  if (!raw.trim()) return null;
  const cached = denyMatcherCache.get(raw);
  if (cached) return cached;
  let matcher = null;
  if (REGEX_HINT.test(raw)) {
    try {
      matcher = new RegExp(raw, 'i');
    } catch {
      matcher = null; // 正则写坏了就当这条不存在，不让它把整张表拖挂
    }
  }
  if (!matcher) {
    const literal = raw.toLowerCase();
    matcher = { test: (text) => String(text).toLowerCase().includes(literal) };
  }
  denyMatcherCache.set(raw, matcher);
  return matcher;
}

/** 命中返回那条 pattern（原样，好写进错误信息），没命中返回 null。 */
export function findDeniedPattern(command, patterns) {
  const text = String(command ?? '');
  if (!text.trim()) return null;
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const label = String(pattern ?? '').trim();
    if (!label) continue;
    const matcher = toDenyMatcher(pattern);
    if (matcher?.test(text)) return pattern;
  }
  return null;
}

export function createSecurityGuard({ config, llm, logger, notify, rng = Math.random } = {}) {
  const security = config?.security ?? {};
  const passphraseCfg = security.passphrase ?? {};
  const sensitiveCfg = security.sensitive ?? {};
  const suspicionCfg = security.suspicion ?? {};

  const admins = new Set((security.admins ?? []).map((id) => normalizeId(id)).filter(Boolean));
  const sessions = new Map(); // userId → 本轮质询（answer / issuedAt / attemptsLeft / challenge）
  const passedAt = new Map(); // userId → 上次通过验证的时间
  const reportedAt = new Map(); // userId → 上次告警时间（去重用）

  const minIntervalMs = Math.max(0, Number(passphraseCfg.minIntervalMinutes ?? 0)) * 60_000;
  const maxAgeMs = Math.max(1, Number(passphraseCfg.maxAgeMinutes ?? 15)) * 60_000;
  const answerAttempts = Math.max(1, Math.trunc(Number(passphraseCfg.answerAttempts ?? 3)) || 3);
  const reportCooldownMs = Math.max(0, Number(suspicionCfg.reportCooldownMinutes ?? 5)) * 60_000;
  const threshold = Number(suspicionCfg.threshold ?? 0.6);
  /** 同一个用户在这个窗口内不会听到同一句问法（取口令频率窗口，没配就 10 分钟）。 */
  const challengeRepeatWindowMs = minIntervalMs > 0 ? minIntervalMs : 10 * 60_000;
  const challengeHistory = new Map(); // userId → [{ text, at }]，最近用过的问法

  /** 这个用户在这个窗口里听过的问法（顺手把过期的清掉）。 */
  function askedPhrasings(userId, now) {
    const key = normalizeId(userId);
    if (!key) return [];
    const list = (challengeHistory.get(key) ?? []).filter((item) => now - item.at < challengeRepeatWindowMs);
    if (list.length) challengeHistory.set(key, list);
    else challengeHistory.delete(key);
    return list;
  }

  function rememberPhrasing(userId, text, now) {
    const key = normalizeId(userId);
    if (!key || !text) return;
    const list = askedPhrasings(key, now);
    list.push({ text, at: now });
    challengeHistory.set(key, list);
  }

  /** 挑一句这个窗口里没用过的问法；都用过了就挑最久没说过的，避免连续重复。 */
  function pickChallengeText({ userId = null, now = Date.now() } = {}) {
    const used = askedPhrasings(userId, now);
    const usedTexts = new Set(used.map((item) => item.text));
    const texts = CHALLENGE_TEMPLATES.map((template) => template());
    const fresh = texts.filter((text) => !usedTexts.has(text));
    if (fresh.length) return pick(fresh, rng) ?? fresh[0];
    const oldest = used[0]?.text;
    return texts.includes(oldest) ? oldest : TEXTS.weakChallenge;
  }

  function refusal() {
    return pick(REFUSALS, rng) ?? REFUSALS[0];
  }

  function isAdmin(userId) {
    const uid = normalizeId(userId);
    return Boolean(uid) && admins.has(uid);
  }

  function isSensitive(action) {
    if (!action) return false;
    if (sensitiveCfg.requireVerification === false) return false;
    return (sensitiveCfg.actions ?? []).map(String).includes(String(action));
  }

  function passphrasePool() {
    return (passphraseCfg.pool ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  }

  function deny(reason, replyText, stage = 'denied', extra = {}) {
    return { ok: false, stage, reason, replyText, ...extra };
  }

  /**
   * 校验问话：够自然、没把口令说出去，**也不许有任何字符级线索**
   * （字数、首字/位置、连续两个字以上的口令片段），同一个用户刚听过的问法也不再重复。
   */
  function validChallengeText(text, pool, { userId = null, now = Date.now() } = {}) {
    const question = String(text ?? '').trim();
    if (question.length < 4 || question.length > 200) return false;
    if (leaksPassphraseHint(question, pool)) return false;
    return !askedPhrasings(userId, now).some((item) => item.text === question);
  }

  async function buildChallenge(answer, pool, { userId = null, now = Date.now() } = {}) {
    if (passphraseCfg.allowLlmChallenge && typeof llm?.chat === 'function') {
      try {
        const style = String(passphraseCfg.style ?? '').trim();
        const result = await llm.chat({
          role: 'judge',
          json: true,
          temperature: 0.95,
          maxTokens: 200,
          messages: [
            {
              role: 'system',
              content: [
                t('security.guard.challenge.systemIntro', {
                  style: style || t('security.guard.challenge.defaultStyle'),
                }),
                t('security.guard.challenge.systemRules'),
              ].join(''),
            },
            {
              role: 'user',
              content: t('security.guard.challenge.userPrompt', { answer }),
            },
          ],
        });
        const parsed = result?.json ?? tryJson(result?.content);
        const question = String(parsed?.question ?? parsed?.challenge ?? parsed?.text ?? '').trim();
        if (validChallengeText(question, pool, { userId, now })) return { text: question, source: 'llm' };
        logger?.debug?.(t('security.guard.log.invalidChallenge'));
      } catch (error) {
        logger?.debug?.(t('security.guard.log.challengeFailed'), error);
      }
    }
    const templated = pickChallengeText({ userId, now });
    return { text: templated ?? TEXTS.weakChallenge, source: templated ? 'template' : 'fallback' };
  }

  async function issueChallenge({ userId, scene, groupId, action, now }) {
    const pool = passphrasePool();
    if (!pool.length) {
      logger?.warn?.(t('security.guard.log.emptyPool'));
      return deny('no_passphrase', refusal());
    }
    const answer = pick(pool, rng) ?? pool[0];
    const challenge = await buildChallenge(answer, pool, { userId, now });
    rememberPhrasing(userId, challenge.text, now);
    const session = {
      userId,
      scene: scene ?? 'private',
      groupId: groupId ?? null,
      action: action ?? null,
      answer,
      pool: [...pool],
      attemptsLeft: answerAttempts,
      attempts: 0,
      issuedAt: now,
      expiresAt: now + maxAgeMs,
      challenge,
    };
    sessions.set(userId, session);
    logger?.operation?.({
      actor: userId,
      action: 'security.challenge_issued',
      target: action ?? null,
      ok: true,
      detail: { source: challenge.source, expiresAt: session.expiresAt },
    });
    return {
      ok: false,
      stage: 'challenge',
      reason: 'challenge_issued',
      action: action ?? null,
      challenge: challenge.text,
      replyText: challenge.text,
      challengeMeta: {
        source: challenge.source,
        // 故意不带 answerLength：字数和首字一样是线索，对外只给来源与有效期
        expiresAt: session.expiresAt,
        attemptsLeft: session.attemptsLeft,
      },
    };
  }

  /** 敏感操作的两步验证。request 有值 = 新请求；request 为 null = 用户在回答上一句问话。 */
  async function verify({ userId, scene = 'private', groupId = null, action = null, message = null, request, now = Date.now() } = {}) {
    const uid = normalizeId(userId);
    try {
      // 第一步：是不是管理者
      if (!isAdmin(uid)) {
        logger?.operation?.({ actor: uid, action: 'security.verify', target: action ?? null, ok: false, detail: 'not_admin' });
        return deny('not_admin', refusal());
      }

      // 不需要验证的情况一律放行
      if (sensitiveCfg.requireVerification === false) {
        return { ok: true, stage: 'passed', reason: 'verification_disabled', replyText: null };
      }
      if (passphraseCfg.enabled === false) {
        return { ok: true, stage: 'passed', reason: 'passphrase_disabled', replyText: null };
      }
      if (!isSensitive(action)) {
        return { ok: true, stage: 'passed', reason: 'not_sensitive', replyText: null };
      }

      // 频率窗口内免验证
      const lastPassed = passedAt.get(uid);
      if (lastPassed != null && now - lastPassed < minIntervalMs) {
        return { ok: true, stage: 'passed', reason: 'frequency_window', replyText: null, lastPassedAt: lastPassed };
      }

      const session = sessions.get(uid);
      const answering = request == null && session != null && session.attemptsLeft > 0;

      if (!answering) {
        // 已经出过题还没答完：复用同一句问话，不重复出题
        if (session && session.attemptsLeft > 0 && now < session.expiresAt) {
          return {
            ok: false,
            stage: 'challenge',
            reason: 'pending',
            action: action ?? session.action ?? null,
            challenge: session.challenge.text,
            replyText: session.challenge.text,
            challengeMeta: {
              source: session.challenge.source,
              expiresAt: session.expiresAt,
              attemptsLeft: session.attemptsLeft,
            },
          };
        }
        return await issueChallenge({ userId: uid, scene, groupId, action, now });
      }

      // 第二步：应答判定
      if (now >= session.expiresAt) {
        sessions.delete(uid);
        logger?.operation?.({ actor: uid, action: 'security.verify', target: action ?? null, ok: false, detail: 'expired' });
        return deny('expired', TEXTS.expired, 'expired');
      }

      session.attempts += 1;
      const answer = messageText(message);
      const hit = matchPassphrase(answer, session.pool);
      if (hit) {
        passedAt.set(uid, now);
        sessions.delete(uid);
        logger?.operation?.({ actor: uid, action: 'security.verify', target: session.action ?? action ?? null, ok: true, detail: 'passed' });
        return { ok: true, stage: 'passed', reason: 'passphrase', replyText: TEXTS.passed, lastPassedAt: now };
      }

      session.attemptsLeft -= 1;
      if (session.attemptsLeft <= 0) {
        sessions.delete(uid);
        logger?.operation?.({ actor: uid, action: 'security.verify', target: session.action ?? action ?? null, ok: false, detail: 'too_many_attempts' });
        return deny('too_many_attempts', TEXTS.denied);
      }

      const nudge = pick(NUDGES, rng) ?? '';
      return {
        ok: false,
        stage: 'challenge',
        reason: 'wrong_answer',
        action: session.action ?? action ?? null,
        challenge: session.challenge.text,
        replyText: `${nudge}${session.challenge.text}`,
        challengeMeta: {
          source: session.challenge.source,
          expiresAt: session.expiresAt,
          attemptsLeft: session.attemptsLeft,
        },
      };
    } catch (error) {
      // fail-closed：安全模块自己出问题，就当这次没通过
      logger?.warn?.(t('security.guard.log.verifyFailed'), error);
      return deny('error', refusal());
    }
  }

  /** 可疑行为检测：关键词打分 +（可选）模型判定，超阈值汇报管理员。 */
  async function noteMessage({ userId, scene = 'private', groupId = null, text, message = null, now = Date.now() } = {}) {
    const body = String(text ?? messageText(message) ?? '').trim();
    const uid = normalizeId(userId);
    const nickname = message?.sender?.nickname ?? message?.sender?.card ?? null;
    try {
      if (suspicionCfg.enabled === false || !body) return { suspicion: 0, alerted: false, reasons: [] };

      const norm = normalizeForMatch(body);
      const keywords = (suspicionCfg.keywords ?? []).map((item) => String(item)).filter(Boolean);
      const hits = keywords.filter((keyword) => {
        const needle = normalizeForMatch(keyword);
        return needle && norm.includes(needle);
      });
      // 命中一条就已经很可疑（0.7），命中越多分越高
      const keywordScore = hits.length ? Math.min(1, 0.7 + 0.15 * (hits.length - 1)) : 0;

      let llmScore = 0;
      const reasons = hits.map((keyword) => t('security.guard.reason.keyword', { keyword }));
      if (suspicionCfg.llmJudge && typeof llm?.chat === 'function' && body) {
        try {
          const result = await llm.chat({
            role: 'judge',
            json: true,
            temperature: 0.2,
            maxTokens: 200,
            messages: [
              {
                role: 'system',
                content: t('security.guard.suspicion.system'),
              },
              {
                role: 'user',
                content: t('security.guard.suspicion.user', {
                  scene,
                  group: groupId ? t('security.guard.suspicion.group', { groupId }) : '',
                  userId: uid || t('security.guard.suspicion.unknownId'),
                  text: truncate(body, 500),
                }),
              },
            ],
          });
          const parsed = result?.json ?? tryJson(result?.content);
          if (parsed && typeof parsed === 'object') {
            const score = Number(parsed.score);
            if (Number.isFinite(score)) llmScore = clamp(score, 0, 1);
            else if (parsed.suspicious) llmScore = 0.7;
            if (Array.isArray(parsed.reasons)) {
              for (const item of parsed.reasons.slice(0, 3)) {
                const reason = String(item ?? '').trim();
                if (reason) reasons.push(reason);
              }
            }
          }
        } catch (error) {
          logger?.debug?.(t('security.guard.log.suspicionJudgeFailed'), error);
        }
      }

      const weighted = Math.max(keywordScore, llmScore * 0.9);
      const suspicion = clamp(keywordScore > 0 && llmScore > 0 ? weighted * 1.05 : weighted, 0, 1);

      if (suspicion < threshold) return { suspicion, alerted: false, reasons };

      if (suspicionCfg.notifyAdmin === false || typeof notify !== 'function') {
        return { suspicion, alerted: false, reasons };
      }

      const lastReported = reportedAt.get(uid) ?? 0;
      if (uid && now - lastReported < reportCooldownMs) {
        return { suspicion, alerted: false, reasons: [...reasons, t('security.guard.reason.reportedRecently')] };
      }
      if (uid) reportedAt.set(uid, now);

      const info = [
        t('security.guard.alert.nickname', { name: nickname ?? t('security.guard.alert.unknownName') }),
        t('security.guard.alert.userId', { userId: uid || t('security.guard.alert.unknownName') }),
        t('security.guard.alert.scene', {
          scene,
          group: groupId ? t('security.guard.suspicion.group', { groupId }) : '',
        }),
        t('security.guard.alert.text', { text: truncate(body, 300) }),
        t('security.guard.alert.verdict', {
          score: suspicion.toFixed(2),
          reasons: reasons.join('\u3001') || t('security.guard.alert.noReason'),
        }),
      ].join('\n');

      try {
        await notify({
          title: t('security.guard.alert.title', { who: nickname ?? uid ?? t('security.guard.alert.unknownUser') }),
          text: info,
        });
      } catch (error) {
        logger?.warn?.(t('security.guard.log.notifyFailed'), error);
        return { suspicion, alerted: false, reasons };
      }

      logger?.operation?.({
        actor: uid || null,
        actorName: nickname,
        action: 'security.suspicion_alert',
        target: scene,
        ok: true,
        detail: { suspicion, reasons },
      });
      return { suspicion, alerted: true, reasons };
    } catch (error) {
      logger?.warn?.(t('security.guard.log.suspicionFailed'), error);
      return { suspicion: 0, alerted: false, reasons: [] };
    }
  }

  function sessionState(userId) {
    const uid = normalizeId(userId);
    const session = sessions.get(uid);
    const lastPassed = passedAt.get(uid) ?? null;
    if (!session && lastPassed == null) return null;
    const fresh = lastPassed != null && Date.now() - lastPassed < minIntervalMs;
    const alive = Boolean(session) && Date.now() < session.expiresAt;
    return {
      userId: uid,
      // stage 给外层用：'challenge' = 正等着对方回话（且还没过期）；'expired' = 过期了不用理；'passed' = 还在免验窗口；'idle' = 窗口过了
      stage: alive ? 'challenge' : session ? 'expired' : fresh ? 'passed' : 'idle',
      pending: Boolean(session),
      answer: session?.answer ?? null,
      pool: session ? [...session.pool] : [],
      challenge: session?.challenge?.text ?? null,
      source: session?.challenge?.source ?? null,
      action: session?.action ?? null,
      issuedAt: session?.issuedAt ?? null,
      expiresAt: session?.expiresAt ?? null,
      attempts: session?.attempts ?? 0,
      attemptsLeft: session?.attemptsLeft ?? 0,
      lastPassedAt: lastPassed,
    };
  }

  function reset(userId) {
    const uid = normalizeId(userId);
    const had = sessions.delete(uid);
    passedAt.delete(uid);
    challengeHistory.delete(uid); // 问法历史一起清，下一轮重新开始
    return had;
  }

  return {
    isAdmin,
    isSensitive,
    verify,
    noteMessage,
    sessionState,
    reset,
    get adminIds() {
      return [...admins];
    },
  };
}
