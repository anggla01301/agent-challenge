/**
 * LLM Proxy Server
 * ══════════════════════════════════════════════════════════════
 * 문제 1: @ai-sdk/openai v2+ 가 /responses 엔드포인트를 기본 사용
 *         → Nosana vLLM은 /chat/completions만 지원 → 400
 * 문제 2: Qwen3.5 thinking 모드 → content: null → AI SDK 파싱 실패
 * 문제 3: 'developer' role → vLLM 400
 *
 * 해결: /responses 요청을 /chat/completions 으로 변환하여 포워딩,
 *       응답을 다시 /responses 형식으로 변환 (스트리밍 포함)
 *
 * 사용법:
 *   node llm-proxy.js
 *   → http://localhost:3001 에서 실행
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const UPSTREAM_URL = process.env.OPENAI_BASE_URL_UPSTREAM
  || 'https://5i8frj7ann99bbw9gzpprvzj2esugg39hxbb4unypskq.node.k8s.prd.nos.ci/v1';

const upstream = new URL(UPSTREAM_URL);

// /responses 요청 바디 → /chat/completions 바디 변환
function convertResponsesReqToChat(parsed) {
  const messages = [];

  if (parsed.instructions) {
    messages.push({ role: 'system', content: parsed.instructions });
  }

  if (typeof parsed.input === 'string') {
    messages.push({ role: 'user', content: parsed.input });
  } else if (Array.isArray(parsed.input)) {
    for (const msg of parsed.input) {
      const role = msg.role === 'developer' ? 'system' : msg.role;
      // content가 배열이면 텍스트만 추출
      let content = msg.content;
      if (Array.isArray(content)) {
        content = content.map(c => (typeof c === 'string' ? c : c.text || '')).join('');
      }
      messages.push({ role, content });
    }
  }

  const chatBody = {
    model: parsed.model,
    messages,
    stream: parsed.stream ?? false,
    chat_template_kwargs: { enable_thinking: false },
  };

  if (parsed.temperature !== undefined) chatBody.temperature = parsed.temperature;
  if (parsed.max_tokens !== undefined) chatBody.max_tokens = parsed.max_tokens;
  if (parsed.top_p !== undefined) chatBody.top_p = parsed.top_p;

  return chatBody;
}

// /chat/completions 응답 JSON → /responses 응답 JSON 변환
function convertChatResToResponses(chatRes, model) {
  const choice = chatRes.choices?.[0];
  const text = choice?.message?.content || '';

  return {
    id: (chatRes.id || `resp_${Date.now()}`).replace('chatcmpl-', 'resp_'),
    object: 'response',
    created_at: chatRes.created || Math.floor(Date.now() / 1000),
    model: chatRes.model || model,
    status: 'completed',
    output: [{
      type: 'message',
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
      status: 'completed',
    }],
    usage: chatRes.usage ? {
      input_tokens: chatRes.usage.prompt_tokens,
      output_tokens: chatRes.usage.completion_tokens,
      total_tokens: chatRes.usage.total_tokens,
    } : undefined,
  };
}

// /chat/completions SSE 스트림 → /responses SSE 스트림 변환
function pipeStreamingConversion(chatStream, res, model) {
  const itemId = `msg_${Date.now()}`;
  let buffer = '';
  let firstChunk = true;
  let fullText = '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // response.created 이벤트
  send({
    type: 'response.created',
    response: {
      id: `resp_${Date.now()}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model,
      status: 'in_progress',
      output: [],
    },
  });

  send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [], status: 'in_progress' } });
  send({ type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });

  chatStream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          send({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta });
        }
      } catch { /* 파싱 실패 무시 */ }
    }
  });

  chatStream.on('end', () => {
    send({ type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: fullText });
    send({ type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } });
    send({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }], status: 'completed' } });
    send({ type: 'response.completed', response: { id: `resp_${Date.now()}`, object: 'response', model, status: 'completed', output: [{ type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }], status: 'completed' }] } });
    res.end();
  });

  chatStream.on('error', (err) => {
    console.error('[Proxy] Stream error:', err.message);
    res.end();
  });
}

const server = http.createServer((req, res) => {
  let body = '';

  req.on('data', chunk => { body += chunk; });

  req.on('end', () => {
    console.log(`[Proxy] → ${req.method} ${req.url}`);

    const isResponses = req.url?.includes('/responses');
    const isChat = req.url?.includes('/chat/completions');

    let outBody = body;
    let targetUrl = req.url || '/';
    let isStreaming = false;
    let originalModel = '';

    if (isResponses && req.method === 'POST' && body) {
      try {
        const parsed = JSON.parse(body);
        originalModel = parsed.model || '';
        isStreaming = parsed.stream === true;

        const chatBody = convertResponsesReqToChat(parsed);
        outBody = JSON.stringify(chatBody);
        // /responses → /chat/completions 경로 변경
        targetUrl = targetUrl.replace('/responses', '/chat/completions');
        console.log(`[Proxy] /responses → /chat/completions (stream=${isStreaming})`);
      } catch (e) {
        console.error('[Proxy] /responses 변환 실패:', e.message);
      }
    } else if (isChat && body) {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map(m =>
            m.role === 'developer' ? { ...m, role: 'system' } : m
          );
        }
        if (!parsed.chat_template_kwargs) {
          parsed.chat_template_kwargs = { enable_thinking: false };
        }
        outBody = JSON.stringify(parsed);
      } catch { /* 원본 그대로 */ }
    }

    const upstreamPath = upstream.pathname.replace(/\/$/, '') + targetUrl;
    const options = {
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: upstreamPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: upstream.hostname,
        'content-length': Buffer.byteLength(outBody),
      },
    };

    const transport = upstream.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(options, proxyRes => {
      console.log(`[Proxy] ← ${proxyRes.statusCode} ${targetUrl}`);

      if (isResponses && isStreaming && proxyRes.statusCode === 200) {
        pipeStreamingConversion(proxyRes, res, originalModel);
        return;
      }

      if (isResponses && !isStreaming && proxyRes.statusCode === 200) {
        let respBody = '';
        proxyRes.on('data', c => { respBody += c; });
        proxyRes.on('end', () => {
          try {
            const chatRes = JSON.parse(respBody);
            const converted = convertChatResToResponses(chatRes, originalModel);
            const out = JSON.stringify(converted);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(out);
          } catch {
            res.writeHead(200, proxyRes.headers);
            res.end(respBody);
          }
        });
        return;
      }

      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      console.error('[Proxy] Upstream error:', err.message);
      res.writeHead(502);
      res.end(`Upstream error: ${err.message}`);
    });

    proxyReq.write(outBody);
    proxyReq.end();
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🔀 LLM Proxy (/responses → /chat/completions)     ║
║  Listening : http://localhost:${PROXY_PORT}                 ║
║  Upstream  : ${UPSTREAM_URL.slice(0, 40)}...  ║
╚══════════════════════════════════════════════════════╝
  `);
});
