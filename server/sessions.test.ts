import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXCHANGE_REPLAY_MS,
  formatPairingCode,
  generatePairingCode,
  GLOBAL_LOCKOUT,
  LOCKOUT,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS,
  SESSION_TTL_MS,
  SessionRegistry,
  STREAM_TICKET_TTL_MS,
} from "./sessions.ts";

let dir: string;
let clock: number;
let registry: SessionRegistry;
const file = () => join(dir, "sessions.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-sessions-"));
  clock = 1_700_000_000_000;
  registry = new SessionRegistry({ file: file(), now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pair(label = "MacBook", source = "10.0.0.2") {
  const { code } = registry.openPairing();
  const result = registry.exchange({ code, label, source });
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("pairing codes", () => {
  it("are 12 unambiguous symbols and survive human retyping", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(12);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
    expect(formatPairingCode("ABCDEFGHJKLM")).toBe("ABCD-EFGH-JKLM");
    expect(normalizePairingCode(" abcd-efgh jklm ")).toBe("ABCDEFGHJKLM");
    expect(normalizePairingCode("0O1I")).toBe("OOII");
  });

  it("exchange once, then never again, and expire after five minutes", () => {
    const { code } = registry.openPairing({ label: "phone" });
    const first = registry.exchange({ code: formatPairingCode(code).toLowerCase(), label: "", source: "a" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.session.label).toBe("phone");
    // the same source retrying gets the same answer (lost-response replay); anyone else is refused
    expect(registry.exchange({ code, label: "x", source: "a" })).toEqual(first);
    const again = registry.exchange({ code, label: "x", source: "someone-else" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/wrong or has expired/);
    const { code: stale } = registry.openPairing();
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(registry.exchange({ code: stale, label: "x", source: "b" }).ok).toBe(false);
    expect(registry.openPairings()).toEqual([]);
  });

  it("locks a source out after repeated failures, and forgets on success", () => {
    for (let i = 0; i < LOCKOUT.failures; i++) {
      expect(registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "attacker" }).ok).toBe(false);
    }
    const { code } = registry.openPairing();
    const locked = registry.exchange({ code, label: "", source: "attacker" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.status).toBe(429);
      expect(locked.error).toMatch(/try again in 10 min/);
    }
    // a different source is unaffected, and the code is still unused
    expect(registry.exchange({ code, label: "", source: "friend" }).ok).toBe(true);
    clock += LOCKOUT.lockMs + 1;
    const { code: fresh } = registry.openPairing();
    expect(registry.exchange({ code: fresh, label: "", source: "attacker" }).ok).toBe(true);
  });

  it("answers a lost-response retry with the same session for a minute, from the same source only", () => {
    const { code } = registry.openPairing();
    const first = registry.exchange({ code, label: "phone", source: "a" });
    const retry = registry.exchange({ code, label: "phone", source: "a" });
    expect(retry).toEqual(first);
    expect(registry.list()).toHaveLength(1);
    const stranger = registry.exchange({ code, label: "x", source: "b" });
    expect(stranger.ok).toBe(false);
    clock += EXCHANGE_REPLAY_MS + 1;
    expect(registry.exchange({ code, label: "phone", source: "a" }).ok).toBe(false);
  });

  it("caps failures across all sources so rotating the forwarded address does not help", () => {
    for (let i = 0; i < GLOBAL_LOCKOUT.failures; i++) {
      expect(registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: `rotating-${i}` }).ok).toBe(false);
    }
    const { code } = registry.openPairing();
    const blocked = registry.exchange({ code, label: "", source: "fresh-address" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/across all clients/);
    clock += GLOBAL_LOCKOUT.lockMs + 1;
    expect(registry.exchange({ code, label: "", source: "fresh-address" }).ok).toBe(true);
  });

  it("names the device from the client, else the code's label, else the user agent", () => {
    const a = registry.openPairing({ label: "Milind's MacBook" });
    const named = registry.exchange({ code: a.code, label: "", source: "s1", fallbackLabel: "Safari on Mac" });
    if (!named.ok) throw new Error(named.error);
    expect(named.session.label).toBe("Milind's MacBook");
    const b = registry.openPairing();
    const ua = registry.exchange({ code: b.code, label: "  ", source: "s2", fallbackLabel: "Safari on Mac" });
    if (!ua.ok) throw new Error(ua.error);
    expect(ua.session.label).toBe("Safari on Mac");
    const c = registry.openPairing({ label: "ignored" });
    const explicit = registry.exchange({ code: c.code, label: "Kitchen iPad", source: "s3", fallbackLabel: "Safari on iPad" });
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.session.label).toBe("Kitchen iPad");
  });

  it("carries scopes from the code into the session, deduplicated", () => {
    const { code } = registry.openPairing({ scopes: ["client", "client"] });
    const result = registry.exchange({ code, label: "viewer", source: "s" });
    if (!result.ok) throw new Error(result.error);
    expect(result.session.scopes).toEqual(["client"]);
    expect(pair().session.scopes).toEqual(["admin", "client"]);
  });
});

describe("sessions", () => {
  it("stores only a hash, owner-only, and reloads from disk", () => {
    const { token, session } = pair();
    const onDisk = readFileSync(file(), "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(session.id);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    const reloaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(reloaded.authenticate(token)?.id).toBe(session.id);
    expect(reloaded.authenticate("omb_sess_nope")).toBeNull();
  });

  it("expires after 30 days and can be revoked", () => {
    const { token, session } = pair();
    clock += SESSION_TTL_MS - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    clock += 2;
    expect(registry.authenticate(token)).toBeNull();
    const other = pair("iPad");
    expect(registry.list().map((s) => s.label)).toEqual(["iPad"]);
    expect(registry.revoke(other.session.id)).toBe(true);
    expect(registry.revoke(other.session.id)).toBe(false);
    expect(registry.authenticate(other.token)).toBeNull();
  });

  it("updates last-seen at most once a minute so reads stay cheap", () => {
    const { token } = pair();
    const before = statSync(file()).mtimeMs;
    clock += 1_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock - 1_000);
    clock += 60_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock);
    expect(statSync(file()).mtimeMs).toBeGreaterThanOrEqual(before);
  });
});

describe("stream tickets", () => {
  it("are single use, short-lived, and die with their session", () => {
    const { session } = pair();
    const { ticket } = registry.issueStreamTicket(session.id);
    expect(registry.redeemStreamTicket(ticket)?.id).toBe(session.id);
    expect(registry.redeemStreamTicket(ticket)).toBeNull();
    const { ticket: late } = registry.issueStreamTicket(session.id);
    clock += STREAM_TICKET_TTL_MS + 1;
    expect(registry.redeemStreamTicket(late)).toBeNull();
    const { ticket: orphan } = registry.issueStreamTicket(session.id);
    registry.revoke(session.id);
    expect(registry.redeemStreamTicket(orphan)).toBeNull();
  });
});
