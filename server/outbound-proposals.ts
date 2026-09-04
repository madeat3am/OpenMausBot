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
  accountAlias: short.optional(),
}).strict();

const proposalInputSchema = z.object({
  originatingThreadId: short,
  coordinatorBotId: short,
  communicationsReceipt: terminalReceipt,
  humanVoiceReceipt: terminalReceipt,
  accountAlias: short,
  channel: short,
  purpose: short,
  relationshipBoundary: short,
  recipients: z.array(short).min(1).max(64),
  subject: z.string().max(2_000).optional(),
  body: z.string().min(1).max(200_000),
  attachments: z.array(attachment).max(32).default([]),
  providerDraftId: short.optional(),
  sourceReferences: z.array(sourceReference).min(1).max(100),
  materialFacts: z.enum(["verified", "missing", "conflicting"]),
  rationale: z.string().trim().min(1).max(2_000),
  providerAction: actionSchema,
  providerReadAction: actionSchema,
  idempotencyKey: short,
}).strict();

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
  providerReadback?: OutboundProviderReadback;
  outcomeReason?: string;
}

interface DiskState { schema: "openmausbot.outbound-proposals-store.v1"; proposals: OutboundProposal[] }

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
    humanVoiceReceipt: row.humanVoiceReceipt,
    accountAlias: row.accountAlias,
    channel: row.channel,
    purpose: row.purpose,
    relationshipBoundary: row.relationshipBoundary,
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
    idempotencyKey: row.idempotencyKey,
  });
}

function validStored(value: unknown): value is OutboundProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<OutboundProposal>;
  return row.schema === OUTBOUND_PROPOSAL_SCHEMA
    && typeof row.proposalId === "string"
    && typeof row.canonicalDigest === "string"
    && (() => { try { proposalInput(row); return true; } catch { return false; } })()
    && ["pending", "held", "revision_requested", "cancelled", "sending", "sent", "failed"].includes(String(row.status));
}

export class OutboundProposalStore {
  private proposals: OutboundProposal[] = [];
  private readonly file: string;

  constructor(dataDir: string, file = join(dataDir, "outbound-proposals.json")) {
    this.file = file;
    try {
      const disk = JSON.parse(readFileSync(file, "utf8")) as Partial<DiskState>;
      if (disk.schema === "openmausbot.outbound-proposals-store.v1" && Array.isArray(disk.proposals)) {
        this.proposals = disk.proposals.filter(validStored);
      }
    } catch {
      // First launch or corrupt legacy state: fail closed with no approvals.
    }
  }

  create(raw: unknown, now = Date.now()): OutboundProposal {
    const input = proposalInput(raw);
    if (input.providerAction.transport !== "composio" || input.providerAction.server !== "composio") {
      throw new Error("outbound sends must use the guarded Composio provider path");
    }
    if (input.providerAction.accountAlias !== input.accountAlias) {
      throw new Error("provider action account does not match the proposal");
    }
    if (input.providerReadAction.accountAlias !== input.accountAlias) {
      throw new Error("provider readback account does not match the proposal");
    }
    if (input.sourceReferences.some((source) => source.relationshipBoundary !== input.relationshipBoundary)) {
      throw new Error("cross-relationship evidence is forbidden");
    }
    const stale = input.sourceReferences.some((source) => source.observedAt > now || source.freshUntil < now);
    const status: OutboundProposalStatus = input.materialFacts === "verified" && !stale ? "pending" : "held";
    const proposal: OutboundProposal = {
      schema: OUTBOUND_PROPOSAL_SCHEMA,
      proposalId: randomUUID(),
      ...input,
      canonicalDigest: proposalDigest(input),
      status,
      createdAt: now,
      updatedAt: now,
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
    return proposal.canonicalDigest === proposalDigest(proposalInput(proposal));
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify({ schema: "openmausbot.outbound-proposals-store.v1", proposals: this.proposals }, null, 2), { mode: 0o600 });
  }
}
