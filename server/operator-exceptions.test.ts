import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AutonomyAuthority } from "./autonomy-policy.ts";
import { OperatorExceptionStore } from "./operator-exceptions.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-operator-exception-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("operator exception proposals", () => {
  it("persists exact eligible actions, deduplicates pending requests, and rejects broader effects", () => {
    const dir = temp();
    const store = new OperatorExceptionStore(dir);
    const input = {
      botId: "personal-admin",
      threadId: "thread-1",
      action: {
        transport: "composio" as const,
        server: "composio" as const,
        tool: "GMAIL_MOVE_TO_TRASH",
        arguments: { message_id: "m-1", permanent: false },
        accountAlias: "personal",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_MOVE_TO_TRASH" } },
    };
    const first = store.create(input, 100);
    expect(store.create(input, 101).proposalId).toBe(first.proposalId);
    expect(new OperatorExceptionStore(dir).get(first.proposalId)).toMatchObject({ status: "pending", action: input.action });
    expect(statSync(join(dir, "operator-exceptions.json")).mode & 0o777).toBe(0o600);
    expect(() => store.create({ ...input, action: { ...input.action, tool: "GMAIL_DELETE_MESSAGE", arguments: { permanent: true } } })).toThrow(/not an operator exception/);
  });

  it("keeps exact capability replay protection across authority restarts", () => {
    const dir = temp();
    const ledger = join(dir, "nonces");
    const key = Buffer.alloc(32, 3);
    const action = {
      transport: "composio" as const,
      server: "composio",
      tool: "DRIVE_ADD_COLLABORATOR",
      arguments: { file_id: "f-1", role: "editor" },
    };
    const first = new AutonomyAuthority(undefined, key, ledger);
    const token = first.issueExact("operator-exception", action, undefined, 30_000);
    expect(first.consumeExact(token, "operator-exception", action)).toBe(true);
    expect(new AutonomyAuthority(undefined, key, ledger).consumeExact(token, "operator-exception", action)).toBe(false);
    expect(readFileSync(ledger, "utf8")).toContain(" ");
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
  });
});
