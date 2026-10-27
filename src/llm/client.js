/**
 * 模型接口客户端：OpenAI 兼容（DeepSeek / OpenAI / 本地 vLLM 等都能接）。
 * 支持流式、工具调用、多模态、JSON 输出、用量统计与余额查询。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep, shortId } from '../util/common.js';
import { estimateTokens } from '../util/text.js';
import { t } from '../i18n/index.js';

export class LLMError extends Error {
  constructor(message, { code = 'llm_error', status = null, response = null, attempts = 0 } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
    this.response = response;
    this.attempts = attempts;
  }
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function resolveRoleParams(modelConfig, role, overrides = {}) {
  const roleConfig = modelConfig.roles?.[role] ?? {};
  return {
    model: overrides.model ?? roleConfig.model ?? modelConfig.model,
    temperature: overrides.temperature ?? roleConfig.temperature ?? modelConfig.temperature,
    maxTokens: overrides.maxTokens ?? roleConfig.maxTokens ?? modelConfig.maxTokens,
    stream: overrides.stream ?? roleConfig.stream ?? modelConfig.stream,
  };
}

/** 把图片路径/URL 变成模型能吃的 image_url 内容块。 */
export async function toImageContent(file) {
  const text = String(file ?? '');
  if (/^https?:\/\//i.test(text)) return { type: 'image_url', image_url: { url: text } };
  if (text.startsWith('data:')) return { type: 'image_url', image_url: { url: text } };
  if (text.startsWith('base64://')) return { type: 'image_url', image_url: { url: `data:image/png;base64,${text.slice('base64://'.length)}` } };
  if (text.startsWith('file://')) return toImageContent(text.replace(/^file:\/\//, ''));
  const absolute = path.resolve(text);
  const buffer = await fs.readFile(absolute);
  if (buffer.byteLength > 12 * 1024 * 1024) {
    throw new LLMError(t('llm.client.imageTooLarge', { mb: Math.round(buffer.byteLength / 1024 / 1024) }), { code: 'image_too_large' });
  }
  const mime = MIME_BY_EXT[path.extname(absolute).toLowerCase()] ?? 'image/png';
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } };
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
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

export function createLLMClient({ config, logger } = {}) {
  const modelConfig = config.model;
  const childLog = logger?.child ? logger.child('llm') : logger;
  const usage = {
    requests: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    since: Date.now(),
    byModel: {},
  };

  function addUsage(model, tokens = {}, requestText = '') {
    usage.requests += 1;
    const entry = usage.byModel[model] ?? { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    entry.requests += 1;
    entry.promptTokens += tokens.promptTokens ?? 0;
    entry.completionTokens += tokens.completionTokens ?? 0;
    entry.totalTokens += tokens.totalTokens ?? (tokens.promptTokens ?? 0) + (tokens.completionTokens ?? 0);
    usage.byModel[model] = entry;
    usage.promptTokens += tokens.promptTokens ?? 0;
    usage.completionTokens += tokens.completionTokens ?? 0;
    usage.totalTokens += tokens.totalTokens ?? (tokens.promptTokens ?? 0) + (tokens.completionTokens ?? 0);
    if (!tokens.promptTokens) {
      // 上游没给用量时自己估
      usage.promptTokens += estimateTokens(requestText);
    }
  }

  function endpoint(pathname = '/chat/completions') {
    return `${String(modelConfig.baseUrl).replace(/\/+$/, '')}${pathname}`;
  }

  function headers() {
    const out = { 'Content-Type': 'application/json' };
    if (modelConfig.apiKey) out.Authorization = `Bearer ${modelConfig.apiKey}`;
    return out;
  }

  async function rawRequest(body, { timeoutMs, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? modelConfig.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      return await fetch(endpoint(), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function readStream(response, onDelta) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    const toolCalls = [];
    let finishReason = null;
    let usageFromStream = null;

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (payload.usage) usageFromStream = payload.usage;
        const choice = payload.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          try {
            onDelta?.(delta.content);
          } catch (error) {
            childLog?.debug?.(t('llm.client.onDeltaError'), error);
          }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const slot = call.index ?? toolCalls.length;
            toolCalls[slot] = toolCalls[slot] ?? { id: null, name: '', arguments: '' };
            if (call.id) toolCalls[slot].id = call.id;
            if (call.function?.name) toolCalls[slot].name = call.function.name;
            if (call.function?.arguments) toolCalls[slot].arguments += call.function.arguments;
          }
        }
      }
    }
    return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage: usageFromStream };
  }

  function normalizeToolCalls(toolCalls = [], finishReason = null) {
    return toolCalls
      .filter(Boolean)
      .map((call, index) => {
        // 流式累积出来的形状是 { name, arguments: string }，
        // 非流式上游给的是 { function: { name, arguments: string } }，两种都要认。
        const rawArguments = call.function?.arguments ?? call.arguments;
        const name = call.function?.name ?? call.name ?? '';
        const rawText = typeof rawArguments === 'string' ? rawArguments : null;
        const parsed = rawText === null ? rawArguments ?? {} : tryParseJson(rawText);
        // 参数被截断时不会报错、只会解析失败：标出来，别静默降级成 { _raw }
        const argumentsError = rawText !== null && parsed === null ? 'json_parse_failed' : null;
        if (argumentsError || finishReason === 'length') {
          const detail = {
            name: name || t('llm.client.unknown'),
            finishReason: finishReason ?? t('llm.client.unknown'),
            length: rawText?.length ?? 0,
            head: String(rawText ?? '').slice(0, 200),
          };
          childLog?.warn?.(
            argumentsError
              ? t('llm.client.toolArgsIncompleteTruncated', detail)
              : t('llm.client.toolArgsIncomplete', detail),
          );
        }
        return {
          id: call.id ?? shortId('call'),
          name,
          arguments: argumentsError ? { _raw: rawText } : parsed,
          raw: rawText ?? JSON.stringify(rawArguments ?? {}),
          index,
          finishReason: finishReason ?? null,
          argumentsError,
        };
      })
      .filter((call) => call.name);
  }

  /**
   * 主对话接口。
   * @param {{ messages: any[], tools?: any[], role?: string, json?: boolean, onDelta?: Function, signal?: AbortSignal }} params
   */
  async function chat({
    messages,
    tools = null,
    role = 'chat',
    model = null,
    temperature = null,
    maxTokens = null,
    stream = null,
    json = false,
    onDelta = null,
    timeoutMs = null,
    signal = null,
  } = {}) {
    const params = resolveRoleParams(modelConfig, role, { model, temperature, maxTokens, stream });
    if (modelConfig.offline) {
      throw new LLMError(t('llm.client.offline'), { code: 'offline' });
    }
    if (!modelConfig.apiKey && !config.env?.ALLOW_EMPTY_API_KEY) {
      childLog?.warn?.(t('llm.client.noApiKey'));
    }
    const useStream = Boolean(params.stream && onDelta);
    const body = {
      model: params.model,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: useStream,
    };
    if (useStream) body.stream_options = { include_usage: true };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (json) body.response_format = { type: 'json_object' };

    const attempts = Math.max(1, (modelConfig.retry?.times ?? 2) + 1);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await rawRequest(body, { timeoutMs, signal });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const retriable = response.status >= 500 || response.status === 429;
          const error = new LLMError(t('llm.client.httpError', { status: response.status, body: text.slice(0, 300) }), {
            code: retriable ? 'upstream_unavailable' : 'upstream_error',
            status: response.status,
            response: text,
            attempts: attempt,
          });
          if (!retriable || attempt === attempts) throw error;
          lastError = error;
        } else if (useStream) {
          const result = await readStream(response, onDelta);
          const toolCalls = normalizeToolCalls(result.toolCalls, result.finishReason);
          const tokens = result.usage
            ? {
                promptTokens: result.usage.prompt_tokens ?? 0,
                completionTokens: result.usage.completion_tokens ?? 0,
                totalTokens: result.usage.total_tokens ?? 0,
              }
            : {};
          addUsage(params.model, tokens, JSON.stringify(messages).slice(0, 2000));
          return {
            content: result.content,
            toolCalls,
            json: json ? tryParseJson(result.content) : null,
            usage: tokens,
            model: params.model,
            finishReason: result.finishReason,
            raw: result,
          };
        } else {
          const payload = await response.json();
          const choice = payload.choices?.[0] ?? {};
          const message = choice.message ?? {};
          const toolCalls = normalizeToolCalls(message.tool_calls ?? [], choice.finish_reason ?? null);
          const content = typeof message.content === 'string' ? message.content : '';
          const tokens = payload.usage
            ? {
                promptTokens: payload.usage.prompt_tokens ?? 0,
                completionTokens: payload.usage.completion_tokens ?? 0,
                totalTokens: payload.usage.total_tokens ?? 0,
              }
            : {};
          addUsage(params.model, tokens, JSON.stringify(messages).slice(0, 2000));
          if (content && onDelta) {
            try {
              onDelta(content);
            } catch {
              /* 忽略 */
            }
          }
          return {
            content,
            toolCalls,
            json: json ? tryParseJson(content) : null,
            usage: tokens,
            model: payload.model ?? params.model,
            finishReason: choice.finish_reason ?? null,
            raw: payload,
          };
        }
      } catch (error) {
        lastError = error instanceof LLMError ? error : new LLMError(t('llm.client.callFailedWithCause', { message: error.message }), { code: 'network_error' });
        if (error.name === 'AbortError') {
          lastError = new LLMError(t('llm.client.timeout'), { code: 'timeout' });
        }
        const retriable = ['upstream_unavailable', 'network_error', 'timeout'].includes(lastError.code);
        if (!retriable || attempt === attempts) break;
        childLog?.warn?.(t('llm.client.retry', { attempt, message: lastError.message }));
        await sleep((modelConfig.retry?.baseDelayMs ?? 800) * 2 ** (attempt - 1));
      }
    }
    usage.failed += 1;
    throw lastError ?? new LLMError(t('llm.client.callFailed'));
  }

  /**
   * 看图。没单独配 `visionModel` 就用主模型 —— DeepSeek 这类主模型本身就能识图，
   * 硬要 `visionModel` 会让「表情包认含义」「看屏幕」在默认配置下直接罢工。
   */
  async function vision({ prompt, images = [], model = null, maxTokens = null } = {}) {
    // visionModel 默认就是空串，而 `??` 只跳 null / undefined —— 空串会被当成「专门配了视觉模型」，
    // 于是「没配就用主模型」这条约定形同虚设，表情包认含义与看屏幕都只会回「没有能看图的模型」。
    const targetModel = model || modelConfig.visionModel || modelConfig.model;
    if (!targetModel) {
      throw new LLMError(t('llm.client.noVisionModel'), { code: 'vision_unsupported' });
    }
    const content = [{ type: 'text', text: String(prompt ?? t('llm.client.defaultVisionPrompt')) }];
    for (const image of images) {
      content.push(await toImageContent(image));
    }
    const result = await chat({
      role: 'chat',
      messages: [{ role: 'user', content }],
      model: targetModel,
      maxTokens,
      stream: false,
    });
    return result.content;
  }

  async function balance() {
    if (!modelConfig.balance?.enabled || !modelConfig.balance?.url) return null;
    try {
      const response = await fetch(modelConfig.balance.url, {
        headers: headers(),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const info = payload.balance_infos?.[0] ?? payload;
      return {
        available: payload.is_available ?? null,
        currency: info.currency ?? modelConfig.balance.currency ?? 'CNY',
        balance: info.total_balance ?? info.balance ?? null,
        granted: info.granted_balance ?? null,
        toppedUp: info.topped_up_balance ?? null,
        raw: payload,
      };
    } catch (error) {
      childLog?.warn?.(t('llm.client.balanceFailed'), error);
      return null;
    }
  }

  return {
    chat,
    vision,
    balance,
    usageTotals: () => ({ ...usage, byModel: { ...usage.byModel } }),
    resetUsage: () => {
      usage.requests = 0;
      usage.failed = 0;
      usage.promptTokens = 0;
      usage.completionTokens = 0;
      usage.totalTokens = 0;
      usage.byModel = {};
      usage.since = Date.now();
    },
    get modelName() {
      return modelConfig.model;
    },
    /** 专门配的视觉模型；留空表示用主模型。 */
    get visionModelName() {
      return modelConfig.visionModel || null;
    },
    /** 真去看图时用的那个模型（visionModel 留空就是主模型）。 */
    get visionTargetName() {
      return modelConfig.visionModel || modelConfig.model || null;
    },
    get baseUrl() {
      return modelConfig.baseUrl;
    },
  };
}
