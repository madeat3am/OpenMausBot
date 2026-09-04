import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OutboundProposalStore } from "./outbound-proposals.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function input(now = 1_000_000) {
  return {
    originatingThreadId: "thread-1",
    coordinatorBotId: "poppy",
    communicationsReceipt: { id: "communications-1", status: "completed", finishedAt: now - 20 },
    humanVoiceReceipt: { id: "voice-1", status: "completed", finishedAt: now - 10 },
    accountAlias: "personal",
    channel: "gmail",
    purpose: "acceptance-test",
    relationshipBoundary: "trey-personal",
    recipients: ["trey"],
    subject: "Acceptance",
    body: "This is a reviewed draft.",
    attachments: [],
    providerDraftId: "draft-1",
    sourceReferences: [{ uri: "gmail://thread/1", relationshipBoundary: "trey-personal", observedAt: now - 100, freshUntil: now + 100 }],
    materialFacts: "verified",
    rationale: "Matches the current thread and Trey's concise style.",
    providerAction: { transport: "composio", server: "composio", tool: "GMAIL_SEND_DRAFT", accountAlias: "personal", arguments: { draft_id: "draft-1", idempotency_key: "proposal-1" } },
    providerReadAction: { transport: "composio", server: "composio", tool: "GMAIL_GET_DRAFT", accountAlias: "personal", arguments: { draft_id: "draft-1" } },
    idempotencyKey: "proposal-1",
  };
}

describe("outbound proposals", () => {
  it("persists a complete reviewed proposal and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    const proposal = store.create(input(), 1_000_000);
    expect(proposal).toMatchObject({ schema: "openmausbot.outbound-proposal.v1", status: "pending", canonicalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(new OutboundProposalStore(dir).get(proposal.proposalId)).toMatchObject({ providerDraftId: "draft-1", status: "pending" });
  });

  it("holds missing, conflicting, or stale evidence instead of seeking approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    expect(store.create({ ...input(), materialFacts: "missing" }, 1_000_000).status).toBe("held");
    expect(store.create({ ...input(), materialFacts: "conflicting" }, 1_000_000).status).toBe("held");
    const stale = input(); stale.sourceReferences[0]!.freshUntil = 999_999;
    expect(store.create(stale, 1_000_000)).toMatchObject({ status: "held", outcomeReason: expect.stringContaining("stale") });
  });

  it("rejects account drift and requires provider reread arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    expect(() => store.create({ ...input(), providerAction: { ...input().providerAction, accountAlias: "work" } }, 1_000_000)).toThrow(/account/);
    expect(() => store.create({ ...input(), providerReadAction: undefined }, 1_000_000)).toThrow();
    expect(() => store.create({ ...input(), sourceReferences: [{ ...input().sourceReferences[0], relationshipBoundary: "other-client" }] }, 1_000_000)).toThrow(/cross-relationship/);
  });

  it("only transitions pending proposals through one terminal choice", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    const proposal = store.create(input(), 1_000_000);
    expect(store.transition(proposal.proposalId, ["pending"], "revision_requested", {}, 1_000_001).status).toBe("revision_requested");
    expect(() => store.transition(proposal.proposalId, ["pending"], "sending")).toThrow(/revision_requested/);
  });
});
