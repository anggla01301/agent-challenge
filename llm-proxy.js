/**
 * LLM Proxy Server — Qwen3.5 thinking 모드 비활성화
 * ══════════════════════════════════════════════════════════════
 * 문제: Qwen3.5 모델은 기본적으로 thinking 모드로 동작해
 *       content: null, reasoning: "..." 형식으로 응답함.
 *       ElizaOS의 AI SDK가 이 형식을 처리 못해 "Unexpected message role" 에러 발생.
 *
 * 해결: 모든 /v1/chat/completions 요청에
 *       chat_template_kwargs: { enable_thinking: false } 를 자동으로 추가해
 *       Nosana 엔드포인트로 포워딩.
 *
 * 사용법:
 *   node llm-proxy.js
 *   → http://localhost:3001 에서 실행
 *
 * .env 설정:
 *   OPENAI_BASE_URL=http://localhost:3001
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const UPSTREAM_URL = process.env.OPENAI_BASE_URL_UPSTREAM
  || 'https://5i8frj7ann99bbw9gzpprvzj2esugg39hxbb4unypskq.node.k8s.prd.nos.ci/v1';

const upstream = new URL(UPSTREAM_URL);

const server = http.createServer((req, res) => {
  let body = '';

  req.on('data', chunk => { body += chunk; });

  req.on('end', () => {
    let outBody = body;

    // chat/completions 요청에만 enable_thinking: false 주입
    if (req.url?.includes('/chat/completions') && body) {
      try {
        const parsed = JSON.parse(body);
        // 'developer' role → 'system' 으로 변환 (vLLM은 developer role 미지원)
        if (Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map(m =>
            m.role === 'developer' ? { ...m, role: 'system' } : m
          );
        }
        if (!parsed.chat_template_kwargs) {
          parsed.chat_template_kwargs = { enable_thinking: false };
        }
        outBody = JSON.stringify(parsed);
      } catch {
        // JSON 파싱 실패 시 원본 그대로 전달
      }
    }

    const targetPath = upstream.pathname.replace(/\/$/, '') + (req.url || '/');
    const options = {
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: upstream.hostname,
        'content-length': Buffer.byteLength(outBody),
      },
    };

    const transport = upstream.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(options, proxyRes => {
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
║  🔀 LLM Proxy (enable_thinking: false)              ║
║  Listening : http://localhost:${PROXY_PORT}                 ║
║  Upstream  : ${UPSTREAM_URL.slice(0, 40)}...  ║
╚══════════════════════════════════════════════════════╝
  `);
});
