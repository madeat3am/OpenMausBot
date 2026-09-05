import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    reviewClass: "high-stakes" as const,
    humanVoiceRubric: { version: "openmausbot.human-voice-rubric.v1" as const, applied: true as const },
    providerAccountId: "ca_gmail_personal",
    accountAlias: "personal",
    providerChannelId: "gmail",
    channel: "gmail",
    purpose: "acceptance-test",
    relationshipBoundary: "trey-personal",
    providerRecipientIds: ["email:trey@example.com"],
    recipients: ["trey"],
    subject: "Acceptance",
    body: "This is a reviewed draft.",
    attachments: [],
    providerDraftId: "draft-1",
    sourceReferences: [{ uri: "gmail://thread/1", relationshipBoundary: "trey-personal", observedAt: now - 100, freshUntil: now + 100 }],
    materialFacts: "verified",
    rationale: "Matches the current thread and Trey's concise style.",
    providerAction: { transport: "composio", server: "composio", tool: "GMAIL_SEND_DRAFT", providerAccountId: "ca_gmail_personal", accountAlias: "personal", arguments: { draft_id: "draft-1" } },
    providerReadAction: { transport: "composio", server: "composio", tool: "GMAIL_GET_DRAFT", providerAccountId: "ca_gmail_personal", accountAlias: "personal", arguments: { draft_id: "draft-1" } },
  };
}

describe("outbound proposals", () => {
  it("persists a complete reviewed proposal and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    const proposal = store.create(input(), 1_000_000);
    expect(proposal).toMatchObject({ schema: "openmausbot.outbound-proposal.v1", status: "pending", approvalExpiresAt: 2_800_000, canonicalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(proposal.idempotencyKey).toBe(`omb-outbound:${proposal.proposalId}`);
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
    expect(() => store.create({ ...input(), providerAction: { ...input().providerAction, providerAccountId: "ca_other" } }, 1_000_000)).toThrow(/account/);
    expect(() => store.create({ ...input(), providerAction: { ...input().providerAction, arguments: { draft_id: "draft-2" } } }, 1_000_000)).toThrow(/approved draft/);
    // the bot-visible MCP server name is the guarded Composio path
    const aliased = store.create({
      ...input(),
      providerAction: { ...input().providerAction, server: "openmausbot_connectors" },
      providerReadAction: { ...input().providerReadAction, server: "openmausbot_connectors" },
    }, 1_000_000);
    expect(aliased.providerAction.server).toBe("composio");
    expect(aliased.providerReadAction.server).toBe("composio");
    // unix-second source timestamps are normalized to milliseconds, not read as 1970
    const nowMs = 1_800_000_000_000;
    const seconds = store.create({
      ...input(),
      sourceReferences: [{ ...input().sourceReferences[0], observedAt: Math.floor(nowMs / 1000) - 60, freshUntil: Math.floor(nowMs / 1000) + 600 }],
    }, nowMs);
    expect(seconds.status).toBe("pending");
    expect(seconds.sourceReferences[0].observedAt).toBe((Math.floor(nowMs / 1000) - 60) * 1000);
    expect(() => store.create({ ...input(), providerReadAction: { ...input().providerReadAction, arguments: { draft_id: "draft-2" } } }, 1_000_000)).toThrow(/approved draft/);
    expect(() => store.create({ ...input(), providerAction: { ...input().providerAction, tool: "SLACK_SEND_MESSAGE" } }, 1_000_000)).toThrow(/channel/);
    expect(() => store.create({ ...input(), providerReadAction: undefined }, 1_000_000)).toThrow();
    expect(() => store.create({ ...input(), sourceReferences: [{ ...input().sourceReferences[0], relationshipBoundary: "other-client" }] }, 1_000_000)).toThrow(/cross-relationship/);
  });

  it("preserves incomplete legacy rows as non-executable history", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const file = join(dir, "outbound-proposals.json");
    const legacy = { schema: "openmausbot.outbound-proposal.v1", proposalId: "legacy-1", status: "pending", body: "legacy reviewed body" };
    writeFileSync(file, JSON.stringify({ schema: "openmausbot.outbound-proposals-store.v1", proposals: [legacy] }));
    const store = new OutboundProposalStore(dir);
    expect(store.get("legacy-1")).toBeNull();
    store.create(input(), 1_000_000);
    const disk = JSON.parse(readFileSync(file, "utf8")) as { proposals: unknown[] };
    expect(disk.proposals).toContainEqual(legacy);
  });

  it("fails closed on missing expiry and settles a send interrupted by restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    const proposal = store.create(input(), 1_000_000);
    store.transition(proposal.proposalId, ["pending"], "sending", {}, 1_000_001);
    const file = join(dir, "outbound-proposals.json");
    const disk = JSON.parse(readFileSync(file, "utf8")) as { proposals: Array<Record<string, unknown>> };
    const missingExpiry = { ...disk.proposals[0] };
    delete missingExpiry.approvalExpiresAt;
    disk.proposals.push(missingExpiry);
    writeFileSync(file, JSON.stringify(disk));

    const reloaded = new OutboundProposalStore(dir);
    expect(reloaded.get(proposal.proposalId)).toMatchObject({ status: "failed", outcomeReason: expect.stringContaining("ambiguous after restart") });
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { proposals: Array<Record<string, unknown>> };
    expect(persisted.proposals.some((row) => row.proposalId === proposal.proposalId && row.approvalExpiresAt === undefined)).toBe(true);
  });

  it("uses inline Human Voice review for routine drafts and requires the specialist for high-stakes drafts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    expect(store.create({ ...input(), reviewClass: "routine", humanVoiceReceipt: undefined }, 1_000_000)).toMatchObject({ status: "pending", reviewClass: "routine" });
    expect(() => store.create({ ...input(), humanVoiceReceipt: undefined }, 1_000_000)).toThrow(/Human Voice/);
  });

  it("only transitions pending proposals through one terminal choice", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-outbound-")); dirs.push(dir);
    const store = new OutboundProposalStore(dir);
    const proposal = store.create(input(), 1_000_000);
    expect(store.transition(proposal.proposalId, ["pending"], "revision_requested", {}, 1_000_001).status).toBe("revision_requested");
    expect(() => store.transition(proposal.proposalId, ["pending"], "sending")).toThrow(/revision_requested/);
    expect(store.actionStillMatches({ ...proposal, idempotencyKey: "agent-selected" })).toBe(false);
  });
});
