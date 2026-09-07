import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PERSONAL_WORKSPACE_AUTHORITY,
  callTool,
  fanOutPersonal,
  transport,
} from "./wiki-anyllm-mcp.mjs";

const realFetch = transport.fetch;
afterEach(() => {
  transport.fetch = realFetch;
});

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

/**
 * Drive the fan-out without a live AnythingLLM.
 *
 * `hits` maps a workspace slug to its vector-search results; `failing` maps a
 * slug to an HTTP status that should fail that one workspace.
 */
function stubInstance({ hits = {}, answers = {}, failing = {} } = {}) {
  const calls = { search: [], chat: [], bodies: {} };
  transport.fetch = async (url, init) => {
    if (url.endsWith("/api/v1/workspaces")) {
      return ok({ workspaces: PERSONAL_WORKSPACE_AUTHORITY.map((slug) => ({ slug })) });
    }
    const match = /\/api\/v1\/workspace\/([^/]+)\/(vector-search|chat)$/.exec(url);
    if (!match) throw new Error(`unexpected url ${url}`);
    const [, slug, kind] = match;
    if (failing[slug]) return { ok: false, status: failing[slug], json: async () => ({}) };
    const body = JSON.parse(init.body);
    if (kind === "vector-search") {
      calls.search.push(slug);
      calls.bodies[slug] = body;
      return ok({ results: hits[slug] || [] });
    }
    calls.chat.push(slug);
    return ok({ textResponse: answers[slug] || `answer from ${slug}`, sources: [{ title: `${slug}__doc.md` }] });
  };
  return calls;
}

describe("query_personal_wiki fan-out", () => {
  it("finds a fact that lives only in trey-learning without being told the workspace", async () => {
    const calls = stubInstance({
      hits: { "trey-learning": [{ score: 0.63, text: "battlecard" }] },
      answers: { "trey-learning": "PASS on building or funding the plan as written." },
    });

    const result = await callTool("query_personal_wiki", { message: "what did the battlecard conclude?" });

    expect(calls.search).toEqual(PERSONAL_WORKSPACE_AUTHORITY);
    expect(result.mode).toBe("fan-out");
    expect(result.answers.map((row) => row.workspace)).toEqual(["trey-learning"]);
    expect(result.answers[0].answer).toContain("PASS on building or funding");
  });

  it("merges per-workspace scores and answers the best-scoring workspaces first", async () => {
    stubInstance({
      hits: {
        "trey-inbox": [{ score: 0.31 }],
        "trey-learning": [{ score: 0.63 }, { score: 0.54 }],
        "trey-work": [{ score: 0.47 }],
      },
    });

    const result = await fanOutPersonal("anything", { limit: 2 });

    expect(result.searched).toBe(PERSONAL_WORKSPACE_AUTHORITY.length);
    expect(result.ranked.map((row) => row.workspace)).toEqual(["trey-learning", "trey-work", "trey-inbox"]);
    expect(result.ranked[0]).toMatchObject({ score: 0.63, chunks: 2 });
    expect(result.answers.map((row) => row.workspace)).toEqual(["trey-learning", "trey-work"]);
  });

  it("chats exactly one workspace when no limit is passed", async () => {
    // The default is the boundary, not the option: fan out retrieval across all
    // fourteen, synthesise on the single best. Every other case in this file
    // passes an explicit limit, so without this assertion the default is unpinned.
    const calls = stubInstance({
      hits: {
        "trey-inbox": [{ score: 0.31 }],
        "trey-learning": [{ score: 0.63 }],
        "trey-work": [{ score: 0.47 }],
      },
    });

    const result = await callTool("query_personal_wiki", { message: "anything" });

    expect(calls.search).toEqual(PERSONAL_WORKSPACE_AUTHORITY);
    expect(calls.chat).toEqual(["trey-learning"]);
    expect(result.answers).toHaveLength(1);
    expect(result.ranked.map((row) => row.workspace)).toEqual(["trey-learning", "trey-work", "trey-inbox"]);
  });

  it("keeps answering when one workspace fails", async () => {
    stubInstance({
      hits: { "trey-learning": [{ score: 0.63 }] },
      failing: { "trey-finance": 500 },
    });

    const result = await fanOutPersonal("anything", { limit: 1 });

    expect(result.errors["trey-finance"]).toMatch(/HTTP 500/);
    expect(result.answers.map((row) => row.workspace)).toEqual(["trey-learning"]);
  });

  it("honours each workspace's own retrieval depth instead of overriding topN", async () => {
    const calls = stubInstance({ hits: { "trey-learning": [{ score: 0.63 }] } });

    await fanOutPersonal("anything");

    for (const slug of PERSONAL_WORKSPACE_AUTHORITY) {
      expect(calls.bodies[slug]).toEqual({ query: "anything" });
    }
  });

  it("still queries exactly one workspace when the caller names it", async () => {
    const calls = stubInstance({ answers: { "trey-health": "sentinel" } });

    const result = await callTool("query_personal_wiki", { workspace: "trey-health", message: "sentinel?" });

    expect(calls.search).toEqual([]);
    expect(calls.chat).toEqual(["trey-health"]);
    expect(result).toMatchObject({ workspace: "trey-health", instance: "personal", answer: "sentinel" });
  });
});

// Windows CI cannot create file symlinks without Developer Mode or elevation,
// and this case exists specifically to launch through one. Skipping keeps the
// other cases collecting and running on all three CI platforms; the guard it
// protects (realpath before comparing argv[1] with import.meta.url) only ever
// mattered on POSIX, where /tmp is itself a symlink.
describe.skipIf(process.platform === "win32")("stdio entry point", () => {
  // Importing the module exercises callTool but never the spawn path. The entry
  // guard compares import.meta.url with process.argv[1], and argv[1] keeps the
  // caller's symlink, so a symlinked launch path can silently start no server at
  // all. This drives the real child process to keep that failure visible.
  it("serves a tools/call over stdio when launched through a symlinked path", async () => {
    const slugs = PERSONAL_WORKSPACE_AUTHORITY;
    const touched = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/v1/workspaces") {
          return res.end(JSON.stringify({ workspaces: slugs.map((slug) => ({ slug })) }));
        }
        const match = /\/api\/v1\/workspace\/([^/]+)\/(vector-search|chat)$/.exec(req.url);
        if (!match) {
          res.statusCode = 404;
          return res.end("{}");
        }
        const [, slug, kind] = match;
        touched.push(slug);
        if (kind === "vector-search") {
          return res.end(JSON.stringify({ results: slug === "trey-learning" ? [{ score: 0.63 }] : [] }));
        }
        res.end(JSON.stringify({ textResponse: "synthetic", sources: [{ title: "x.md" }] }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const real = path.join(path.dirname(fileURLToPath(import.meta.url)), "wiki-anyllm-mcp.mjs");
    // Launch through a symlink on purpose: that is the shape where argv[1] and
    // import.meta.url disagree, and a guard that compares them without realpath
    // starts no server at all.
    const linkDir = mkdtempSync(path.join(os.tmpdir(), "wiki-anyllm-entry-"));
    const entry = path.join(linkDir, "wiki-anyllm-mcp.mjs");
    symlinkSync(real, entry);

    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, PERSONAL_ANYLLM_URL: base, PERSONAL_ANYLLM_KEY: "x", CLUSTER_ANYLLM_URL: base },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const reply = new Promise((resolve, reject) => {
      let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        const line = buffered.split("\n").find((row) => row.includes('"id":2'));
        if (line) resolve(JSON.parse(line));
      });
      child.on("exit", (code) => reject(new Error(`server exited early: ${code}`)));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "query_personal_wiki", arguments: { message: "anything" } },
    }) + "\n");

    try {
      const message = await reply;
      const payload = JSON.parse(message.result.content[0].text);
      expect(payload.mode).toBe("fan-out");
      expect(payload.searched).toBe(slugs.length);
      expect(touched.filter((slug) => slug === "trey-learning").length).toBeGreaterThan(0);
    } finally {
      child.kill();
      server.close();
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});
