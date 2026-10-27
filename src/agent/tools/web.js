/**
 * 联网类工具：web_fetch（抓一个网页转纯文本）、web_search（搜索）。
 * 只允许 http/https；搜索优先用注入的 search / sidecar 服务，否则走 DuckDuckGo 的 html 端点。
 * 解析不出结果时明确报错，绝不编造结果。
 */

import { assertNotAborted, combineSignals, requireArg, resolveFetch, ToolError, truncateWithNote } from './error.js';
import { t } from '../../i18n/index.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// HTML 实体是程序要用的字符，不是文字，用转义写（见 docs/I18N.md 第 3.5 节）
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '\u201C',
  rdquo: '\u201D',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
};

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)\s*>/gi, '\n')
    // 行内标签直接拿掉，中文里不留空格（「这是<strong>摘要</strong>内容」→「这是摘要内容」）
    .replace(/<\/?(b|i|em|strong|span|code|small|mark|sub|sup|font|label|abbr|u|s|del|ins)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-zA-Z]+);/g, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeDuckDuckGoHref(href) {
  const raw = String(href ?? '');
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return raw;
    }
  }
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

export function parseDuckDuckGoResults(html) {
  const source = String(html ?? '');
  const links = [];
  const linkPattern = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let match = linkPattern.exec(source);
  while (match) {
    links.push({ url: decodeDuckDuckGoHref(match[1]), title: htmlToText(match[2]) });
    match = linkPattern.exec(source);
  }
  match = snippetPattern.exec(source);
  while (match) {
    snippets.push(htmlToText(match[1]));
    match = snippetPattern.exec(source);
  }
  return links
    .filter((item) => item.url && item.title)
    .map((item, index) => ({ title: item.title, url: item.url, snippet: snippets[index] ?? '' }));
}

function normalizeServiceResults(payload, limit) {
  if (payload == null) return null;
  if (typeof payload === 'string') return { text: payload, results: [] };
  const list = Array.isArray(payload) ? payload : payload.results ?? payload.items ?? null;
  if (!Array.isArray(list)) return null;
  const results = list
    .slice(0, limit)
    .map((item) => ({
      title: String(item?.title ?? item?.name ?? ''),
      url: String(item?.url ?? item?.link ?? ''),
      snippet: String(item?.snippet ?? item?.text ?? item?.summary ?? ''),
    }))
    .filter((item) => item.title || item.url);
  return { results, text: null };
}

export function createWebTools({ config, services, fetch: fetchOverride = null }) {
  const timeoutMs = () => Math.max(500, Number(config?.agent?.stepTimeoutMs ?? 15000) || 15000);
  const getFetch = () => resolveFetch(services, fetchOverride);

  function searchService() {
    if (services?.search && typeof services.search.search === 'function') return services.search;
    if (services?.sidecar && typeof services.sidecar.search === 'function') return services.sidecar;
    return null;
  }

  async function webFetchRun(args, ctx) {
    assertNotAborted(ctx);
    const raw = requireArg(args, 'url', { type: 'string' });
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolError(t('agent.web.invalidUrl', { url: raw }), 'invalid_url', { url: raw });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ToolError(t('agent.web.protocolNotAllowed', { protocol: url.protocol }), 'invalid_url', { url: raw });
    }
    const maxChars = Math.min(Math.max(Number(args?.maxChars) > 0 ? Math.trunc(Number(args.maxChars)) : 8000, 200), 40000);
    const signal = combineSignals(ctx?.signal, AbortSignal.timeout(timeoutMs()));
    const doFetch = getFetch();
    let response;
    try {
      response = await doFetch(url.href, {
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
        signal,
      });
    } catch (error) {
      if (ctx?.signal?.aborted) throw new ToolError(t('agent.web.aborted'), 'aborted');
      throw new ToolError(t('agent.web.fetchFailed', { message: error?.message ?? error }), 'network_error', { url: url.href });
    }
    if (!response || typeof response.text !== 'function') {
      throw new ToolError(t('agent.web.badResponse'), 'bad_response', { url: url.href });
    }
    if (!response.ok && response.status >= 400) {
      throw new ToolError(
        t('agent.web.httpError', {
          status: response.status,
          statusText: response.statusText ? ` ${response.statusText}` : '',
        }),
        'http_error',
        {
          url: url.href,
          status: response.status,
        },
      );
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    const body = await response.text();
    const looksHtml = /html|xml/i.test(contentType) || /^\s*</.test(String(body).slice(0, 200));
    const plain = looksHtml ? htmlToText(body) : String(body);
    const { text, truncated } = truncateWithNote(plain, maxChars);
    return {
      ok: true,
      url: response.url ?? url.href,
      status: response.status ?? 200,
      contentType,
      text,
      truncated,
    };
  }

  async function webSearchRun(args, ctx) {
    assertNotAborted(ctx);
    const query = requireArg(args, 'query', { type: 'string' });
    const limit = Math.min(Math.max(Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : 5, 1), 20);

    const service = searchService();
    if (service) {
      let payload;
      try {
        payload = await service.search({ query, limit });
      } catch (error) {
        throw new ToolError(t('agent.web.searchServiceFailed', { message: error?.message ?? error }), 'search_failed', { query });
      }
      const normalized = normalizeServiceResults(payload, limit);
      if (!normalized) throw new ToolError(t('agent.web.searchParseFailed'), 'parse_failed', { query });
      return { ok: true, query, source: 'service', count: normalized.results.length, results: normalized.results, text: normalized.text };
    }

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const signal = combineSignals(ctx?.signal, AbortSignal.timeout(timeoutMs()));
    const doFetch = getFetch();
    let response;
    try {
      response = await doFetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, signal });
    } catch (error) {
      if (ctx?.signal?.aborted) throw new ToolError(t('agent.web.aborted'), 'aborted');
      throw new ToolError(t('agent.web.searchRequestFailed', { message: error?.message ?? error }), 'network_error', { query });
    }
    if (!response?.ok) {
      throw new ToolError(
        t('agent.web.searchHttpFailed', { status: response?.status ?? t('agent.web.unknown') }),
        'http_error',
        { query, status: response?.status ?? null },
      );
    }
    const html = await response.text();
    const results = parseDuckDuckGoResults(html).slice(0, limit);
    if (!results.length) {
      throw new ToolError(t('agent.web.noResults'), 'parse_failed', { query });
    }
    return { ok: true, query, source: 'duckduckgo', count: results.length, results };
  }

  const webFetch = {
    name: 'web_fetch',
    description: t('agent.web.fetch.description'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: t('agent.web.fetch.url') },
        maxChars: { type: 'number', description: t('agent.web.fetch.maxChars') },
      },
      required: ['url'],
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: webFetchRun,
  };

  const webSearch = {
    name: 'web_search',
    description: t('agent.web.search.description'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: t('agent.web.search.query') },
        limit: { type: 'number', description: t('agent.web.search.limit') },
      },
      required: ['query'],
      additionalProperties: false,
    },
    sensitive: false,
    action: null,
    run: webSearchRun,
  };

  return [webFetch, webSearch];
}
