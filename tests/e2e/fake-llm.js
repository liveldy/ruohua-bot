/**
 * 端到端测试用的假模型接口：按请求特征路由，模拟决策 / 情绪判定 / 记忆提炼 / agent 工具循环。
 * 进程内起一个 HTTP 服务，`requests` 里留着每次请求，方便断言「模型到底看到了什么」。
 */

import http from 'node:http';

const CHAT_REPLY = '**在的**\n\n怎么了，你说。这句话**有点长**，我分两条发。😊';

export function decideFor(userText) {
  const text = String(userText ?? '');
  if (/命令|跑个脚本|删除文件|写文件/.test(text)) {
    return { mode: 'work', goal: text, style: 'work', needs_tools: true, sensitive: ['shell'], reply: null, confidence: 0.9, reason: '本机动作' };
  }
  if (/整理|总结|理一理|资料|状态/.test(text)) {
    return { mode: 'agent', goal: text, style: 'work', needs_tools: true, sensitive: [], reply: null, confidence: 0.9, reason: '多步任务' };
  }
  return { mode: 'chat', goal: null, style: 'chat', needs_tools: false, sensitive: [], reply: null, confidence: 0.9, reason: '闲聊' };
}

function nextToolCall(userText) {
  // 注意：agent 的提示词里会出现「每一步都必须用工具去执行」，别拿“执行”当关键词
  if (/命令/.test(userText)) {
    return { id: 'call_shell', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo ruohua-e2e' }) } };
  }
  return { id: 'call_status', type: 'function', function: { name: 'system_status', arguments: '{}' } };
}

function route(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
  const hasToolResult = messages.some((message) => message.role === 'tool');

  // 带工具的请求分两种：agent 循环（提示词里写着「agent 工作模式」）与聊天里的工具环
  // （人设提示词，她是自己去查一眼、查完照常回话）。聊天那条走下面的正常路由。
  const isAgentLoop = system.includes('agent 工作模式');
  if (Array.isArray(body.tools) && body.tools.length && isAgentLoop) {
    if (hasToolResult) {
      return { content: '做完了，你看下' };
    }
    return { tool_calls: [nextToolCall(userText)] };
  }
  // 我的决策提示词
  if (system.includes('你在判断一条 QQ 消息')) {
    return { content: JSON.stringify(decideFor(userText)) };
  }
  // 情绪判定：要的字段里有 event + delta
  if (system.includes('event') && system.includes('delta')) {
    return { content: JSON.stringify({ event: 'praise', delta: 3, mood: '开心', reason: '对方在夸我', importance: 0.82 }) };
  }
  // 记忆提炼：要的是条目数组
  if (system.includes('importance') && (system.includes('kind') || system.includes('记忆'))) {
    return { content: JSON.stringify([{ content: '对方来找我打了个招呼', importance: 0.35, kind: 'temporary', tags: ['闲聊'] }]) };
  }
  // 表情包识别：提示词要的是 {title, meaning, tags}
  if (system.includes('短标题') && system.includes('时机标签')) {
    return { content: JSON.stringify({ title: '假笑一张', meaning: '画面是一张笑脸，适合打招呼时发', tags: ['打招呼'] }) };
  }
  return { content: CHAT_REPLY };
}

export async function startFakeLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* 忽略 */
      }
      requests.push({ body, at: Date.now(), stream: Boolean(body.stream) });

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const content = route(body).content ?? '';
        requests.at(-1).response = { content };
        // 故意拆成几段，验证流式累积
        const parts = [content.slice(0, 2), content.slice(2)];
        for (const part of parts) {
          if (part) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const routed = route(body);
      requests.at(-1).response = routed;
      const message = routed.tool_calls
        ? { role: 'assistant', content: null, tool_calls: routed.tool_calls }
        : { role: 'assistant', content: routed.content };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          model: body.model ?? 'fake-model',
          choices: [{ index: 0, message, finish_reason: routed.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    reset: () => requests.splice(0, requests.length),
    toolMessages: () =>
      requests
        .flatMap((entry) => entry.body.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 找一段空闲端口：起一个服务拿端口再关掉。 */
export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
