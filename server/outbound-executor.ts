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

function parsedJson(value: string): unknown | undefined {
  const candidate = value.trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined;
  try { return JSON.parse(candidate); } catch { return undefined; }
}

function nestedError(value: unknown): boolean {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    return parsed === undefined ? false : nestedError(parsed);
  }
  if (Array.isArray(value)) return value.some(nestedError);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.error) return true;
  if (row.isError === true) return true;
  if (row.successful === false) return true;
  return Object.values(row).some(nestedError);
}

function providerResultId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    return parsed === undefined ? undefined : providerResultId(parsed);
  }
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

function namedStrings(value: unknown, names: Set<string>): string[] {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    return parsed === undefined ? [] : namedStrings(parsed, names);
  }
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => namedStrings(item, names));
  const found: string[] = [];
  const row = value as Record<string, unknown>;
  if (typeof row.name === "string" && ["to", "cc", "bcc"].includes(row.name.trim().toLowerCase())) {
    const headerValue = row.value;
    if (typeof headerValue === "string") found.push(...headerValue.split(",").map((item) => item.trim()).filter(Boolean));
  }
  for (const [key, item] of Object.entries(row)) {
    if (names.has(key)) {
      const visit = (candidate: unknown): void => {
        if (typeof candidate === "string" && candidate.trim()) found.push(candidate.trim());
        else if (Array.isArray(candidate)) candidate.forEach(visit);
        else if (candidate && typeof candidate === "object") Object.values(candidate as Record<string, unknown>).forEach(visit);
      };
      visit(item);
    }
    found.push(...namedStrings(item, names));
  }
  return found;
}

function normalizedRecipient(value: string): string {
  const angleAddress = value.match(/<([^<>]+)>/)?.[1] ?? value;
  return angleAddress.trim().toLowerCase().replace(/^email:/, "");
}

function containsExactString(value: unknown, target: string): boolean {
  if (typeof value === "string") {
    if (value === target) return true;
    const parsed = parsedJson(value);
    return parsed === undefined ? false : containsExactString(parsed, target);
  }
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, target));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsExactString(item, target));
}

function bindingFailure(value: unknown, proposal: OutboundProposal, requireDraft = true): string | undefined {
  if (requireDraft) {
    const draftIds = namedStrings(value, new Set(["draft_id", "draftId", "provider_draft_id", "providerDraftId"]));
    const containsExactDraftId = containsExactString(value, proposal.providerDraftId);
    if (!draftIds.includes(proposal.providerDraftId) && !containsExactDraftId) return "provider draft changed or disappeared";
  }
  const observedRecipients = new Set(namedStrings(value, new Set([
    "to", "cc", "bcc", "recipients", "recipient_ids", "recipientIds", "provider_recipient_ids", "providerRecipientIds",
    "to_addresses", "toAddresses", "cc_addresses", "ccAddresses", "bcc_addresses", "bccAddresses",
  ])).map(normalizedRecipient));
  const approvedRecipients = new Set(proposal.providerRecipientIds.map(normalizedRecipient));
  if (
    observedRecipients.size !== approvedRecipients.size
    || ![...approvedRecipients].every((recipient) => observedRecipients.has(recipient))
  ) {
    return "provider draft recipients do not match the approved proposal";
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
        tools: [{
          tool_slug: action.tool,
          arguments: action.arguments,
          ...(action.providerAccountId ? { connected_account_id: action.providerAccountId } : {}),
          ...(action.accountAlias ? { account: action.accountAlias } : {}),
        }],
      },
    },
  };
}

function readback(result: RelayResult, now: number): OutboundProviderReadback & { value: unknown; text: string } {
  const body = decoded(result);
  return {
    observedAt: now,
    providerResultId: providerResultId(body.value),
    detail: result.status >= 200 && result.status < 300 && !nestedError(body.value) ? "provider state reread" : "provider reread failed",
    ...body,
  };
}

export class OutboundExecutor {
  private readonly authority: AutonomyAuthority;
  private readonly relay: OutboundRelay;
  private readonly now: () => number;

  constructor(authority: AutonomyAuthority, relay: OutboundRelay, now: () => number = Date.now) {
    this.authority = authority;
    this.relay = relay;
    this.now = now;
  }

  async execute(proposal: OutboundProposal): Promise<OutboundExecutionResult> {
    const startedAt = this.now();
    if (startedAt >= proposal.approvalExpiresAt) {
      return { status: "failed", recovered: false, providerReadback: { observedAt: startedAt, detail: "approval expired before provider initialization" }, reason: "the exact 30-minute approval window expired" };
    }
    let sessionId: string | undefined;
    let initialize: RelayResult;
    try {
      initialize = await this.relay({
        jsonrpc: "2.0",
        id: `outbound-init-${proposal.proposalId}`,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmausbot-outbound", version: "1" } },
      });
    } catch {
      return { status: "failed", recovered: false, providerReadback: { observedAt: this.now(), detail: "provider initialization unavailable" }, reason: "provider initialization failed before any send attempt" };
    }
    if (initialize.status < 200 || initialize.status >= 300 || nestedError(decoded(initialize).value)) {
      return { status: "failed", recovered: false, providerReadback: { observedAt: startedAt, detail: "provider initialization failed" }, reason: "provider initialization failed" };
    }
    sessionId = initialize.transportSessionId;

    const beforeReadAt = this.now();
    if (beforeReadAt >= proposal.approvalExpiresAt) {
      return { status: "failed", recovered: false, providerReadback: { observedAt: beforeReadAt, detail: "approval expired before provider reread" }, reason: "the exact 30-minute approval window expired" };
    }
    const readCapability = this.authority.issueExact("outbound-readback", proposal.providerReadAction, proposal.canonicalDigest, proposal.approvalExpiresAt - beforeReadAt, beforeReadAt);
    let before: RelayResult;
    try {
      before = await this.relay(
        callPayload(`outbound-read-${proposal.proposalId}`, proposal.providerReadAction),
        sessionId,
        { token: readCapability, kind: "outbound-readback", action: proposal.providerReadAction, proposalDigest: proposal.canonicalDigest },
      );
    } catch {
      return { status: "failed", recovered: false, providerReadback: { observedAt: this.now(), detail: "provider state reread unavailable" }, reason: "provider state could not be reread before any send attempt" };
    }
    const beforeState = readback(before, this.now());
    const providerReadback: OutboundProviderReadback = {
      observedAt: beforeState.observedAt,
      providerResultId: beforeState.providerResultId,
      detail: beforeState.detail,
    };
    if (before.status < 200 || before.status >= 300 || nestedError(beforeState.value)) {
      return { status: "failed", recovered: false, providerReadback, reason: "provider state could not be reread" };
    }
    const mismatch = bindingFailure(beforeState.value, proposal);
    if (mismatch) return { status: "failed", recovered: false, providerReadback, reason: mismatch };
    const sendAt = this.now();
    if (proposal.approvalExpiresAt - sendAt < 1_000) {
      return { status: "failed", recovered: false, providerReadback, reason: "the exact 30-minute approval window expired before send" };
    }

    const capability = this.authority.issueExact("outbound-send", proposal.providerAction, proposal.canonicalDigest, proposal.approvalExpiresAt - sendAt, sendAt);
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
      const recoveryAt = this.now();
      const recoveryCapability = this.authority.issueExact("outbound-readback", proposal.providerReadAction, proposal.canonicalDigest, 5 * 60_000, recoveryAt);
      let after: RelayResult;
      try {
        after = await this.relay(
          callPayload(`outbound-recover-${proposal.proposalId}`, proposal.providerReadAction),
          sessionId,
          { token: recoveryCapability, kind: "outbound-readback", action: proposal.providerReadAction, proposalDigest: proposal.canonicalDigest },
        );
      } catch {
        return {
          status: "failed",
          recovered: false,
          providerReadback: { observedAt: this.now(), detail: "provider state unavailable after ambiguous send" },
          reason: "send outcome is ambiguous; provider readback failed and no retry was attempted",
        };
      }
      const afterState = readback(after, this.now());
      const recoveredReadback: OutboundProviderReadback = {
        observedAt: afterState.observedAt,
        providerResultId: afterState.providerResultId,
        detail: "provider state reread after ambiguous send; delivery was not inferred",
      };
      return { status: "failed", recovered: false, providerReadback: recoveredReadback, reason: "send outcome is ambiguous; no retry was attempted" };
    }
  }
}
