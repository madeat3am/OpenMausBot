import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { AutonomyAuthority, loadAutonomyPolicy, type ToolAction } from "./autonomy-policy.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-sidecar.ts");
const temporary: string[] = [];
let child: ChildProcess | null = null;
let broker: Server | null = null;

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not listen");
  return address.port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    child = null;
  }
  if (broker) {
    await new Promise<void>((resolve) => broker!.close(() => resolve()));
    broker = null;
  }
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("connector execution sidecar", () => {
  it("enforces policy atomically and consumes exact exceptions once", async () => {
    let providerCalls = 0;
    broker = createServer((_req, res) => {
      providerCalls += 1;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "provider-session" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }));
    });
    const brokerPort = await listen(broker);
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "omb-sidecar-"));
    temporary.push(dir);
    const token = "t".repeat(48);
    const key = Buffer.alloc(32, 11);
    const policyPath = join(dir, "policy.json");
    const keyPath = join(dir, "key");
    const tokenPath = join(dir, "token");
    const brokerTokenPath = join(dir, "broker-token");
    const mcpSecretsPath = join(dir, "mcp-secrets.json");
    const connectorConfigPath = join(dir, "connector-config.json");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    writeFileSync(brokerTokenPath, "b".repeat(64), { mode: 0o600 });
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    writeFileSync(connectorConfigPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    writeFileSync(policyPath, JSON.stringify({
      schema: "openmausbot.autonomy-policy.v1",
      revision: "sidecar-test",
      rules: [{
        id: "allowed-read",
        botId: "ops",
        wakeKinds: ["operator"],
        transport: "composio",
        server: "composio",
        tools: ["GMAIL_FETCH_EMAILS"],
        accountAliases: ["personal"],
        effect: "read",
      }],
    }), { mode: 0o600 });
    child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
      env: {
        ...process.env,
        OMB_DATA_DIR: join(dir, "data"),
        OMB_CONNECTOR_SIDECAR_HOST: "127.0.0.1",
        OMB_CONNECTOR_SIDECAR_PORT: String(port),
        OMB_CONNECTOR_SIDECAR_TOKEN_FILE: tokenPath,
        OMB_AUTONOMY_POLICY_PATH: policyPath,
        OMB_AUTONOMY_SIGNING_KEY_FILE: keyPath,
        OMB_MCP_SECRETS_FILE: mcpSecretsPath,
        OMB_CONNECTOR_CONFIG_FILE: connectorConfigPath,
        OMB_MCP_INLINE_SECRETS: "reject",
        OMB_COMPOSIO_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
        OMB_COMPOSIO_BROKER_TOKEN_FILE: brokerTokenPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sidecar did not start")), 5_000);
      child!.stderr!.on("data", (chunk) => {
        if (!String(chunk).includes("connector sidecar listening")) return;
        clearTimeout(timer);
        resolve();
      });
      child!.once("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
    });

    const post = (value: unknown, authorized = true) => fetch(`http://127.0.0.1:${port}/v1/composio`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(value),
    });
    expect((await post({}, false)).status).toBe(401);

    const authority = new AutonomyAuthority(loadAutonomyPolicy(policyPath), key);
    const capability = authority.issue({ botId: "ops", threadId: "thread-1", wakeKind: "operator" })!;
    const call = (tools: unknown[]) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools } } });
    const mixed = await post({ capability, payload: call([
      { tool_slug: "GMAIL_FETCH_EMAILS", account: "personal", arguments: {} },
      { tool_slug: "GMAIL_DELETE_MESSAGE", account: "personal", arguments: {} },
    ]) });
    expect(mixed.status).toBe(200);
    const mixedEnvelope = await mixed.json() as { bodyBase64: string };
    expect(Buffer.from(mixedEnvelope.bodyBase64, "base64").toString("utf8")).toContain("entire batch was denied");
    expect(providerCalls).toBe(0);

    const allowed = await post({ capability, payload: call([{ tool_slug: "GMAIL_FETCH_EMAILS", account: "personal", arguments: {} }]) });
    expect(await allowed.json()).toEqual(expect.objectContaining({ status: 200 }));
    expect(providerCalls).toBe(1);

    const action: ToolAction = { transport: "composio", server: "composio", tool: "GMAIL_MOVE_TO_TRASH", accountAlias: "personal", arguments: { message_id: "m-1" } };
    const exact = authority.issueExact("operator-exception", action, undefined, 30_000);
    const exceptionPayload = call([{ tool_slug: action.tool, account: action.accountAlias, arguments: action.arguments }]);
    const exactBody = { payload: exceptionPayload, exact: { token: exact, kind: "operator-exception", action } };
    expect((await post(exactBody)).status).toBe(200);
    expect(providerCalls).toBe(2);
    expect((await post(exactBody)).status).toBe(403);
    expect(providerCalls).toBe(2);

    const control = async (method: string, args: unknown[]) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/custom-mcp-control`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, args }),
      });
      return { response, body: await response.json() as { result?: unknown; error?: string } };
    };
    const secret = "only-the-sidecar-may-read-this";
    const created = await control("upsert", ["notes", {
      command: process.execPath,
      args: ["fixture.js"],
      env: { NOTES_TOKEN: secret },
    }]);
    expect(created.response.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain(secret);
    const storedConfig = JSON.parse(readFileSync(connectorConfigPath, "utf8"));
    expect(storedConfig.mcpServers.notes.env).toEqual({ NOTES_TOKEN: "" });
    const storedSecrets = JSON.parse(readFileSync(mcpSecretsPath, "utf8"));
    expect(storedSecrets.servers.notes).toEqual({ NOTES_TOKEN: secret });
    const diagnostic = await control("diagnostic", []);
    expect(diagnostic.body.result).toEqual({ status: "resolved", servers: { notes: "resolved" } });

    const retained = await control("upsert", ["notes", {
      command: process.execPath,
      args: ["fixture-2.js"],
      env: { NOTES_TOKEN: true },
      enabled: false,
    }]);
    expect(retained.response.status).toBe(200);
    expect(JSON.parse(readFileSync(mcpSecretsPath, "utf8")).servers.notes).toEqual({ NOTES_TOKEN: secret });
    expect((await control("setEnabled", ["notes", true])).response.status).toBe(200);
    expect((await control("remove", ["notes"])).response.status).toBe(200);
    expect(JSON.parse(readFileSync(mcpSecretsPath, "utf8")).servers.notes).toBeUndefined();
  });
});
