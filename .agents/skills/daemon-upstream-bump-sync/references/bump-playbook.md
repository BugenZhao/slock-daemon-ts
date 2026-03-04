# Bump Playbook

## Command Skeleton

```bash
# 1) confirm latest
npm view @slock-ai/daemon version dist-tags --json

# 2) fetch and unpack target (example: 0.7.0)
npm pack @slock-ai/daemon@0.7.0 --pack-destination ../npm-upstream
mkdir -p ../npm-upstream/v0.7.0
# If overwrite is unsupported, unpack into a new folder like v0.7.0b

tar -xzf ../npm-upstream/slock-ai-daemon-0.7.0.tgz -C ../npm-upstream/v0.7.0

# 3) compare dist files against baseline (example: 0.6.0)
git diff --no-index --stat ../npm-upstream/v0.6.0/package/dist/index.js ../npm-upstream/v0.7.0/package/dist/index.js
git diff --no-index --stat ../npm-upstream/v0.6.0/package/dist/chat-bridge.js ../npm-upstream/v0.7.0/package/dist/chat-bridge.js

git diff --no-index ../npm-upstream/v0.6.0/package/dist/index.js ../npm-upstream/v0.7.0/package/dist/index.js
git diff --no-index ../npm-upstream/v0.6.0/package/dist/chat-bridge.js ../npm-upstream/v0.7.0/package/dist/chat-bridge.js

# 4) bump local package version to aligned upstream version
npm pkg set version=0.7.0
# If package-lock.json exists, sync lockfile root versions as well
npm install --package-lock-only
```

## Mapping Heuristic

- Upstream `dist/index.js` changes usually map to:
  - `src/index.ts`
  - `src/agentProcessManager.ts`
  - `src/types.ts`
  - `src/drivers/*`
- Upstream `dist/chat-bridge.js` changes map to:
  - `src/chat-bridge.ts`

## Local-Enhancement Safety Checklist

- Keep `--disable-sleep-wake` semantics unchanged unless user asks otherwise.
- Keep `--verbose` JSON I/O tracing unchanged unless user asks otherwise.
- If upstream adds a field to ready/agent payloads, extend local types and preserve local fields.

## Validation Checklist

- `npm run typecheck` passes
- `npm run build` passes
- `package.json` version is bumped to the aligned upstream version
- If lockfile exists, `package-lock.json` root version entries are in sync
- README aligned version updated
- Final summary includes intentional deviations (if any)
