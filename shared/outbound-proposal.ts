export const OUTBOUND_PROPOSAL_SCHEMA = "openmausbot.outbound-proposal.v1" as const;

export type OutboundProposalStatus =
  | "pending"
  | "held"
  | "revision_requested"
  | "cancelled"
  | "sending"
  | "sent"
  | "failed";

/** Small, renderer-safe projection. The protected provider arguments and
 * evidence receipts remain server-side. */
export interface OutboundProposalCardData {
  schema: typeof OUTBOUND_PROPOSAL_SCHEMA;
  proposalId: string;
  digest: string;
  approvalExpiresAt: number;
  reviewClass: "routine" | "high-stakes";
  channel: string;
  accountAlias: string;
  purpose: string;
  /** Immutable provider identities covered by this exact approval. */
  providerRecipientIds: string[];
  recipients: string[];
  subject?: string;
  attachmentCount: number;
  status: OutboundProposalStatus;
  rationale: string;
}
