import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentConfig, ParsedEvent } from "../types.js";

export interface DriverSpawnContext {
  agentId: string;
  config: AgentConfig;
  prompt: string;
  workingDirectory: string;
  chatBridgePath: string;
  daemonApiKey: string;
  codexOss: boolean;
  onAgentJsonIo?: (stream: "stdin" | "stdout" | "stderr", raw: string) => void;
}

export interface DriverSpawnResult {
  process: ChildProcessWithoutNullStreams;
}

export interface RuntimeDriver {
  readonly id: string;
  readonly supportsStdinNotification: boolean;
  readonly mcpToolPrefix: string;

  spawn(ctx: DriverSpawnContext): DriverSpawnResult;
  parseLine(line: string): ParsedEvent[];
  encodeStdinMessage(text: string, sessionId: string | null): string | null;
  buildSystemPrompt(config: AgentConfig, agentId: string): string;
  toolDisplayName(name: string): string;
  summarizeToolInput(name: string, input: unknown): string;
}
