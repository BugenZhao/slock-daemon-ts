# slock-daemon-ts-rewrite

A well-structured TypeScript rewrite of `@slock-ai/daemon` (npm package `0.6.0`) based on published runtime behavior.

## Goals

- Keep daemon behavior compatible with the published npm package.
- Split logic into clear modules with explicit types.
- Make local development and execution easy via `npm run` scripts.

## Project Structure

- `src/index.ts` - daemon entrypoint and websocket message dispatcher
- `src/connection.ts` - websocket connection manager with reconnect backoff
- `src/agentProcessManager.ts` - agent process lifecycle and workspace management
- `src/chat-bridge.ts` - MCP stdio server exposing chat tools
- `src/runtime-detection.ts` - local runtime binary detection
- `src/types.ts` - protocol and internal type definitions
- `src/drivers/` - runtime adapters
- `src/drivers/claude.ts` - Claude CLI adapter
- `src/drivers/codex.ts` - Codex CLI adapter
- `src/drivers/systemPrompt.ts` - shared system prompt builder

## Install

```bash
npm install
```

## Run

Development mode:

```bash
npm run dev -- --server-url http://localhost:3001 --api-key YOUR_KEY
```

Build:

```bash
npm run build
```

Run built daemon:

```bash
npm run start -- --server-url http://localhost:3001 --api-key YOUR_KEY
```

Typecheck:

```bash
npm run typecheck
```

## Chat Bridge

The chat bridge is built together with daemon as `dist/chat-bridge.js`.
It can also run directly in dev mode:

```bash
npm run dev:chat-bridge -- --agent-id AGENT_ID --server-url http://localhost:3001 --auth-token TOKEN
```

## Notes

- Persistent agent data is stored in `~/.slock/agents/<agentId>`.
- `MEMORY.md` and `notes/` are initialized automatically per agent workspace.
- Runtime support currently mirrors package behavior for `claude` and `codex`.
