import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

export const MCP_SECRETS_SCHEMA = "openmausbot.mcp-secrets.v1" as const;

const secretFileSchema = z.object({
  schema: z.literal(MCP_SECRETS_SCHEMA),
  servers: z.record(
    z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1).max(16_384)),
  ),
}).strict();

export interface McpSecretResolution {
  status: "resolved" | "missing" | "invalid";
  env: Record<string, string>;
  missingKeys: string[];
}

let managedSecrets: z.infer<typeof secretFileSchema> | null = null;

/** Desktop Electron sends its safeStorage-decrypted document over the private
 * utility-process channel. Keep it in memory only; the renderer and model
 * processes never receive it. Headless installs continue to use the
 * root/owner-controlled read-only file. */
export function setManagedMcpSecrets(raw: unknown): void {
  managedSecrets = raw === null ? null : secretFileSchema.parse(raw);
}

function externalSecrets(path = process.env.OMB_MCP_SECRETS_FILE): z.infer<typeof secretFileSchema> | null {
  if (!path?.trim()) return null;
  return secretFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The connector sidecar is the only hosted process allowed to mutate this
 * owner-mounted file. Writes are atomic and keep the document mode 0600; the
 * main OMB process only receives key-name placeholders. */
export function updateExternalMcpSecrets(
  server: string,
  env: Record<string, string> | null,
  path = process.env.OMB_MCP_SECRETS_FILE,
): void {
  if (!path?.trim()) throw new Error("OMB_MCP_SECRETS_FILE is required for hosted MCP secret updates");
  let current: z.infer<typeof secretFileSchema> | null = null;
  try {
    current = externalSecrets(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  current ??= { schema: MCP_SECRETS_SCHEMA, servers: {} };
  const servers = { ...current.servers };
  if (env === null) delete servers[server];
  else servers[server] = Object.fromEntries(Object.entries(env).filter(([, value]) => Boolean(value)));
  const checked = secretFileSchema.parse({ schema: MCP_SECRETS_SCHEMA, servers });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Resolve one server only. No caller ever receives another server's subtree. */
export function resolveMcpSecrets(
  server: string,
  inline: Record<string, string>,
  path = process.env.OMB_MCP_SECRETS_FILE,
  inlineMode = process.env.OMB_MCP_INLINE_SECRETS === "reject" ? "reject" : "allow",
): McpSecretResolution {
  let file: z.infer<typeof secretFileSchema> | null;
  try {
    file = externalSecrets(path) ?? managedSecrets;
  } catch {
    return { status: "invalid", env: {}, missingKeys: Object.keys(inline).sort() };
  }
  const external = file?.servers[server] ?? {};
  const keys = [...new Set([...Object.keys(inline), ...Object.keys(external)])].sort();
  if (inlineMode === "reject" && Object.values(inline).some(Boolean)) {
    return { status: "invalid", env: {}, missingKeys: keys };
  }
  const env: Record<string, string> = {};
  const missingKeys: string[] = [];
  for (const key of keys) {
    const value = external[key] || (inlineMode === "allow" ? inline[key] : "");
    if (value) env[key] = value;
    else missingKeys.push(key);
  }
  return {
    status: missingKeys.length ? "missing" : "resolved",
    env,
    missingKeys,
  };
}

export function mcpSecretsDiagnostic(
  servers: Record<string, unknown> | undefined,
): { status: "resolved" | "missing" | "invalid"; servers: Record<string, "resolved" | "missing" | "invalid"> } {
  const results = Object.fromEntries(Object.entries(servers ?? {}).map(([name, entry]) => {
    const rawEnv = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { env?: unknown }).env
      : undefined;
    const env = rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)
      ? Object.fromEntries(Object.entries(rawEnv).filter((item): item is [string, string] => typeof item[1] === "string"))
      : {};
    return [name, resolveMcpSecrets(name, env).status];
  }));
  const values = Object.values(results);
  const status = values.includes("invalid") ? "invalid" : values.includes("missing") ? "missing" : "resolved";
  return { status, servers: results };
}
