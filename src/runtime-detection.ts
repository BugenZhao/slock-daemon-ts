import { execSync } from "node:child_process";

import type { RuntimeId } from "./types.js";

interface RuntimeSpec {
  id: RuntimeId;
  displayName: string;
  binary: string;
  supported: boolean;
}

const RUNTIMES: RuntimeSpec[] = [
  { id: "claude", displayName: "Claude Code", binary: "claude", supported: true },
  { id: "codex", displayName: "Codex CLI", binary: "codex", supported: true },
  { id: "gemini", displayName: "Gemini CLI", binary: "gemini", supported: false },
  { id: "kimi", displayName: "Kimi CLI", binary: "kimi", supported: false },
];

/** Detect which agent runtimes are available on the local machine. */
export function detectRuntimes(): RuntimeId[] {
  const detected: RuntimeId[] = [];

  for (const runtime of RUNTIMES) {
    try {
      execSync(`which ${runtime.binary}`, { stdio: "pipe" });
      detected.push(runtime.id);
    } catch {
      // Missing runtime is expected on many machines.
    }
  }

  return detected;
}
