import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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

/** Runtime adapter for Codex CLI JSON event stream. */
export class CodexDriver implements RuntimeDriver {
  readonly id = "codex";
  readonly supportsStdinNotification = false;
  readonly mcpToolPrefix = "mcp_chat_";

  spawn(ctx: DriverSpawnContext): DriverSpawnResult {
    const gitDir = path.join(ctx.workingDirectory, ".git");
    if (!existsSync(gitDir)) {
      execSync("git init", { cwd: ctx.workingDirectory, stdio: "pipe" });
      execSync("git add -A && git commit --allow-empty -m 'init'", {
        cwd: ctx.workingDirectory,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "slock",
          GIT_AUTHOR_EMAIL: "slock@local",
          GIT_COMMITTER_NAME: "slock",
          GIT_COMMITTER_EMAIL: "slock@local",
        },
      });
    }

    const isTsSource = ctx.chatBridgePath.endsWith(".ts");
    const command = isTsSource ? "npx" : "node";
    const bridgeArgs = isTsSource
      ? [
          "tsx",
          ctx.chatBridgePath,
          "--agent-id",
          ctx.agentId,
          "--server-url",
          ctx.config.serverUrl,
          "--auth-token",
          ctx.config.authToken || ctx.daemonApiKey,
        ]
      : [
          ctx.chatBridgePath,
          "--agent-id",
          ctx.agentId,
          "--server-url",
          ctx.config.serverUrl,
          "--auth-token",
          ctx.config.authToken || ctx.daemonApiKey,
        ];

    const args: string[] = ["exec"];
    if (ctx.config.sessionId) {
      args.push("resume", ctx.config.sessionId);
    }

    args.push("--dangerously-bypass-approvals-and-sandbox", "--json");

    args.push(
      "-c",
      `mcp_servers.chat.command=${JSON.stringify(command)}`,
      "-c",
      `mcp_servers.chat.args=${JSON.stringify(bridgeArgs)}`,
      "-c",
      "mcp_servers.chat.startup_timeout_sec=30",
      "-c",
      "mcp_servers.chat.tool_timeout_sec=120",
      "-c",
      "mcp_servers.chat.enabled=true",
      "-c",
      "mcp_servers.chat.required=true",
    );

    if (ctx.config.model) {
      args.push("-m", ctx.config.model);
    }

    if (ctx.config.reasoningEffort) {
      args.push("-c", `model_reasoning_effort=${ctx.config.reasoningEffort}`);
    }

    args.push(ctx.prompt);

    const proc = spawn("codex", args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

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
      case "thread.started":
        if (typeof event.thread_id === "string") {
          events.push({ kind: "session_init", sessionId: event.thread_id });
        }
        break;

      case "turn.started":
        events.push({ kind: "thinking", text: "" });
        break;

      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = asRecord(event.item);
        if (!item || typeof item.type !== "string") {
          break;
        }

        switch (item.type) {
          case "reasoning":
            if (typeof item.text === "string") {
              events.push({ kind: "thinking", text: item.text });
            }
            break;

          case "agent_message":
            if (event.type === "item.completed" && typeof item.text === "string") {
              events.push({ kind: "text", text: item.text });
            }
            break;

          case "command_execution":
            if (event.type === "item.started") {
              events.push({
                kind: "tool_call",
                name: "shell",
                input: { command: String(item.command || "") },
              });
            }
            break;

          case "file_change":
            if (event.type === "item.started" && Array.isArray(item.changes)) {
              for (const change of item.changes) {
                const c = asRecord(change);
                if (!c) continue;
                events.push({
                  kind: "tool_call",
                  name: "file_change",
                  input: { path: String(c.path || ""), kind: String(c.kind || "") },
                });
              }
            }
            break;

          case "mcp_tool_call":
            if (event.type === "item.started") {
              const server = typeof item.server === "string" ? item.server : "";
              const tool = typeof item.tool === "string" ? item.tool : "mcp_tool";
              const toolName =
                server && tool
                  ? `${this.mcpToolPrefix.replace(/_$/, "")}_${server}_${tool}`
                  : tool;
              const name = server === "chat" ? `${this.mcpToolPrefix}${tool}` : toolName;

              events.push({
                kind: "tool_call",
                name,
                input: item.arguments,
              });
            }
            break;

          case "collab_tool_call":
            if (event.type === "item.started") {
              events.push({ kind: "tool_call", name: "collab_tool_call", input: {} });
            }
            break;

          case "todo_list":
            if (event.type === "item.started" || event.type === "item.updated") {
              events.push({
                kind: "thinking",
                text: typeof item.title === "string" ? item.title : "Planning...",
              });
            }
            break;

          case "web_search":
            if (event.type === "item.started") {
              events.push({
                kind: "tool_call",
                name: "web_search",
                input: { query: String(item.query || "") },
              });
            }
            break;

          case "error":
            if (typeof item.message === "string") {
              events.push({ kind: "error", message: item.message });
            }
            break;
        }

        break;
      }

      case "turn.completed":
        events.push({ kind: "turn_end" });
        break;

      case "turn.failed":
        if (asRecord(event.error)?.message && typeof asRecord(event.error)?.message === "string") {
          events.push({ kind: "error", message: String(asRecord(event.error)?.message) });
        }
        events.push({ kind: "turn_end" });
        break;

      case "error":
        events.push({
          kind: "error",
          message: typeof event.message === "string" ? event.message : "Unknown error",
        });
        break;
    }

    return events;
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig): string {
    return buildBaseSystemPrompt(config, {
      toolPrefix: "",
      extraCriticalRules: [
        "- Do NOT use shell commands to send or receive messages. The MCP tools handle everything.",
        "- ALWAYS call receive_message(block=true) after completing any task.",
      ],
      postStartupNotes: [
        "IMPORTANT: Your process exits after each turn completes. You are restarted when a new message arrives. Always call receive_message(block=true) as your last action.",
      ],
      includeStdinNotificationSection: false,
    });
  }

  toolDisplayName(name: string): string {
    if (name.startsWith(this.mcpToolPrefix)) return "";
    if (name === "shell" || name === "command_execution") return "Running command...";
    if (name === "file_change") return "Editing file...";
    if (name === "file_read") return "Reading file...";
    if (name === "file_write") return "Writing file...";
    if (name === "web_search") return "Searching web...";
    if (name === "collab_tool_call") return "Collaborating...";
    return `Using ${name.length > 20 ? `${name.slice(0, 20)}...` : name}...`;
  }

  summarizeToolInput(name: string, input: unknown): string {
    const record = asRecord(input);
    if (!record) {
      return "";
    }

    try {
      if (name === "shell" || name === "command_execution") {
        const cmd = String(record.command || "");
        return cmd.length > 100 ? `${cmd.slice(0, 100)}...` : cmd;
      }

      if (name === "file_change") return String(record.path || "");
      if (name === "file_read") return String(record.path || record.file_path || "");
      if (name === "file_write") return String(record.path || record.file_path || "");
      if (name === "web_search") return String(record.query || "");

      if (name === `${this.mcpToolPrefix}send_message`) {
        if (record.channel) return String(record.channel);
        if (record.dm_to) return `DM:@${String(record.dm_to)}`;
        return "";
      }

      if (name === `${this.mcpToolPrefix}read_history`) {
        return String(record.channel || "");
      }

      return "";
    } catch {
      return "";
    }
  }
}
