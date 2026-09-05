import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  actionsFromCustomMcpPayload,
  actionsFromMcpPayload,
  AutonomyAuthority,
  AUTONOMY_DECISION_SCHEMA,
  exactActionDigest,
  splitIndependentReadPayloads,
  splitReadBatchMcpResponse,
  usableMcpReadResponse,
  type AutonomyDecision,
  type ToolAction,
} from "./autonomy-policy.ts";
import * as composio from "./composio.ts";
import { customMcpServers, ensureDirs, loadConfig, saveConfig } from "./config.ts";
import { CustomMcpManager } from "./custom-mcp-manager.ts";
import { mcpSecretsDiagnostic, resolveMcpSecrets, updateExternalMcpSecrets } from "./mcp-secrets.ts";
import { listMcpServers, parseMcpServerMutation, parseStoredMcpServer, type StoredMcpServer } from "./mcp-registry.ts";
import { probeMcpServer } from "./mcp-probe.ts";
import type { ExactRelayAuthorization } from "./connector-sidecar-client.ts";

const PORT = Number(process.env.OMB_CONNECTOR_SIDECAR_PORT || 8810);
const HOST = process.env.OMB_CONNECTOR_SIDECAR_HOST || "0.0.0.0";
const MAX_BODY = 20 * 1024 * 1024;

function secret(name: string, fileName: string): void {
  const path = process.env[fileName]?.trim();
  if (!path) return;
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${fileName} is empty`);
  process.env[name] = value;
}

secret("COMPOSIO_API_KEY", "COMPOSIO_API_KEY_FILE");
secret("OMB_COMPOSIO_BROKER_TOKEN", "OMB_COMPOSIO_BROKER_TOKEN_FILE");
ensureDirs();
const cfg = loadConfig();
const authority = new AutonomyAuthority();
const customMcpManager = new CustomMcpManager();

function bearer(): Buffer {
  const path = process.env.OMB_CONNECTOR_SIDECAR_TOKEN_FILE?.trim();
  if (!path) throw new Error("OMB_CONNECTOR_SIDECAR_TOKEN_FILE is required");
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32) throw new Error("connector sidecar token is invalid");
  return Buffer.from(value);
}
const expectedToken = bearer();

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : Buffer.alloc(0);
  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.byteLength), "cache-control": "no-store" });
  res.end(bytes);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY) throw new Error("request exceeded 20 MB");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

function denied(id: unknown, decisions: AutonomyDecision[]) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: decisions.map((decision) => `${decision.tool}: ${decision.reason}`).join("; ") }],
      isError: true,
    },
  };
}

function authorize(actions: ToolAction[], capability: unknown): AutonomyDecision[] {
  return actions.map((action) => authority.authorize(
    typeof capability === "string" ? capability : undefined,
    action,
  ));
}

function exactAuthorized(value: unknown, actions: ToolAction[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const exact = value as ExactRelayAuthorization;
  if (actions.length !== 1 || exactActionDigest(actions[0]!) !== exactActionDigest(exact.action)) return false;
  return authority.consumeExact(exact.token, exact.kind, exact.action, exact.proposalDigest);
}

function withoutInlineSecrets(server: StoredMcpServer): StoredMcpServer {
  return { ...server, env: Object.fromEntries(Object.keys(server.env).map((key) => [key, ""])) };
}

function currentMcpServers(): Record<string, unknown> {
  const path = process.env.OMB_CONNECTOR_CONFIG_FILE?.trim();
  if (!path) return cfg.mcpServers ?? {};
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("connector MCP config is invalid");
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("connector MCP config is invalid");
  return servers as Record<string, unknown>;
}

function currentMcpConfig() {
  return { ...cfg, mcpServers: currentMcpServers() };
}

function resolvedStoredServer(name: string): StoredMcpServer | null {
  const raw = currentMcpServers()[name];
  if (raw === undefined) return null;
  const parsed = parseStoredMcpServer(name, raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const secrets = resolveMcpSecrets(name, parsed.server.env);
  return secrets.status === "resolved" ? { ...parsed.server, env: secrets.env } : null;
}

function saveMcpServers(next: Record<string, unknown>): void {
  const path = process.env.OMB_CONNECTOR_CONFIG_FILE?.trim();
  if (path) {
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ mcpServers: next }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } else {
    saveConfig({ mcpServers: next });
  }
  cfg.mcpServers = next;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && req.method === "GET") return json(res, 200, { schema: "openmausbot.connector-sidecar-health.v1", status: "ok", policy: authority.state.status });
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (url.pathname === "/v1/composio" && req.method === "POST") {
      const input = await body(req);
      const payload = input.payload;
      const extracted = actionsFromMcpPayload(payload);
      if (extracted.error) {
        const decision: AutonomyDecision = { schema: AUTONOMY_DECISION_SCHEMA, allowed: false, code: "malformed-action", reason: extracted.error, tool: "unknown" };
        return json(res, 200, { status: 200, bodyBase64: Buffer.from(JSON.stringify(denied((payload as { id?: unknown })?.id, [decision]))).toString("base64"), contentType: "application/json" });
      }
      if (extracted.actions.length > 0) {
        if (input.exact !== undefined) {
          if (!exactAuthorized(input.exact, extracted.actions)) return json(res, 403, { error: "exact capability is invalid, expired, replayed, or mismatched" });
        } else {
          const decisions = authorize(extracted.actions, input.capability);
          if (decisions.some((decision) => !decision.allowed)) {
            const splitReads = splitIndependentReadPayloads(payload, extracted.actions, decisions);
            if (splitReads) {
              let transportSessionId = typeof input.transportSessionId === "string" ? input.transportSessionId : undefined;
              const results: Array<{ action: ToolAction; response?: unknown }> = [];
              for (const [index, item] of splitReads.entries()) {
                if (!decisions[index]!.allowed) {
                  results.push({ action: item.action });
                  continue;
                }
                let upstream;
                try {
                  upstream = await composio.relayMcp(cfg, item.payload as never, transportSessionId);
                } catch {
                  results.push({ action: item.action });
                  continue;
                }
                transportSessionId = upstream.transportSessionId ?? transportSessionId;
                const text = Buffer.from(upstream.bytes).toString("utf8");
                let response: unknown = text;
                try { response = JSON.parse(text); } catch {}
                results.push({ action: item.action, ...(usableMcpReadResponse(upstream.status, response) ? { response } : {}) });
              }
              const response = splitReadBatchMcpResponse((payload as { id?: unknown })?.id, results);
              return json(res, 200, {
                status: 200,
                bodyBase64: Buffer.from(JSON.stringify(response)).toString("base64"),
                contentType: "application/json",
                ...(transportSessionId ? { transportSessionId } : {}),
              });
            }
            const rejected = decisions.map((decision): AutonomyDecision => decision.allowed
              ? { ...decision, allowed: false, code: "mixed-batch-denied", reason: "the entire batch was denied before execution" }
              : decision);
            return json(res, 200, { status: 200, bodyBase64: Buffer.from(JSON.stringify(denied((payload as { id?: unknown })?.id, rejected))).toString("base64"), contentType: "application/json" });
          }
        }
      }
      const result = await composio.relayMcp(cfg, payload as never, typeof input.transportSessionId === "string" ? input.transportSessionId : undefined);
      return json(res, 200, { status: result.status, bodyBase64: Buffer.from(result.bytes).toString("base64"), contentType: result.contentType, transportSessionId: result.transportSessionId });
    }
    if (url.pathname === "/v1/composio-control" && req.method === "POST") {
      const input = await body(req);
      const args = Array.isArray(input.args) ? input.args : [];
      let result: unknown;
      switch (input.method) {
        case "connectedServices": result = await composio.connectedServices(cfg); break;
        case "connectionStatus": result = await composio.connectionStatus(cfg, args[0] as string[]); break;
        case "listToolkits": result = await composio.listToolkits(cfg); break;
        case "toolkitCard": result = await composio.toolkitCard(cfg, String(args[0] ?? "")); break;
        case "authorizeService": result = await composio.authorizeService(cfg, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined); break;
        case "removeAccount": result = await composio.removeAccount(cfg, String(args[0] ?? ""), String(args[1] ?? "")); break;
        case "updateAccountAlias": result = await composio.updateAccountAlias(cfg, String(args[0] ?? ""), String(args[1] ?? ""), typeof args[2] === "string" ? args[2] : undefined); break;
        case "removeService": result = await composio.removeService(cfg, String(args[0] ?? "")); break;
        default: return json(res, 400, { error: "unsupported connected-app control method" });
      }
      return json(res, 200, { status: 200, bodyBase64: "", contentType: "application/json", result });
    }
    if (url.pathname === "/v1/custom-mcp-control" && req.method === "POST") {
      const input = await body(req);
      const args = Array.isArray(input.args) ? input.args : [];
      const name = String(args[0] ?? "");
      let result: unknown;
      switch (input.method) {
        case "diagnostic":
          result = mcpSecretsDiagnostic(currentMcpServers());
          break;
        case "list":
          result = listMcpServers(currentMcpServers());
          break;
        case "upsert": {
          const activeServers = currentMcpServers();
          const existingRaw = activeServers[name];
          const existing = existingRaw === undefined ? undefined : parseStoredMcpServer(name, existingRaw);
          if (existing && !existing.ok) return json(res, 400, { error: existing.error });
          const resolved = existing ? resolvedStoredServer(name) : undefined;
          const incoming = args[1];
          const incomingEnv = incoming && typeof incoming === "object" && !Array.isArray(incoming)
            ? (incoming as { env?: unknown }).env
            : undefined;
          if (incomingEnv && typeof incomingEnv === "object" && !Array.isArray(incomingEnv)
            && Object.values(incomingEnv).includes(true) && !resolved) {
            return json(res, 409, { error: "MCP credentials are missing or invalid." });
          }
          const parsed = parseMcpServerMutation(name, incoming, resolved ?? existing?.server);
          if (!parsed.ok) return json(res, 400, { error: parsed.error });
          updateExternalMcpSecrets(name, parsed.server.env);
          const stored = withoutInlineSecrets(parsed.server);
          saveMcpServers({ ...activeServers, [name]: stored });
          customMcpManager.closeServer(name);
          result = stored;
          break;
        }
        case "setEnabled": {
          const activeServers = currentMcpServers();
          const raw = activeServers[name];
          if (raw === undefined) return json(res, 404, { error: "MCP server not found." });
          const parsed = parseStoredMcpServer(name, raw);
          if (!parsed.ok) return json(res, 400, { error: parsed.error });
          if (typeof args[1] !== "boolean") return json(res, 400, { error: "enabled must be a boolean" });
          const stored = { ...parsed.server, enabled: args[1] };
          saveMcpServers({ ...activeServers, [name]: stored });
          customMcpManager.closeServer(name);
          result = stored;
          break;
        }
        case "remove": {
          const next = { ...currentMcpServers() };
          if (!Object.hasOwn(next, name)) return json(res, 404, { error: "MCP server not found." });
          delete next[name];
          updateExternalMcpSecrets(name, null);
          saveMcpServers(next);
          customMcpManager.closeServer(name);
          result = { ok: true };
          break;
        }
        case "test": {
          const server = resolvedStoredServer(name);
          if (!server) return json(res, 409, { error: "MCP credentials are missing or invalid." });
          result = await probeMcpServer(server);
          break;
        }
        default:
          return json(res, 400, { error: "unsupported custom MCP control method" });
      }
      return json(res, 200, { status: 200, bodyBase64: "", contentType: "application/json", result });
    }
    if (url.pathname === "/v1/custom-mcp" && req.method === "DELETE") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) customMcpManager.close(sessionId);
      return json(res, 200, { status: 204, bodyBase64: "", contentType: "application/json" });
    }
    if (url.pathname === "/v1/custom-mcp" && req.method === "POST") {
      const input = await body(req);
      const serverName = typeof input.server === "string" ? input.server : "";
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(serverName)) return json(res, 400, { error: "invalid custom MCP server" });
      const payload = input.payload;
      const extracted = actionsFromCustomMcpPayload(serverName, payload);
      if (extracted.error) return json(res, 400, { error: extracted.error });
      if (input.exact !== undefined) {
        if (!exactAuthorized(input.exact, extracted.actions)) return json(res, 403, { error: "exact capability is invalid, expired, replayed, or mismatched" });
      } else {
        const decisions = authorize(extracted.actions, input.capability);
        if (decisions.some((decision) => !decision.allowed)) {
          return json(res, 200, { status: 200, bodyBase64: "", contentType: "application/json", sessionId: typeof input.sessionId === "string" ? input.sessionId : "denied", response: denied((payload as { id?: unknown })?.id, decisions) });
        }
      }
      const target = customMcpServers(currentMcpConfig())[serverName];
      if (!target) return json(res, 404, { error: "custom MCP server is unavailable" });
      const result = await customMcpManager.relay(serverName, target, payload as Record<string, unknown>, typeof input.sessionId === "string" ? input.sessionId : undefined);
      return json(res, 200, { status: result.response ? 200 : 204, bodyBase64: "", contentType: "application/json", sessionId: result.sessionId, response: result.response });
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "connector sidecar failed" });
  }
});

server.listen(PORT, HOST, () => {
  console.error(`OpenMausBot connector sidecar listening on ${HOST}:${PORT}`);
});
process.once("SIGTERM", () => { customMcpManager.dispose(); server.close(() => process.exit(0)); });
process.once("SIGINT", () => { customMcpManager.dispose(); server.close(() => process.exit(0)); });
