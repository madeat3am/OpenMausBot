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
    originatingThreadId: "thread-1",
    coordinatorBotId: "poppy",
    communicationsReceipt: { id: "communications-1", status: "completed", finishedAt: 1 },
    humanVoiceReceipt: { id: "voice-1", status: "completed", finishedAt: 1 },
    accountAlias: "personal",
    channel: "gmail",
    purpose: "acceptance-test",
    relationshipBoundary: "trey-personal",
    recipients: ["self"],
    subject: "Acceptance",
    body: "Reviewed body",
    attachments: [],
    providerDraftId: "draft-1",
    sourceReferences: [{ uri: "gmail://thread/1", relationshipBoundary: "trey-personal", observedAt: 1, freshUntil: 10_000 }],
    materialFacts: "verified",
    rationale: "reviewed",
    providerAction: { transport: "composio", server: "composio", tool: "GMAIL_SEND_DRAFT", accountAlias: "personal", arguments: { draft_id: "draft-1", idempotency_key: "idem-1" } },
    providerReadAction: { transport: "composio", server: "composio", tool: "GMAIL_GET_DRAFT", accountAlias: "personal", arguments: { draft_id: "draft-1" } },
    idempotencyKey: "idem-1",
  };
}

describe("outbound executor", () => {
  it("rereads provider state then executes the exact stored action once", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1" } }))
      .mockResolvedValueOnce(response({ result: { log_id: "log-1", message_id: "message-1" } }));
    const result = await new OutboundExecutor(new AutonomyAuthority(undefined, Buffer.alloc(32, 1)), relay).execute(proposal(), 100);
    expect(result).toMatchObject({ status: "sent", recovered: false, providerResultId: "log-1" });
    expect(relay).toHaveBeenCalledTimes(3);
    expect(relay.mock.calls[2]![0]).toMatchObject({ params: { arguments: { tools: [{ tool_slug: "GMAIL_SEND_DRAFT", arguments: { draft_id: "draft-1", idempotency_key: "idem-1" } }] } } });
  });

  it("does not send when the provider draft changed", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "other" } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay).execute(proposal(), 100)).toMatchObject({ status: "failed", reason: expect.stringContaining("draft changed") });
    expect(relay).toHaveBeenCalledTimes(2);
  });

  it("recovers an ambiguous timeout by idempotency readback without retrying", async () => {
    const relay = vi.fn<OutboundRelay>()
      .mockResolvedValueOnce(response({ result: {} }))
      .mockResolvedValueOnce(response({ result: { draft_id: "draft-1" } }))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(response({ result: { log_id: "log-recovered", idempotency_key: "idem-1" } }));
    expect(await new OutboundExecutor(new AutonomyAuthority(), relay).execute(proposal(), 100)).toMatchObject({ status: "sent", recovered: true, providerResultId: "log-recovered" });
    expect(relay).toHaveBeenCalledTimes(4);
  });
});
