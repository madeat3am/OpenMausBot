import { createHash } from "node:crypto";

/** Stable and opaque across repeat turns for one bot thread and MCP server. */
export function customMcpSessionId(botId: string, threadId: string, serverName: string): string {
  return createHash("sha256")
    .update(JSON.stringify([botId, threadId, serverName]))
    .digest("hex");
}
