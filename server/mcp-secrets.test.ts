import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMcpSecrets } from "./mcp-secrets.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("external MCP secrets", () => {
  it("prefers the named server subtree and never returns sibling secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-mcp-secrets-"));
    dirs.push(dir);
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify({ schema: "openmausbot.mcp-secrets.v1", servers: {
      wiki: { TOKEN: "external" }, twenty: { TOKEN: "other-server" },
    } }), { mode: 0o600 });
    expect(resolveMcpSecrets("wiki", { TOKEN: "legacy" }, file)).toEqual({ status: "resolved", env: { TOKEN: "external" }, missingKeys: [] });
    expect(JSON.stringify(resolveMcpSecrets("wiki", {}, file))).not.toContain("other-server");
  });

  it("rejects inline values in external-only mode and redacts invalid files", () => {
    expect(resolveMcpSecrets("wiki", { TOKEN: "legacy" }, undefined, "reject")).toMatchObject({ status: "invalid", env: {} });
    expect(resolveMcpSecrets("wiki", { TOKEN: "legacy" }, "/definitely/missing", "allow")).toEqual({ status: "invalid", env: {}, missingKeys: ["TOKEN"] });
  });
});
