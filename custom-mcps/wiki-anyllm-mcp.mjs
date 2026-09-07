#!/usr/bin/env node
// Citadel wiki-query stdio MCP for OpenMausBot bots.
// Read-only RAG access to BOTH wikis via AnythingLLM REST:
//   cluster wiki  -> CLUSTER_ANYLLM_URL  (AnythingLLM on g428:3100)
//   personal wiki -> PERSONAL_ANYLLM_URL (fwpc-personal-anythingllm:3101)
// Env: CLUSTER_ANYLLM_URL, CLUSTER_ANYLLM_KEY, PERSONAL_ANYLLM_URL, PERSONAL_ANYLLM_KEY
import { realpathSync } from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const INSTANCES = {
  cluster:  { url: process.env.CLUSTER_ANYLLM_URL  || "http://192.168.0.12:3100",  key: process.env.CLUSTER_ANYLLM_KEY  || "" },
  personal: { url: process.env.PERSONAL_ANYLLM_URL || "http://192.168.0.163:3101", key: process.env.PERSONAL_ANYLLM_KEY || "" },
};

// The personal vault's governed workspace set. Authority:
// cluster-config `contracts/personal-vault-layout-contract.json`, loaded by
// `cluster_scripts/personal_vault_layout.py`. Kept in declaration order so the
// fan-out is deterministic; intersected with the live instance so a drifted
// instance narrows the set instead of erroring.
export const PERSONAL_WORKSPACE_AUTHORITY = [
  "trey-inbox",
  "trey-journal",
  "trey-health",
  "trey-finance",
  "trey-people",
  "trey-goals",
  "trey-learning",
  "trey-home",
  "trey-work",
  "trey-self",
  "trey-ideas",
  "trey-voice-vendor-followups",
  "trey-voice-client-replies",
  "trey-voice-personal-warm",
];

// How many workspaces get a synthesis call after ranking. Retrieval fans out
// across every workspace; only the best-scoring ones are worth an LLM call.
const PERSONAL_ANSWER_LIMIT = Number(process.env.PERSONAL_ANYLLM_ANSWER_LIMIT || 2);

// Injectable so tests can drive the fan-out without a live AnythingLLM.
export const transport = { fetch: (...args) => globalThis.fetch(...args) };

async function api(inst, path, method = "GET", body = null) {
  const { url, key } = INSTANCES[inst];
  const res = await transport.fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(150000),
  });
  if (!res.ok) throw new Error(`${inst} anythingllm ${path} -> HTTP ${res.status}`);
  return res.json();
}

const TOOLS = [
  { name: "list_wiki_workspaces",
    description: "List available wiki RAG workspaces on the cluster and personal AnythingLLM instances.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "query_cluster_wiki",
    description: "Ask the CLUSTER wiki (operational/cluster knowledge: services, doctrine, infrastructure) a question via AnythingLLM RAG. Returns a grounded answer with sources.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string", description: "Workspace slug (default: the main cluster wiki workspace)" },
      message: { type: "string" } }, required: ["message"], additionalProperties: false } },
  { name: "query_personal_wiki",
    description: "Ask Trey's PERSONAL wiki (person-centric/private knowledge) a question via AnythingLLM RAG. With no workspace argument this searches EVERY personal workspace and answers from the best-scoring ones, so you never have to guess which life area holds a fact. Returns grounded answers with per-workspace scores and sources.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string", description: "Optional single workspace slug. Omit it to search every personal workspace." },
      message: { type: "string" } }, required: ["message"], additionalProperties: false } },
];

async function firstWorkspace(inst) {
  const d = await api(inst, "/api/v1/workspaces");
  const ws = d.workspaces || [];
  if (!ws.length) throw new Error(`${inst}: no workspaces`);
  return ws[0].slug;
}

export async function personalWorkspaces() {
  const d = await api("personal", "/api/v1/workspaces");
  const live = new Set((d.workspaces || []).map((w) => w.slug).filter(Boolean));
  const governed = PERSONAL_WORKSPACE_AUTHORITY.filter((slug) => live.has(slug));
  if (governed.length) return governed;
  const treyOnly = [...live].filter((slug) => slug.startsWith("trey-")).sort();
  if (treyOnly.length) return treyOnly;
  throw new Error("personal: no governed workspaces");
}

function bestScore(results) {
  let best = 0;
  for (const row of results || []) {
    const score = Number(row?.score);
    if (Number.isFinite(score) && score > best) best = score;
  }
  return best;
}

function askWorkspace(slug, message) {
  return api("personal", `/api/v1/workspace/${encodeURIComponent(slug)}/chat`, "POST",
             { message, mode: "query" });
}

/**
 * Search every governed personal workspace, then answer from the best-scoring
 * ones. Retrieval sends no topN: each workspace's own governed depth is what
 * its synthesis receives, so overriding it here would measure a depth no
 * answer ever sees. One workspace failing is recorded and never blanks the
 * others.
 */
export async function fanOutPersonal(message, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? PERSONAL_ANSWER_LIMIT));
  const slugs = await personalWorkspaces();
  const searched = await Promise.allSettled(
    slugs.map((slug) => api("personal", `/api/v1/workspace/${encodeURIComponent(slug)}/vector-search`, "POST", { query: message })),
  );

  const errors = {};
  const ranked = [];
  slugs.forEach((slug, index) => {
    const outcome = searched[index];
    if (outcome.status === "rejected") {
      errors[slug] = String(outcome.reason?.message || outcome.reason);
      return;
    }
    const results = outcome.value?.results || [];
    if (!results.length) return;
    ranked.push({ workspace: slug, score: bestScore(results), chunks: results.length });
  });
  ranked.sort((a, b) => b.score - a.score);

  const chosen = ranked.slice(0, limit);
  const answered = await Promise.allSettled(chosen.map((row) => askWorkspace(row.workspace, message)));
  const answers = [];
  chosen.forEach((row, index) => {
    const outcome = answered[index];
    if (outcome.status === "rejected") {
      errors[row.workspace] = String(outcome.reason?.message || outcome.reason);
      return;
    }
    const d = outcome.value;
    answers.push({
      workspace: row.workspace,
      score: row.score,
      answer: d.textResponse ?? d.response ?? d,
      sources: (d.sources || []).map((s) => s.title || s.url || s.id).slice(0, 8),
    });
  });

  return {
    instance: "personal",
    mode: "fan-out",
    searched: slugs.length,
    ranked,
    answers,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

export async function callTool(name, args) {
  if (name === "list_wiki_workspaces") {
    const out = {};
    for (const inst of Object.keys(INSTANCES)) {
      try { const d = await api(inst, "/api/v1/workspaces"); out[inst] = (d.workspaces || []).map(w => w.slug); }
      catch (e) { out[inst] = `error: ${e.message}`; }
    }
    return out;
  }
  const inst = name === "query_cluster_wiki" ? "cluster" : "personal";
  if (inst === "personal" && !args.workspace) return fanOutPersonal(args.message);
  const slug = args.workspace || await firstWorkspace(inst);
  const d = await api(inst, `/api/v1/workspace/${encodeURIComponent(slug)}/chat`, "POST",
                      { message: args.message, mode: "query" });
  return { workspace: slug, instance: inst, answer: d.textResponse ?? d.response ?? d,
           sources: (d.sources || []).map(s => s.title || s.url || s.id).slice(0, 8) };
}

export function serve() {
  const rl = readline.createInterface({ input: process.stdin });
  const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  rl.on("line", async (line) => {
    line = line.trim(); if (!line) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    const { id, method, params } = m;
    try {
      if (method === "initialize")
        reply({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} }, serverInfo: { name: "citadel-wiki-anyllm", version: "1.1.0" } } });
      else if (method === "tools/list") reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      else if (method === "tools/call") {
        const r = await callTool(params.name, params.arguments || {});
        reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] } });
      } else if (id !== undefined) reply({ jsonrpc: "2.0", id, result: {} });
    } catch (e) {
      if (id !== undefined) reply({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e.message || e) } });
    }
  });
  return rl;
}

// Resolve the entry through realpath before comparing: import.meta.url is the
// real path, while process.argv[1] keeps whatever symlink the caller used. On a
// host that launches this file through a symlink (/tmp -> /private/tmp is the
// everyday case) a naive comparison silently never starts the server.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) serve();
