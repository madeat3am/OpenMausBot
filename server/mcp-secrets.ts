import { readFileSync } from "node:fs";

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

function externalSecrets(path = process.env.OMB_MCP_SECRETS_FILE): z.infer<typeof secretFileSchema> | null {
  if (!path?.trim()) return null;
  return secretFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
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
    file = externalSecrets(path);
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
