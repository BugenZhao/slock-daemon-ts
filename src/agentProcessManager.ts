import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import { getDriver } from "./drivers/index.js";
import type { RuntimeDriver } from "./drivers/types.js";
import type {
  AgentConfig,
  AgentMessage,
  OutgoingMessage,
  ParsedEvent,
  TrajectoryEntry,
  WorkspaceDirectorySummary,
  WorkspaceFileNode,
} from "./types.js";

const DATA_DIR = path.join(os.homedir(), ".slock", "agents");
const MAX_TRAJECTORY_TEXT = 2_000;

function toLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface PendingReceive {
  resolve: (messages: AgentMessage[]) => void;
  timer: NodeJS.Timeout;
}

interface AgentProcess {
  process: ChildProcessWithoutNullStreams;
  driver: RuntimeDriver;
  inbox: AgentMessage[];
  pendingReceive: PendingReceive | null;
  config: AgentConfig;
  sessionId: string | null;
  isInReceiveMessage: boolean;
  notificationTimer: NodeJS.Timeout | null;
  pendingNotificationCount: number;
}

/**
 * Owns all local runtime processes and their persistent workspaces.
 */
export class AgentProcessManager {
  private readonly agents = new Map<string, AgentProcess>();
  private readonly agentsStarting = new Set<string>();

  constructor(
    private readonly chatBridgePath: string,
    private readonly sendToServer: (msg: OutgoingMessage) => void,
    private readonly daemonApiKey: string,
    private readonly verboseJsonIo = false,
    private readonly codexOss = false,
  ) {}

  async startAgent(
    agentId: string,
    config: AgentConfig,
    wakeMessage?: AgentMessage,
    unreadSummary?: Record<string, number>,
  ): Promise<void> {
    if (this.agents.has(agentId) || this.agentsStarting.has(agentId)) {
      return;
    }
    this.agentsStarting.add(agentId);

    try {
      const driver = getDriver(config.runtime || "claude");
      const agentDataDir = path.join(DATA_DIR, agentId);

      await mkdir(agentDataDir, { recursive: true });

      const memoryMdPath = path.join(agentDataDir, "MEMORY.md");
      try {
        await access(memoryMdPath);
      } catch {
        const agentName = config.displayName || config.name;
        const initialMemory = `# ${agentName}

## Role
${config.description || "No role defined yet."}

## Key Knowledge
- No notes yet.

## Active Context
- First startup.
`;
        await writeFile(memoryMdPath, initialMemory);
      }

      await mkdir(path.join(agentDataDir, "notes"), { recursive: true });

      const prompt = this.buildStartupPrompt(
        driver,
        config,
        agentId,
        wakeMessage,
        unreadSummary,
      );

      const { process } = driver.spawn({
        agentId,
        config,
        prompt,
        workingDirectory: agentDataDir,
        chatBridgePath: this.chatBridgePath,
        daemonApiKey: this.daemonApiKey,
        codexOss: this.codexOss,
        onAgentJsonIo: (stream, raw) => {
          this.logAgentJsonIo(agentId, stream, raw);
        },
      });

      const agentProcess: AgentProcess = {
        process,
        driver,
        inbox: [],
        pendingReceive: null,
        config,
        sessionId: config.sessionId || null,
        isInReceiveMessage: false,
        notificationTimer: null,
        pendingNotificationCount: 0,
      };

      this.agents.set(agentId, agentProcess);
      this.agentsStarting.delete(agentId);

      this.bindProcessStreams(agentId, process, driver);

      this.sendToServer({ type: "agent:status", agentId, status: "active" });
      this.sendToServer({
        type: "agent:activity",
        agentId,
        activity: "working",
        detail: "Starting...",
      });
    } catch (error) {
      this.agentsStarting.delete(agentId);
      throw error;
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    const ap = this.agents.get(agentId);
    if (!ap) {
      return;
    }

    if (ap.pendingReceive) {
      clearTimeout(ap.pendingReceive.timer);
      ap.pendingReceive.resolve([]);
    }

    if (ap.notificationTimer) {
      clearTimeout(ap.notificationTimer);
    }

    this.agents.delete(agentId);
    ap.process.kill("SIGTERM");

    this.sendToServer({ type: "agent:status", agentId, status: "inactive" });
    this.sendToServer({
      type: "agent:activity",
      agentId,
      activity: "offline",
      detail: "",
    });
  }

  /** Hibernate = kill process but keep semantic state as sleeping. */
  sleepAgent(agentId: string): void {
    const ap = this.agents.get(agentId);
    if (!ap) {
      return;
    }

    console.log(`[Agent ${agentId}] Hibernating (sleeping)`);

    if (ap.pendingReceive) {
      clearTimeout(ap.pendingReceive.timer);
      ap.pendingReceive.resolve([]);
    }

    if (ap.notificationTimer) {
      clearTimeout(ap.notificationTimer);
    }

    this.agents.delete(agentId);
    ap.process.kill("SIGTERM");
  }

  deliverMessage(agentId: string, message: AgentMessage): void {
    const ap = this.agents.get(agentId);
    if (!ap) {
      return;
    }

    if (ap.pendingReceive) {
      clearTimeout(ap.pendingReceive.timer);
      ap.pendingReceive.resolve([message]);
      ap.pendingReceive = null;
    } else {
      ap.inbox.push(message);
    }

    if (!ap.driver.supportsStdinNotification) return;
    if (ap.isInReceiveMessage) return;
    if (!ap.sessionId) return;

    ap.pendingNotificationCount += 1;
    if (!ap.notificationTimer) {
      ap.notificationTimer = setTimeout(() => {
        this.sendStdinNotification(agentId);
      }, 3_000);
    }
  }

  async resetWorkspace(agentId: string): Promise<void> {
    const agentDataDir = path.join(DATA_DIR, agentId);

    try {
      await rm(agentDataDir, { recursive: true, force: true });
      console.log(`[Agent ${agentId}] Workspace deleted: ${agentDataDir}`);
    } catch (error) {
      console.error(`[Agent ${agentId}] Failed to delete workspace:`, error);
    }
  }

  async stopAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.stopAgent(id)));
  }

  getRunningAgentIds(): string[] {
    return [...this.agents.keys()];
  }

  async scanAllWorkspaces(): Promise<WorkspaceDirectorySummary[]> {
    const results: WorkspaceDirectorySummary[] = [];
    let entries;

    try {
      entries = await readdir(DATA_DIR, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(DATA_DIR, entry.name);

      try {
        const dirContents = await readdir(dirPath, { withFileTypes: true });
        let totalSize = 0;
        let latestMtime = new Date(0);
        let fileCount = 0;

        for (const item of dirContents) {
          const itemPath = path.join(dirPath, item.name);

          try {
            const info = await stat(itemPath);
            if (item.isFile()) {
              totalSize += info.size;
              fileCount += 1;
            }
            if (info.mtime > latestMtime) {
              latestMtime = info.mtime;
            }
          } catch {
            // Skip unreadable file.
          }
        }

        results.push({
          directoryName: entry.name,
          totalSizeBytes: totalSize,
          lastModified: latestMtime.toISOString(),
          fileCount,
        });
      } catch {
        // Skip broken directory entries.
      }
    }

    return results;
  }

  async deleteWorkspaceDirectory(directoryName: string): Promise<boolean> {
    if (
      directoryName.includes("/") ||
      directoryName.includes("..") ||
      directoryName.includes("\\")
    ) {
      return false;
    }

    const targetDir = path.join(DATA_DIR, directoryName);

    try {
      await rm(targetDir, { recursive: true, force: true });
      console.log(`[Workspace] Deleted directory: ${targetDir}`);
      return true;
    } catch (error) {
      console.error(
        `[Workspace] Failed to delete directory ${targetDir}:`,
        error,
      );
      return false;
    }
  }

  async getFileTree(agentId: string, dirPath?: string): Promise<WorkspaceFileNode[]> {
    const agentDir = path.join(DATA_DIR, agentId);

    try {
      await stat(agentDir);
    } catch {
      return [];
    }

    let targetDir = agentDir;
    if (dirPath) {
      const resolved = path.resolve(agentDir, dirPath);
      if (!resolved.startsWith(`${agentDir}${path.sep}`) && resolved !== agentDir) {
        return [];
      }
      targetDir = resolved;
    }

    return this.listDirectoryChildren(targetDir, agentDir);
  }

  async readFile(
    agentId: string,
    filePath: string,
  ): Promise<{ content: string | null; binary: boolean }> {
    const agentDir = path.join(DATA_DIR, agentId);
    const resolved = path.resolve(agentDir, filePath);

    if (!resolved.startsWith(`${agentDir}${path.sep}`) && resolved !== agentDir) {
      throw new Error("Access denied");
    }

    const info = await stat(resolved);
    if (info.isDirectory()) {
      throw new Error("Cannot read a directory");
    }

    const textExtensions = new Set<string>([
      ".md",
      ".txt",
      ".json",
      ".js",
      ".ts",
      ".jsx",
      ".tsx",
      ".yaml",
      ".yml",
      ".toml",
      ".log",
      ".csv",
      ".xml",
      ".html",
      ".css",
      ".sh",
      ".py",
    ]);

    const ext = path.extname(resolved).toLowerCase();
    if (!textExtensions.has(ext) && ext !== "") {
      return { content: null, binary: true };
    }

    if (info.size > 1_048_576) {
      throw new Error("File too large");
    }

    const content = await readFile(resolved, "utf-8");
    return { content, binary: false };
  }

  private bindProcessStreams(
    agentId: string,
    process: ChildProcessWithoutNullStreams,
    driver: RuntimeDriver,
  ): void {
    let buffer = "";

    process.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.logAgentJsonIo(agentId, "stdout", line);

        const events = driver.parseLine(line);
        for (const event of events) {
          this.handleParsedEvent(agentId, event, driver);
        }
      }
    });

    process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.logAgentJsonIo(agentId, "stderr", line);
      }
      if (/Reconnecting\.\.\.|Falling back from WebSockets/i.test(text)) return;
      console.error(`[Agent ${agentId} stderr]: ${text}`);
    });

    process.on("exit", (code) => {
      console.log(`[Agent ${agentId}] Process exited with code ${code}`);

      const ap = this.agents.get(agentId);
      if (!ap) {
        return;
      }
      if (ap.process !== process) return;

      if (ap.pendingReceive) {
        clearTimeout(ap.pendingReceive.timer);
        ap.pendingReceive.resolve([]);
      }

      if (ap.notificationTimer) {
        clearTimeout(ap.notificationTimer);
      }

      this.agents.delete(agentId);
      if (code === 0) {
        this.sendToServer({ type: "agent:status", agentId, status: "sleeping" });
        this.sendToServer({
          type: "agent:activity",
          agentId,
          activity: "sleeping",
          detail: "",
        });
      } else {
        const reason = code === null ? "killed by signal" : `exit code ${code}`;
        console.error(`[Agent ${agentId}] Process crashed (${reason}) - marking inactive`);
        this.sendToServer({ type: "agent:status", agentId, status: "inactive" });
        this.sendToServer({
          type: "agent:activity",
          agentId,
          activity: "offline",
          detail: `Crashed (${reason})`,
        });
      }
    });
  }

  private buildStartupPrompt(
    driver: RuntimeDriver,
    config: AgentConfig,
    agentId: string,
    wakeMessage?: AgentMessage,
    unreadSummary?: Record<string, number>,
  ): string {
    const isResume = Boolean(config.sessionId);

    if (!isResume) {
      return driver.buildSystemPrompt(config, agentId);
    }

    if (wakeMessage) {
      const channelLabel =
        wakeMessage.channel_type === "dm"
          ? `DM:@${wakeMessage.channel_name}`
          : `#${wakeMessage.channel_name}`;
      const senderPrefix = wakeMessage.sender_type === "agent" ? "(agent) " : "";
      const time = wakeMessage.timestamp ? ` (${toLocalTime(wakeMessage.timestamp)})` : "";

      const formatted = `[${channelLabel}]${time} ${senderPrefix}@${wakeMessage.sender_name}: ${wakeMessage.content}`;
      let prompt = `New message received:\n\n${formatted}`;

      if (unreadSummary && Object.keys(unreadSummary).length > 0) {
        const otherUnread = Object.entries(unreadSummary).filter(
          ([channel]) => channel !== channelLabel,
        );

        if (otherUnread.length > 0) {
          prompt += "\n\nYou also have unread messages in other channels:";
          for (const [channel, count] of otherUnread) {
            prompt += `\n- ${channel}: ${count} unread`;
          }

          prompt +=
            "\n\nUse read_history to catch up, or respond to the message above first.";
        }
      }

      prompt +=
        "\n\nRespond as appropriate, then call receive_message(block=true) to keep listening.";

      if (driver.supportsStdinNotification) {
        prompt +=
          "\n\nNote: While busy, you may receive [System notification: ...]. Finish current work, then call receive_message.";
      }

      return prompt;
    }

    if (unreadSummary && Object.keys(unreadSummary).length > 0) {
      let prompt = "You have unread messages from while you were offline:";
      for (const [channel, count] of Object.entries(unreadSummary)) {
        prompt += `\n- ${channel}: ${count} unread`;
      }

      prompt +=
        "\n\nUse read_history to catch up on important channels, then call receive_message(block=true).";

      if (driver.supportsStdinNotification) {
        prompt +=
          "\n\nNote: While busy, you may receive [System notification: ...]. Finish current work, then call receive_message.";
      }

      return prompt;
    }

    let prompt =
      `No new messages while you were away. Call ${driver.mcpToolPrefix}` +
      "receive_message(block=true) to listen for new messages.";

    if (driver.supportsStdinNotification) {
      prompt +=
        "\n\nNote: While busy, you may receive [System notification: ...] about new messages.";
    }

    return prompt;
  }

  private handleParsedEvent(
    agentId: string,
    event: ParsedEvent,
    driver: RuntimeDriver,
  ): void {
    const trajectory: TrajectoryEntry[] = [];
    let activity: "online" | "working" | "thinking" | "" = "";
    let detail = "";

    const ap = this.agents.get(agentId);

    switch (event.kind) {
      case "session_init":
        if (ap) ap.sessionId = event.sessionId;
        this.sendToServer({ type: "agent:session", agentId, sessionId: event.sessionId });
        break;

      case "thinking": {
        const text =
          event.text.length > MAX_TRAJECTORY_TEXT
            ? `${event.text.slice(0, MAX_TRAJECTORY_TEXT)}...`
            : event.text;

        trajectory.push({ kind: "thinking", text });
        activity = "thinking";
        if (ap) ap.isInReceiveMessage = false;
        break;
      }

      case "text": {
        const text =
          event.text.length > MAX_TRAJECTORY_TEXT
            ? `${event.text.slice(0, MAX_TRAJECTORY_TEXT)}...`
            : event.text;

        trajectory.push({ kind: "text", text });
        activity = "thinking";
        if (ap) ap.isInReceiveMessage = false;
        break;
      }

      case "tool_call": {
        const toolName = event.name;
        const inputSummary = driver.summarizeToolInput(toolName, event.input);

        trajectory.push({
          kind: "tool_start",
          toolName,
          toolInput: inputSummary,
        });

        if (toolName === `${driver.mcpToolPrefix}receive_message`) {
          activity = "online";
          if (ap) {
            ap.isInReceiveMessage = true;
            ap.pendingNotificationCount = 0;
            if (ap.notificationTimer) {
              clearTimeout(ap.notificationTimer);
              ap.notificationTimer = null;
            }
          }
        } else if (toolName === `${driver.mcpToolPrefix}send_message`) {
          activity = "working";
          detail = "Fucking...";
          if (ap) ap.isInReceiveMessage = false;
        } else {
          activity = "working";
          detail = driver.toolDisplayName(toolName);
          if (ap) ap.isInReceiveMessage = false;
        }
        break;
      }

      case "turn_end":
        activity = "online";
        if (ap) {
          ap.isInReceiveMessage = false;
          if (event.sessionId) {
            ap.sessionId = event.sessionId;
          }
        }

        if (event.sessionId) {
          this.sendToServer({
            type: "agent:session",
            agentId,
            sessionId: event.sessionId,
          });
        }

        break;

      case "error":
        trajectory.push({ kind: "text", text: `Error: ${event.message}` });
        break;
    }

    if (activity) {
      this.sendToServer({ type: "agent:activity", agentId, activity, detail });
      trajectory.push({ kind: "status", activity, detail });
    }

    if (trajectory.length > 0) {
      this.sendToServer({ type: "agent:trajectory", agentId, entries: trajectory });
    }
  }

  private sendStdinNotification(agentId: string): void {
    const ap = this.agents.get(agentId);
    if (!ap) return;

    const count = ap.pendingNotificationCount;
    ap.pendingNotificationCount = 0;
    ap.notificationTimer = null;

    if (count === 0) return;
    if (ap.isInReceiveMessage) return;
    if (!ap.sessionId) return;

    const notification =
      `[System notification: You have ${count} new message${count > 1 ? "s" : ""} waiting. ` +
      `Call receive_message to read ${count > 1 ? "them" : "it"} when you're ready.]`;

    console.log(
      `[Agent ${agentId}] Sending stdin notification: ${count} message(s)`,
    );

    const encoded = ap.driver.encodeStdinMessage(notification, ap.sessionId);
    if (encoded) {
      this.logAgentJsonIo(agentId, "stdin", encoded);
      ap.process.stdin.write(`${encoded}\n`);
    }
  }

  private logAgentJsonIo(
    agentId: string,
    stream: "stdin" | "stdout" | "stderr",
    raw: string,
  ): void {
    if (!this.verboseJsonIo) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const tag = stream.toUpperCase();
      console.log(`[Agent ${agentId} ${tag} JSON] ${JSON.stringify(parsed)}`);
    } catch {
      // Only log valid JSON payloads in verbose mode.
    }
  }

  private async listDirectoryChildren(
    dir: string,
    rootDir: string,
  ): Promise<WorkspaceFileNode[]> {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: WorkspaceFileNode[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      let info;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          isDirectory: true,
          size: 0,
          modifiedAt: info.mtime.toISOString(),
        });
      } else {
        nodes.push({
          name: entry.name,
          path: relativePath,
          isDirectory: false,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }

    return nodes;
  }
}
