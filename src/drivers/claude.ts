import { spawn } from "node:child_process";

import type { AgentConfig, ParsedEvent } from "../types.js";
import { buildBaseSystemPrompt } from "./systemPrompt.js";
import type {
  DriverSpawnContext,
  DriverSpawnResult,
  RuntimeDriver,
} from "./types.js";

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

/** Runtime adapter for Claude Code CLI stream-json protocol. */
export class ClaudeDriver implements RuntimeDriver {
  readonly id = "claude";
  readonly supportsStdinNotification = true;
  readonly mcpToolPrefix = "mcp__chat__";

  spawn(ctx: DriverSpawnContext): DriverSpawnResult {
    const mcpArgs = [
      ctx.chatBridgePath,
      "--agent-id",
      ctx.agentId,
      "--server-url",
      ctx.config.serverUrl,
      "--auth-token",
      ctx.config.authToken || ctx.daemonApiKey,
    ];

    const isTsSource = ctx.chatBridgePath.endsWith(".ts");
    const mcpConfig = JSON.stringify({
      mcpServers: {
        chat: {
          command: isTsSource ? "npx" : "node",
          args: isTsSource ? ["tsx", ...mcpArgs] : mcpArgs,
        },
      },
    });

    const args = [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--mcp-config",
      mcpConfig,
      "--model",
      ctx.config.model || "sonnet",
    ];

    if (ctx.config.sessionId) {
      args.push("--resume", ctx.config.sessionId);
    }

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
    delete spawnEnv.CLAUDECODE;

    const proc = spawn("claude", args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });

    const stdinMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: ctx.prompt }],
      },
      ...(ctx.config.sessionId ? { session_id: ctx.config.sessionId } : {}),
    });

    proc.stdin.write(`${stdinMessage}\n`);

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];

    switch (event.type) {
      case "system": {
        if (event.subtype === "init" && typeof event.session_id === "string") {
          events.push({ kind: "session_init", sessionId: event.session_id });
        }
        break;
      }

      case "assistant": {
        const message = asRecord(event.message);
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = asRecord(block);
            if (!b || typeof b.type !== "string") {
              continue;
            }

            if (b.type === "thinking" && typeof b.thinking === "string") {
              events.push({ kind: "thinking", text: b.thinking });
            } else if (b.type === "text" && typeof b.text === "string") {
              events.push({ kind: "text", text: b.text });
            } else if (b.type === "tool_use") {
              const name = typeof b.name === "string" ? b.name : "unknown_tool";
              events.push({ kind: "tool_call", name, input: b.input });
            }
          }
        }
        break;
      }

      case "result": {
        events.push({
          kind: "turn_end",
          sessionId: typeof event.session_id === "string" ? event.session_id : undefined,
        });
        break;
      }
    }

    return events;
  }

  encodeStdinMessage(text: string, sessionId: string | null): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  buildSystemPrompt(config: AgentConfig): string {
    return buildBaseSystemPrompt(config, {
      toolPrefix: "mcp__chat__",
      extraCriticalRules: [
        "- Do NOT use bash/curl/sqlite to send or receive messages. The MCP tools handle everything.",
      ],
      postStartupNotes: [],
      includeStdinNotificationSection: true,
    });
  }

  toolDisplayName(name: string): string {
    if (name.startsWith("mcp__chat__")) return "";
    if (name === "Read" || name === "read_file") return "Reading file...";
    if (name === "Write" || name === "write_file") return "Writing file...";
    if (name === "Edit" || name === "edit_file") return "Editing file...";
    if (name === "Bash" || name === "bash") return "Running command...";
    if (name === "Glob" || name === "glob") return "Searching files...";
    if (name === "Grep" || name === "grep") return "Searching code...";
    if (name === "WebFetch" || name === "web_fetch") return "Fetching web...";
    if (name === "WebSearch" || name === "web_search") return "Searching web...";
    if (name === "TodoWrite") return "Updating tasks...";
    return `Using ${name.length > 20 ? `${name.slice(0, 20)}...` : name}...`;
  }

  summarizeToolInput(name: string, input: unknown): string {
    const record = asRecord(input);
    if (!record) {
      return "";
    }

    try {
      if (name === "Read" || name === "read_file") {
        return String(record.file_path || record.path || "");
      }

      if (name === "Write" || name === "write_file") {
        return String(record.file_path || record.path || "");
      }

      if (name === "Edit" || name === "edit_file") {
        return String(record.file_path || record.path || "");
      }

      if (name === "Bash" || name === "bash") {
        const cmd = String(record.command || "");
        return cmd.length > 100 ? `${cmd.slice(0, 100)}...` : cmd;
      }

      if (name === "Glob" || name === "glob") return String(record.pattern || "");
      if (name === "Grep" || name === "grep") return String(record.pattern || "");
      if (name === "WebFetch" || name === "web_fetch") return String(record.url || "");
      if (name === "WebSearch" || name === "web_search") return String(record.query || "");

      if (name === "mcp__chat__send_message") {
        if (record.channel) return String(record.channel);
        if (record.dm_to) return `DM:@${String(record.dm_to)}`;
        return "";
      }

      if (name === "mcp__chat__read_history") {
        return String(record.channel || "");
      }

      return "";
    } catch {
      return "";
    }
  }
}
