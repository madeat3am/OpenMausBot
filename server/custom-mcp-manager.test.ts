import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CustomMcpManager, customMcpChildCommand, customMcpChildEnvironment } from "./custom-mcp-manager.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
}

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

  it("caps fresh sidecar sessions per server and reaps every idle child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-custom-mcp-cap-"));
    dirs.push(dir);
    const fixture = join(dir, "fixture.mjs");
    const pidLog = join(dir, "pids");
    writeFileSync(fixture, `
      import { appendFileSync } from "node:fs";
      import readline from "node:readline";
      appendFileSync(process.env.PID_LOG, String(process.pid) + "\\n");
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n");
      });
    `, { mode: 0o600 });
    const manager = new CustomMcpManager({
      maxSessionsPerServer: 3,
      sessionIdleMs: 500,
      reaperIntervalMs: 50,
    });
    const server = { command: process.execPath, args: [fixture], env: { PID_LOG: pidLog } };

    for (let id = 0; id < 5; id += 1) {
      await manager.relay("wiki", server, { jsonrpc: "2.0", id, method: "tools/list" }, `fresh-${id}`, 2_000);
    }

    await eventually(() => manager.health().children <= 3);
    expect(manager.health()).toEqual({ sessions: 3, children: 3 });
    const pids = readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(5);
    await eventually(() => manager.health().sessions === 0 && manager.health().children === 0);
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    await manager.stop();
  }, 10_000);

  it("refuses a fourth session instead of evicting an in-flight request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-custom-mcp-busy-cap-"));
    dirs.push(dir);
    const fixture = join(dir, "fixture.mjs");
    writeFileSync(fixture, `
      import readline from "node:readline";
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on("line", (line) => {
        const frame = JSON.parse(line);
        setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n"), 250);
      });
    `, { mode: 0o600 });
    const manager = new CustomMcpManager({ maxSessionsPerServer: 3, sessionIdleMs: 60_000 });
    const server = { command: process.execPath, args: [fixture], env: {} };
    const pending = [0, 1, 2].map((id) => manager.relay(
      "wiki", server, { jsonrpc: "2.0", id, method: "tools/list" }, `busy-${id}`, 2_000,
    ));

    await expect(manager.relay(
      "wiki", server, { jsonrpc: "2.0", id: 3, method: "tools/list" }, "busy-3", 2_000,
    )).rejects.toThrow("server session limit reached");
    expect(manager.health()).toEqual({ sessions: 3, children: 3 });
    await Promise.all(pending);
    await manager.stop();
  });

  it("stop waits through the grace window until a SIGTERM-resistant child is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-custom-mcp-stop-"));
    dirs.push(dir);
    const fixture = join(dir, "fixture.mjs");
    const pidLog = join(dir, "pids");
    writeFileSync(fixture, `
      import { appendFileSync } from "node:fs";
      import readline from "node:readline";
      appendFileSync(process.env.PID_LOG, String(process.pid) + "\\n");
      process.on("SIGTERM", () => {});
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n");
      });
    `, { mode: 0o600 });
    const manager = new CustomMcpManager({ sessionIdleMs: 60_000, reaperIntervalMs: 60_000 });
    const server = { command: process.execPath, args: [fixture], env: { PID_LOG: pidLog } };
    await manager.relay("wiki", server, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "stop-me", 2_000);
    const pid = Number(readFileSync(pidLog, "utf8").trim());

    await manager.stop();

    expect(manager.health()).toEqual({ sessions: 0, children: 0 });
    expect(alive(pid)).toBe(false);
  }, 10_000);
});
