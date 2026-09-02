import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { environmentDescriptor, loadEnvironmentId, serverVersion } from "./environment.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.OMB_APP_VERSION;
  delete process.env.OMB_ENVIRONMENT_LABEL;
});

describe("environment identity", () => {
  it("creates the id once, owner-only, and keeps it across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-env-"));
    dirs.push(dir);
    const id = loadEnvironmentId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(join(dir, "environment-id")).mode & 0o777).toBe(0o600);
    expect(loadEnvironmentId(dir)).toBe(id);
    writeFileSync(join(dir, "environment-id"), "garbage\n");
    expect(loadEnvironmentId(dir)).not.toBe("garbage");
    expect(readFileSync(join(dir, "environment-id"), "utf8").trim()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("describes the server for clients without leaking anything secret", () => {
    process.env.OMB_APP_VERSION = "0.1.99";
    process.env.OMB_ENVIRONMENT_LABEL = "cab mini";
    const d = environmentDescriptor({ environmentId: "abc", desktopManaged: true });
    expect(d).toEqual({
      environmentId: "abc",
      label: "cab mini",
      platform: process.platform,
      version: "0.1.99",
      capabilities: { remoteSessions: true, selfUpdate: "desktop-managed" },
    });
    expect(environmentDescriptor({ environmentId: "abc", desktopManaged: false }).capabilities.selfUpdate).toBe("operator");
  });

  it("falls back to the checkout's package.json version, then to unknown", () => {
    delete process.env.OMB_APP_VERSION;
    expect(serverVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
