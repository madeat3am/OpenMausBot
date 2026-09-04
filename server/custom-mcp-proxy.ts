// Credential-free stdio bridge for one user-configured MCP server. The model
// process gets this proxy and a short-lived capability; only the OMB server
// can resolve and inject the configured MCP's secret environment.
import { randomUUID } from "node:crypto";
import readline from "node:readline";

type JsonRpc = Record<string, unknown>;

const HARNESS_URL = (process.env.OMB_HARNESS_URL ?? "").replace(/\/$/, "");
const COMMS_TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const CAPABILITY = process.env.OMB_AUTONOMY_CAPABILITY ?? "";
const SERVER = process.env.OMB_CUSTOM_MCP_SERVER ?? "";
const SESSION = process.env.OMB_CUSTOM_MCP_SESSION ?? randomUUID();
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const send = (message: JsonRpc) => process.stdout.write(`${JSON.stringify(message)}\n`);

function failure(id: unknown, message: string, toolCall: boolean): JsonRpc {
  if (toolCall) {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

async function boundedJson(response: Response): Promise<JsonRpc | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("custom MCP response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("custom MCP response exceeded 20 MB");
  if (!bytes.byteLength) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonRpc;
}

async function relay(message: JsonRpc): Promise<void> {
  const method = String(message.method ?? "");
  try {
    if (!HARNESS_URL || !COMMS_TOKEN || !SERVER) throw new Error("custom MCP proxy is not configured");
    const response = await fetch(`${HARNESS_URL}/api/internal/custom-mcp/mcp?server=${encodeURIComponent(SERVER)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${COMMS_TOKEN}`,
        "content-type": "application/json",
        "x-openmaus-autonomy-capability": CAPABILITY,
        "x-openmaus-mcp-session": SESSION,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const body = await boundedJson(response);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `custom MCP returned HTTP ${response.status}`);
    if (body && message.id !== undefined) send(body);
  } catch (error) {
    if (message.id === undefined) return;
    send(failure(message.id, error instanceof Error ? error.message : String(error), method === "tools/call"));
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
input.on("line", (line) => {
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
  } catch {
    return;
  }
  // MCP initialization is stateful. Preserve the client's wire order even
  // though each hop to the OMB-owned child crosses HTTP.
  queue = queue.then(() => relay(message));
});
input.on("close", () => {
  if (HARNESS_URL && COMMS_TOKEN && SERVER) {
    void queue.then(() => fetch(`${HARNESS_URL}/api/internal/custom-mcp/mcp?server=${encodeURIComponent(SERVER)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${COMMS_TOKEN}`, "x-openmaus-mcp-session": SESSION },
    })).finally(() => { process.exitCode = 0; });
  }
});
