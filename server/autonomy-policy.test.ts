import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { actionsFromCustomMcpPayload, actionsFromMcpPayload, AutonomyAuthority, isOperatorException, parseAutonomyPolicy } from "./autonomy-policy.ts";

const rawPolicy = {
  schema: "openmausbot.autonomy-policy.v1",
  revision: "test-1",
  rules: [{
    id: "personal-todoist",
    botId: "personal-admin",
    wakeKinds: ["operator", "routine", "webhook"],
    triggerIds: ["todoist-item-added"],
    transport: "composio",
    server: "composio",
    tools: ["TODOIST_UPSERT_TASK", "TODOIST_GET_TASKS"],
    accountAliases: ["personal"],
    effect: "todoist_upsert",
  }],
};

describe("autonomy policy", () => {
  it("parses, freezes, and digests immutable policy", () => {
    const first = parseAutonomyPolicy(rawPolicy);
    const second = parseAutonomyPolicy({ ...rawPolicy, rules: [...rawPolicy.rules] });
    expect(first.digest).toBe(second.digest);
    expect(Object.isFrozen(first.policy)).toBe(true);
    expect(Object.isFrozen(first.policy.rules[0])).toBe(true);
  });

  it("keeps the checked-in redacted policy example schema-valid", () => {
    expect(() => parseAutonomyPolicy(JSON.parse(readFileSync("docs/autonomy-policy.example.json", "utf8")))).not.toThrow();
  });

  it("rejects malformed or globally denied policy effects", () => {
    expect(() => parseAutonomyPolicy({ ...rawPolicy, schema: "wrong" })).toThrow();
    expect(() => parseAutonomyPolicy({ ...rawPolicy, rules: [{ ...rawPolicy.rules[0], effect: "money" }] })).toThrow();
  });

  it("binds capabilities to bot, wake, trigger, account, and exact tool", () => {
    const parsed = parseAutonomyPolicy(rawPolicy);
    const authority = new AutonomyAuthority({ policy: parsed.policy, digest: parsed.digest, revision: "test-1", status: "resolved" }, Buffer.alloc(32, 7));
    const token = authority.issue({ botId: "personal-admin", threadId: "thread-1", wakeKind: "webhook", triggerId: "todoist-item-added" }, 10_000, 100)!;
    const action = { transport: "composio" as const, server: "composio", tool: "TODOIST_UPSERT_TASK", arguments: {}, accountAlias: "personal" };
    expect(authority.authorize(token, action, 101)).toMatchObject({ allowed: true, ruleId: "personal-todoist" });
    expect(authority.authorize(token, { ...action, accountAlias: "work" }, 101)).toMatchObject({ allowed: false, code: "no-matching-rule" });
    expect(authority.authorize(token, action, 10_100)).toMatchObject({ allowed: false, code: "invalid-capability" });
    const operator = authority.issue({ botId: "personal-admin", threadId: "thread-1", wakeKind: "operator" }, 10_000, 100)!;
    expect(authority.authorize(operator, action, 101)).toMatchObject({ allowed: true, ruleId: "personal-todoist" });
  });

  it("enforces routine, originating-thread, recipient, and argument constraints", () => {
    const parsed = parseAutonomyPolicy({
      schema: "openmausbot.autonomy-policy.v1",
      revision: "constraints-1",
      rules: [{
        id: "communications-reply",
        botId: "communications",
        wakeKinds: ["routine"],
        routineIds: ["morning-replies"],
        transport: "composio",
        server: "composio",
        tools: ["GMAIL_REPLY_TO_THREAD"],
        accountAliases: ["personal"],
        effect: "thread_reply",
        authority: "operator-promoted",
        constraints: {
          recipientAliases: ["trey"],
          purposes: ["status-update"],
          originatingThreadOnly: true,
          argumentEquals: { mode: "reply" },
        },
      }],
    });
    const authority = new AutonomyAuthority({ policy: parsed.policy, digest: parsed.digest, revision: "constraints-1", status: "resolved" }, Buffer.alloc(32, 8));
    const issue = (routineId: string) => authority.issue({ botId: "communications", threadId: "thread-1", wakeKind: "routine", routineId }, 10_000, 100)!;
    const action = {
      transport: "composio" as const,
      server: "composio",
      tool: "GMAIL_REPLY_TO_THREAD",
      accountAlias: "personal",
      arguments: { thread_id: "thread-1", recipient_alias: "trey", purpose: "status-update", mode: "reply" },
    };
    expect(authority.authorize(issue("morning-replies"), action, 101)).toMatchObject({ allowed: true });
    expect(authority.authorize(issue("other"), action, 101)).toMatchObject({ allowed: false });
    expect(authority.authorize(issue("morning-replies"), { ...action, arguments: { ...action.arguments, thread_id: "other" } }, 101)).toMatchObject({ allowed: false });
    expect(authority.authorize(issue("morning-replies"), { ...action, arguments: { ...action.arguments, recipient_alias: "unknown" } }, 101)).toMatchObject({ allowed: false });
    expect(authority.authorize(issue("morning-replies"), { ...action, arguments: { ...action.arguments, mode: "forward" } }, 101)).toMatchObject({ allowed: false });
    expect(authority.authorize(issue("morning-replies"), { ...action, arguments: { ...action.arguments, purpose: "sales" } }, 101)).toMatchObject({ allowed: false });
  });

  it("requires explicit promotion for autonomous thread replies", () => {
    expect(() => parseAutonomyPolicy({
      ...rawPolicy,
      rules: [{ ...rawPolicy.rules[0], effect: "thread_reply" }],
    })).toThrow(/operator-promoted/);
  });

  it("binds exact capabilities to one action, proposal, expiry, and use", () => {
    const authority = new AutonomyAuthority(undefined, Buffer.alloc(32, 9));
    const action = { transport: "composio" as const, server: "composio", tool: "GMAIL_SEND_EMAIL", accountAlias: "personal", arguments: { to: "self", body: "hello" } };
    const proposalDigest = "a".repeat(64);
    const token = authority.issueExact("outbound-send", action, proposalDigest, 10_000, 100);
    expect(authority.consumeExact(token, "outbound-send", { ...action, arguments: { ...action.arguments, body: "changed" } }, proposalDigest, 101)).toBe(false);
    expect(authority.consumeExact(token, "outbound-send", action, "b".repeat(64), 101)).toBe(false);
    expect(authority.consumeExact(token, "outbound-send", action, proposalDigest, 101)).toBe(true);
    expect(authority.consumeExact(token, "outbound-send", action, proposalDigest, 102)).toBe(false);
    const notExpired = authority.issueExact("outbound-send", action, proposalDigest, 1_000, 100);
    expect(authority.consumeExact(notExpired, "outbound-send", action, proposalDigest, 1_099)).toBe(true);
    const expired = authority.issueExact("outbound-send", action, proposalDigest, 1_000, 100);
    expect(authority.consumeExact(expired, "outbound-send", action, proposalDigest, 1_100)).toBe(false);
  });

  it("recognizes only non-permanent trash and non-admin collaborator exceptions", () => {
    const action = (tool: string, args: Record<string, unknown> = {}) => ({ transport: "composio" as const, server: "composio", tool, arguments: args });
    expect(isOperatorException(action("GMAIL_MOVE_TO_TRASH"))).toBe(true);
    expect(isOperatorException(action("DRIVE_ADD_COLLABORATOR", { role: "editor" }))).toBe(true);
    expect(isOperatorException(action("DRIVE_ADD_COLLABORATOR", { role: "owner" }))).toBe(false);
    expect(isOperatorException(action("DRIVE_DELETE_FILE", { permanent: true }))).toBe(false);
  });

  it("hard-denies destructive, financial, permission, credential, and security tools", () => {
    const authority = new AutonomyAuthority();
    for (const [tool, effect] of [
      ["GMAIL_DELETE_MESSAGE", "delete"],
      ["STRIPE_REFUND_PAYMENT", "money"],
      ["GITHUB_INVITE_MEMBER", "permission"],
      ["SERVICE_ROTATE_API_KEY", "credential"],
      ["AUTH_DISABLE_MFA", "security"],
    ]) {
      expect(authority.authorize(undefined, { transport: "composio", server: "composio", tool, arguments: {} })).toMatchObject({ allowed: false, code: "hard-deny", effect });
    }
  });

  it("allows discovery without a capability but not an ordinary action", () => {
    const authority = new AutonomyAuthority();
    expect(authority.authorize(undefined, { transport: "composio", server: "composio", tool: "COMPOSIO_SEARCH_TOOLS", arguments: {} })).toMatchObject({ allowed: true, code: "discovery" });
    expect(authority.authorize(undefined, { transport: "composio", server: "composio", tool: "GMAIL_FETCH_EMAILS", arguments: {} })).toMatchObject({ allowed: false });
  });

  it("extracts multi-execute actions all-or-nothing and rejects unknown entries", () => {
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { slug: "GMAIL_FETCH_EMAILS", arguments: { account_alias: "personal" } },
      { tool_slug: "TODOIST_UPSERT_TASK", account: "personal", arguments: {} },
    ] } } })).toMatchObject({ actions: [{ tool: "GMAIL_FETCH_EMAILS" }, { tool: "TODOIST_UPSERT_TASK" }] });
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { tool_slug: "TODOIST_UPSERT_TASK", account: "personal", arguments: {} },
    ] } } })).toMatchObject({ actions: [{ accountAlias: "personal" }] });
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{}] } } })).toMatchObject({ actions: [], error: expect.any(String) });
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: Array.from({ length: 51 }, () => ({ slug: "TODOIST_GET_TASKS" })) } } })).toMatchObject({ actions: [], error: "multi-execute exceeds the 50-action provider limit" });
  });

  it("binds custom MCP calls to the exact server, tool, and arguments", () => {
    expect(actionsFromCustomMcpPayload("wiki", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_notes", arguments: { account_alias: "private", query: "one" } },
    })).toEqual({ actions: [{
      transport: "custom-mcp",
      server: "wiki",
      tool: "search_notes",
      arguments: { account_alias: "private", query: "one" },
      accountAlias: "private",
    }] });
    expect(actionsFromCustomMcpPayload("wiki", { method: "tools/list", params: {} })).toEqual({ actions: [] });
    expect(actionsFromCustomMcpPayload("wiki", { method: "tools/call", params: {} })).toMatchObject({ error: "missing tool name" });
  });
});
