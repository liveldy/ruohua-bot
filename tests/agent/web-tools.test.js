/** 联网工具：只用注入的假 fetch，绝不真的联网。 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createTools } from '../../src/agent/tools/index.js';
import { createNullLogger } from '../../src/logging/logger.js';

function makeConfig(root = 'D:/tmp') {
  return {
    rootDir: root,
    boundaryRoot: path.resolve(root),
    dataDir: path.join(path.resolve(root), 'data'),
    agent: { stepTimeoutMs: 3000 },
    security: { boundary: { shell: { enabled: false } } },
  };
}

function fakeResponse({ body = '', status = 200, headers = {}, url = 'https://example.com/page' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() {
      return body;
    },
  };
}

function makeCtx(services = {}) {
  return {
    userId: 10001,
    scene: 'private',
    groupId: null,
    taskId: 'task_web',
    task: null,
    message: null,
    services,
    logger: createNullLogger(),
    signal: new AbortController().signal,
  };
}

const HTML_PAGE = `<!doctype html>
<html><head><title>示例页面</title><style>body{color:red}</style></head>
<body>
<script>console.log('不该出现')</script>
<h1>你好</h1>
<p>第一段&amp;第二段</p>
<div>第三段<br>第四段</div>
<!-- 注释不该出现 -->
<ul><li>甲</li><li>乙</li></ul>
</body></html>`;

test('web_fetch 把网页转成纯文本（去脚本、去标签、解实体）', async () => {
  const requested = [];
  const services = {
    fetch: async (url, options) => {
      requested.push({ url, options });
      return fakeResponse({ body: HTML_PAGE, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
  const tools = createTools({ config: makeConfig(), services });
  const result = await tools.get('web_fetch').run({ url: 'https://example.com/page' }, makeCtx(services));

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.match(result.text, /你好/);
  assert.match(result.text, /第一段&第二段/);
  assert.match(result.text, /第三段/);
  assert.ok(!result.text.includes('console.log'), '脚本要去掉');
  assert.ok(!result.text.includes('color:red'), '样式要去掉');
  assert.ok(!result.text.includes('<'), '不该留标签');
  assert.ok(!result.text.includes('注释'), '注释要去掉');
  assert.equal(requested.length, 1);
  assert.ok(requested[0].options.signal, '要带超时/取消信号');
});

test('web_fetch：非 html 原样返回，超长截断', async () => {
  const services = {
    fetch: async () =>
      fakeResponse({ body: '甲'.repeat(500), headers: { 'content-type': 'text/plain; charset=utf-8' } }),
  };
  const tools = createTools({ config: makeConfig(), services });
  const result = await tools.get('web_fetch').run({ url: 'https://example.com/a.txt', maxChars: 100 }, makeCtx(services));
  assert.equal(result.truncated, true);
  assert.match(result.text, /已截断/);
  assert.ok(result.text.length < 300);
});

test('web_fetch：非法地址、非 http、HTTP 错误、网络异常都明确报错', async () => {
  const tools = createTools({ config: makeConfig(), services: { fetch: async () => fakeResponse({ status: 404 }) } });
  const ctx = makeCtx({ fetch: async () => fakeResponse({ status: 404 }) });

  await assert.rejects(() => tools.get('web_fetch').run({}, ctx), (error) => error.code === 'missing_argument');
  await assert.rejects(() => tools.get('web_fetch').run({ url: '不是网址' }, ctx), (error) => error.code === 'invalid_url');
  await assert.rejects(() => tools.get('web_fetch').run({ url: 'ftp://example.com/a' }, ctx), (error) => error.code === 'invalid_url');
  await assert.rejects(() => tools.get('web_fetch').run({ url: 'https://example.com/none' }, ctx), (error) => {
    assert.equal(error.name, 'ToolError');
    assert.equal(error.code, 'http_error');
    assert.match(error.message, /404/);
    return true;
  });

  const broken = createTools({
    config: makeConfig(),
    services: {
      fetch: async () => {
        throw new Error('ENOTFOUND');
      },
    },
  });
  await assert.rejects(() => broken.get('web_fetch').run({ url: 'https://nope.invalid' }, makeCtx()), (error) => error.code === 'network_error');
});

const DDG_HTML = `<html><body>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">这是<strong>摘要</strong>内容</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://ruohua.example.com/guide">若华指南</a>
  </h2>
  <a class="result__snippet" href="https://ruohua.example.com/guide">另一条摘要</a>
</div>
</body></html>`;

test('web_search：没有搜索服务时走 DuckDuckGo 并解析出标题与链接', async () => {
  const urls = [];
  const services = {
    fetch: async (url) => {
      urls.push(url);
      return fakeResponse({ body: DDG_HTML, headers: { 'content-type': 'text/html' } });
    },
  };
  const tools = createTools({ config: makeConfig(), services });
  const result = await tools.get('web_search').run({ query: '若华 文档', limit: 5 }, makeCtx(services));

  assert.equal(result.ok, true);
  assert.equal(result.source, 'duckduckgo');
  assert.equal(result.count, 2);
  assert.equal(result.results[0].title, 'Example Docs');
  assert.equal(result.results[0].url, 'https://example.com/docs');
  assert.match(result.results[0].snippet, /这是摘要内容/);
  assert.equal(result.results[1].url, 'https://ruohua.example.com/guide');
  assert.match(urls[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
  assert.match(decodeURIComponent(urls[0]), /若华 文档/);
});

test('web_search：解析不出结果时报错，不伪造结果', async () => {
  const services = { fetch: async () => fakeResponse({ body: '<html><body>没有结果</body></html>' }) };
  const tools = createTools({ config: makeConfig(), services });
  await assert.rejects(() => tools.get('web_search').run({ query: '随便什么' }, makeCtx(services)), (error) => {
    assert.equal(error.name, 'ToolError');
    assert.equal(error.code, 'parse_failed');
    return true;
  });
});

test('web_search：有 search 服务时优先用它', async () => {
  const queries = [];
  const services = {
    search: {
      async search({ query, limit }) {
        queries.push({ query, limit });
        return { results: [{ title: '甲', url: 'https://a.example', snippet: '摘要甲' }, { title: '乙', url: 'https://b.example' }] };
      },
    },
    fetch: async () => {
      throw new Error('不该真的去抓 DDG');
    },
  };
  const tools = createTools({ config: makeConfig(), services });
  const result = await tools.get('web_search').run({ query: '若华', limit: 2 }, makeCtx(services));
  assert.equal(result.source, 'service');
  assert.deepEqual(queries, [{ query: '若华', limit: 2 }]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].snippet, '摘要甲');
});

test('web_search / web_fetch 没有可用的 fetch 时明确报错', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const tools = createTools({ config: makeConfig(), services: {} });
    await assert.rejects(() => tools.get('web_fetch').run({ url: 'https://example.com' }, makeCtx()), (error) => {
      assert.equal(error.name, 'ToolError');
      assert.equal(error.code, 'fetch_unavailable');
      return true;
    });
    await assert.rejects(() => tools.get('web_search').run({ query: '若华' }, makeCtx()), (error) => error.code === 'fetch_unavailable');
  } finally {
    globalThis.fetch = original;
  }
});
