import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import type { RuntimeDriver } from "./types.js";

const drivers: Record<string, RuntimeDriver> = {
  claude: new ClaudeDriver(),
  codex: new CodexDriver(),
};

export function getDriver(runtimeId: string): RuntimeDriver {
  const driver = drivers[runtimeId];
  if (!driver) {
    throw new Error(
      `Unknown runtime: ${runtimeId}. Available: ${Object.keys(drivers).join(", ")}`,
    );
  }
  return driver;
}
