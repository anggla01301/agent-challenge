/**
 * SolRoast 프론트엔드 정적 파일 서버
 * ══════════════════════════════════════════════════════════════
 * frontend/ 디렉토리의 HTML/CSS/JS를 HTTP로 서빙하는 경량 서버.
 *
 * 왜 별도 서버가 필요한가?
 *   ElizaOS는 포트 3000에서 REST API + 자체 내장 UI를 제공한다.
 *   커스텀 SolRoast UI는 별도 포트(8080)에서 서빙하고,
 *   브라우저에서 ElizaOS API(3000)로 fetch 요청을 보내는 구조.
 *
 * CORS 처리:
 *   프론트엔드(8080)가 API(3000)에 요청할 때 Same-Origin Policy에 걸림.
 *   ElizaOS 서버에서 CORS를 허용하거나,
 *   배포 시 같은 origin에서 서빙해 CORS를 피한다.
 *   (Nosana 배포 시 리버스 프록시로 단일 포트에서 처리)
 *
 * 사용법:
 *   node frontend/server.js
 *   → http://localhost:8080 에서 접근 가능
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ES Module에서 __dirname 대체
// __filename: 현재 파일의 절대 경로
// __dirname:  현재 파일이 있는 디렉토리 경로
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * 프론트엔드 서버 포트.
 * 환경 변수 FRONTEND_PORT가 없으면 기본 8080 사용.
 */
const PORT = parseInt(process.env.FRONTEND_PORT || '8080', 10);

/**
 * MIME 타입 매핑.
 * 파일 확장자 → Content-Type 헤더 값.
 * 브라우저가 파일을 올바르게 해석하도록 필요.
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

/**
 * HTTP 요청 핸들러.
 * 요청된 URL을 파일 경로로 변환해 정적 파일을 응답.
 *
 * URL → 파일 매핑:
 *   /           → frontend/index.html
 *   /style.css  → frontend/style.css
 *   /app.js     → frontend/app.js
 *
 * @param {http.IncomingMessage} req - 요청 객체
 * @param {http.ServerResponse}  res - 응답 객체
 */
function requestHandler(req, res) {
  // URL에서 쿼리스트링과 해시 제거
  let urlPath = req.url.split('?')[0].split('#')[0];

  // '/'는 index.html로 리다이렉트
  if (urlPath === '/') urlPath = '/index.html';

  // 경로 순회 공격 방지: '..'이 포함된 경로는 거부
  // normalize 후 __dirname 기준 경로인지 확인
  const filePath = path.normalize(path.join(__dirname, urlPath));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  // 파일 확장자로 MIME 타입 결정
  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  // 파일 읽기 & 응답
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // 파일 없음: 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        // 기타 오류: 500
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }

    // 성공 응답
    res.writeHead(200, {
      'Content-Type': mimeType,
      // 개발 환경에서 캐시 비활성화 (파일 변경 즉시 반영)
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
}

// HTTP 서버 생성 & 시작
const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  🔥 SolRoast Frontend                   ║
║  http://localhost:${PORT}               ║
║                                          ║
║  ElizaOS API: http://localhost:3000/api  ║
╚══════════════════════════════════════════╝
  `);
});
