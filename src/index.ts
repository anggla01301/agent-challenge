// ElizaOS 코어 타입 임포트
// Plugin: 플러그인 등록 구조체 타입
// Action: 에이전트가 수행할 수 있는 액션 타입
// IAgentRuntime: 런타임 컨텍스트 (에이전트 설정, DB 등 접근)
// Memory: 메시지 메모리 구조체 (사용자 입력 포함)
// State: 현재 대화 상태
// HandlerCallback: 액션 핸들러에서 응답을 돌려보내는 콜백 함수 타입
import { type Plugin, type Action, type IAgentRuntime, type Memory, type State, type HandlerCallback } from "@elizaos/core";

// Solana Web3.js — 온체인 데이터 조회용
// Connection: RPC 노드와의 연결 객체
// PublicKey: Solana 지갑 주소를 다루는 클래스
// LAMPORTS_PER_SOL: lamport → SOL 단위 변환 상수 (1 SOL = 1,000,000,000 lamports)
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

// Helius API 키 — SOL 잔액 및 토큰 목록 조회에 사용
// .env의 HELIUS_API_KEY가 없으면 빈 문자열로 폴백 (요청 실패로 이어질 수 있음)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

// Helius RPC 엔드포인트 — Solana 메인넷 연결용
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

/**
 * 주어진 Solana 지갑 주소의 온체인 데이터를 조회한다.
 * - SOL 잔액 (lamport → SOL 변환)
 * - 보유 토큰 목록 (Helius Balances API)
 */
async function getWalletData(walletAddress: string) {
  // Helius RPC로 연결 생성
  const connection = new Connection(HELIUS_RPC_URL);

  // 문자열 주소를 PublicKey 객체로 변환
  const pubkey = new PublicKey(walletAddress);

  // getBalance는 lamport 단위로 반환하므로 LAMPORTS_PER_SOL로 나눠 SOL 단위로 변환
  const balance = await connection.getBalance(pubkey);
  const solBalance = balance / LAMPORTS_PER_SOL;

  // Helius Balances API로 토큰 목록 조회
  const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${HELIUS_API_KEY}`
  );
  const data = await res.json();

  return {
    solBalance,
    tokens: data.tokens || [], // 토큰이 없으면 빈 배열 반환
  };
}

/**
 * Nosana 추론 엔드포인트(OpenAI 호환 API)에 프롬프트를 보내고 roast 텍스트를 반환한다.
 *
 * 왜 OPENAI_ 변수명을 쓰는가?
 *   Nosana는 OpenAI-compatible REST API를 제공하므로,
 *   ElizaOS의 @elizaos/plugin-openai가 동일한 env 변수를 읽어 Nosana 엔드포인트로 요청을 보낸다.
 *   즉 변수명은 OpenAI 형식이지만 실제 요청 대상은 Nosana 노드다.
 *
 * TEXT_LARGE 에러 방지:
 *   ElizaOS는 응답 텍스트가 일정 길이를 초과하면 TEXT_LARGE 타입으로 분류하는데,
 *   plugin-bootstrap에 TEXT_LARGE 핸들러가 없어 에러가 발생한다.
 *   max_tokens: 200으로 제한해 응답 길이를 TEXT 범위 내로 유지한다.
 */
async function generateRoast(prompt: string): Promise<string> {
  // Nosana 추론 엔드포인트 URL (.env의 OPENAI_BASE_URL)
  const apiUrl = process.env.OPENAI_BASE_URL || "";

  // Nosana 인증 키 (.env의 OPENAI_API_KEY = "nosana")
  const apiKey = process.env.OPENAI_API_KEY || "nosana";

  // 사용할 모델명 (기본값: Qwen3.5-27B-AWQ-4bit)
  const model = process.env.MODEL_NAME || "Qwen3.5-27B-AWQ-4bit";

  const res = await fetch(`${apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 350,
    }),
  });

  const data = await res.json();

  // choices[0]이 없으면 기본 메시지 반환
  return data.choices?.[0]?.message?.content ?? "No roast generated.";
}

/**
 * ROAST_WALLET 액션
 * 사용자 메시지에서 Solana 지갑 주소를 감지하면:
 *   1. 온체인 데이터 조회 (SOL 잔액, 토큰 수)
 *   2. Nosana LLM으로 roast 생성
 *   3. 요약 + roast를 콜백으로 전송
 */
const roastWalletAction: Action = {
  name: "ROAST_WALLET",
  description: "Analyzes a Solana wallet and roasts the owner based on their on-chain activity",

  // ElizaOS가 이 액션을 트리거할 수 있는 유사 키워드 목록
  similes: ["ANALYZE_WALLET", "ROAST", "CHECK_WALLET", "WALLET_ROAST"],

  /**
   * 메시지에 Solana 주소 패턴(Base58, 32~44자)이 있을 때만 액션을 활성화
   */
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text || "";
    // Solana 주소 정규식: Base58 문자(0/O/I/l 제외), 32~44자
    return /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text);
  },

  /**
   * 액션 핸들러 — 실제 roast 로직 실행
   */
  handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      _options?: Record<string, unknown>,
      callback?: HandlerCallback
  ) => {
    const text = message.content.text || "";

    // 메시지에서 Solana 주소 추출
    const match = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);

    if (!match) {
      // 주소가 없으면 안내 메시지 반환
      if (callback) await callback({ text: "올바른 Solana 지갑 주소를 입력해주세요." });
      return;
    }

    const walletAddress = match[0];

    try {
      // 온체인 데이터 조회
      const walletData = await getWalletData(walletAddress);

      // 토큰 이름 목록 (최대 10개)
      const tokenNames = walletData.tokens
        .slice(0, 10)
        .map((t: { symbol?: string; mint?: string }) => t.symbol || t.mint?.slice(0, 8))
        .filter(Boolean)
        .join(", ");

      // 랜덤 오프닝 스타일
      const openingStyles = [
        "BREAKING NEWS:",
        "VERDICT:",
        "Dear diary entry for this wallet:",
        "Official analysis:",
        "Attention:",
        "Court has reached a decision:",
        "This just in —",
        "A eulogy for this portfolio:",
      ];
      const openingStyle = openingStyles[Math.floor(Math.random() * openingStyles.length)];

      const prompt = `You are SolRoast, a savage on-chain comedian. Roast this Solana wallet in 3-4 sentences.

Wallet data:
- Address: ${walletAddress}
- SOL balance: ${walletData.solBalance.toFixed(4)}
- Token count: ${walletData.tokens.length}
- Tokens held: ${tokenNames || "none"}

Rules:
- Start with: "${openingStyle}"
- Pick the single weirdest or most roastable signal from the wallet data and build the entire joke around it
- Do NOT list numbers; turn this wallet into a character or tell a story
- Do NOT use these overused phrases: "broke", "dust wallet", "cooked", "exit liquidity", "ngmi", "probably nothing"
- End with one memorable final line: a nickname, verdict, curse, or title for this wallet
- Be creative, specific, and ruthlessly funny

Roast:`;

      // Nosana LLM으로 roast 생성
      const roast = await generateRoast(prompt);

      if (callback) {
        // 지갑 주소 앞 8자만 표시해 응답 길이 최소화
        const summary = `🔥 ${walletAddress.slice(0, 8)}... | ${walletData.solBalance.toFixed(4)} SOL | ${walletData.tokens.length} tokens`;
        await callback({
          text: `${summary}\n\n${roast}`,
        });
      }
    } catch (err) {
      // 온체인 조회 또는 LLM 호출 실패 시 에러 메시지 반환
      if (callback) await callback({ text: `❌ 오류 발생: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  // 예시 대화 (현재 미사용)
  examples: [],
};

/**
 * solroast-plugin
 * ElizaOS에 등록되는 플러그인 객체.
 * actions 배열에 ROAST_WALLET 액션을 포함시켜 에이전트가 사용할 수 있도록 한다.
 */
export const customPlugin: Plugin = {
  name: "solroast-plugin",
  description: "Roasts Solana wallet owners based on their on-chain activity",
  actions: [roastWalletAction],
  providers: [],   // 외부 데이터를 컨텍스트에 주입하는 프로바이더 (현재 미사용)
  evaluators: [],  // 대화 품질을 평가하는 이벨류에이터 (현재 미사용)
};

export default customPlugin;
