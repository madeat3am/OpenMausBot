import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportManagedComposioCredential,
  parseManagedComposioExportArguments,
} from "./managed-composio-export.mjs";

const TOKEN = "a".repeat(64);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-credential-export-test-"));
  roots.push(root);
  const source = path.join(root, "credentials.bin");
  const output = path.join(root, "handoff", "broker.json");
  fs.writeFileSync(source, "cipher", { mode: 0o600 });
  return { root, source, output };
}

describe("managed connected-apps credential export", () => {
  it("parses only the three explicit path and URL arguments", () => {
    expect(
      parseManagedComposioExportArguments([
        "--source",
        "/secure/credentials.bin",
        "--ignored",
        "secret",
        "--output",
        "/secure/broker.json",
        "--broker-url",
        "https://broker.example/path/",
      ]),
    ).toEqual({
      source: "/secure/credentials.bin",
      output: "/secure/broker.json",
      brokerUrl: "https://broker.example/path",
    });
  });

  it("writes the exact broker credential once with mode 0600", async () => {
    const { source, output } = fixture();
    await exportManagedComposioCredential({
      source,
      output,
      brokerUrl: "https://broker.example",
      storageAvailable: async () => true,
      decrypt: async () =>
        JSON.stringify({ composioBrokerToken: TOKEN, composioInstallationId: "installation-1" }),
    });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
      schema: "openmausbot.managed-composio-credential.v1",
      brokerUrl: "https://broker.example",
      token: TOKEN,
      installationId: "installation-1",
    });
    await expect(
      exportManagedComposioCredential({
        source,
        output,
        brokerUrl: "https://broker.example",
        storageAvailable: async () => true,
        decrypt: async () =>
          JSON.stringify({ composioBrokerToken: TOKEN, composioInstallationId: "installation-1" }),
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("fails closed before writing for unavailable storage or malformed credentials", async () => {
    const unavailable = fixture();
    await expect(
      exportManagedComposioCredential({
        ...unavailable,
        brokerUrl: "https://broker.example",
        storageAvailable: async () => false,
        decrypt: async () => "{}",
      }),
    ).rejects.toThrow(/unavailable/);
    expect(fs.existsSync(unavailable.output)).toBe(false);

    const malformed = fixture();
    await expect(
      exportManagedComposioCredential({
        ...malformed,
        brokerUrl: "https://broker.example",
        storageAvailable: async () => true,
        decrypt: async () => JSON.stringify({ composioBrokerToken: "wrong" }),
      }),
    ).rejects.toThrow(/missing or invalid/);
    expect(fs.existsSync(malformed.output)).toBe(false);
  });

  it("refuses symlink sources and non-HTTPS remote brokers", async () => {
    const { root, source, output } = fixture();
    const link = path.join(root, "credentials-link.bin");
    fs.symlinkSync(source, link);
    await expect(
      exportManagedComposioCredential({
        source: link,
        output,
        brokerUrl: "https://broker.example",
        storageAvailable: async () => true,
        decrypt: async () => "{}",
      }),
    ).rejects.toThrow(/regular file/);
    await expect(
      exportManagedComposioCredential({
        source,
        output,
        brokerUrl: "http://broker.example",
        storageAvailable: async () => true,
        decrypt: async () => "{}",
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});
