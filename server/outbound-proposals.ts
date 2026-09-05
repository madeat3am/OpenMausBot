import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { OUTBOUND_PROPOSAL_SCHEMA, type OutboundProposalStatus } from "../shared/outbound-proposal.ts";

const short = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const terminalReceipt = z.object({
  id: short,
  status: z.literal("completed"),
  finishedAt: z.number().int().positive(),
}).strict();
const humanVoiceRubric = z.object({
  version: z.literal("openmausbot.human-voice-rubric.v1"),
  applied: z.literal(true),
}).strict();
const attachment = z.object({
  name: short,
  mime: short,
  size: z.number().int().min(0).max(25 * 1024 * 1024),
  sha256: digest,
}).strict();
const sourceReference = z.object({
  uri: z.string().trim().min(1).max(2_000),
  relationshipBoundary: short,
  observedAt: z.number().int().positive(),
  freshUntil: z.number().int().positive(),
}).strict();
const actionSchema = z.object({
  transport: z.enum(["composio", "custom-mcp"]),
  server: short,
  tool: short,
  arguments: z.record(z.string(), z.unknown()),
  providerAccountId: short,
  accountAlias: short.optional(),
}).strict();

const proposalInputSchema = z.object({
  originatingThreadId: short,
  coordinatorBotId: short,
  communicationsReceipt: terminalReceipt,
  reviewClass: z.enum(["routine", "high-stakes"]),
  humanVoiceRubric,
  humanVoiceReceipt: terminalReceipt.optional(),
  providerAccountId: short,
  accountAlias: short,
  providerChannelId: short,
  channel: short,
  purpose: short,
  relationshipBoundary: short,
  providerRecipientIds: z.array(short).min(1).max(64),
  recipients: z.array(short).min(1).max(64),
  subject: z.string().max(2_000).optional(),
  body: z.string().min(1).max(200_000),
  attachments: z.array(attachment).max(32).default([]),
  providerDraftId: short,
  sourceReferences: z.array(sourceReference).min(1).max(100),
  materialFacts: z.enum(["verified", "missing", "conflicting"]),
  rationale: z.string().trim().min(1).max(2_000),
  providerAction: actionSchema,
  providerReadAction: actionSchema,
}).strict().superRefine((value, ctx) => {
  if (value.reviewClass === "high-stakes" && !value.humanVoiceReceipt) {
    ctx.addIssue({ code: "custom", path: ["humanVoiceReceipt"], message: "high-stakes proposals require terminal Human Voice review" });
  }
  if (value.providerRecipientIds.length !== value.recipients.length) {
    ctx.addIssue({ code: "custom", path: ["providerRecipientIds"], message: "provider recipient ids must match displayed recipients" });
  }
});

export type OutboundProposalInput = z.input<typeof proposalInputSchema>;
export interface OutboundProviderReadback {
  observedAt: number;
  providerResultId?: string;
  matchedIdempotencyKey?: boolean;
  detail?: string;
}

export interface OutboundProposal extends z.infer<typeof proposalInputSchema> {
  schema: typeof OUTBOUND_PROPOSAL_SCHEMA;
  proposalId: string;
  canonicalDigest: string;
  status: OutboundProposalStatus;
  createdAt: number;
  updatedAt: number;
  approvalExpiresAt: number;
  /** OMB-owned attempt identity. It is intentionally not injected into tool
   * arguments: many provider write schemas (including GMAIL_SEND_DRAFT) do
   * not accept an idempotency field. */
  idempotencyKey: string;
  providerReadback?: OutboundProviderReadback;
  outcomeReason?: string;
}

interface DiskState { schema: "openmausbot.outbound-proposals-store.v1"; proposals: unknown[] }

const DRAFT_ARGUMENT_KEYS = ["draft_id", "draftId", "provider_draft_id", "providerDraftId"];

function boundArgument(action: z.infer<typeof actionSchema>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = action.arguments[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function providerFromTool(tool: string): string {
  return tool.trim().split("_", 1)[0]!.toLowerCase();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function proposalDigest(input: z.infer<typeof proposalInputSchema>): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

function proposalInput(value: unknown): z.infer<typeof proposalInputSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return proposalInputSchema.parse(value);
  }
  const row = value as Record<string, unknown>;
  return proposalInputSchema.parse({
    originatingThreadId: row.originatingThreadId,
    coordinatorBotId: row.coordinatorBotId,
    communicationsReceipt: row.communicationsReceipt,
    reviewClass: row.reviewClass,
    humanVoiceRubric: row.humanVoiceRubric,
    humanVoiceReceipt: row.humanVoiceReceipt,
    providerAccountId: row.providerAccountId,
    accountAlias: row.accountAlias,
    providerChannelId: row.providerChannelId,
    channel: row.channel,
    purpose: row.purpose,
    relationshipBoundary: row.relationshipBoundary,
    providerRecipientIds: row.providerRecipientIds,
    recipients: row.recipients,
    subject: row.subject,
    body: row.body,
    attachments: row.attachments,
    providerDraftId: row.providerDraftId,
    sourceReferences: row.sourceReferences,
    materialFacts: row.materialFacts,
    rationale: row.rationale,
    providerAction: row.providerAction,
    providerReadAction: row.providerReadAction,
  });
}

function validStored(value: unknown): value is OutboundProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<OutboundProposal>;
  return row.schema === OUTBOUND_PROPOSAL_SCHEMA
    && typeof row.proposalId === "string"
    && typeof row.canonicalDigest === "string"
    && /^[a-f0-9]{64}$/.test(row.canonicalDigest)
    && row.idempotencyKey === `omb-outbound:${row.proposalId}`
    && Number.isSafeInteger(row.createdAt)
    && Number.isSafeInteger(row.updatedAt)
    && Number.isSafeInteger(row.approvalExpiresAt)
    && row.approvalExpiresAt === row.createdAt! + 30 * 60_000
    && (() => { try { proposalInput(row); return true; } catch { return false; } })()
    && ["pending", "held", "revision_requested", "cancelled", "sending", "sent", "failed"].includes(String(row.status));
}


/** Bots see the guarded Composio path under the MCP server name
 * `openmausbot_connectors`; the proposal store keys it as `composio`. Accept
 * the visible name so a coordinator quoting exactly what it was shown does
 * not fail the whole proposal on a label. */
const GUARDED_COMPOSIO_SERVER_ALIASES = new Set(["composio", "openmausbot_connectors", "openmausbot-connectors", "openmausbot connectors"]);

function normalizeGuardedServers(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const row = { ...(raw as Record<string, unknown>) };
  for (const key of ["providerAction", "providerReadAction"]) {
    const action = row[key];
    if (!action || typeof action !== "object" || Array.isArray(action)) continue;
    const record = action as Record<string, unknown>;
    if (record.transport === "composio" && typeof record.server === "string"
      && GUARDED_COMPOSIO_SERVER_ALIASES.has(record.server.trim().toLowerCase())) {
      row[key] = { ...record, server: "composio" };
    }
  }
  return row;
}

export class OutboundProposalStore {
  private proposals: OutboundProposal[] = [];
  /** Invalid older rows are retained byte-for-byte as non-executable history.
   * A current proposal is never reconstructed from fields that were absent at
   * the time the operator reviewed it. */
  private preservedLegacyProposals: unknown[] = [];
  private readonly file: string;

  constructor(dataDir: string, file = join(dataDir, "outbound-proposals.json")) {
    this.file = file;
    try {
      const disk = JSON.parse(readFileSync(file, "utf8")) as Partial<DiskState>;
      if (disk.schema === "openmausbot.outbound-proposals-store.v1" && Array.isArray(disk.proposals)) {
        this.proposals = disk.proposals.filter(validStored);
        this.preservedLegacyProposals = disk.proposals.filter((proposal) => !validStored(proposal));
        let interrupted = false;
        this.proposals = this.proposals.map((proposal) => {
          if (proposal.status !== "sending") return proposal;
          interrupted = true;
          const observedAt = Date.now();
          return {
            ...proposal,
            status: "failed",
            updatedAt: observedAt,
            outcomeReason: "send outcome is ambiguous after restart; no retry was attempted",
            providerReadback: { observedAt, detail: "server restarted during the provider attempt" },
          };
        });
        if (interrupted) this.persist();
      }
    } catch {
      // First launch or corrupt legacy state: fail closed with no approvals.
    }
  }

  create(raw: unknown, now = Date.now()): OutboundProposal {
    const input = proposalInput(normalizeGuardedServers(raw));
    if (input.providerAction.transport !== "composio" || input.providerAction.server !== "composio") {
      throw new Error("outbound sends must use the guarded Composio provider path");
    }
    if (input.providerAction.providerAccountId !== input.providerAccountId) {
      throw new Error("provider action account does not match the proposal");
    }
    if (input.providerReadAction.providerAccountId !== input.providerAccountId) {
      throw new Error("provider readback account does not match the proposal");
    }
    if (input.providerReadAction.transport !== "composio" || input.providerReadAction.server !== "composio") {
      throw new Error("outbound readback must use the guarded Composio provider path");
    }
    const expectedProvider = input.providerChannelId.trim().toLowerCase();
    if (providerFromTool(input.providerAction.tool) !== expectedProvider || providerFromTool(input.providerReadAction.tool) !== expectedProvider) {
      throw new Error("provider action channel does not match the proposal");
    }
    if (boundArgument(input.providerAction, DRAFT_ARGUMENT_KEYS) !== input.providerDraftId) {
      throw new Error("provider send action is not bound to the approved draft");
    }
    if (boundArgument(input.providerReadAction, DRAFT_ARGUMENT_KEYS) !== input.providerDraftId) {
      throw new Error("provider readback action is not bound to the approved draft");
    }
    if (input.sourceReferences.some((source) => source.relationshipBoundary !== input.relationshipBoundary)) {
      throw new Error("cross-relationship evidence is forbidden");
    }
    const stale = input.sourceReferences.some((source) => source.observedAt > now || source.freshUntil < now);
    const status: OutboundProposalStatus = input.materialFacts === "verified" && !stale ? "pending" : "held";
    const proposalId = randomUUID();
    const proposal: OutboundProposal = {
      schema: OUTBOUND_PROPOSAL_SCHEMA,
      proposalId,
      ...input,
      canonicalDigest: proposalDigest(input),
      idempotencyKey: `omb-outbound:${proposalId}`,
      status,
      createdAt: now,
      updatedAt: now,
      approvalExpiresAt: now + 30 * 60_000,
      ...(status === "held" ? { outcomeReason: stale ? "source evidence is stale" : `material facts are ${input.materialFacts}` } : {}),
    };
    this.proposals.unshift(proposal);
    this.persist();
    return structuredClone(proposal);
  }

  get(id: string): OutboundProposal | null {
    const found = this.proposals.find((proposal) => proposal.proposalId === id);
    return found ? structuredClone(found) : null;
  }

  pendingForThread(threadId: string): OutboundProposal[] {
    return this.proposals
      .filter((proposal) => proposal.originatingThreadId === threadId && proposal.status === "pending")
      .map((proposal) => structuredClone(proposal));
  }

  transition(id: string, from: OutboundProposalStatus[], to: OutboundProposalStatus, patch: Partial<Pick<OutboundProposal, "providerReadback" | "outcomeReason">> = {}, now = Date.now()): OutboundProposal {
    const index = this.proposals.findIndex((proposal) => proposal.proposalId === id);
    if (index < 0) throw new Error("outbound proposal not found");
    const current = this.proposals[index]!;
    if (!from.includes(current.status)) throw new Error(`outbound proposal is ${current.status}`);
    const next = { ...current, ...patch, status: to, updatedAt: now };
    this.proposals[index] = next;
    this.persist();
    return structuredClone(next);
  }

  actionStillMatches(proposal: OutboundProposal): boolean {
    return proposal.idempotencyKey === `omb-outbound:${proposal.proposalId}`
      && proposal.canonicalDigest === proposalDigest(proposalInput(proposal));
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify({
      schema: "openmausbot.outbound-proposals-store.v1",
      proposals: [...this.proposals, ...this.preservedLegacyProposals],
    }, null, 2), { mode: 0o600 });
  }
}
