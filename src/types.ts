export type RuntimeId = "claude" | "codex" | "gemini" | "kimi";

export interface AgentConfig {
  name: string;
  displayName?: string;
  description?: string;
  runtime?: RuntimeId;
  model?: string;
  sessionId?: string;
  serverUrl: string;
  authToken?: string;
  reasoningEffort?: string;
}

export interface AgentMessage {
  channel_type: "channel" | "dm" | string;
  channel_name: string;
  sender_type: "agent" | "human" | string;
  sender_name: string;
  content: string;
  timestamp?: string;
}

export interface WorkspaceFileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  children?: WorkspaceFileNode[];
}

export interface WorkspaceDirectorySummary {
  directoryName: string;
  totalSizeBytes: number;
  lastModified: string;
  fileCount: number;
}

export type TrajectoryEntry =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_start"; toolName: string; toolInput: string }
  | { kind: "status"; activity: AgentActivity; detail: string };

export type AgentActivity =
  | "online"
  | "working"
  | "thinking"
  | "sleeping"
  | "offline";

export type ParsedEvent =
  | { kind: "session_init"; sessionId: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "turn_end"; sessionId?: string }
  | { kind: "error"; message: string };

export type IncomingMessage =
  | {
      type: "agent:start";
      agentId: string;
      config: AgentConfig;
      wakeMessage?: AgentMessage;
      unreadSummary?: Record<string, number>;
    }
  | { type: "agent:stop"; agentId: string }
  | { type: "agent:sleep"; agentId: string }
  | { type: "agent:reset-workspace"; agentId: string }
  | { type: "agent:deliver"; agentId: string; message: AgentMessage; seq: number }
  | { type: "agent:workspace:list"; agentId: string; dirPath?: string }
  | { type: "agent:workspace:read"; agentId: string; path: string; requestId: string }
  | { type: "machine:workspace:scan" }
  | { type: "machine:workspace:delete"; directoryName: string }
  | { type: "ping" };

export type OutgoingMessage =
  | {
      type: "ready";
      capabilities: string[];
      runtimes: RuntimeId[];
      runningAgents: string[];
      hostname: string;
      os: string;
      daemonVersion: string;
    }
  | { type: "pong" }
  | { type: "agent:status"; agentId: string; status: "active" | "sleeping" | "inactive" }
  | { type: "agent:activity"; agentId: string; activity: AgentActivity; detail: string }
  | { type: "agent:trajectory"; agentId: string; entries: TrajectoryEntry[] }
  | { type: "agent:session"; agentId: string; sessionId: string }
  | { type: "agent:deliver:ack"; agentId: string; seq: number }
  | { type: "agent:workspace:file_tree"; agentId: string; files: WorkspaceFileNode[]; dirPath?: string }
  | { type: "agent:workspace:file_content"; agentId: string; requestId: string; content: string | null; binary: boolean }
  | { type: "machine:workspace:scan_result"; directories: WorkspaceDirectorySummary[] }
  | { type: "machine:workspace:delete_result"; directoryName: string; success: boolean };
