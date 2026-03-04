---
name: daemon-upstream-bump-sync
description: Align a local daemon implementation with new npm releases of @slock-ai/daemon while preserving local enhancements. Use when users ask to "align with upstream", "bump to latest", compare 2 npm versions, or sync behavior/protocol changes from upstream dist files into this repo.
---

# Daemon Upstream Bump Sync

## Overview

Use this skill to sync this repo to a newer `@slock-ai/daemon` npm release without losing local enhancements.
Focus on behavior parity first, then re-apply/retain local feature flags and debug capabilities.

For concrete command snippets and a parity checklist, read `references/bump-playbook.md`.

## Workflow

1. Confirm target version

- Query npm for latest/tag version of `@slock-ai/daemon`.
- Use explicit versions and dates in communication (for example: `0.7.0`, checked on `2026-03-04`).

2. Fetch and unpack upstream artifacts

- Download tarballs for both baseline and target versions with `npm pack`.
- Unpack into versioned folders under a local temp or `../npm-upstream/` style directory.
- Prefer creating new versioned directories instead of deleting old ones.

3. Diff upstream dist outputs

- Compare:
  - `dist/index.js`
  - `dist/chat-bridge.js`
  - `package.json` (if relevant)
- First produce a high-level diffstat, then inspect actual hunks.

4. Classify changes before coding

- Protocol changes: websocket message shapes, MCP tool payloads, new fields.
- Behavior changes: lifecycle, crash/exit handling, startup prompt, command routing.
- Presentation changes: formatting or text-only changes.
- Ignore minified/bundled noise unless it changes runtime behavior.

5. Map to local TypeScript sources

- Apply deltas to the corresponding TS modules (never copy dist JS directly).
- Preserve local enhancements unless explicitly asked to remove them.
- If upstream conflicts with a local enhancement, keep compatibility with upstream behavior and retain the enhancement behind existing flags when possible.

6. Validate

- Run at least:
  - `npm run typecheck`
  - `npm run build`
- If any validation step is skipped or fails, report it clearly.

7. Update docs

- Bump version text in root README to the new aligned version.
- Update enhancement notes only if behavior changed.

8. Report results

- Include:
  - Upstream version aligned
  - Key behavior/protocol deltas synced
  - Files changed
  - Validation status
  - Any intentional deviations from upstream

## Guardrails

- Do not run destructive cleanup commands (`git reset --hard`, broad `rm -rf` in shared dirs).
- Do not silently drop local flags/enhancements (`--disable-sleep-wake`, `--verbose`) during sync.
- Keep changes minimal and traceable to upstream diff hunks.
- Prefer deterministic, primary-source verification (npm tarball + local diff) over memory.
