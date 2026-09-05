import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { actionsFromCustomMcpPayload, actionsFromMcpPayload, AutonomyAuthority, classifyDefaultEffect, isOperatorException, isOutboundAction, parseAutonomyPolicy, usableMcpReadResponse } from "./autonomy-policy.ts";

// Rules only ever gate OUTBOUND tools now; TODOIST_SHARE_PROJECT is outbound
// (it reaches another person), so it exercises the rule loop.
const rawPolicy = {
  schema: "openmausbot.autonomy-policy.v1",
  revision: "test-1",
  rules: [{
    id: "personal-todoist",
    botId: "personal-admin",
    wakeKinds: ["operator", "routine", "webhook", "delegated"],
    triggerIds: ["todoist-item-added"],
    transport: "composio",
    server: "composio",
    tools: ["TODOIST_SHARE_PROJECT", "TODOIST_GET_TASKS"],
    accountAliases: ["personal"],
    effect: "todoist_upsert",
  }],
};

const composio = (tool: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ transport: "composio" as const, server: "composio", tool, arguments: args, ...extra });

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

  it("does not report HTTP-success MCP errors as completed reads", () => {
    expect(usableMcpReadResponse(503, { result: {} })).toBe(false);
    expect(usableMcpReadResponse(200, { error: { code: -32000 } })).toBe(false);
    expect(usableMcpReadResponse(200, { result: { isError: true, content: [] } })).toBe(false);
    expect(usableMcpReadResponse(200, { result: { content: [{ type: "text", text: JSON.stringify({ successful: false, error: "provider failed" }) }] } })).toBe(false);
    expect(usableMcpReadResponse(200, { result: { content: [{ type: "text", text: "ok" }] } })).toBe(true);
  });

  it("rejects malformed or globally denied policy effects", () => {
    expect(() => parseAutonomyPolicy({ ...rawPolicy, schema: "wrong" })).toThrow();
    expect(() => parseAutonomyPolicy({ ...rawPolicy, rules: [{ ...rawPolicy.rules[0], effect: "money" }] })).toThrow();
  });

  it("binds capabilities to bot, wake, trigger, account, and exact tool", () => {
    const parsed = parseAutonomyPolicy(rawPolicy);
    const authority = new AutonomyAuthority({ policy: parsed.policy, digest: parsed.digest, revision: "test-1", status: "resolved" }, Buffer.alloc(32, 7));
    const token = authority.issue({ botId: "personal-admin", threadId: "thread-1", wakeKind: "webhook", triggerId: "todoist-item-added" }, 10_000, 100)!;
    const action = { transport: "composio" as const, server: "composio", tool: "TODOIST_SHARE_PROJECT", arguments: {}, accountAlias: "personal" };
    expect(authority.authorize(token, action, 101)).toMatchObject({ allowed: true, ruleId: "personal-todoist" });
    expect(authority.authorize(token, { ...action, accountAlias: "work" }, 101)).toMatchObject({ allowed: false, code: "no-matching-rule" });
    expect(authority.authorize(token, action, 10_100)).toMatchObject({ allowed: false, code: "invalid-capability" });
    const operator = authority.issue({ botId: "personal-admin", threadId: "thread-1", wakeKind: "operator" }, 10_000, 100)!;
    expect(authority.authorize(operator, action, 101)).toMatchObject({ allowed: true, ruleId: "personal-todoist" });
    const delegated = authority.issue({ botId: "personal-admin", threadId: "thread-1", wakeKind: "delegated" }, 10_000, 100)!;
    expect(authority.authorize(delegated, action, 101)).toMatchObject({ allowed: true, ruleId: "personal-todoist" });
  });

  it("default-allows reads and internal writes for every wake kind, account, and even a stale capability", () => {
    const parsed = parseAutonomyPolicy({ schema: "openmausbot.autonomy-policy.v1", revision: "empty-1", rules: [] });
    const authority = new AutonomyAuthority({ policy: parsed.policy, digest: parsed.digest, revision: "empty-1", status: "resolved" }, Buffer.alloc(32, 9));
    const routine = authority.issue({ botId: "communications", threadId: "thread-1", wakeKind: "routine", routineId: "monitor" }, 10_000, 100)!;
    const delegated = authority.issue({ botId: "revenue", threadId: "thread-2", wakeKind: "delegated" }, 10_000, 100)!;
    // Slack and Calendar reads carry no account alias at all; Gmail reads carry a drifted one.
    expect(authority.authorize(routine, composio("SLACK_SEARCH_MESSAGES", { query: "Gigbit" }), 101)).toMatchObject({ allowed: true, code: "default-allow", effect: "read" });
    expect(authority.authorize(routine, composio("GOOGLECALENDAR_FIND_EVENT"), 101)).toMatchObject({ allowed: true, code: "default-allow", effect: "read" });
    expect(authority.authorize(routine, composio("GMAIL_FETCH_EMAILS", {}, { accountAlias: "gmail_armor-tan", providerAccountId: "ca_x" }), 101))
      .toMatchObject({ allowed: true, code: "default-allow", effect: "read", providerAccountId: "ca_x" });
    expect(authority.authorize(delegated, composio("FRESHBOOKS_LIST_INVOICES"), 101)).toMatchObject({ allowed: true, code: "default-allow", effect: "read" });
    // Expired capability never blocks evidence gathering.
    expect(authority.authorize(routine, composio("GMAIL_FETCH_EMAILS"), 10_100)).toMatchObject({ allowed: true, code: "default-allow" });
    expect(authority.authorize(undefined, composio("GMAIL_FETCH_EMAILS"))).toMatchObject({ allowed: true, code: "default-allow" });
    // Internal writes: drafts, tasks, private calendar holds, CRM notes, wiki, other reversible writes.
    expect(authority.authorize(routine, composio("GMAIL_CREATE_EMAIL_DRAFT", { to: "me@example.com" }), 101)).toMatchObject({ allowed: true, effect: "communication_draft" });
    expect(authority.authorize(routine, composio("TODOIST_CREATE_TASK", { content: "x" }), 101)).toMatchObject({ allowed: true, effect: "todoist_upsert" });
    expect(authority.authorize(routine, composio("GOOGLECALENDAR_CREATE_EVENT", { summary: "hold", transparency: "tentative" }), 101)).toMatchObject({ allowed: true, effect: "calendar_upsert" });
    expect(authority.authorize(routine, { transport: "custom-mcp", server: "citadel-twenty", tool: "twenty_create_record", arguments: {} }, 101)).toMatchObject({ allowed: true, effect: "crm_note_upsert" });
    expect(authority.authorize(routine, composio("GOOGLEDRIVE_UPLOAD_FILE", {}), 101)).toMatchObject({ allowed: true, effect: "internal_write" });
    expect(authority.authorize(routine, composio("GITHUB_CREATE_AN_ISSUE_COMMENT", {}), 101)).toMatchObject({ allowed: true, effect: "internal_write" });
  });

  it("keeps outbound sends behind operator-promoted rules and the exact approval path", () => {
    const parsed = parseAutonomyPolicy({ schema: "openmausbot.autonomy-policy.v1", revision: "empty-2", rules: [] });
    const authority = new AutonomyAuthority({ policy: parsed.policy, digest: parsed.digest, revision: "empty-2", status: "resolved" }, Buffer.alloc(32, 10));
    const token = authority.issue({ botId: "communications", threadId: "thread-1", wakeKind: "operator" }, 10_000, 100)!;
    for (const tool of ["GMAIL_SEND_DRAFT", "GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "SLACK_SEND_MESSAGE", "SLACK_CHAT_POST_MESSAGE", "GOOGLEDRIVE_SHARE_FILE", "TODOIST_SHARE_PROJECT", "REDDIT_CREATE_REDDIT_POST"]) {
      expect(isOutboundAction(composio(tool))).toBe(true);
      expect(authority.authorize(token, composio(tool), 101)).toMatchObject({ allowed: false, code: "no-matching-rule" });
    }
    expect(authority.authorize(undefined, composio("GMAIL_SEND_EMAIL"))).toMatchObject({ allowed: false, code: "invalid-capability" });
    // Calendar writes become outbound only when they reach other people.
    expect(isOutboundAction(composio("GOOGLECALENDAR_CREATE_EVENT", { attendees: ["a@b.c"] }))).toBe(true);
    expect(isOutboundAction(composio("GOOGLECALENDAR_UPDATE_EVENT", { event: { attendees: ["a@b.c"] } }))).toBe(true);
    expect(isOutboundAction(composio("GOOGLECALENDAR_CREATE_EVENT", { sendUpdates: "all" }))).toBe(true);
    expect(isOutboundAction(composio("GOOGLECALENDAR_CREATE_EVENT", { attendees: [], sendUpdates: "none" }))).toBe(false);
    expect(isOutboundAction(composio("GMAIL_CREATE_EMAIL_DRAFT", { to: "a@b.c" }))).toBe(false);
    expect(classifyDefaultEffect(composio("MONDAY_CREATE_UPDATE"))).toBe("internal_write");
  });

  it("authorizes immutable provider account ids while treating aliases as display labels", () => {
    const parsed = parseAutonomyPolicy({
      schema: "openmausbot.autonomy-policy.v1",
      revision: "canonical-account-1",
      rules: [{
        id: "gmail-send",
        botId: "communications",
        wakeKinds: ["delegated"],
        transport: "composio",
        server: "composio",
        tools: ["GMAIL_SEND_DRAFT"],
        providerAccountIds: ["ca_gmail_personal"],
        accountAliases: ["personal"],
        effect: "communication_draft",
      }],
    });
    const authority = new AutonomyAuthority(
      { policy: parsed.policy, digest: parsed.digest, revision: parsed.policy.revision, status: "resolved" },
      Buffer.alloc(32, 14),
    );
    const capability = authority.issue({ botId: "communications", threadId: "thread-1", wakeKind: "delegated" })!;
    const action = {
      transport: "composio" as const,
      server: "composio",
      tool: "GMAIL_SEND_DRAFT",
      providerAccountId: "ca_gmail_personal",
      accountAlias: "renamed-label",
      arguments: {},
    };
    expect(authority.authorize(capability, action)).toMatchObject({
      allowed: true,
      ruleId: "gmail-send",
      providerAccountId: "ca_gmail_personal",
      accountAlias: "renamed-label",
    });
    expect(authority.authorize(capability, { ...action, providerAccountId: "ca_other" })).toMatchObject({ allowed: false });
  });

  it("uses the provider-executed row account and rejects contradictory nested selectors", () => {
    const payload = (row: Record<string, unknown>) => ({
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [row] } },
    });
    expect(actionsFromMcpPayload(payload({
      tool_slug: "GMAIL_FETCH_EMAILS",
      connected_account_id: "ca_row",
      arguments: { connected_account_id: "ca_nested" },
    }))).toMatchObject({ actions: [], error: expect.stringContaining("unrecognized") });
    expect(actionsFromMcpPayload(payload({
      tool_slug: "GMAIL_FETCH_EMAILS",
      connected_account_id: "ca_row",
      arguments: {},
    })).actions[0]).toMatchObject({ providerAccountId: "ca_row", accountAlias: "ca_row" });
    expect(actionsFromMcpPayload(payload({
      tool_slug: "GMAIL_FETCH_EMAILS",
      arguments: { connected_account_id: "ca_nested" },
    })).actions[0]).toMatchObject({ providerAccountId: undefined });
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

  it("allows discovery without a capability but not an outbound action", () => {
    const authority = new AutonomyAuthority();
    expect(authority.authorize(undefined, { transport: "composio", server: "composio", tool: "COMPOSIO_SEARCH_TOOLS", arguments: {} })).toMatchObject({ allowed: true, code: "discovery" });
    expect(authority.authorize(undefined, { transport: "composio", server: "composio", tool: "GMAIL_SEND_EMAIL", arguments: {} })).toMatchObject({ allowed: false });
  });

  it("extracts multi-execute actions all-or-nothing and rejects unknown entries", () => {
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { slug: "GMAIL_FETCH_EMAILS", arguments: { account_alias: "personal" } },
      { tool_slug: "TODOIST_UPSERT_TASK", account: "personal", arguments: {} },
    ] } } })).toMatchObject({ actions: [{ tool: "GMAIL_FETCH_EMAILS" }, { tool: "TODOIST_UPSERT_TASK" }] });
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { tool_slug: "TODOIST_UPSERT_TASK", account: "personal", arguments: {} },
    ] } } })).toMatchObject({ actions: [{ accountAlias: "personal" }] });
    expect(actionsFromMcpPayload({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
      { tool_slug: "GMAIL_FETCH_EMAILS", account: "personal", connected_account_id: "ca_gmail_personal", arguments: {} },
    ] } } })).toMatchObject({ actions: [{ accountAlias: "personal", providerAccountId: "ca_gmail_personal" }] });
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

  it("inspects the isolated Todoist broker like Composio and preserves atomic batches", () => {
    const extracted = actionsFromCustomMcpPayload("todoist", {
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
        { slug: "TODOIST_GET_ALL_TASKS", arguments: {} },
        { slug: "GMAIL_FETCH_EMAILS", arguments: {} },
      ] } },
    });
    expect(extracted).toMatchObject({ actions: [
      { transport: "custom-mcp", server: "todoist", tool: "TODOIST_GET_ALL_TASKS" },
      { transport: "custom-mcp", server: "todoist", tool: "GMAIL_FETCH_EMAILS" },
    ] });
    const policy = parseAutonomyPolicy({
      schema: "openmausbot.autonomy-policy.v1",
      revision: "isolated-todoist",
      rules: [{
        id: "todoist-read",
        botId: "ops",
        wakeKinds: ["routine"],
        routineIds: ["morning"],
        transport: "custom-mcp",
        server: "todoist",
        tools: ["TODOIST_GET_ALL_TASKS"],
        effect: "read",
      }],
    });
    const authority = new AutonomyAuthority({ policy: policy.policy, digest: policy.digest, revision: "isolated-todoist", status: "resolved" }, Buffer.alloc(32, 12));
    const capability = authority.issue({ botId: "ops", threadId: "thread-1", wakeKind: "routine", routineId: "morning" })!;
    // Both rows are reads, so both default-allow regardless of the isolated-broker rule.
    expect(extracted.actions.map((action) => authority.authorize(capability, action).code)).toEqual(["default-allow", "default-allow"]);
    expect(actionsFromCustomMcpPayload("todoist", {
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{}] } },
    })).toMatchObject({ actions: [], error: expect.any(String) });
    expect(actionsFromCustomMcpPayload("todoist", {
      method: "tools/call",
      params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} },
    })).toMatchObject({ actions: [{ transport: "custom-mcp", server: "todoist", tool: "COMPOSIO_SEARCH_TOOLS" }] });
  });

  it("binds the isolated FreshBooks broker to one exact account alias", () => {
    const extracted = actionsFromCustomMcpPayload("freshbooks-seed", {
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
        { tool_slug: "FRESHBOOKS_LIST_BUSINESSES", arguments: {}, account: "SEED Creates LLC" },
      ], sync_response_to_workbench: false } },
    });
    expect(extracted).toMatchObject({ actions: [{
      transport: "custom-mcp",
      server: "freshbooks-seed",
      tool: "FRESHBOOKS_LIST_BUSINESSES",
      accountAlias: "SEED Creates LLC",
    }] });
    const policy = parseAutonomyPolicy({
      schema: "openmausbot.autonomy-policy.v1",
      revision: "isolated-freshbooks",
      rules: [{
        id: "freshbooks-seed-read",
        botId: "personal-admin",
        wakeKinds: ["operator"],
        transport: "custom-mcp",
        server: "freshbooks-seed",
        tools: ["FRESHBOOKS_LIST_BUSINESSES"],
        accountAliases: ["SEED Creates LLC"],
        effect: "read",
      }],
    });
    const authority = new AutonomyAuthority({ policy: policy.policy, digest: policy.digest, revision: "isolated-freshbooks", status: "resolved" }, Buffer.alloc(32, 13));
    const capability = authority.issue({ botId: "personal-admin", threadId: "thread-1", wakeKind: "operator" })!;
    // Reads on either FreshBooks account default-allow; the alias is a display label carried on the decision.
    expect(authority.authorize(capability, extracted.actions[0]!)).toMatchObject({ allowed: true, code: "default-allow", accountAlias: "SEED Creates LLC" });
    expect(authority.authorize(capability, { ...extracted.actions[0]!, accountAlias: "Meridian Row LLC" })).toMatchObject({ allowed: true, code: "default-allow", accountAlias: "Meridian Row LLC" });
  });
});
