/**
 * SolRoast — app.js
 * ══════════════════════════════════════════════════════════════
 * ElizaOS REST API와 통신해 SolRoast 에이전트를 구동하는 메인 스크립트.
 *
 * ElizaOS v2 메시지 플로우:
 *   1. GET  /api/agents                   → 에이전트 ID 조회
 *   2. POST /api/messaging/sessions       → 세션 생성 (agentId + userId 필요)
 *   3. POST /api/messaging/sessions/:id/messages → 메시지 전송
 *      └─ 응답이 POST 바디에 동기적으로 포함됨 (agentResponse.text)
 *
 * 모든 API 요청은 같은 출처(origin)의 ElizaOS 서버(포트 3000)로 보냄.
 * 프론트엔드도 같은 포트에서 서빙되므로 CORS 이슈 없음.
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
   상수
══════════════════════════════════════════════════════════════ */

/**
 * ElizaOS REST API 베이스 URL.
 * 개발환경: http://localhost:3000/api
 * 배포환경: 같은 origin에서 서빙되므로 상대 경로 '/api' 사용 가능하나,
 * 명시적으로 기록해둬 유지보수 편의성 향상.
 */
// 개발: ElizaOS가 3000번 포트에서 실행되므로 절대 URL 사용
// 배포: 같은 origin에서 서빙될 경우 '/api'로 변경
const API_BASE     = '/api';
const MESSAGING_BASE = '/api/messaging';

/**
 * 응답 폴링 설정 (현재 미사용 — 응답은 POST 바디에 동기적으로 수신).
 * 비동기 방식으로 전환 시를 대비해 유지.
 */
const POLL_INTERVAL_MS  = 3000;
const POLL_MAX_ATTEMPTS = 100;

/**
 * 타이핑 애니메이션 속도.
 * roast 텍스트를 한 글자씩 출력할 때의 딜레이(ms).
 */
const TYPING_SPEED_MS = 25;

/**
 * Solana 지갑 주소 정규식.
 * Base58 인코딩: 0, O, I, l 제외한 영숫자, 길이 32~44자.
 */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * 파티클 수.
 * 배경에 생성할 불꽃 파티클 개수. 너무 많으면 성능 저하.
 */
const PARTICLE_COUNT = 20;


/* ══════════════════════════════════════════════════════════════
   전역 상태
══════════════════════════════════════════════════════════════ */

/**
 * ElizaOS에서 조회한 에이전트 ID.
 * 페이지 로드 시 fetchAgentId()로 설정됨.
 * 모든 세션 생성 시 필요.
 * @type {string|null}
 */
let agentId = null;
let socket = null;

/**
 * 현재 표시된 roast 텍스트.
 * 복사 및 X 공유 버튼에서 사용.
 * @type {string}
 */
let currentRoastText = '';

/**
 * 현재 분석 중인 지갑 주소.
 * 공유 버튼 메시지에 포함.
 * @type {string}
 */
let currentWalletAddress = '';


/* ══════════════════════════════════════════════════════════════
   초기화
══════════════════════════════════════════════════════════════ */

/**
 * DOMContentLoaded 이벤트 리스너.
 * HTML이 완전히 파싱된 후 실행:
 *   1. 배경 파티클 생성
 *   2. 에이전트 ID 비동기 조회
 *   3. 인풋에 Enter 키 이벤트 등록
 */
document.addEventListener('DOMContentLoaded', () => {
  // 배경 파티클 초기화
  initParticles();

  // ElizaOS에서 에이전트 ID 조회 (백그라운드, UI 블로킹 없음)
  fetchAgentId();

  // SocketIO 연결 초기화
  initSocket();

  // 인풋 필드: Enter 키로 roast 시작
  const input = document.getElementById('walletInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !document.getElementById('roastBtn').disabled) {
        handleRoast();
      }
    });
  }
});

/**
 * SocketIO 연결 초기화.
 * ElizaOS 서버(3000)에 연결하고 messageBroadcast 이벤트 수신 준비.
 */
function initSocket() {
  const userId = getUserId();
  socket = io(window.location.origin, {
    auth: { entityId: userId },
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    console.log('[SolRoast] SocketIO 연결됨:', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('[SolRoast] SocketIO 연결 끊김');
  });
}

/**
 * 세션 채널에 SocketIO로 참여하고 roast 응답을 기다린다.
 * @param {string} channelId - 참여할 채널 ID
 * @param {string} sentAt - 메시지 전송 시각
 * @returns {Promise<string>} roast 텍스트
 */
function waitForRoast(channelId, sentAt) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('messageBroadcast', onMessage);
      reject(new Error('응답 타임아웃: 5분 내 응답 없음'));
    }, 5 * 60 * 1000);

    function onMessage(data) {
      const text = data.text || '';
      // 🔥 가 포함된 실제 roast 응답만 수신
      if (data.roomId === channelId && text.includes('🔥') && text.length > 20) {
        clearTimeout(timeout);
        socket.off('messageBroadcast', onMessage);
        resolve(text);
      }
    }

    // 채널 참여
    socket.emit('1', {
      channelId,
      agentId,
      entityId: getUserId(),
      messageServerId: '00000000-0000-0000-0000-000000000000',
    });

    socket.on('messageBroadcast', onMessage);
  });
}

/**
 * userId를 sessionStorage에서 가져오거나 새로 생성.
 */
function getUserId() {
  let userId = sessionStorage.getItem('solroast_user_id');
  if (!userId) {
    userId = crypto.randomUUID();
    sessionStorage.setItem('solroast_user_id', userId);
  }
  return userId;
}


/* ══════════════════════════════════════════════════════════════
   파티클 시스템
══════════════════════════════════════════════════════════════ */

/**
 * 배경 파티클을 생성하고 컨테이너에 추가한다.
 * 각 파티클은 랜덤한 위치·크기·색상·애니메이션 딜레이를 가진다.
 * CSS @keyframes 'floatUp'이 실제 이동 처리.
 */
function initParticles() {
  const container = document.getElementById('particles');
  if (!container) return;

  // 파이어 팔레트: 색상을 랜덤으로 선택해 자연스러운 불꽃 표현
  const fireColors = ['#ff2200', '#ff6600', '#ff8c00', '#ffd700', '#ff4400'];

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const particle = document.createElement('span');
    particle.className = 'particle';

    // 랜덤 수평 위치: 0% ~ 100%
    particle.style.left = `${Math.random() * 100}%`;

    // 랜덤 크기: 2px ~ 6px (작은 파티클이 더 멀리 있는 원근감)
    const size = 2 + Math.random() * 4;
    particle.style.width  = `${size}px`;
    particle.style.height = `${size}px`;

    // 랜덤 색상
    particle.style.background = fireColors[Math.floor(Math.random() * fireColors.length)];

    // 랜덤 애니메이션 딜레이: 0s ~ 6s (한꺼번에 올라가지 않도록)
    particle.style.animationDelay = `${Math.random() * 6}s`;

    // 랜덤 지속시간: 4s ~ 8s (속도 다양성)
    particle.style.animationDuration = `${4 + Math.random() * 4}s`;

    container.appendChild(particle);
  }
}


/* ══════════════════════════════════════════════════════════════
   ElizaOS API 통신
══════════════════════════════════════════════════════════════ */

/**
 * ElizaOS 에이전트 목록을 조회하고 첫 번째 에이전트의 ID를 저장한다.
 *
 * 엔드포인트: GET /api/agents
 * 응답 예시: { agents: [{ id: "uuid", name: "SolRoast", ... }] }
 *
 * 에이전트가 아직 시작 중이면 재시도. 최대 10초 대기.
 */
async function fetchAgentId() {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 2000; // 2초

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${API_BASE}/agents`);

      if (!response.ok) {
        // 서버가 응답했지만 에러 상태 (4xx/5xx)
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // ElizaOS v2 응답 구조: { success: true, data: { agents: [...] } }
      const agents = data.data?.agents || data.agents || data;

      if (Array.isArray(agents) && agents.length > 0) {
        agentId = agents[0].id;
        console.log(`[SolRoast] 에이전트 ID 조회 성공: ${agentId}`);
        return;
      }

      // 에이전트 목록이 비어있으면 아직 초기화 중
      console.warn(`[SolRoast] 에이전트 목록 비어있음. ${attempt + 1}/${MAX_RETRIES} 재시도...`);

    } catch (err) {
      console.warn(`[SolRoast] 에이전트 ID 조회 실패 (${attempt + 1}/${MAX_RETRIES}):`, err.message);
    }

    // 다음 시도 전 대기
    if (attempt < MAX_RETRIES - 1) {
      await delay(RETRY_DELAY);
    }
  }

  console.error('[SolRoast] 에이전트 ID 조회 최종 실패. 수동으로 새로고침 필요.');
}

/**
 * ElizaOS 세션을 생성한다.
 *
 * 엔드포인트: POST /api/messaging/sessions
 * 요청 바디: { agentId, userId }
 * 응답 예시: { sessionId: "uuid", channelId: "uuid", ... }
 *
 * @param {string} agentIdParam - 대화할 에이전트의 ID
 * @returns {Promise<string>} 생성된 세션 ID
 * @throws {Error} 세션 생성 실패 시
 */
async function createSession(agentIdParam) {
  /**
   * userId: 사용자 식별자.
   * 실제 인증 시스템이 없으므로 브라우저 세션마다 UUID를 생성.
   * sessionStorage: 탭을 닫으면 초기화 (localStorage보다 프라이버시 친화적)
   */
  const userId = getUserId();

  const response = await fetch(`${MESSAGING_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agentIdParam,
      userId,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`세션 생성 실패: HTTP ${response.status} — ${errorText}`);
  }

  const data = await response.json();

  // 응답 구조: { sessionId: "...", ... } 또는 { data: { sessionId: "..." } }
  const sessionId = data.sessionId || data.data?.sessionId;
  const channelId = data.channelId || data.data?.channelId || sessionId;
  if (!sessionId) {
    throw new Error('세션 ID를 응답에서 찾을 수 없음');
  }

  return { sessionId, channelId };
}

/**
 * 세션에 메시지를 전송하고 에이전트 응답을 반환한다.
 *
 * 엔드포인트: POST /api/messaging/sessions/:sessionId/messages
 * 요청 바디: { content: string }
 *
 * ElizaOS는 응답을 POST 바디에 동기적으로 포함해 반환한다.
 * 응답 구조: { agentResponse: { text: string, ... }, ... }
 *
 * @param {string} sessionId - 대상 세션 ID
 * @param {string} text - 전송할 메시지 텍스트
 * @returns {Promise<object>} ElizaOS 응답 객체 (agentResponse 포함)
 * @throws {Error} 전송 실패 시
 */
async function sendMessage(sessionId, text) {
  const response = await fetch(`${MESSAGING_BASE}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // ElizaOS v2: content는 객체가 아닌 문자열이어야 함
      content: text,
      transport: 'sync',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`메시지 전송 실패: HTTP ${response.status} — ${errorText}`);
  }

  const responseData = await response.json().catch(() => null);
  return responseData;
}

/**
 * 세션의 최신 메시지를 폴링해 에이전트 응답을 기다린다.
 *
 * ElizaOS는 메시지를 비동기로 처리하므로,
 * 에이전트가 응답을 추가할 때까지 주기적으로 GET 요청을 보낸다.
 *
 * 엔드포인트: GET /api/messaging/sessions/:sessionId/messages
 * 에이전트 응답 조건: role이 'agent' 또는 'assistant'이고 내 메시지 이후에 추가된 것
 *
 * @param {string} sessionId - 폴링할 세션 ID
 * @param {number} sentAt - 메시지 전송 시각 (timestamp). 이후 응답만 유효.
 * @returns {Promise<string>} 에이전트 응답 텍스트
 * @throws {Error} 타임아웃 또는 오류 발생 시
 */
async function pollForResponse(sessionId, sentAt) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    // 폴링 간격 대기
    await delay(POLL_INTERVAL_MS);

    try {
      const response = await fetch(`${MESSAGING_BASE}/sessions/${sessionId}/messages`);

      if (!response.ok) continue; // 일시적 오류면 재시도

      const data = await response.json();

      // 메시지 배열 위치: { messages: [...] } 또는 { data: [...] } 또는 [...]
      const messages = data.messages || data.data || data;

      if (!Array.isArray(messages)) continue;

      // 에이전트가 보낸 메시지 중 내 메시지 이후 것 찾기
      const agentMessages = messages.filter((msg) => {
        const isAgent = msg.isAgent === true || msg.role === 'agent' || msg.role === 'assistant';
        const isAfterSend = new Date(msg.createdAt || msg.timestamp || 0).getTime() >= sentAt;
        return isAgent && isAfterSend;
      });
      if (agentMessages.length > 0) {
        // 가장 최근 메시지의 텍스트 반환
        const lastMsg = agentMessages[agentMessages.length - 1];
        const text = lastMsg.content?.text || lastMsg.text || '';

        // 빈 응답이거나 "분석 중..." 같은 중간 메시지는 건너뜀
        if (text && text.length > 10 && !text.includes('분석 중')) {
          return text;
        }
      }

    } catch (err) {
      // 폴링 중 네트워크 오류는 무시하고 재시도
      console.warn(`[SolRoast] 폴링 시도 ${attempt + 1} 실패:`, err.message);
    }
  }

  throw new Error(`응답 타임아웃: ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}초 내 응답 없음`);
}


/* ══════════════════════════════════════════════════════════════
   메인 핸들러
══════════════════════════════════════════════════════════════ */

/**
 * ROAST IT 버튼 클릭 또는 Enter 키 시 실행되는 메인 핸들러.
 * HTML onclick="handleRoast()"로 바인딩.
 *
 * 흐름:
 *   1. 입력 유효성 검사
 *   2. 로딩 UI 표시
 *   3. 에이전트 ID 확인 (없으면 재조회)
 *   4. 세션 생성
 *   5. 메시지 전송 → POST 응답에서 agentResponse.text 추출
 *   6. 결과 파싱 & 표시
 *   7. 에러 처리
 */
async function handleRoast() {
  // ── 1. 입력값 가져오기 & 유효성 검사 ──
  const input = document.getElementById('walletInput');
  const walletAddress = input.value.trim();

  clearError(); // 이전 에러 메시지 초기화

  if (!walletAddress) {
    showError('지갑 주소를 입력해주세요.');
    return;
  }

  if (!SOLANA_ADDRESS_REGEX.test(walletAddress)) {
    showError('올바른 Solana 지갑 주소 형식이 아닙니다. (32~44자 Base58)');
    return;
  }

  currentWalletAddress = walletAddress;

  // ── 2. 로딩 UI 활성화 ──
  setButtonLoading(true);
  showLoading('지갑 연결 중...');

  try {
    // ── 3. 에이전트 ID 확인 ──
    if (!agentId) {
      updateLoadingText('에이전트 초기화 중...');
      await fetchAgentId();

      if (!agentId) {
        throw new Error('ElizaOS 에이전트를 찾을 수 없습니다. 서버가 실행 중인지 확인하세요.');
      }
    }

    // ── 4. 세션 생성 ──
    updateLoadingText('세션 생성 중...');
    const { sessionId } = await createSession(agentId);
    console.log(`[SolRoast] 세션 생성됨: ${sessionId}`);

    // ── 5. 메시지 전송 & 응답 수신 ──
    updateLoadingText('AI가 roast 작성 중... 🔥');
    const roastMessage = `Roast this Solana wallet: ${walletAddress}`;

    const msgResponse = await sendMessage(sessionId, roastMessage);

    // roast는 agentResponse.actionCallbacks.text에 있음
    const responseText = msgResponse?.agentResponse?.actionCallbacks?.text
      || msgResponse?.agentResponse?.text;

    if (!responseText) {
      throw new Error('roast 응답을 받지 못했습니다.');
    }

    // ── 6. 결과 파싱 & 표시 ──
    const parsed = parseResponse(responseText, walletAddress);
    showResult(parsed);

  } catch (err) {
    // ── 8. 에러 처리 ──
    console.error('[SolRoast] 처리 중 오류:', err);
    hideLoading();
    showError(`오류 발생: ${err.message}`);

  } finally {
    // 버튼은 결과 표시 이후에도 비활성 상태 유지 (resetUI()로 리셋)
    setButtonLoading(false);
  }
}

/**
 * ElizaOS 응답 텍스트를 파싱해 UI에 필요한 구조체로 변환한다.
 *
 * 에이전트 응답 형식 (src/index.ts에서 정의):
 *   "🔥 XXXXXXXX... | 1.2345 SOL | 12 tokens\n\n[roast text]"
 *
 * @param {string} text - ElizaOS 에이전트의 응답 텍스트
 * @param {string} walletAddress - 분석한 지갑 주소 (파싱 실패 시 폴백용)
 * @returns {{ sol: string, tokens: string, address: string, roast: string }}
 */
function parseResponse(text, walletAddress) {
  // 응답에서 줄 구분
  const lines = text.split('\n').filter(Boolean);

  let sol = '—';
  let tokens = '—';
  let roast = text; // 파싱 실패 시 전체 텍스트를 roast로 표시

  // 첫 번째 줄에서 통계 파싱: "🔥 XXXXXXXX... | 1.2345 SOL | 12 tokens"
  // 정확한 포맷 기준 파싱으로 roast 텍스트 내 SOL/tokens 언급과 혼동 방지
  const summaryLine = lines[0] || '';
  const summaryMatch = summaryLine.match(/🔥\s+\S+\s*\|\s*([\d.]+)\s*SOL\s*\|\s*(\d+)\s*tokens?/);

  if (summaryMatch) {
    sol    = `${summaryMatch[1]} SOL`;
    tokens = summaryMatch[2];
  }

  // 빈 줄 이후의 텍스트가 실제 roast 내용
  const separatorIndex = text.indexOf('\n\n');
  if (separatorIndex !== -1) {
    roast = text.slice(separatorIndex + 2).trim();
  }

  // roast가 비어있으면 전체 텍스트 사용
  if (!roast) roast = text;

  return {
    sol,
    tokens,
    address: walletAddress,
    roast,
  };
}


/* ══════════════════════════════════════════════════════════════
   UI 상태 관리
══════════════════════════════════════════════════════════════ */

/**
 * 로딩 섹션을 표시하고 입력 섹션을 숨긴다.
 * @param {string} message - 로딩 텍스트 초기 메시지
 */
function showLoading(message) {
  const loadingSection = document.getElementById('loadingSection');
  const inputSection   = document.querySelector('.input-section');
  const resultSection  = document.getElementById('resultSection');

  if (inputSection)   inputSection.style.display   = 'none';
  if (resultSection)  resultSection.style.display  = 'none';
  if (loadingSection) {
    loadingSection.style.display = 'flex';
    updateLoadingText(message);
  }
}

/**
 * 로딩 텍스트를 업데이트한다.
 * 분석 단계마다 진행 상황을 사용자에게 알려줌.
 * @param {string} message - 새 메시지
 */
function updateLoadingText(message) {
  const el = document.getElementById('loadingText');
  if (el) el.textContent = message;
}

/**
 * 로딩 섹션을 숨기고 입력 섹션을 다시 표시한다.
 */
function hideLoading() {
  const loadingSection = document.getElementById('loadingSection');
  const inputSection   = document.querySelector('.input-section');

  if (loadingSection) loadingSection.style.display = 'none';
  if (inputSection)   inputSection.style.display   = 'block';
}

/**
 * 결과 섹션을 표시하고 데이터를 채운다.
 * 통계 카드와 roast 카드를 순서대로 렌더링.
 *
 * @param {{ sol: string, tokens: string, address: string, roast: string }} data
 */
function showResult(data) {
  // 로딩 숨기기
  const loadingSection = document.getElementById('loadingSection');
  if (loadingSection) loadingSection.style.display = 'none';

  // 통계 카드 채우기
  const statSol     = document.getElementById('statSol');
  const statTokens  = document.getElementById('statTokens');
  const statAddress = document.getElementById('statAddress');

  if (statSol)     statSol.textContent     = data.sol;
  if (statTokens)  statTokens.textContent  = data.tokens;
  if (statAddress) statAddress.textContent = data.address;

  // 결과 섹션 표시
  const resultSection = document.getElementById('resultSection');
  if (resultSection) resultSection.style.display = 'flex';

  // roast 텍스트를 타이핑 애니메이션으로 표시
  currentRoastText = data.roast;
  typewriterEffect('roastText', data.roast);
}

/**
 * UI를 초기 상태(입력 폼)로 되돌린다.
 * "Roast Another" 버튼 클릭 시 호출.
 * HTML onclick="resetUI()"로 바인딩.
 */
function resetUI() {
  const inputSection  = document.querySelector('.input-section');
  const resultSection = document.getElementById('resultSection');
  const loadingSection = document.getElementById('loadingSection');

  if (resultSection)  resultSection.style.display  = 'none';
  if (loadingSection) loadingSection.style.display = 'none';
  if (inputSection)   inputSection.style.display   = 'block';

  // 인풋 초기화 & 포커스
  const input = document.getElementById('walletInput');
  if (input) {
    input.value = '';
    input.focus();
  }

  clearError();
  currentRoastText = '';
  currentWalletAddress = '';
}

/**
 * ROAST IT 버튼을 로딩/일반 상태로 전환한다.
 * @param {boolean} isLoading - true: 로딩 상태 (비활성화 + 스피너)
 */
function setButtonLoading(isLoading) {
  const btn = document.getElementById('roastBtn');
  if (!btn) return;

  btn.disabled = isLoading;

  if (isLoading) {
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.classList.remove('loading');
    btn.removeAttribute('aria-busy');
  }
}

/**
 * 에러 메시지를 표시한다.
 * @param {string} message - 표시할 에러 메시지
 */
function showError(message) {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = message;
}

/**
 * 에러 메시지를 초기화한다.
 */
function clearError() {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = '';
}


/* ══════════════════════════════════════════════════════════════
   타이핑 애니메이션
══════════════════════════════════════════════════════════════ */

/**
 * 텍스트를 한 글자씩 타이핑하는 애니메이션 효과.
 * 타이핑 중에는 커서(|)가 표시되고, 완료되면 커서 제거.
 *
 * @param {string} elementId - 텍스트를 채울 요소의 ID
 * @param {string} text - 표시할 전체 텍스트
 */
function typewriterEffect(elementId, text) {
  const el = document.getElementById(elementId);
  if (!el) return;

  // 초기화
  el.textContent = '';
  el.classList.add('typing'); // 커서 표시 (CSS .typing::after)

  let index = 0;

  /**
   * 재귀적으로 한 글자씩 추가.
   * setInterval 대신 재귀 setTimeout 사용:
   * → 각 글자 렌더링 후 다음 딜레이를 설정하므로 더 일정한 타이밍
   */
  function typeNext() {
    if (index < text.length) {
      el.textContent += text[index];
      index++;

      // 구두점(.,!?) 뒤에는 살짝 더 긴 딜레이 — 자연스러운 타이핑 리듬
      const char = text[index - 1];
      const extraDelay = /[.,!?]/.test(char) ? 100 : 0;

      setTimeout(typeNext, TYPING_SPEED_MS + extraDelay);
    } else {
      // 타이핑 완료: 커서 제거
      el.classList.remove('typing');
    }
  }

  typeNext();
}


/* ══════════════════════════════════════════════════════════════
   공유 & 복사 기능
══════════════════════════════════════════════════════════════ */

/**
 * roast 텍스트를 클립보드에 복사한다.
 * HTML onclick="copyRoast()"로 바인딩.
 *
 * navigator.clipboard API: HTTPS 또는 localhost에서만 사용 가능.
 * 복사 성공 시 버튼 텍스트를 "Copied!" 로 변경해 피드백 제공.
 */
async function copyRoast() {
  if (!currentRoastText) return;

  const copyText = `🔥 SolRoast result for ${currentWalletAddress}:\n\n${currentRoastText}\n\nPowered by @nosana_ai`;

  try {
    await navigator.clipboard.writeText(copyText);

    // 성공 피드백: 버튼 텍스트 임시 변경
    const btn = document.querySelector('.action-btn--copy');
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = '<span>✅</span> Copied!';
      btn.style.color = '#00ffa3'; // 초록색

      // 2초 후 원래대로 복구
      setTimeout(() => {
        btn.innerHTML = original;
        btn.style.color = '';
      }, 2000);
    }

  } catch (err) {
    // clipboard API 실패 시 (비보안 컨텍스트 등) 알림
    console.error('[SolRoast] 클립보드 복사 실패:', err);
    alert('복사에 실패했습니다. 텍스트를 직접 선택해 복사해주세요.');
  }
}

/**
 * roast 결과를 X(트위터)에 공유한다.
 * HTML onclick="shareOnX()"로 바인딩.
 *
 * twitter.com/intent/tweet URL 파라미터:
 *   - text: 트윗 본문 (URL 인코딩 필요)
 *   - via: 멘션할 계정 (nosana_ai)
 */
function shareOnX() {
  if (!currentRoastText) return;

  // 트윗 텍스트 구성 (280자 제한 고려해 짧게)
  const shortRoast = currentRoastText.slice(0, 200);
  const tweetText  = `🔥 My Solana wallet just got roasted by AI:\n\n"${shortRoast}"\n\n#SolRoast #Solana @nosana_ai`;

  // URL 인코딩: 특수문자가 URL 파라미터를 깨지 않도록
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

  // 새 탭에서 트위터 공유 팝업 열기
  window.open(tweetUrl, '_blank', 'noopener,noreferrer');
}


/* ══════════════════════════════════════════════════════════════
   유틸리티
══════════════════════════════════════════════════════════════ */

/**
 * 지정된 시간(ms)만큼 비동기 대기한다.
 * async/await 코드에서 sleep처럼 사용.
 *
 * @param {number} ms - 대기 시간 (밀리초)
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
