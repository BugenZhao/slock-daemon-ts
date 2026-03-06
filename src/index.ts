#!/usr/bin/env node

import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { AgentProcessManager } from "./agentProcessManager.js";
import { DaemonConnection } from "./connection.js";
import { DRIVER_IDS } from "./drivers/index.js";
import { detectRuntimes } from "./runtime-detection.js";
import type { RuntimeId } from "./types.js";
import type { IncomingMessage } from "./types.js";

const require = createRequire(import.meta.url);
const DAEMON_VERSION = (require("../package.json") as { version?: string }).version || "unknown";

interface CliOptions {
  serverUrl: string;
  apiKey: string;
  enableSleepWake: boolean;
  verbose: boolean;
  codexOss: boolean;
  overwriteModel?: string;
  overwriteModelsByRuntime: Partial<Record<RuntimeId, string>>;
}

const USAGE =
  "Usage: slock-daemon --server-url <url> --api-key <key> [--disable-sleep-wake] [--verbose] [--codex-oss] [--overwrite-model <model>] [--overwrite-model-<runtime> <model>]";

function resolveOverwriteModel(
  runtime: string | undefined,
  overwriteModel: string | undefined,
  overwriteModelsByRuntime: Partial<Record<RuntimeId, string>>,
): string | undefined {
  if (runtime && runtime in overwriteModelsByRuntime) {
    return overwriteModelsByRuntime[runtime as RuntimeId];
  }

  return overwriteModel;
}

function parseCliArgs(argv: string[]): CliOptions {
  const runtimeOverwriteOptions = Object.fromEntries(
    DRIVER_IDS.map((runtime) => [(`overwrite-model-${runtime}`), { type: "string" as const }]),
  );

  let values: ReturnType<typeof parseNodeArgs>["values"];
  try {
    ({ values } = parseNodeArgs({
      args: argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        "server-url": { type: "string" },
        "api-key": { type: "string" },
        "disable-sleep-wake": { type: "boolean" },
        "enable-sleep-wake": { type: "boolean" },
        verbose: { type: "boolean" },
        "codex-oss": { type: "boolean" },
        "overwrite-model": { type: "string" },
        ...runtimeOverwriteOptions,
      },
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${USAGE}\n${detail}`);
  }

  const overwriteModelsByRuntime: Partial<Record<RuntimeId, string>> = {};
  for (const runtime of DRIVER_IDS) {
    const value = values[`overwrite-model-${runtime}`];
    if (typeof value === "string") {
      overwriteModelsByRuntime[runtime as RuntimeId] = value;
    }
  }

  const serverUrl = typeof values["server-url"] === "string" ? values["server-url"] : "";
  const apiKey = typeof values["api-key"] === "string" ? values["api-key"] : "";
  const enableSleepWake = values["disable-sleep-wake"] ? false : values["enable-sleep-wake"] ? true : true;
  const verbose = values.verbose === true;
  const codexOss = values["codex-oss"] === true;
  const overwriteModel =
    typeof values["overwrite-model"] === "string" ? values["overwrite-model"] : undefined;

  if (!serverUrl || !apiKey) {
    throw new Error(USAGE);
  }

  return {
    serverUrl,
    apiKey,
    enableSleepWake,
    verbose,
    codexOss,
    overwriteModel,
    overwriteModelsByRuntime,
  };
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
  const {
    serverUrl,
    apiKey,
    enableSleepWake,
    verbose,
    codexOss,
    overwriteModel,
    overwriteModelsByRuntime,
  } = parseCliArgs(process.argv);
  const chatBridgePath = resolveChatBridgePath();

  let connection!: DaemonConnection;

  const agentManager = new AgentProcessManager(
    chatBridgePath,
    (msg) => connection.send(msg),
    apiKey,
    verbose,
    codexOss,
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
        case "agent:start": {
          const overwriteTargetModel = resolveOverwriteModel(
            msg.config.runtime,
            overwriteModel,
            overwriteModelsByRuntime,
          );
          const effectiveConfig = overwriteTargetModel
            ? { ...msg.config, model: overwriteTargetModel }
            : msg.config;
          const effectiveWakeMessage = enableSleepWake ? msg.wakeMessage : undefined;
          const effectiveUnreadSummary = enableSleepWake
            ? msg.unreadSummary
            : undefined;

          console.log(
            `[Daemon] Starting agent ${msg.agentId} (model: ${effectiveConfig.model}, session: ${effectiveConfig.sessionId || "new"}${effectiveWakeMessage ? ", with wake message" : ""})`,
          );
          void agentManager
            .startAgent(
              msg.agentId,
              effectiveConfig,
              effectiveWakeMessage,
              effectiveUnreadSummary,
            )
            .catch((error) => {
              const reason = error instanceof Error ? error.message : String(error);
              console.error(`[Daemon] Failed to start agent ${msg.agentId}:`, reason);
              connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive" });
              connection.send({
                type: "agent:activity",
                agentId: msg.agentId,
                activity: "offline",
                detail: `Start failed: ${reason}`,
              });
            });
          break;
        }

        case "agent:stop":
          console.log(`[Daemon] Stopping agent ${msg.agentId}`);
          void agentManager.stopAgent(msg.agentId);
          break;

        case "agent:sleep":
          if (!enableSleepWake) {
            console.log(
              `[Daemon] Ignoring sleep request for ${msg.agentId} (--disable-sleep-wake)`,
            );
            break;
          }
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
          void agentManager.getFileTree(msg.agentId, msg.dirPath).then((files) => {
            connection.send({
              type: "agent:workspace:file_tree",
              agentId: msg.agentId,
              files,
              dirPath: msg.dirPath,
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
        daemonVersion: DAEMON_VERSION,
      });
    },
    onDisconnect: () => {
      console.log("[Daemon] Lost connection - agents continue running locally");
    },
  });

  console.log("[Slock Daemon] Starting...");
  console.log(
    `[Slock Daemon] Sleep/Wake mode: ${enableSleepWake ? "enabled" : "disabled"}`,
  );
  if (verbose) {
    console.log("[Slock Daemon] Verbose agent JSON I/O logging: enabled");
  }
  if (overwriteModel) {
    console.log(`[Slock Daemon] Global model override: ${overwriteModel}`);
  }
  for (const runtime of DRIVER_IDS) {
    const model = overwriteModelsByRuntime[runtime as RuntimeId];
    if (model) {
      console.log(`[Slock Daemon] ${runtime} model override: ${model}`);
    }
  }
  if (codexOss) {
    console.log("[Slock Daemon] Codex OSS mode: enabled (--oss)");
  }
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
