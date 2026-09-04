import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { AutonomyDatabase } from "./autonomy-db.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("autonomy database", () => {
  it("deduplicates event ids and suppresses unchanged material for 24 hours", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-autonomy-db-"));
    dirs.push(dir);
    const db = new AutonomyDatabase(dir);
    const base = { receivedAt: 1_000_000_000, materialDigest: "a".repeat(64), triggerSlug: "GMAIL_NEW_MESSAGE", accountAlias: "personal" };
    expect(db.acceptComposioEvent({ ...base, eventId: "evt-1" })).toBe("accepted");
    expect(db.acceptComposioEvent({ ...base, eventId: "evt-1" })).toBe("duplicate");
    expect(db.acceptComposioEvent({ ...base, eventId: "evt-2", receivedAt: base.receivedAt + 1_000 })).toBe("suppressed");
    expect(db.acceptComposioEvent({ ...base, eventId: "evt-3", materialDigest: "b".repeat(64), receivedAt: base.receivedAt + 2_000 })).toBe("accepted");
    db.close();
  });

  it("forgets deduplication receipts after 30 days", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-autonomy-db-"));
    dirs.push(dir);
    const db = new AutonomyDatabase(dir);
    const first = 1_000_000_000;
    const event = { eventId: "evt-expiring", receivedAt: first, materialDigest: "a".repeat(64), triggerSlug: "GMAIL_NEW_MESSAGE" };
    expect(db.acceptComposioEvent(event)).toBe("accepted");
    expect(db.acceptComposioEvent({ ...event, receivedAt: first + 30 * 24 * 60 * 60_000 + 1 })).toBe("accepted");
    db.close();
  });

  it("retains redacted decisions for one year and then removes them", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-autonomy-db-"));
    dirs.push(dir);
    const file = join(dir, "autonomy.db");
    const db = new AutonomyDatabase(dir, file);
    const action = { transport: "composio" as const, server: "composio", tool: "GMAIL_CREATE_DRAFT", arguments: { body: "private" } };
    const decision = { schema: "openmausbot.autonomy-decision.v1" as const, allowed: true, code: "policy-allowed", reason: "allowed", tool: action.tool };
    const first = 1_000_000_000;
    db.recordDecision(decision, action, "log-1", first);
    db.cleanupDecisions(first + 365 * 24 * 60 * 60_000);
    db.close();
    const inspect = new DatabaseSync(file);
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM decision_receipts").get()).toEqual({ count: 1 });
    inspect.close();
    const reopened = new AutonomyDatabase(dir, file);
    reopened.cleanupDecisions(first + 365 * 24 * 60 * 60_000 + 1);
    reopened.close();
    const final = new DatabaseSync(file);
    expect(final.prepare("SELECT COUNT(*) AS count FROM decision_receipts").get()).toEqual({ count: 0 });
    final.close();
  });
});
