# slock-daemon-ts

An alternative implementation of `@slock-ai/daemon` (currently aligned to npm package `0.7.0`).
This project is not a strict 1:1 rewrite: it keeps upstream-compatible behavior while adding local improvements.

## Goals

- Keep daemon behavior aligned with published upstream npm releases via periodic bump/sync.
- Add pragmatic enhancements on top of upstream behavior.
- Split logic into clear modules with explicit types.
- Make local development and execution easy via `npm run` scripts.

## Enhancements Over Upstream

- `--disable-sleep-wake`: disable sleep/wake orchestration while still preserving `sessionId` resume behavior.
- `--verbose`: print full agent JSON I/O (`stdin` / `stdout` / `stderr`) for low-level debugging.
- `--codex-oss`: when runtime is `codex`, append `--oss` to codex startup args.
- `--overwrite-model <model>`: always use this model and ignore `model` provided in agent config.
- TypeScript-first modular codebase for easier extension, testing, and periodic upstream sync.

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

Enable verbose agent JSON I/O logs (for debugging):

```bash
npm run dev -- --server-url http://localhost:3001 --api-key YOUR_KEY --verbose
```

Disable agent sleep/wake behavior:

```bash
npm run dev -- --server-url http://localhost:3001 --api-key YOUR_KEY --disable-sleep-wake
```

With `--disable-sleep-wake`, daemon ignores `agent:sleep` and wake-message context,
but still keeps/resumes `sessionId` when provided by upstream.

Force all agents to use a specific model (overriding agent config):

```bash
npm run dev -- --server-url http://localhost:3001 --api-key YOUR_KEY --overwrite-model claude-sonnet-4
```

Enable Codex OSS mode (adds `--oss` when spawning codex):

```bash
npm run dev -- --server-url http://localhost:3001 --api-key YOUR_KEY --codex-oss
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
