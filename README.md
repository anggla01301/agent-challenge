# 🔥 SolRoast — AI Solana Wallet Roaster

> Built for the [Nosana x ElizaOS Agent Challenge](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/)

SolRoast is an AI agent that analyzes your Solana wallet and **roasts you based on your on-chain activity**. Powered by ElizaOS, deployed on Nosana's decentralized GPU network, and running the Qwen3.5 model.

---

## What It Does

Give SolRoast your Solana wallet address and it will:
1. Fetch your SOL balance and token holdings via [Helius API](https://helius.dev)
2. Feed the data to Qwen3.5 running on Nosana's decentralized GPU network
3. Generate a savage, funny roast about your crypto portfolio

---

## Architecture

```
Browser (8080)
     ↓
SolRoast UI (frontend/server.js)
     ↓
ElizaOS REST API (port 3000)
     ↓
ROAST_WALLET Action (src/index.ts)
     ├── Helius API  ← on-chain wallet data
     └── LLM Proxy (port 3001)
              ↓
         Nosana Endpoint (Qwen3.5)
```

> **Why the LLM Proxy?**
> Qwen3.5 defaults to "thinking mode" which returns `content: null` with reasoning in a separate field.
> ElizaOS's AI SDK doesn't handle this, causing errors. The proxy intercepts all requests and adds
> `enable_thinking: false`, and also converts the `developer` role (sent by newer AI SDK versions)
> to `system` which vLLM understands.

---

## Running Locally

### 1. Install dependencies

```bash
bun install
bun install -g @elizaos/cli
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# LLM — via LLM proxy (localhost:3001 → Nosana endpoint)
OPENAI_BASE_URL=http://localhost:3001
OPENAI_BASE_URL_UPSTREAM=https://<nosana-node>.node.k8s.prd.nos.ci/v1
OPENAI_API_KEY=nosana
MODEL_NAME=Qwen3.5-9B-FP8
OPENAI_SMALL_MODEL=Qwen3.5-9B-FP8
OPENAI_LARGE_MODEL=Qwen3.5-9B-FP8

# Embeddings
OPENAI_EMBEDDING_URL=https://<nosana-embedding-node>.node.k8s.prd.nos.ci/v1
OPENAI_EMBEDDING_API_KEY=nosana
OPENAI_EMBEDDING_MODEL=Qwen3-Embedding-0.6B
OPENAI_EMBEDDING_DIMENSIONS=1024

# Helius API — get at helius.dev
HELIUS_API_KEY=your_helius_api_key
```

> **Note:** Nosana endpoint URLs change periodically. Get the latest from [Nosana Discord](https://nosana.com/discord).

### 3. Start all three servers

**Terminal 1 — LLM Proxy (port 3001)**
```bash
node llm-proxy.js
```

**Terminal 2 — ElizaOS Agent (port 3000)**
```bash
bun run dev
```

**Terminal 3 — SolRoast UI (port 8080)**
```bash
bun run frontend
```

Open **http://localhost:8080** in your browser.

---

## Project Structure

```
├── src/
│   └── index.ts                    # ROAST_WALLET custom action + plugin
├── characters/
│   └── agent.character.json        # SolRoast personality & plugins
├── frontend/
│   ├── index.html                  # SolRoast UI
│   ├── style.css                   # Dark fire theme
│   ├── app.js                      # ElizaOS API client
│   └── server.js                   # Static file server (port 8080)
├── llm-proxy.js                    # LLM proxy (enable_thinking + role fix)
├── nos_job_def/
│   └── nosana_eliza_job_definition.json  # Nosana deployment config
├── Dockerfile
└── .env.example
```

---

## Deploy to Nosana

### 1. Build and push Docker image

```bash
docker build -t <your-dockerhub-username>/solroast:latest .
docker login
docker push <your-dockerhub-username>/solroast:latest
```

### 2. Update job definition

Edit `nos_job_def/nosana_eliza_job_definition.json` and set your image name.

### 3. Deploy via Nosana Dashboard

1. Go to [deploy.nosana.com/deploy](https://deploy.nosana.com/deploy)
2. Connect your Solana wallet
3. Paste the contents of `nos_job_def/nosana_eliza_job_definition.json`
4. Select a GPU market (e.g. `nvidia-3090`)
5. Deploy

### 4. Deploy via Nosana CLI

```bash
npm install -g @nosana/cli

nosana job post \
  --file ./nos_job_def/nosana_eliza_job_definition.json \
  --market nvidia-4090 \
  --timeout 300 \
  --api <API_KEY>
```

---

## Troubleshooting

**`Unexpected message role.` error**
- The LLM proxy must be running (`node llm-proxy.js`)
- Check that `OPENAI_BASE_URL=http://localhost:3001` in `.env`

**`Not Found` from proxy**
- Make sure `OPENAI_BASE_URL_UPSTREAM` is set to the correct Nosana endpoint

**`Unable to connect` error**
- Proxy is not running, or `OPENAI_BASE_URL` is pointing directly to the Nosana endpoint without the proxy

**Nosana endpoint URL expired**
- Get the latest URL from [Nosana Discord](https://nosana.com/discord)

---

## Resources

- [ElizaOS Documentation](https://elizaos.github.io/eliza/docs)
- [Nosana Dashboard](https://deploy.nosana.com)
- [Helius API](https://helius.dev)
- [Nosana Discord](https://nosana.com/discord)

---

**Built with ElizaOS · Deployed on Nosana · Powered by Qwen3.5**
