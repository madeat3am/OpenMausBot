export const OPERATOR_EXCEPTION_SCHEMA = "openmausbot.operator-exception.v1" as const;

export type OperatorExceptionStatus = "pending" | "cancelled" | "executing" | "executed" | "failed";

/** Renderer-safe projection. The exact provider request stays in the
 * mode-0600 server store and is never returned to the model or browser. */
export interface OperatorExceptionCardData {
  schema: typeof OPERATOR_EXCEPTION_SCHEMA;
  proposalId: string;
  actionDigest: string;
  tool: string;
  accountAlias?: string;
  status: OperatorExceptionStatus;
}
