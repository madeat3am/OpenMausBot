import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AutonomyDecision, ToolAction } from "./autonomy-policy.ts";
import { argumentDigest } from "./autonomy-policy.ts";

export class AutonomyDatabase {
  private readonly database: DatabaseSync;

  constructor(dataDir: string, file = join(dataDir, "autonomy.db")) {
    closeSync(openSync(file, "a", 0o600));
    try { chmodSync(file, 0o600); } catch {}
    this.database = new DatabaseSync(file);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS decision_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decided_at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        code TEXT NOT NULL,
        rule_id TEXT,
        effect TEXT,
        account_alias TEXT,
        tool TEXT NOT NULL,
        argument_digest TEXT NOT NULL,
        provider_result_id TEXT,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composio_events (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        material_digest TEXT NOT NULL,
        trigger_slug TEXT NOT NULL,
        account_alias TEXT
      );
      CREATE INDEX IF NOT EXISTS composio_events_received ON composio_events(received_at);
      CREATE INDEX IF NOT EXISTS composio_events_material ON composio_events(trigger_slug, account_alias, material_digest, received_at);
    `);
  }

  recordDecision(decision: AutonomyDecision, action: ToolAction, providerResultId?: string, now = Date.now()): number {
    this.cleanupDecisions(now);
    const result = this.database.prepare(`
      INSERT INTO decision_receipts
        (decided_at, outcome, code, rule_id, effect, account_alias, tool, argument_digest, provider_result_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now,
      decision.allowed ? "allowed" : "denied",
      decision.code,
      decision.ruleId ?? null,
      decision.effect ?? null,
      decision.accountAlias ?? null,
      action.tool,
      argumentDigest(action),
      providerResultId ?? null,
      decision.reason,
    );
    return Number(result.lastInsertRowid);
  }

  cleanupDecisions(now = Date.now()): void {
    this.database.prepare("DELETE FROM decision_receipts WHERE decided_at < ?")
      .run(now - 365 * 24 * 60 * 60_000);
  }

  acceptComposioEvent(input: {
    eventId: string;
    receivedAt: number;
    materialDigest: string;
    triggerSlug: string;
    accountAlias?: string;
  }, suppressionMs = 24 * 60 * 60_000): "accepted" | "duplicate" | "suppressed" {
    this.cleanupEvents(input.receivedAt);
    const existing = this.database.prepare("SELECT 1 FROM composio_events WHERE event_id = ?").get(input.eventId);
    if (existing) return "duplicate";
    const equivalent = this.database.prepare(`
      SELECT 1 FROM composio_events
      WHERE trigger_slug = ? AND COALESCE(account_alias, '') = COALESCE(?, '')
        AND material_digest = ? AND received_at > ? LIMIT 1
    `).get(input.triggerSlug, input.accountAlias ?? null, input.materialDigest, input.receivedAt - suppressionMs);
    this.database.prepare(`
      INSERT INTO composio_events (event_id, received_at, material_digest, trigger_slug, account_alias)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.eventId, input.receivedAt, input.materialDigest, input.triggerSlug, input.accountAlias ?? null);
    return equivalent ? "suppressed" : "accepted";
  }

  cleanupEvents(now = Date.now()): void {
    this.database.prepare("DELETE FROM composio_events WHERE received_at < ?").run(now - 30 * 24 * 60 * 60_000);
  }

  close(): void {
    this.database.close();
  }
}
