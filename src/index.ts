import { type Plugin, type Action, type IAgentRuntime, type Memory, type State, type HandlerCallback } from "@elizaos/core";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function getWalletData(walletAddress: string) {
  const connection = new Connection(HELIUS_RPC_URL);
  const pubkey = new PublicKey(walletAddress);
  const balance = await connection.getBalance(pubkey);
  const solBalance = balance / LAMPORTS_PER_SOL;

  const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${HELIUS_API_KEY}`
  );
  const data = await res.json();

  return {
    solBalance,
    tokens: data.tokens || [],
  };
}

async function generateRoast(prompt: string): Promise<string> {
  const apiUrl = process.env.OPENAI_BASE_URL || "";
  const apiKey = process.env.OPENAI_API_KEY || "nosana";
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
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "No roast generated.";
}

const roastWalletAction: Action = {
  name: "ROAST_WALLET",
  description: "Analyzes a Solana wallet and roasts the owner based on their on-chain activity",
  similes: ["ANALYZE_WALLET", "ROAST", "CHECK_WALLET", "WALLET_ROAST"],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text || "";
    return /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text);
  },

  handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      _options?: Record<string, unknown>,
      callback?: HandlerCallback
  ) => {
    const text = message.content.text || "";
    const match = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);

    if (!match) {
      if (callback) await callback({ text: "Please provide a valid Solana wallet address." });
      return;
    }

    const walletAddress = match[0];

    try {
      const walletData = await getWalletData(walletAddress);

      const tokenNames = walletData.tokens
        .slice(0, 10)
        .map((t: { symbol?: string; mint?: string }) => t.symbol || t.mint?.slice(0, 8))
        .filter(Boolean)
        .join(", ");

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

      const roast = await generateRoast(prompt);

      if (callback) {
        const summary = `🔥 ${walletAddress.slice(0, 8)}... | ${walletData.solBalance.toFixed(4)} SOL | ${walletData.tokens.length} tokens`;
        await callback({
          text: `${summary}\n\n${roast}`,
        });
      }
    } catch (err) {
      if (callback) await callback({ text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  examples: [],
};

const customPlugin: Plugin = {
  name: "solroast-plugin",
  description: "Roasts Solana wallet owners based on their on-chain activity",
  actions: [roastWalletAction],
  providers: [],
  evaluators: [],
};

// Load character from JSON file
const __dirname = dirname(fileURLToPath(import.meta.url));
const character = JSON.parse(
  readFileSync(join(__dirname, "../characters/agent.character.json"), "utf-8")
);

// Export project-style agent config so elizaos start picks up the plugin automatically
export default {
  agents: [
    {
      character,
      plugins: [customPlugin],
      init: async () => {},
    },
  ],
};
