import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { exactActionDigest, isOperatorException } from "./autonomy-policy.ts";
import { writeFileAtomic } from "./atomic.ts";
import { OPERATOR_EXCEPTION_SCHEMA, type OperatorExceptionStatus } from "../shared/operator-exception.ts";

const short = z.string().trim().min(1).max(300);
const actionSchema = z.object({
  transport: z.enum(["composio", "custom-mcp"]),
  server: short,
  tool: short,
  arguments: z.record(z.string(), z.unknown()),
  accountAlias: short.optional(),
}).strict();
const inputSchema = z.object({
  botId: short,
  threadId: short,
  action: actionSchema,
  payload: z.record(z.string(), z.unknown()),
  transportSessionId: short.optional(),
}).strict();

export interface OperatorExceptionProposal extends z.infer<typeof inputSchema> {
  schema: typeof OPERATOR_EXCEPTION_SCHEMA;
  proposalId: string;
  actionDigest: string;
  status: OperatorExceptionStatus;
  createdAt: number;
  updatedAt: number;
  providerResultId?: string;
  outcomeReason?: string;
}

interface DiskState {
  schema: "openmausbot.operator-exceptions-store.v1";
  proposals: OperatorExceptionProposal[];
}

function proposalInput(value: unknown): z.infer<typeof inputSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return inputSchema.parse(value);
  const row = value as Record<string, unknown>;
  return inputSchema.parse({
    botId: row.botId,
    threadId: row.threadId,
    action: row.action,
    payload: row.payload,
    transportSessionId: row.transportSessionId,
  });
}

function validStored(value: unknown): value is OperatorExceptionProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<OperatorExceptionProposal>;
  return row.schema === OPERATOR_EXCEPTION_SCHEMA
    && typeof row.proposalId === "string"
    && typeof row.actionDigest === "string"
    && (() => { try { proposalInput(row); return true; } catch { return false; } })()
    && ["pending", "cancelled", "executing", "executed", "failed"].includes(String(row.status));
}

export class OperatorExceptionStore {
  private proposals: OperatorExceptionProposal[] = [];
  private readonly file: string;

  constructor(dataDir: string, file = join(dataDir, "operator-exceptions.json")) {
    this.file = file;
    try {
      const disk = JSON.parse(readFileSync(file, "utf8")) as Partial<DiskState>;
      if (disk.schema === "openmausbot.operator-exceptions-store.v1" && Array.isArray(disk.proposals)) {
        this.proposals = disk.proposals.filter(validStored);
      }
    } catch {
      // Missing or invalid state fails closed with no executable proposal.
    }
  }

  create(raw: unknown, now = Date.now()): OperatorExceptionProposal {
    const input = proposalInput(raw);
    if (!isOperatorException(input.action)) throw new Error("action is not an operator exception");
    const actionDigest = exactActionDigest(input.action);
    const existing = this.proposals.find((proposal) =>
      proposal.threadId === input.threadId && proposal.actionDigest === actionDigest && proposal.status === "pending"
    );
    if (existing) return structuredClone(existing);
    const proposal: OperatorExceptionProposal = {
      schema: OPERATOR_EXCEPTION_SCHEMA,
      proposalId: randomUUID(),
      ...input,
      actionDigest,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.unshift(proposal);
    this.persist();
    return structuredClone(proposal);
  }

  get(id: string): OperatorExceptionProposal | null {
    const found = this.proposals.find((proposal) => proposal.proposalId === id);
    return found ? structuredClone(found) : null;
  }

  transition(
    id: string,
    from: OperatorExceptionStatus[],
    to: OperatorExceptionStatus,
    patch: Partial<Pick<OperatorExceptionProposal, "providerResultId" | "outcomeReason">> = {},
    now = Date.now(),
  ): OperatorExceptionProposal {
    const index = this.proposals.findIndex((proposal) => proposal.proposalId === id);
    if (index < 0) throw new Error("operator exception not found");
    const current = this.proposals[index]!;
    if (!from.includes(current.status)) throw new Error(`operator exception is ${current.status}`);
    const next = { ...current, ...patch, status: to, updatedAt: now };
    this.proposals[index] = next;
    this.persist();
    return structuredClone(next);
  }

  actionStillMatches(proposal: OperatorExceptionProposal): boolean {
    return proposal.actionDigest === exactActionDigest(proposal.action) && isOperatorException(proposal.action);
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify({ schema: "openmausbot.operator-exceptions-store.v1", proposals: this.proposals }, null, 2), { mode: 0o600 });
  }
}
