#!/usr/bin/env node
// Citadel wiki-query stdio MCP for OpenMausBot bots.
// Read-only RAG access to BOTH wikis via AnythingLLM REST:
//   cluster wiki  -> CLUSTER_ANYLLM_URL  (AnythingLLM on g428:3100)
//   personal wiki -> PERSONAL_ANYLLM_URL (fwpc-personal-anythingllm:3101)
// Env: CLUSTER_ANYLLM_URL, CLUSTER_ANYLLM_KEY, PERSONAL_ANYLLM_URL, PERSONAL_ANYLLM_KEY
import readline from "node:readline";

const INSTANCES = {
  cluster:  { url: process.env.CLUSTER_ANYLLM_URL  || "http://192.168.0.12:3100",  key: process.env.CLUSTER_ANYLLM_KEY  || "" },
  personal: { url: process.env.PERSONAL_ANYLLM_URL || "http://192.168.0.163:3101", key: process.env.PERSONAL_ANYLLM_KEY || "" },
};

async function api(inst, path, method = "GET", body = null) {
  const { url, key } = INSTANCES[inst];
  const res = await fetch(`${url}${path}`, {
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
    description: "Ask Trey's PERSONAL wiki (person-centric/private knowledge) a question via AnythingLLM RAG. Returns a grounded answer with sources.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string", description: "Workspace slug (default: the main personal workspace)" },
      message: { type: "string" } }, required: ["message"], additionalProperties: false } },
];

async function firstWorkspace(inst) {
  const d = await api(inst, "/api/v1/workspaces");
  const ws = d.workspaces || [];
  if (!ws.length) throw new Error(`${inst}: no workspaces`);
  return ws[0].slug;
}

async function callTool(name, args) {
  if (name === "list_wiki_workspaces") {
    const out = {};
    for (const inst of Object.keys(INSTANCES)) {
      try { const d = await api(inst, "/api/v1/workspaces"); out[inst] = (d.workspaces || []).map(w => w.slug); }
      catch (e) { out[inst] = `error: ${e.message}`; }
    }
    return out;
  }
  const inst = name === "query_cluster_wiki" ? "cluster" : "personal";
  const slug = args.workspace || await firstWorkspace(inst);
  const d = await api(inst, `/api/v1/workspace/${encodeURIComponent(slug)}/chat`, "POST",
                      { message: args.message, mode: "query" });
  return { workspace: slug, instance: inst, answer: d.textResponse ?? d.response ?? d,
           sources: (d.sources || []).map(s => s.title || s.url || s.id).slice(0, 8) };
}

const rl = readline.createInterface({ input: process.stdin });
const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", async (line) => {
  line = line.trim(); if (!line) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  try {
    if (method === "initialize")
      reply({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: "citadel-wiki-anyllm", version: "1.0.0" } } });
    else if (method === "tools/list") reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else if (method === "tools/call") {
      const r = await callTool(params.name, params.arguments || {});
      reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] } });
    } else if (id !== undefined) reply({ jsonrpc: "2.0", id, result: {} });
  } catch (e) {
    if (id !== undefined) reply({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e.message || e) } });
  }
});
