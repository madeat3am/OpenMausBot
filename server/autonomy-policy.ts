import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

export const AUTONOMY_POLICY_SCHEMA = "openmausbot.autonomy-policy.v1" as const;
export const AUTONOMY_DECISION_SCHEMA = "openmausbot.autonomy-decision.v1" as const;

export const ALLOWED_EFFECTS = [
  "read",
  "communication_draft",
  "todoist_upsert",
  "thread_reply",
  "calendar_upsert",
  "crm_note_upsert",
  "wiki_upsert",
  "omb_admin",
] as const;

export const DENIED_EFFECTS = ["money", "delete", "permission", "credential", "security"] as const;

const wakeKindSchema = z.enum(["operator", "routine", "webhook"]);
const transportSchema = z.enum(["composio", "custom-mcp"]);
const effectSchema = z.enum(ALLOWED_EFFECTS);
const shortId = z.string().trim().min(1).max(160);
const constraintsSchema = z.object({
  recipientAliases: z.array(shortId).max(64).optional(),
  purposes: z.array(shortId).min(1).max(64).optional(),
  originatingThreadOnly: z.boolean().optional(),
  argumentEquals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict().optional();

const ruleSchema = z.object({
  id: shortId,
  botId: shortId,
  wakeKinds: z.array(wakeKindSchema).min(1).max(3),
  routineIds: z.array(shortId).max(100).optional(),
  triggerIds: z.array(shortId).max(100).optional(),
  transport: transportSchema,
  server: shortId,
  tools: z.array(shortId).min(1).max(200),
  accountAliases: z.array(shortId).max(100).optional(),
  effect: effectSchema,
  /** Outbound sends never become autonomous merely because a broad policy
   * row exists. Trey must explicitly promote the exact recipient/account/
   * channel/purpose rule first. */
  authority: z.literal("operator-promoted").optional(),
  constraints: constraintsSchema,
}).strict();

const webhookRouteSchema = z.object({
  id: shortId,
  triggerSlugs: z.array(shortId).min(1).max(100),
  botId: shortId,
  connectedAccountIds: z.array(shortId).max(100).optional(),
  runOn: z.enum(["maus", "cloud"]).optional(),
}).strict();

const policySchema = z.object({
  schema: z.literal(AUTONOMY_POLICY_SCHEMA),
  revision: shortId,
  rules: z.array(ruleSchema).max(2_000),
  webhooks: z.array(webhookRouteSchema).max(500).optional(),
}).strict().superRefine((policy, ctx) => {
  const ids = new Set<string>();
  for (const [index, rule] of policy.rules.entries()) {
    if (ids.has(rule.id)) ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: "Rule ids must be unique" });
    ids.add(rule.id);
    if (rule.wakeKinds.includes("routine") && rule.routineIds?.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rules", index, "routineIds"], message: "routineIds cannot be empty" });
    }
    if (rule.wakeKinds.includes("webhook") && rule.triggerIds?.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rules", index, "triggerIds"], message: "triggerIds cannot be empty" });
    }
    if (rule.effect === "thread_reply" && rule.authority !== "operator-promoted") {
      ctx.addIssue({ code: "custom", path: ["rules", index, "authority"], message: "thread_reply rules must be explicitly operator-promoted" });
    }
  }
});

export type AutonomyPolicy = Readonly<z.infer<typeof policySchema>>;
export type WakeKind = z.infer<typeof wakeKindSchema>;
export type AllowedEffect = z.infer<typeof effectSchema>;
export type DeniedEffect = typeof DENIED_EFFECTS[number];

export interface CapabilityContext {
  botId: string;
  threadId: string;
  wakeKind: WakeKind;
  routineId?: string;
  triggerId?: string;
}

interface CapabilityPayload extends CapabilityContext {
  schema: "openmausbot.autonomy-capability.v1";
  policyDigest: string;
  expiresAt: number;
  nonce: string;
}

interface ExactCapabilityPayload {
  schema: "openmausbot.exact-effect-capability.v1";
  kind: "outbound-send" | "outbound-readback" | "operator-exception";
  actionDigest: string;
  proposalDigest?: string;
  expiresAt: number;
  nonce: string;
}

export interface ToolAction {
  transport: "composio" | "custom-mcp";
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  accountAlias?: string;
}

export interface AutonomyDecision {
  schema: typeof AUTONOMY_DECISION_SCHEMA;
  allowed: boolean;
  code: string;
  reason: string;
  ruleId?: string;
  effect?: AllowedEffect | DeniedEffect;
  tool: string;
  accountAlias?: string;
}

export interface PolicyState {
  policy: AutonomyPolicy | null;
  digest: string | null;
  revision: string | null;
  status: "resolved" | "missing" | "invalid";
  error?: string;
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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

export function parseAutonomyPolicy(raw: unknown): { policy: AutonomyPolicy; digest: string } {
  const policy = deepFreeze(policySchema.parse(raw));
  return { policy, digest: createHash("sha256").update(canonical(policy)).digest("hex") };
}

export function loadAutonomyPolicy(path = process.env.OMB_AUTONOMY_POLICY_PATH): PolicyState {
  if (!path?.trim()) return { policy: null, digest: null, revision: null, status: "missing" };
  try {
    const loaded = parseAutonomyPolicy(JSON.parse(readFileSync(path, "utf8")));
    return { ...loaded, revision: loaded.policy.revision, status: "resolved" };
  } catch (error) {
    return {
      policy: null,
      digest: null,
      revision: null,
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

const capabilitySchema = z.object({
  schema: z.literal("openmausbot.autonomy-capability.v1"),
  botId: shortId,
  threadId: shortId,
  wakeKind: wakeKindSchema,
  routineId: shortId.optional(),
  triggerId: shortId.optional(),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
  nonce: z.string().uuid(),
}).strict();

const exactCapabilitySchema = z.object({
  schema: z.literal("openmausbot.exact-effect-capability.v1"),
  kind: z.enum(["outbound-send", "outbound-readback", "operator-exception"]),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().uuid(),
}).strict();

export class AutonomyAuthority {
  readonly state: PolicyState;
  private readonly key: Buffer;
  private readonly consumedExactNonces = new Set<string>();
  private readonly exactNonceFile?: string;

  constructor(state = loadAutonomyPolicy(), key = loadAutonomySigningKey(), exactNonceFile = process.env.OMB_EXACT_NONCE_FILE?.trim()) {
    this.state = state;
    this.key = key;
    this.exactNonceFile = exactNonceFile || undefined;
    if (this.exactNonceFile) {
      const keep: string[] = [];
      try {
        for (const line of readFileSync(this.exactNonceFile, "utf8").split("\n")) {
          const [nonce, expires] = line.trim().split(" ");
          if (!nonce || !expires || Number(expires) <= Date.now()) continue;
          this.consumedExactNonces.add(nonce);
          keep.push(`${nonce} ${expires}`);
        }
      } catch {
        // First launch has no replay ledger. Failure to create or append the
        // path is handled fail-closed before provider I/O in consumeExact.
      }
      writeFileSync(this.exactNonceFile, keep.length ? `${keep.join("\n")}\n` : "", { mode: 0o600 });
      chmodSync(this.exactNonceFile, 0o600);
    }
  }

  issue(context: CapabilityContext, ttlMs = 30 * 60_000, now = Date.now()): string | null {
    if (!this.state.digest || !this.state.policy) return null;
    const payload: CapabilityPayload = {
      schema: "openmausbot.autonomy-capability.v1",
      ...context,
      policyDigest: this.state.digest,
      expiresAt: now + Math.max(1_000, Math.min(ttlMs, 60 * 60_000)),
      nonce: randomUUID(),
    };
    const body = encode(payload);
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }

  verify(token: string | undefined, now = Date.now()): CapabilityPayload | null {
    if (!token || !this.state.digest || !this.state.policy) return null;
    const [body, supplied, ...extra] = token.split(".");
    if (!body || !supplied || extra.length) return null;
    const expected = createHmac("sha256", this.key).update(body).digest();
    let received: Buffer;
    try {
      received = Buffer.from(supplied, "base64url");
    } catch {
      return null;
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    try {
      const payload = capabilitySchema.parse(decode(body));
      if (payload.expiresAt <= now || payload.policyDigest !== this.state.digest) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Minted only by a server-owned confirmation handler. The action digest
   * binds the capability to the exact provider arguments reviewed by the
   * operator; models never receive a general-purpose outbound grant. */
  issueExact(
    kind: ExactCapabilityPayload["kind"],
    action: ToolAction,
    proposalDigest?: string,
    ttlMs = 30 * 60_000,
    now = Date.now(),
  ): string {
    const payload: ExactCapabilityPayload = {
      schema: "openmausbot.exact-effect-capability.v1",
      kind,
      actionDigest: exactActionDigest(action),
      ...(proposalDigest ? { proposalDigest } : {}),
      expiresAt: now + Math.max(1_000, Math.min(ttlMs, 30 * 60_000)),
      nonce: randomUUID(),
    };
    const body = encode(payload);
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }

  /** Consume a single-use exact capability immediately before the server
   * executes its stored provider arguments. A retry must first prove absence
   * using provider readback and receive a newly confirmed capability. */
  consumeExact(
    token: string | undefined,
    kind: ExactCapabilityPayload["kind"],
    action: ToolAction,
    proposalDigest?: string,
    now = Date.now(),
  ): boolean {
    if (!token) return false;
    const [body, supplied, ...extra] = token.split(".");
    if (!body || !supplied || extra.length) return false;
    const expected = createHmac("sha256", this.key).update(body).digest();
    let received: Buffer;
    try { received = Buffer.from(supplied, "base64url"); } catch { return false; }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
    try {
      const payload = exactCapabilitySchema.parse(decode(body));
      if (payload.kind !== kind || payload.expiresAt <= now || this.consumedExactNonces.has(payload.nonce)) return false;
      if (payload.actionDigest !== exactActionDigest(action)) return false;
      if ((payload.proposalDigest ?? undefined) !== (proposalDigest ?? undefined)) return false;
      this.consumedExactNonces.add(payload.nonce);
      if (this.exactNonceFile) {
        try {
          appendFileSync(this.exactNonceFile, `${payload.nonce} ${payload.expiresAt}\n`, { mode: 0o600 });
          chmodSync(this.exactNonceFile, 0o600);
        } catch {
          this.consumedExactNonces.delete(payload.nonce);
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  authorize(token: string | undefined, action: ToolAction, now = Date.now()): AutonomyDecision {
    const hardDenied = hardDeniedEffect(action);
    if (hardDenied) return denied(action, "hard-deny", `${hardDenied} effects are never autonomous`, hardDenied);
    if (isDiscoveryAction(action)) {
      return { schema: AUTONOMY_DECISION_SCHEMA, allowed: true, code: "discovery", reason: "non-effecting discovery", effect: "read", tool: action.tool, ...(action.accountAlias ? { accountAlias: action.accountAlias } : {}) };
    }
    const capability = this.verify(token, now);
    if (!capability) return denied(action, "invalid-capability", "missing, expired, or invalid autonomy capability");
    const policy = this.state.policy;
    if (!policy) return denied(action, "policy-unavailable", "autonomy policy is missing or invalid");
    for (const rule of policy.rules) {
      if (rule.botId !== capability.botId || !rule.wakeKinds.includes(capability.wakeKind)) continue;
      if (rule.transport !== action.transport || rule.server !== action.server || !rule.tools.includes(action.tool)) continue;
      if (capability.wakeKind === "routine" && rule.routineIds
        && (!capability.routineId || !rule.routineIds.includes(capability.routineId))) continue;
      if (capability.wakeKind === "webhook" && rule.triggerIds
        && (!capability.triggerId || !rule.triggerIds.includes(capability.triggerId))) continue;
      if (rule.accountAliases && (!action.accountAlias || !rule.accountAliases.includes(action.accountAlias))) continue;
      if (rule.constraints?.originatingThreadOnly && !argumentMatches(action.arguments, ["threadId", "thread_id"], capability.threadId)) continue;
      if (rule.constraints?.recipientAliases) {
        const recipient = stringArgument(action.arguments, ["recipientAlias", "recipient_alias", "recipient", "to"]);
        if (!recipient || !rule.constraints.recipientAliases.includes(recipient)) continue;
      }
      if (rule.constraints?.purposes) {
        const purpose = stringArgument(action.arguments, ["purpose", "communication_purpose"]);
        if (!purpose || !rule.constraints.purposes.includes(purpose)) continue;
      }
      if (rule.constraints?.argumentEquals) {
        const matches = Object.entries(rule.constraints.argumentEquals).every(([key, value]) => action.arguments[key] === value);
        if (!matches) continue;
      }
      return {
        schema: AUTONOMY_DECISION_SCHEMA,
        allowed: true,
        code: "policy-allowed",
        reason: `allowed by ${rule.id}`,
        ruleId: rule.id,
        effect: rule.effect,
        tool: action.tool,
        ...(action.accountAlias ? { accountAlias: action.accountAlias } : {}),
      };
    }
    return denied(action, "no-matching-rule", "no autonomy rule matches this bot, wake, account, tool, and arguments");
  }
}

function loadAutonomySigningKey(path = process.env.OMB_AUTONOMY_SIGNING_KEY_FILE): Buffer {
  if (!path?.trim()) return randomBytes(32);
  const encoded = readFileSync(path, "utf8").trim();
  if (!encoded) throw new Error("autonomy signing key is empty");
  const key = /^[a-f0-9]{64}$/i.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64url");
  if (key.byteLength < 32) throw new Error("autonomy signing key must contain at least 32 bytes");
  return key;
}

function denied(action: ToolAction, code: string, reason: string, effect?: DeniedEffect): AutonomyDecision {
  return { schema: AUTONOMY_DECISION_SCHEMA, allowed: false, code, reason, ...(effect ? { effect } : {}), tool: action.tool, ...(action.accountAlias ? { accountAlias: action.accountAlias } : {}) };
}

function stringArgument(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof args[key] === "string" && args[key]) return args[key] as string;
  return undefined;
}

function argumentMatches(args: Record<string, unknown>, keys: string[], expected: string): boolean {
  return keys.some((key) => args[key] === expected);
}

function isDiscoveryAction(action: ToolAction): boolean {
  return action.transport === "composio"
    && ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_WAIT_FOR_CONNECTIONS"].includes(action.tool);
}

function hardDeniedEffect(action: ToolAction): DeniedEffect | null {
  const tool = action.tool.toUpperCase();
  if (/REMOTE_(BASH|SHELL|WORKBENCH)|WORKBENCH|CONNECTIONS?$|ACCOUNT_MANAGEMENT/.test(tool)) return "security";
  if (/(_|^)(DELETE|REMOVE|TRASH|PURGE|CANCEL)_/.test(`${tool}_`)) return "delete";
  if (/(_|^)(PAY|TRANSFER|CHARGE|REFUND|PURCHASE|BUY|ISSUE_INVOICE|CREATE_INVOICE)_/.test(`${tool}_`)) return "money";
  if (/(_|^)(GRANT|REVOKE|INVITE|ADD_MEMBER|REMOVE_MEMBER|CHANGE_ROLE)_/.test(`${tool}_`)) return "permission";
  if (/(_|^)(CREATE|ROTATE|RESET|UPDATE)_(API_?KEY|TOKEN|PASSWORD|CREDENTIAL|SECRET)/.test(tool)) return "credential";
  if (/(_|^)(DISABLE_MFA|CHANGE_SECURITY|UPDATE_FIREWALL|CREATE_AUTH_CONFIG|MANAGE_CONNECTIONS)_/.test(`${tool}_`)) return "security";
  return null;
}

/** The only hard-denied operations that can cross an attended, exact,
 * one-time operator confirmation. Permanent deletion and admin/ownership
 * changes deliberately do not match. */
export function isOperatorException(action: ToolAction): boolean {
  const tool = action.tool.toUpperCase();
  const moveToTrash = /(^|_)(MOVE_TO_TRASH|TRASH_MESSAGE|TRASH_FILE|TRASH_ITEM)(_|$)/.test(tool)
    && action.arguments.permanent !== true;
  const collaboratorChange = /(^|_)(ADD_COLLABORATOR|REMOVE_COLLABORATOR|UPDATE_COLLABORATOR)(_|$)/.test(tool)
    && action.arguments.admin !== true
    && action.arguments.role !== "admin"
    && action.arguments.role !== "owner";
  return moveToTrash || collaboratorChange;
}

function actionFromNested(value: unknown): ToolAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const tool = [row.slug, row.tool_slug, row.tool_name, row.name].find((item): item is string => typeof item === "string" && item.length > 0);
  if (!tool) return null;
  const args = [row.arguments, row.args, row.input].find((item) => item && typeof item === "object" && !Array.isArray(item));
  const argumentsRecord = (args ?? {}) as Record<string, unknown>;
  return {
    transport: "composio",
    server: "composio",
    tool,
    arguments: argumentsRecord,
    accountAlias: stringArgument({ ...row, ...argumentsRecord }, ["account", "account_alias", "accountAlias", "connected_account_id", "connectedAccountId"]),
  };
}

export function actionsFromMcpPayload(payload: unknown): { actions: ToolAction[]; error?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { actions: [], error: "invalid MCP request" };
  const request = payload as Record<string, unknown>;
  if (request.method !== "tools/call") return { actions: [] };
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return { actions: [], error: "invalid tools/call params" };
  const row = params as Record<string, unknown>;
  const tool = typeof row.name === "string" ? row.name : "";
  const args = row.arguments && typeof row.arguments === "object" && !Array.isArray(row.arguments)
    ? row.arguments as Record<string, unknown>
    : {};
  if (!tool) return { actions: [], error: "missing tool name" };
  if (tool === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const nested = args.tools ?? args.actions;
    if (!Array.isArray(nested) || nested.length === 0) return { actions: [], error: "multi-execute has no recognizable actions" };
    const actions = nested.map(actionFromNested);
    if (actions.some((action) => action === null)) return { actions: [], error: "multi-execute contains an unrecognized action" };
    return { actions: actions as ToolAction[] };
  }
  return { actions: [{ transport: "composio", server: "composio", tool, arguments: args, accountAlias: stringArgument(args, ["account", "account_alias", "accountAlias", "connected_account_id", "connectedAccountId"]) }] };
}

/** Extract the exact effecting call for a named custom MCP. Handshakes,
 * discovery, notifications, and resource reads are relayed as non-effecting
 * protocol traffic; every tools/call is policy matched before the child sees
 * it. Custom MCP batching is intentionally unsupported unless a policy can
 * inspect the nested provider actions. */
export function actionsFromCustomMcpPayload(
  server: string,
  payload: unknown,
): { actions: ToolAction[]; error?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { actions: [], error: "invalid MCP request" };
  }
  const request = payload as Record<string, unknown>;
  if (request.method !== "tools/call") return { actions: [] };
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { actions: [], error: "invalid tools/call params" };
  }
  const row = params as Record<string, unknown>;
  const tool = typeof row.name === "string" ? row.name.trim() : "";
  if (!tool) return { actions: [], error: "missing tool name" };
  const args = row.arguments && typeof row.arguments === "object" && !Array.isArray(row.arguments)
    ? row.arguments as Record<string, unknown>
    : {};
  return { actions: [{
    transport: "custom-mcp",
    server,
    tool,
    arguments: args,
    accountAlias: stringArgument(args, ["account", "account_alias", "accountAlias"]),
  }] };
}

export function argumentDigest(action: ToolAction): string {
  return createHash("sha256").update(canonical(action.arguments)).digest("hex");
}

export function exactActionDigest(action: ToolAction): string {
  return createHash("sha256").update(canonical({
    transport: action.transport,
    server: action.server,
    tool: action.tool,
    accountAlias: action.accountAlias ?? null,
    arguments: action.arguments,
  })).digest("hex");
}
