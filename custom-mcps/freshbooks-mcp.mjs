#!/usr/bin/env node
// freshbooks-mcp.mjs — direct FreshBooks API MCP for OpenMausBot (read-only v1).
//
// Why: Composio's FreshBooks toolkit exposes only businesses/projects/journal
// entries (verified 2026-09-05), so invoices, clients, payments and expenses
// were unreachable for every bot. This server talks to api.freshbooks.com with
// FreshBooks' own OAuth2 (one grant per business login) and refreshes tokens
// itself. FreshBooks refresh tokens are single-use, so every refresh persists
// the new pair atomically before use.
//
// Runtime: plain Node >= 18 (no dependencies), stdio JSON-RPC like the other
// OMB custom MCPs. Registered in OMB as `citadel-freshbooks` with env:
//   FRESHBOOKS_CLIENT_ID, FRESHBOOKS_CLIENT_SECRET   (developer app)
//   FRESHBOOKS_REDIRECT_URI  (default https://127.0.0.1/freshbooks-callback)
//   FRESHBOOKS_TOKEN_DIR     (default /data/.openmausbot/freshbooks; must be rw)
//
// One-time authorization per business (run inside the OMB container):
//   node /custom-mcps/freshbooks-mcp.mjs auth-url
//     -> open the URL logged in as that business's FreshBooks user, approve,
//        copy the `code=` value from the redirect URL (the page itself 404s).
//   node /custom-mcps/freshbooks-mcp.mjs auth --alias meridian-row --code <code>
//   node /custom-mcps/freshbooks-mcp.mjs auth --alias seed --code <code>
//   node /custom-mcps/freshbooks-mcp.mjs whoami            # readback per alias
//
// Tools (all read-only): freshbooks_list_businesses, freshbooks_list_invoices,
// freshbooks_get_invoice, freshbooks_list_clients, freshbooks_list_payments,
// freshbooks_list_expenses. Every tool takes `alias` (a token file name).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const API = "https://api.freshbooks.com";
const AUTH_URL = "https://auth.freshbooks.com/oauth/authorize/";
const TOKEN_URL = `${API}/auth/oauth/token`;
const CLIENT_ID = process.env.FRESHBOOKS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.FRESHBOOKS_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.FRESHBOOKS_REDIRECT_URI || "https://127.0.0.1/freshbooks-callback";
const TOKEN_DIR = process.env.FRESHBOOKS_TOKEN_DIR || "/data/.openmausbot/freshbooks";
const UA = "openmausbot-citadel-freshbooks/1.0";

function needClient() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("FRESHBOOKS_CLIENT_ID / FRESHBOOKS_CLIENT_SECRET are not set");
}
function tokenPath(alias) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(alias)) throw new Error(`bad alias "${alias}" (lowercase letters, digits, dashes)`);
  return path.join(TOKEN_DIR, `${alias}.json`);
}
function listAliases() {
  try { return fs.readdirSync(TOKEN_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); }
  catch { return []; }
}
function readTokens(alias) {
  const p = tokenPath(alias);
  if (!fs.existsSync(p)) throw new Error(`no FreshBooks authorization stored for alias "${alias}" (known: ${listAliases().join(", ") || "none"}); run: freshbooks-mcp.mjs auth --alias ${alias} --code <code>`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeTokens(alias, tok) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const p = tokenPath(alias); const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(tok, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

async function tokenRequest(body) {
  needClient();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FreshBooks token endpoint ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(j.expires_in || 43200) - 120) * 1000,
    token_type: j.token_type || "Bearer",
    obtained_at: new Date().toISOString(),
  };
}

// Single-flight refresh per alias: concurrent tool calls must not both spend
// the same single-use refresh token.
const refreshing = new Map();
async function accessToken(alias) {
  const tok = readTokens(alias);
  if (tok.access_token && Date.now() < (tok.expires_at || 0)) return tok.access_token;
  if (!refreshing.has(alias)) {
    refreshing.set(alias, (async () => {
      const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh_token });
      writeTokens(alias, { ...tok, ...fresh });
      return fresh.access_token;
    })().finally(() => refreshing.delete(alias)));
  }
  return refreshing.get(alias);
}

async function fb(alias, endpoint, params) {
  const url = new URL(endpoint, API);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let token = await accessToken(alias);
  let res = await fetch(url, { headers: { authorization: `Bearer ${token}`, "api-version": "alpha", "user-agent": UA } });
  if (res.status === 401) {
    // access token revoked server-side: force one refresh and retry once
    const tok = readTokens(alias); writeTokens(alias, { ...tok, expires_at: 0 });
    token = await accessToken(alias);
    res = await fetch(url, { headers: { authorization: `Bearer ${token}`, "api-version": "alpha", "user-agent": UA } });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`FreshBooks ${res.status} ${url.pathname}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function identity(alias) {
  const me = await fb(alias, "/auth/api/v1/users/me");
  const r = me.response || me;
  return {
    alias,
    user: { id: r.id, email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(" ") },
    businesses: (r.business_memberships || []).map((m) => ({
      business_id: m.business?.id, account_id: m.business?.account_id, name: m.business?.name, role: m.role,
    })),
  };
}
async function accountId(alias, requested) {
  const tok = readTokens(alias);
  if (requested) return requested;
  if (tok.account_id) return tok.account_id;
  const id = await identity(alias);
  const withAccount = id.businesses.filter((b) => b.account_id);
  if (withAccount.length !== 1) throw new Error(`alias "${alias}" has ${withAccount.length} accounting businesses; pass account_id explicitly: ${JSON.stringify(id.businesses)}`);
  writeTokens(alias, { ...tok, account_id: withAccount[0].account_id, business_name: withAccount[0].name });
  return withAccount[0].account_id;
}

// Accounting list envelope: response.result.<key> plus page/pages/per_page/total
function page(d, key) {
  const r = d.response?.result || {};
  return { [key]: r[key] || [], page: r.page, pages: r.pages, per_page: r.per_page, total: r.total };
}
function searchParams(args, allowed) {
  const out = { page: args.page || 1, per_page: Math.min(Number(args.per_page || 30), 100) };
  for (const k of allowed) if (args[k] !== undefined) out[`search[${k}]`] = args[k];
  return out;
}
const aliasProp = { alias: { type: "string", description: `Business authorization alias (one of: ${listAliases().join(", ") || "none authorized yet"})` } };
const acct = { account_id: { type: "string", description: "Optional accounting account_id override (defaults to the alias's single business)" } };
const paging = { page: { type: "integer", minimum: 1 }, per_page: { type: "integer", minimum: 1, maximum: 100 } };
const dateRange = { date_min: { type: "string", description: "YYYY-MM-DD" }, date_max: { type: "string", description: "YYYY-MM-DD" } };

const TOOLS = [
  { name: "freshbooks_list_businesses", description: "Identity readback for one alias (or all): user, businesses, account_ids. Use first when unsure which alias is which business.",
    inputSchema: { type: "object", properties: { alias: { type: "string" } }, additionalProperties: false } },
  { name: "freshbooks_list_invoices", description: "List invoices for a business. Filters: status (draft|sent|viewed|paid|auto-paid|retry|failed|partial|overdue|disputed|declined|pending|depositPartial|depositPaid|resolved), date range, customer, invoice number substring.",
    inputSchema: { type: "object", properties: { ...aliasProp, ...acct, ...paging, ...dateRange,
      status: { type: "string" }, customerid: { type: "string" }, invoice_number_like: { type: "string" } }, required: ["alias"], additionalProperties: false } },
  { name: "freshbooks_get_invoice", description: "Get one invoice by id (includes lines when include_lines=true).",
    inputSchema: { type: "object", properties: { ...aliasProp, ...acct, invoice_id: { type: "string" }, include_lines: { type: "boolean" } }, required: ["alias", "invoice_id"], additionalProperties: false } },
  { name: "freshbooks_list_clients", description: "List clients for a business. Filters: email, organization/name substring, userid.",
    inputSchema: { type: "object", properties: { ...aliasProp, ...acct, ...paging, email: { type: "string" }, organization_like: { type: "string" }, userid: { type: "string" } }, required: ["alias"], additionalProperties: false } },
  { name: "freshbooks_list_payments", description: "List payments received. Filters: date range, invoiceid, clientid.",
    inputSchema: { type: "object", properties: { ...aliasProp, ...acct, ...paging, ...dateRange, invoiceid: { type: "string" }, clientid: { type: "string" } }, required: ["alias"], additionalProperties: false } },
  { name: "freshbooks_list_expenses", description: "List expenses. Filters: date range, vendor substring, categoryid.",
    inputSchema: { type: "object", properties: { ...aliasProp, ...acct, ...paging, ...dateRange, vendor_like: { type: "string" }, categoryid: { type: "string" } }, required: ["alias"], additionalProperties: false } },
];

async function callTool(name, a) {
  if (name === "freshbooks_list_businesses") {
    const aliases = a.alias ? [a.alias] : listAliases();
    const out = [];
    for (const al of aliases) { try { out.push(await identity(al)); } catch (e) { out.push({ alias: al, error: String(e.message || e) }); } }
    return { authorized_aliases: listAliases(), identities: out };
  }
  const id = await accountId(a.alias, a.account_id);
  switch (name) {
    case "freshbooks_list_invoices": {
      const p = searchParams(a, ["date_min", "date_max", "customerid", "invoice_number_like"]);
      if (a.status) p["search[status]"] = a.status; // FreshBooks accepts the v3 status name
      return { alias: a.alias, account_id: id, ...page(await fb(a.alias, `/accounting/account/${id}/invoices/invoices`, p), "invoices") };
    }
    case "freshbooks_get_invoice": {
      const p = a.include_lines ? { "include[]": "lines" } : {};
      const d = await fb(a.alias, `/accounting/account/${id}/invoices/invoices/${encodeURIComponent(a.invoice_id)}`, p);
      return { alias: a.alias, account_id: id, invoice: d.response?.result?.invoice || d };
    }
    case "freshbooks_list_clients":
      return { alias: a.alias, account_id: id, ...page(await fb(a.alias, `/accounting/account/${id}/users/clients`, searchParams(a, ["email", "organization_like", "userid"])), "clients") };
    case "freshbooks_list_payments":
      return { alias: a.alias, account_id: id, ...page(await fb(a.alias, `/accounting/account/${id}/payments/payments`, searchParams(a, ["date_min", "date_max", "invoiceid", "clientid"])), "payments") };
    case "freshbooks_list_expenses":
      return { alias: a.alias, account_id: id, ...page(await fb(a.alias, `/accounting/account/${id}/expenses/expenses`, searchParams(a, ["date_min", "date_max", "vendor_like", "categoryid"])), "expenses") };
    default: throw new Error(`unknown tool ${name}`);
  }
}

// ---- CLI (authorization bootstrap) ---------------------------------------
const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }
if (argv[0] === "auth-url") {
  try { needClient(); } catch (e) { console.error(String(e.message || e)); process.exit(78); }
  const u = new URL(AUTH_URL); u.searchParams.set("response_type", "code"); u.searchParams.set("redirect_uri", REDIRECT_URI); u.searchParams.set("client_id", CLIENT_ID);
  console.log(u.toString());
  console.log("Open it logged in as the business's FreshBooks user, approve, then copy the code= value from the redirect URL.");
  process.exit(0);
} else if (argv[0] === "auth") {
  const alias = flag("alias"); const code = flag("code");
  if (!alias || !code) { console.error("usage: auth --alias <alias> --code <authorization-code>"); process.exit(64); }
  tokenRequest({ grant_type: "authorization_code", code }).then(async (tok) => {
    writeTokens(alias, tok);
    const id = await identity(alias);
    const withAccount = id.businesses.filter((b) => b.account_id);
    if (withAccount.length === 1) writeTokens(alias, { ...readTokens(alias), account_id: withAccount[0].account_id, business_name: withAccount[0].name });
    console.log(JSON.stringify({ stored: tokenPath(alias), identity: id }, null, 1));
  }).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
} else if (argv[0] === "whoami") {
  callTool("freshbooks_list_businesses", { alias: flag("alias") }).then((r) => console.log(JSON.stringify(r, null, 1))).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
} else {
  // ---- MCP stdio server ----------------------------------------------------
  const rl = readline.createInterface({ input: process.stdin });
  const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  rl.on("line", async (line) => {
    line = line.trim(); if (!line) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    const { id, method, params } = m;
    try {
      if (method === "initialize")
        reply({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "citadel-freshbooks", version: "1.0.0" } } });
      else if (method === "tools/list") reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      else if (method === "tools/call") {
        const r = await callTool(params.name, params.arguments || {});
        reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], structuredContent: r } });
      } else if (id !== undefined) reply({ jsonrpc: "2.0", id, result: {} });
    } catch (e) {
      if (id !== undefined) reply({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } });
    }
  });
}
