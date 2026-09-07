import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "custom-mcp-proxy.ts");
let child: ChildProcess | null = null;
let harness: Server | null = null;

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = null;
  if (harness) {
    harness.closeAllConnections();
    await new Promise<void>((resolve) => harness!.close(() => resolve()));
    harness = null;
  }
});

describe("custom MCP proxy shutdown", () => {
  it("bounds signal cleanup even when an in-flight relay never settles", async () => {
    let sawRelay!: () => void;
    const relayStarted = new Promise<void>((resolve) => { sawRelay = resolve; });
    harness = createServer((request, response) => {
      if (request.method === "POST") {
        sawRelay();
        return;
      }
      response.writeHead(204).end();
    });
    harness.listen(0, "127.0.0.1");
    await once(harness, "listening");
    const address = harness.address();
    if (!address || typeof address === "string") throw new Error("harness did not listen");
    child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "--server", "wiki", "--session", "stable"], {
      env: {
        ...process.env,
        OMB_HARNESS_URL: `http://127.0.0.1:${address.port}`,
        OMB_COMMS_TOKEN: "t".repeat(48),
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await relayStarted;
    const started = Date.now();
    child.kill("SIGTERM");

    await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("proxy did not stop within 4.5 seconds")), 4_500)),
    ]);

    expect(Date.now() - started).toBeLessThan(4_500);
  }, 7_000);
});
