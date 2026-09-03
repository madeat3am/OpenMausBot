// What a client learns about this server before it authenticates: a stable
// identity, a label, the version, and what it can do. Served without auth at
// /.well-known/openmausbot/environment so a saved connection can check it is
// still talking to the same server, and so version skew is visible.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: NodeJS.Platform;
  version: string;
  revision: string;
  capabilities: {
    /** Pairing and sessions are available (this build). */
    remoteSessions: true;
    /** Who can update the server: the desktop app that runs it, or the operator. */
    selfUpdate: "desktop-managed" | "operator";
  };
}

/** Read or create the id. Written once, never rotated by the server itself. */
export function loadEnvironmentId(dataDir: string): string {
  const file = join(dataDir, "environment-id");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  }
  const id = randomUUID();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

/** The desktop app passes its own version; a checkout reads package.json;
 * an image sets OMB_APP_VERSION at build time. */
export function serverVersion(): string {
  const fromEnv = process.env.OMB_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(SERVER_ROOT, "..", "package.json"), "utf8"));
    const version = Reflect.get(Object(pkg), "version");
    if (typeof version === "string" && version) return version;
  } catch {
    /* no package.json next to the bundle */
  }
  return "unknown";
}

/** Immutable source revision for self-hosted images. Desktop builds that do not
 * inject one report unknown rather than implying that a version identifies the
 * exact source tree. */
export function serverRevision(): string {
  const revision = process.env.OMB_APP_REVISION?.trim() ?? "";
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(revision) ? revision.toLowerCase() : "unknown";
}

export function environmentDescriptor(input: { environmentId: string; desktopManaged: boolean }): EnvironmentDescriptor {
  return {
    environmentId: input.environmentId,
    label: process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname(),
    platform: process.platform,
    version: serverVersion(),
    revision: serverRevision(),
    capabilities: {
      remoteSessions: true,
      selfUpdate: input.desktopManaged ? "desktop-managed" : "operator",
    },
  };
}
