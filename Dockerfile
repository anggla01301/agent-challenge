# syntax=docker/dockerfile:1

FROM node:23-slim AS base

# Install system dependencies needed for native modules (e.g. better-sqlite3)
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  git \
  curl \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Disable telemetry
ENV ELIZAOS_TELEMETRY_DISABLED=true
ENV DO_NOT_TRACK=1

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package manifest and install dependencies
COPY package.json ./
RUN pnpm install

# Copy all source files
COPY . .

# Build TypeScript
RUN pnpm run build

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000
EXPOSE 8080

ENV NODE_ENV=production
ENV SERVER_PORT=3000

# 프록시(3001) + ElizaOS(3000) + 프론트엔드(8080) 동시 실행
CMD ["sh", "-c", "node llm-proxy.js & node frontend/server.js & pnpm start"]
