import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CustomMcpManager, customMcpChildCommand, customMcpChildEnvironment } from "./custom-mcp-manager.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("guarded custom MCP manager", () => {
  it("gives a child only its named secret subtree and a small ambient env", () => {
    const env = customMcpChildEnvironment({ WIKI_TOKEN: "one" });
    expect(env.WIKI_TOKEN).toBe("one");
    expect(env.OMB_MCP_SECRETS_FILE).toBeUndefined();
    expect(env.OMB_AUTONOMY_POLICY_PATH).toBeUndefined();
    expect(env.COMPOSIO_API_KEY).toBeUndefined();
  });

  it("wraps each hosted child in bubblewrap and hides connector state", () => {
    process.env.OMB_MCP_CHILD_BWRAP = "1";
    process.env.OMB_MCP_SECRETS_FILE = "/authority/sidecar/mcp-secrets.json";
    process.env.OMB_CONNECTOR_CONFIG_FILE = "/authority/sidecar/connector-config.json";
    const command = customMcpChildCommand({ command: "node", args: ["server.mjs"], env: {} });
    expect(command.command).toBe("/usr/bin/bwrap");
    expect(command.args).toContain("--unshare-pid");
    expect(command.args).toEqual(expect.arrayContaining(["--tmpfs", "/authority/sidecar", "--", "node", "server.mjs"]));
    delete process.env.OMB_MCP_CHILD_BWRAP;
    delete process.env.OMB_MCP_SECRETS_FILE;
    delete process.env.OMB_CONNECTOR_CONFIG_FILE;
  });

  it("keeps one stdio session and relays responses by JSON-RPC id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-custom-mcp-"));
    dirs.push(dir);
    const fixture = join(dir, "fixture.mjs");
    writeFileSync(fixture, `
      import readline from "node:readline";
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          method: frame.method, token: process.env.ONLY_THIS_ONE || null,
          sibling: process.env.SIBLING_SECRET || null
        } }) + "\\n");
      });
    `, { mode: 0o600 });
    const manager = new CustomMcpManager();
    const server = { command: process.execPath, args: [fixture], env: { ONLY_THIS_ONE: "present" } };
    const first = await manager.relay("wiki", server, { jsonrpc: "2.0", id: 1, method: "initialize" }, "session-one", 2_000);
    const second = await manager.relay("wiki", server, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "session-one", 2_000);
    expect(first.sessionId).toBe("session-one");
    expect(first.response).toMatchObject({ id: 1, result: { token: "present", sibling: null } });
    expect(second.response).toMatchObject({ id: 2, result: { method: "tools/list" } });
    manager.dispose();
  });
});
