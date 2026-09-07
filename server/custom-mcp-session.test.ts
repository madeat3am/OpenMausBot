import { describe, expect, it } from "vitest";

import { customMcpSessionId } from "./custom-mcp-session.ts";

describe("custom MCP proxy session identity", () => {
  it("reuses the same --session for the same bot, thread, and server", () => {
    const first = customMcpSessionId("bot-1", "thread-1", "wiki");
    const second = customMcpSessionId("bot-1", "thread-1", "wiki");
    expect(first).toBe(second);
    expect(["--server", "wiki", "--session", first]).toEqual(["--server", "wiki", "--session", second]);
  });

  it("keeps server identity in the session key", () => {
    expect(customMcpSessionId("bot-1", "thread-1", "wiki"))
      .not.toBe(customMcpSessionId("bot-1", "thread-1", "notes"));
  });
});
