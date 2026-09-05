import { describe, expect, it, vi } from "vitest";

import { AutonomyAuthority } from "./autonomy-policy.ts";
import { OutboundExecutor, type OutboundRelay } from "./outbound-executor.ts";
import type { OutboundProposal } from "./outbound-proposals.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const response = (value: unknown, session = "session-1") => ({ status: 200, bytes: bytes(value), contentType: "application/json", transportSessionId: session });

function proposal(): OutboundProposal {
  return {
    schema: "openmausbot.outbound-proposal.v1",
    proposalId: "proposal-1",
    canonicalDigest: "a".repeat(64),
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    approvalExpiresAt: 1_800_001,
    originatingThreadId: "thread-1",
    coordinatorBotId: "poppy",
    communicationsReceipt: { id: "communications-1", status: "completed", finishedAt: 1 },
    humanVoiceReceipt: { id: "voice-1", status: "completed", finishedAt: 1 },
    reviewClass: "high-stakes",
    humanVoiceRubric: { version: "openmausbot.human-voice-rubric.v1", applied: true },
    providerAccountId: "ca_gmail_personal",
    accountAlias: "personal",
    providerChannelId: "gmail",
    channel: "gmail",
    purpose: "acceptance-test",
    relationshipBoundary: "trey-personal",
    providerRecipientIds: ["self@example.com"],
    recipients: ["self@example.com"],
    subject: "Acceptance",
    body: "Reviewed body",
    attachments: [],
    providerDraftId: "draft-1",
    sourceReferences: [{ uri: "gmail://thread/1", relationshipBoundary: "trey-personal", observedAt: 1, freshUntil: 10_000 }],
    materialFacts: "verified",
    rationale: "reviewed",
    providerAction: { transport: "composio", server: "composio", tool: "GMAIL_SEND_DRAFT", providerAccountId: "ca_gmail_personal", accountAlias: "personal", arguments: { draft_id: "draft-1" } },
    providerReadAction: { transport: "composio", server: "composio", tool: "GMAIL_GET_DRAFT", providerAccountId: "ca_gmail_personal", accountAlias: "personal", arguments: { draft_id: "draft-1" } },
    idempotencyKey: "idem-1",
  };
}

describe("outbound executor", () => {
  it("rereads provider state then executes the exact stored action once", async () => {
    let now = 100;
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1", to: ["self@example.com"] } }))
      .mockResolvedValueOnce(response({ result: { log_id: "log-1", message_id: "message-1" } }));
    const result = await new OutboundExecutor(new AutonomyAuthority(undefined, Buffer.alloc(32, 1)), relay, () => now).execute(proposal());
    expect(result).toMatchObject({ status: "sent", recovered: false, providerResultId: "log-1" });
    expect(relay).toHaveBeenCalledTimes(3);
    expect(relay.mock.calls[2]![0]).toMatchObject({ params: { arguments: { tools: [{ tool_slug: "GMAIL_SEND_DRAFT", connected_account_id: "ca_gmail_personal", arguments: { draft_id: "draft-1" } }] } } });
  });

  it("matches recipients in a provider MCP content envelope", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { content: [{ type: "text", text: JSON.stringify({ data: { id: "draft-1", message: { payload: { headers: [{ name: "To", value: "Self <self@example.com>" }] } } } }) }] } }))
      .mockResolvedValueOnce(response({ result: { data: { log_id: "log-1" } } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => 100).execute(proposal())).toMatchObject({ status: "sent" });
  });

  it("does not send when the provider draft changed", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "other" } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => 100).execute(proposal())).toMatchObject({ status: "failed", reason: expect.stringContaining("draft changed") });
    expect(relay).toHaveBeenCalledTimes(2);
  });

  it("does not send when the provider draft recipients changed", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1", to: ["other@example.com"] } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => 100).execute(proposal())).toMatchObject({ status: "failed", reason: expect.stringContaining("recipients") });
    expect(relay).toHaveBeenCalledTimes(2);
  });

  it("does not send when an extra provider recipient was added after approval", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1", to: ["self@example.com"], bcc: ["other@example.com"] } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => 100).execute(proposal())).toMatchObject({ status: "failed", reason: expect.stringContaining("recipients") });
    expect(relay).toHaveBeenCalledTimes(2);
  });

  it("does not mint a send capability after the approval deadline", async () => {
    let now = 100;
    const relay = vi.fn<OutboundRelay>()
      .mockImplementationOnce(async () => {
        now = proposal().approvalExpiresAt;
        return response({ result: {} });
      });
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => now).execute(proposal())).toMatchObject({ status: "failed", reason: expect.stringContaining("expired") });
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it("rereads an ambiguous timeout but never infers delivery or retries", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1", to: ["self@example.com"] } }))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1", to: ["self@example.com"], log_id: "log-observed" } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => 100).execute(proposal())).toMatchObject({ status: "failed", recovered: false, reason: expect.stringContaining("ambiguous") });
    expect(relay).toHaveBeenCalledTimes(4);
  });

  it("returns a terminal failure when the provider transport rejects before send", async () => {
    const relay = vi.fn<OutboundRelay>().mockRejectedValueOnce(new Error("offline"));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay, () => 100).execute(proposal())).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("before any send attempt"),
    });
  });
});
