#!/usr/bin/env node

import { accessSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentProcessManager } from "./agentProcessManager.js";
import { DaemonConnection } from "./connection.js";
import { detectRuntimes } from "./runtime-detection.js";
import type { IncomingMessage } from "./types.js";

interface CliOptions {
  serverUrl: string;
  apiKey: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let serverUrl = "";
  let apiKey = "";

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--server-url" && args[i + 1]) {
      serverUrl = args[i + 1];
      i += 1;
      continue;
    }

    if (args[i] === "--api-key" && args[i + 1]) {
      apiKey = args[i + 1];
      i += 1;
    }
  }

  if (!serverUrl || !apiKey) {
    throw new Error("Usage: slock-daemon --server-url <url> --api-key <key>");
  }

  return { serverUrl, apiKey };
}

function resolveChatBridgePath(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  let chatBridgePath = path.resolve(dirname, "chat-bridge.js");

  try {
    accessSync(chatBridgePath);
  } catch {
    chatBridgePath = path.resolve(dirname, "chat-bridge.ts");
  }

  return chatBridgePath;
}

async function main(): Promise<void> {
  const { serverUrl, apiKey } = parseArgs(process.argv);
  const chatBridgePath = resolveChatBridgePath();

  let connection!: DaemonConnection;

  const agentManager = new AgentProcessManager(
    chatBridgePath,
    (msg) => connection.send(msg),
    apiKey,
  );

  connection = new DaemonConnection({
    serverUrl,
    apiKey,
    onMessage: (msg: IncomingMessage) => {
      console.log(
        `[Daemon] Received: ${msg.type}`,
        msg.type === "ping" ? "" : JSON.stringify(msg).slice(0, 200),
      );

      switch (msg.type) {
        case "agent:start":
          console.log(
            `[Daemon] Starting agent ${msg.agentId} (model: ${msg.config.model}, session: ${msg.config.sessionId || "new"}${msg.wakeMessage ? ", with wake message" : ""})`,
          );
          void agentManager.startAgent(
            msg.agentId,
            msg.config,
            msg.wakeMessage,
            msg.unreadSummary,
          );
          break;

        case "agent:stop":
          console.log(`[Daemon] Stopping agent ${msg.agentId}`);
          void agentManager.stopAgent(msg.agentId);
          break;

        case "agent:sleep":
          console.log(`[Daemon] Sleeping agent ${msg.agentId}`);
          agentManager.sleepAgent(msg.agentId);
          break;

        case "agent:reset-workspace":
          console.log(`[Daemon] Resetting workspace for agent ${msg.agentId}`);
          void agentManager.resetWorkspace(msg.agentId);
          break;

        case "agent:deliver":
          console.log(
            `[Daemon] Delivering message to ${msg.agentId}: ${msg.message.content.slice(0, 80)}`,
          );
          agentManager.deliverMessage(msg.agentId, msg.message);
          connection.send({ type: "agent:deliver:ack", agentId: msg.agentId, seq: msg.seq });
          break;

        case "agent:workspace:list":
          void agentManager.getFileTree(msg.agentId).then((files) => {
            connection.send({
              type: "agent:workspace:file_tree",
              agentId: msg.agentId,
              files,
            });
          });
          break;

        case "agent:workspace:read":
          void agentManager
            .readFile(msg.agentId, msg.path)
            .then(({ content, binary }) => {
              connection.send({
                type: "agent:workspace:file_content",
                agentId: msg.agentId,
                requestId: msg.requestId,
                content,
                binary,
              });
            })
            .catch(() => {
              connection.send({
                type: "agent:workspace:file_content",
                agentId: msg.agentId,
                requestId: msg.requestId,
                content: null,
                binary: false,
              });
            });
          break;

        case "machine:workspace:scan":
          console.log("[Daemon] Scanning all workspace directories");
          void agentManager.scanAllWorkspaces().then((directories) => {
            connection.send({ type: "machine:workspace:scan_result", directories });
          });
          break;

        case "machine:workspace:delete":
          console.log(
            `[Daemon] Deleting workspace directory: ${msg.directoryName}`,
          );
          void agentManager
            .deleteWorkspaceDirectory(msg.directoryName)
            .then((success) => {
              connection.send({
                type: "machine:workspace:delete_result",
                directoryName: msg.directoryName,
                success,
              });
            });
          break;

        case "ping":
          connection.send({ type: "pong" });
          break;

        default:
          break;
      }
    },
    onConnect: () => {
      const runtimes = detectRuntimes();
      console.log(`[Daemon] Detected runtimes: ${runtimes.join(", ") || "none"}`);

      connection.send({
        type: "ready",
        capabilities: ["agent:start", "agent:stop", "agent:deliver", "workspace:files"],
        runtimes,
        runningAgents: agentManager.getRunningAgentIds(),
        hostname: os.hostname(),
        os: `${os.platform()} ${os.arch()}`,
      });
    },
    onDisconnect: () => {
      console.log("[Daemon] Lost connection - agents continue running locally");
    },
  });

  console.log("[Slock Daemon] Starting...");
  connection.connect();

  const shutdown = async () => {
    console.log("[Slock Daemon] Shutting down...");
    await agentManager.stopAll();
    connection.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });

  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((error) => {
  if ((error as Error).message.includes("Usage: slock-daemon")) {
    console.error((error as Error).message);
  } else {
    console.error("[Slock Daemon] Fatal error:", error);
  }
  process.exit(1);
});
