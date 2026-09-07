import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-sidecar.ts");
const temporary: string[] = [];
let sidecar: ChildProcess | null = null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not listen");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  expect(accept(value)).toBe(true);
  return value;
}

afterEach(async () => {
  if (sidecar) {
    sidecar.kill("SIGTERM");
    await Promise.race([once(sidecar, "close"), new Promise((resolve) => setTimeout(resolve, 8_000))]);
    sidecar = null;
  }
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("connector sidecar custom MCP lifecycle", () => {
  it("caps five unclosed relay sessions, then reaps every idle child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-sidecar-reaper-"));
    temporary.push(dir);
    const port = await freePort();
    const token = "t".repeat(48);
    const tokenPath = join(dir, "token");
    const keyPath = join(dir, "key");
    const policyPath = join(dir, "policy.json");
    const connectorConfigPath = join(dir, "connector-config.json");
    const pidLog = join(dir, "pids");
    const fixture = join(dir, "echo.mjs");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    writeFileSync(keyPath, Buffer.alloc(32, 7).toString("hex"), { mode: 0o600 });
    writeFileSync(policyPath, JSON.stringify({
      schema: "openmausbot.autonomy-policy.v1",
      revision: "sidecar-reaper-test",
      rules: [],
    }), { mode: 0o600 });
    writeFileSync(fixture, `
      import { appendFileSync } from "node:fs";
      import readline from "node:readline";
      appendFileSync(process.argv[2], String(process.pid) + "\\n");
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n");
      });
    `, { mode: 0o600 });
    writeFileSync(connectorConfigPath, JSON.stringify({
      mcpServers: { notes: { command: process.execPath, args: [fixture, pidLog], env: {}, enabled: true } },
    }), { mode: 0o600 });

    sidecar = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
      env: {
        ...process.env,
        OMB_DATA_DIR: join(dir, "data"),
        OMB_CONNECTOR_SIDECAR_HOST: "127.0.0.1",
        OMB_CONNECTOR_SIDECAR_PORT: String(port),
        OMB_CONNECTOR_SIDECAR_TOKEN_FILE: tokenPath,
        OMB_AUTONOMY_POLICY_PATH: policyPath,
        OMB_AUTONOMY_SIGNING_KEY_FILE: keyPath,
        OMB_CONNECTOR_CONFIG_FILE: connectorConfigPath,
        OMB_MCP_INLINE_SECRETS: "reject",
        OMB_CUSTOM_MCP_MAX_SESSIONS_PER_SERVER: "3",
        OMB_CUSTOM_MCP_SESSION_IDLE_MS: "500",
        OMB_CUSTOM_MCP_REAPER_INTERVAL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sidecar did not start")), 5_000);
      sidecar!.stderr!.on("data", (chunk) => {
        if (!String(chunk).includes("connector sidecar listening")) return;
        clearTimeout(timer);
        resolve();
      });
      sidecar!.once("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
    });

    const health = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return await response.json() as { sessions: number; children: number };
    };
    const outcomes = await Promise.all(Array.from({ length: 5 }, async (_, id) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/custom-mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          server: "notes",
          sessionId: `fresh-${id}`,
          payload: { jsonrpc: "2.0", id, method: "tools/list" },
        }),
      });
      return { status: response.status, body: await response.json() as { error?: string } };
    }));
    expect(outcomes.filter(({ status }) => status === 200)).toHaveLength(3);
    expect(outcomes.filter(({ status }) => status === 500)).toHaveLength(2);
    expect(outcomes.filter(({ status }) => status === 500).every(
      ({ body }) => body.error?.includes("server session limit reached"),
    )).toBe(true);

    expect(await eventually(health, (value) => value.sessions === 3 && value.children === 3))
      .toMatchObject({ sessions: 3, children: 3 });
    const pids = readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(3);
    expect(await eventually(health, (value) => value.sessions === 0 && value.children === 0))
      .toMatchObject({ sessions: 0, children: 0 });
    expect(pids.every((pid) => !alive(pid))).toBe(true);
  }, 15_000);
});
