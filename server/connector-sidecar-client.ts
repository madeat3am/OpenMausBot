import { readFileSync } from "node:fs";

import type { ToolAction } from "./autonomy-policy.ts";

export interface ConnectorRelayResult {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  transportSessionId?: string;
}

export interface ExactRelayAuthorization {
  token: string;
  kind: "outbound-send" | "outbound-readback" | "operator-exception";
  action: ToolAction;
  proposalDigest?: string;
}

interface SidecarEnvelope {
  status: number;
  bodyBase64: string;
  contentType: string;
  transportSessionId?: string;
  sessionId?: string;
  response?: Record<string, unknown> | null;
  result?: unknown;
}

function access(): { url: string; token: string } | null {
  const url = process.env.OMB_CONNECTOR_SIDECAR_URL?.trim().replace(/\/$/, "");
  if (!url) return null;
  const tokenFile = process.env.OMB_CONNECTOR_SIDECAR_TOKEN_FILE?.trim();
  if (!tokenFile) throw new Error("connector sidecar token file is required");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length < 32) throw new Error("connector sidecar token is invalid");
  return { url, token };
}

async function request(path: string, body: unknown, method = "POST"): Promise<SidecarEnvelope> {
  const target = access();
  if (!target) throw new Error("connector sidecar is not configured");
  const response = await fetch(`${target.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 20 * 1024 * 1024) throw new Error("connector sidecar response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("connector sidecar response exceeded 20 MB");
  const value = (() => {
    try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return null; }
  })() as SidecarEnvelope | { error?: unknown } | null;
  if (!response.ok || !value || typeof value !== "object" || !("status" in value)) {
    const detail = value && "error" in value && typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
    throw new Error(`connector sidecar unavailable: ${detail}`);
  }
  return value as SidecarEnvelope;
}

export function connectorSidecarConfigured(): boolean {
  return Boolean(process.env.OMB_CONNECTOR_SIDECAR_URL?.trim());
}

export function requireConnectorSidecarWhenConfigured(): void {
  if (process.env.OMB_CONNECTOR_SIDECAR_REQUIRED === "1" && !connectorSidecarConfigured()) {
    throw new Error("connector sidecar is required but not configured");
  }
}

export async function relayComposioSidecar(
  payload: Record<string, unknown>,
  transportSessionId?: string,
  capability?: string,
  exact?: ExactRelayAuthorization,
): Promise<ConnectorRelayResult> {
  const value = await request("/v1/composio", { payload, transportSessionId, capability, exact });
  return {
    status: value.status,
    bytes: Buffer.from(value.bodyBase64, "base64"),
    contentType: value.contentType,
    ...(value.transportSessionId ? { transportSessionId: value.transportSessionId } : {}),
  };
}

export async function relayCustomMcpSidecar(
  server: string,
  payload: Record<string, unknown>,
  sessionId?: string,
  capability?: string,
  exact?: ExactRelayAuthorization,
): Promise<{ sessionId: string; response: Record<string, unknown> | null }> {
  const value = await request("/v1/custom-mcp", { server, payload, sessionId, capability, exact });
  if (!value.sessionId) throw new Error("connector sidecar returned no custom MCP session");
  return { sessionId: value.sessionId, response: value.response ?? null };
}

export async function closeCustomMcpSidecar(server: string, sessionId: string): Promise<void> {
  await request(`/v1/custom-mcp?server=${encodeURIComponent(server)}&sessionId=${encodeURIComponent(sessionId)}`, undefined, "DELETE");
}

export async function callComposioSidecar<T>(method: string, args: unknown[] = []): Promise<T> {
  const value = await request("/v1/composio-control", { method, args });
  return value.result as T;
}
