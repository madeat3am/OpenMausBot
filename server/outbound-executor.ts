import type { AutonomyAuthority, ToolAction } from "./autonomy-policy.ts";
import type { ExactRelayAuthorization } from "./connector-sidecar-client.ts";
import type { OutboundProposal, OutboundProviderReadback } from "./outbound-proposals.ts";

interface RelayResult {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  transportSessionId?: string;
}

export type OutboundRelay = (
  payload: Record<string, unknown>,
  transportSessionId?: string,
  exact?: ExactRelayAuthorization,
) => Promise<RelayResult>;

export interface OutboundExecutionResult {
  status: "sent" | "failed";
  recovered: boolean;
  providerResultId?: string;
  providerReadback: OutboundProviderReadback;
  reason?: string;
}

function decoded(result: RelayResult): { value: unknown; text: string } {
  const text = new TextDecoder().decode(result.bytes);
  const candidates = result.contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter((line) => line && line !== "[DONE]")
    : [text];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try { return { value: JSON.parse(candidates[index]!), text }; } catch {}
  }
  return { value: null, text };
}

function nestedError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.error) return true;
  if (row.isError === true) return true;
  if (row.result && typeof row.result === "object") return nestedError(row.result);
  return false;
}

function providerResultId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = providerResultId(item);
      if (found) return found;
    }
    return undefined;
  }
  const row = value as Record<string, unknown>;
  for (const key of ["log_id", "logId", "provider_result_id", "message_id", "draft_id", "id"]) {
    if (typeof row[key] === "string" && row[key]) return row[key] as string;
  }
  for (const item of Object.values(row)) {
    const found = providerResultId(item);
    if (found) return found;
  }
  return undefined;
}

function callPayload(id: string, action: ToolAction): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      arguments: {
        tools: [{ tool_slug: action.tool, arguments: action.arguments, ...(action.accountAlias ? { account: action.accountAlias } : {}) }],
      },
    },
  };
}

function readback(result: RelayResult, now: number, idempotencyKey: string): OutboundProviderReadback & { value: unknown; text: string } {
  const body = decoded(result);
  return {
    observedAt: now,
    providerResultId: providerResultId(body.value),
    matchedIdempotencyKey: body.text.includes(idempotencyKey),
    detail: result.status >= 200 && result.status < 300 && !nestedError(body.value) ? "provider state reread" : "provider reread failed",
    ...body,
  };
}

export class OutboundExecutor {
  private readonly authority: AutonomyAuthority;
  private readonly relay: OutboundRelay;

  constructor(authority: AutonomyAuthority, relay: OutboundRelay) {
    this.authority = authority;
    this.relay = relay;
  }

  async execute(proposal: OutboundProposal, now = Date.now()): Promise<OutboundExecutionResult> {
    let sessionId: string | undefined;
    const initialize = await this.relay({
      jsonrpc: "2.0",
      id: `outbound-init-${proposal.proposalId}`,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmausbot-outbound", version: "1" } },
    });
    if (initialize.status < 200 || initialize.status >= 300 || nestedError(decoded(initialize).value)) {
      return { status: "failed", recovered: false, providerReadback: { observedAt: now, detail: "provider initialization failed" }, reason: "provider initialization failed" };
    }
    sessionId = initialize.transportSessionId;

    const readCapability = this.authority.issueExact("outbound-readback", proposal.providerReadAction, proposal.canonicalDigest, 30 * 60_000, now);
    const before = await this.relay(
      callPayload(`outbound-read-${proposal.proposalId}`, proposal.providerReadAction),
      sessionId,
      { token: readCapability, kind: "outbound-readback", action: proposal.providerReadAction, proposalDigest: proposal.canonicalDigest },
    );
    const beforeState = readback(before, now, proposal.idempotencyKey);
    const providerReadback: OutboundProviderReadback = {
      observedAt: beforeState.observedAt,
      providerResultId: beforeState.providerResultId,
      matchedIdempotencyKey: beforeState.matchedIdempotencyKey,
      detail: beforeState.detail,
    };
    if (before.status < 200 || before.status >= 300 || nestedError(beforeState.value)) {
      return { status: "failed", recovered: false, providerReadback, reason: "provider state could not be reread" };
    }
    if (beforeState.matchedIdempotencyKey) {
      return { status: "sent", recovered: true, providerResultId: beforeState.providerResultId, providerReadback: { ...providerReadback, detail: "existing idempotent send found" } };
    }
    if (proposal.providerDraftId && !beforeState.text.includes(proposal.providerDraftId)) {
      return { status: "failed", recovered: false, providerReadback, reason: "provider draft changed or disappeared" };
    }

    const capability = this.authority.issueExact("outbound-send", proposal.providerAction, proposal.canonicalDigest, 30 * 60_000, now);
    try {
      const sent = await this.relay(
        callPayload(`outbound-send-${proposal.proposalId}`, proposal.providerAction),
        sessionId,
        { token: capability, kind: "outbound-send", action: proposal.providerAction, proposalDigest: proposal.canonicalDigest },
      );
      const sentBody = decoded(sent);
      if (sent.status < 200 || sent.status >= 300 || nestedError(sentBody.value)) {
        return { status: "failed", recovered: false, providerReadback, reason: "provider rejected the send" };
      }
      return { status: "sent", recovered: false, providerResultId: providerResultId(sentBody.value), providerReadback: { ...providerReadback, detail: "provider state reread before send" } };
    } catch {
      const recoveryCapability = this.authority.issueExact("outbound-readback", proposal.providerReadAction, proposal.canonicalDigest, 30 * 60_000, Date.now());
      const after = await this.relay(
        callPayload(`outbound-recover-${proposal.proposalId}`, proposal.providerReadAction),
        sessionId,
        { token: recoveryCapability, kind: "outbound-readback", action: proposal.providerReadAction, proposalDigest: proposal.canonicalDigest },
      );
      const afterState = readback(after, Date.now(), proposal.idempotencyKey);
      const recoveredReadback: OutboundProviderReadback = {
        observedAt: afterState.observedAt,
        providerResultId: afterState.providerResultId,
        matchedIdempotencyKey: afterState.matchedIdempotencyKey,
        detail: afterState.matchedIdempotencyKey ? "send recovered by idempotency readback" : "ambiguous send not found by idempotency readback",
      };
      return afterState.matchedIdempotencyKey
        ? { status: "sent", recovered: true, providerResultId: afterState.providerResultId, providerReadback: recoveredReadback }
        : { status: "failed", recovered: false, providerReadback: recoveredReadback, reason: "send outcome is ambiguous; no retry was attempted" };
    }
  }
}
