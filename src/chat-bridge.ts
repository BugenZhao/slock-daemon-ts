#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface CliArgs {
  agentId: string;
  serverUrl: string;
  authToken: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let agentId = "";
  let serverUrl = "http://localhost:3001";
  let authToken = "";

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--agent-id" && args[i + 1]) {
      agentId = args[i + 1];
      i += 1;
      continue;
    }

    if (args[i] === "--server-url" && args[i + 1]) {
      serverUrl = args[i + 1];
      i += 1;
      continue;
    }

    if (args[i] === "--auth-token" && args[i + 1]) {
      authToken = args[i + 1];
      i += 1;
    }
  }

  if (!agentId) {
    throw new Error("Missing --agent-id");
  }

  return { agentId, serverUrl, authToken };
}

function buildHeaders(authToken: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}

async function main(): Promise<void> {
  const { agentId, serverUrl, authToken } = parseArgs(process.argv);
  const commonHeaders = buildHeaders(authToken);

  const server = new McpServer({
    name: "chat",
    version: "1.0.0",
  });

  server.tool(
    "send_message",
    "Send a message to a channel or DM. Reuse channel from received messages for replies. Use dm_to only to start a brand new DM.",
    {
      channel: z
        .string()
        .optional()
        .describe(
          "Reply target. Examples: '#all', '#general', 'DM:@richard'.",
        ),
      dm_to: z
        .string()
        .optional()
        .describe("Person name to start a NEW DM with."),
      content: z.string().describe("Message content."),
    },
    async ({ channel, dm_to, content }) => {
      try {
        const response = await fetch(
          `${serverUrl}/internal/agent/${agentId}/send`,
          {
            method: "POST",
            headers: commonHeaders,
            body: JSON.stringify({ channel, dm_to, content }),
          },
        );

        const data = (await response.json()) as { error?: string };

        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `Error: ${data.error}` }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to ${channel || `new DM with ${dm_to}`}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(error as Error).message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "receive_message",
    "Receive new messages. Use block=true to wait for new messages.",
    {
      block: z.boolean().default(true),
      timeout_ms: z
        .number()
        .default(59_000)
        .describe("Blocking wait timeout in milliseconds."),
    },
    async ({ block, timeout_ms }) => {
      try {
        const params = new URLSearchParams();
        if (block) params.set("block", "true");
        params.set("timeout", String(timeout_ms));

        const response = await fetch(
          `${serverUrl}/internal/agent/${agentId}/receive?${params}`,
          { method: "GET", headers: commonHeaders },
        );

        const data = (await response.json()) as {
          messages?: Array<{
            channel_type: string;
            channel_name: string;
            sender_type: string;
            sender_name: string;
            content: string;
          }>;
        };

        if (!data.messages || data.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        const formatted = data.messages
          .map((m) => {
            const channel =
              m.channel_type === "dm"
                ? `DM:@${m.channel_name}`
                : `#${m.channel_name}`;
            const senderPrefix = m.sender_type === "agent" ? "(agent) " : "";
            return `[${channel}] ${senderPrefix}@${m.sender_name}: ${m.content}`;
          })
          .join("\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(error as Error).message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "list_server",
    "List channels, agents, and humans in the current server.",
    {},
    async () => {
      try {
        const response = await fetch(
          `${serverUrl}/internal/agent/${agentId}/server`,
          { method: "GET", headers: commonHeaders },
        );

        const data = (await response.json()) as {
          channels?: Array<{ name: string }>;
          agents?: Array<{ name: string; status: string }>;
          humans?: Array<{ name: string }>;
        };

        let text = "## Server\n\n";

        text += "### Your Channels\n";
        text += "Use #channel-name with send_message to post in a channel.\n";
        if (data.channels?.length) {
          for (const channel of data.channels) {
            text += `  - #${channel.name}\n`;
          }
        } else {
          text += "  (none)\n";
        }

        text += "\n### Agents\n";
        text += "Other AI agents in this server.\n";
        if (data.agents?.length) {
          for (const agent of data.agents) {
            text += `  - @${agent.name} (${agent.status})\n`;
          }
        } else {
          text += "  (none)\n";
        }

        text += "\n### Humans\n";
        text +=
          'To start a new DM: send_message(dm_to="<name>"). To reply in existing DM: reuse channel.\n';
        if (data.humans?.length) {
          for (const human of data.humans) {
            text += `  - @${human.name}\n`;
          }
        } else {
          text += "  (none)\n";
        }

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(error as Error).message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "read_history",
    "Read message history for a channel or DM. Supports before/after pagination.",
    {
      channel: z
        .string()
        .describe("Examples: '#all', '#general', 'DM:@richard'"),
      limit: z.number().default(50),
      before: z.number().optional(),
      after: z.number().optional(),
    },
    async ({ channel, limit, before, after }) => {
      try {
        const params = new URLSearchParams();
        params.set("channel", channel);
        params.set("limit", String(Math.min(limit, 100)));
        if (before) params.set("before", String(before));
        if (after) params.set("after", String(after));

        const response = await fetch(
          `${serverUrl}/internal/agent/${agentId}/history?${params}`,
          { method: "GET", headers: commonHeaders },
        );

        const data = (await response.json()) as {
          error?: string;
          messages?: Array<{
            seq: number;
            senderType: string;
            senderName: string;
            content: string;
          }>;
          historyLimited?: boolean;
          historyLimitMessage?: string;
          has_more?: boolean;
          last_read_seq?: number;
        };

        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `Error: ${data.error}` }],
          };
        }

        if (!data.messages || data.messages.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No messages in this channel." },
            ],
          };
        }

        const formatted = data.messages
          .map((m) => {
            const senderPrefix = m.senderType === "agent" ? "(agent) " : "";
            return `[seq:${m.seq}] ${senderPrefix}@${m.senderName}: ${m.content}`;
          })
          .join("\n");

        let footer = "";
        if (data.historyLimited) {
          footer = `\n\n--- ${data.historyLimitMessage || "Message history is limited on this plan."} ---`;
        } else if (data.has_more && data.messages.length > 0) {
          if (after) {
            const maxSeq = data.messages[data.messages.length - 1].seq;
            footer = `\n\n--- ${data.messages.length} messages shown. Use after=${maxSeq} to load more recent messages. ---`;
          } else {
            const minSeq = data.messages[0].seq;
            footer = `\n\n--- ${data.messages.length} messages shown. Use before=${minSeq} to load older messages. ---`;
          }
        }

        let header = `## Message History for ${channel} (${data.messages.length} messages)`;
        if (typeof data.last_read_seq === "number" && data.last_read_seq > 0 && !after && !before) {
          header += `\nYour last read position: seq ${data.last_read_seq}. Use read_history(channel=\"${channel}\", after=${data.last_read_seq}) to read unread messages.`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${formatted}${footer}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(error as Error).message}` },
          ],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
