#!/usr/bin/env node
// control-omb — the agent-facing remote control for a running OpenMausBot
// harness server. One lever, shared by every agent working on this repo:
// drive the real product in single commands instead of improvising HTTP
// calls per session. JSON out, teaching errors, no dependencies.
//
//   node scripts/control-omb.mjs doctor
//   node scripts/control-omb.mjs new-bot --name Probe
//   node scripts/control-omb.mjs send <botId> "hello"
//   node scripts/control-omb.mjs wait-turn <botId>
//   node scripts/control-omb.mjs transcript <botId> --last 5
//   node scripts/control-omb.mjs delete-bot <botId>
//
// Server selection: OMB_URL (default http://127.0.0.1:8799). The companion
// feature map lives in .claude/skills/verify-omb/.
const BASE = (process.env.OMB_URL ?? "http://127.0.0.1:8799").replace(/\/+$/, "");

function die(message, hint) {
  console.error(`error: ${message}`);
  if (hint) console.error(`hint: ${hint}`);
  process.exit(1);
}

async function api(method, path, body) {
  let res;
  try {
    const init = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    die(`no OpenMausBot server answering at ${BASE}`,
      "start one with `pnpm dev:server` (or set OMB_URL); for an isolated instance use OMB_DATA_DIR + OMB_PORT");
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok && res.status !== 202) {
    die(`${method} ${path} → ${res.status}: ${parsed.error ?? text.slice(0, 200)}`);
  }
  return parsed;
}

const out = (value) => console.log(JSON.stringify(value, null, 2));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const [, , command, ...args] = process.argv;

const HELP = `control-omb — drive a running OpenMausBot server (JSON out)

commands:
  doctor                       server up? engines available? bot/group counts
  bots                         id, name, engine, busy for every bot
  new-bot [--name N]           create a bot (uses the default engine selection)
  send <botId> <text>          send a chat message (starts a turn)
  wait-turn <botId> [--timeout-s 120]   block until the bot's turn settles
  transcript <botId> [--last N]         newest N messages, compacted
  interrupt <botId>            stop the bot's current turn
  delete-bot <botId>           remove a bot created for verification
  config                       configured-or-not summary (never secrets)

environment:
  OMB_URL   server base (default http://127.0.0.1:8799)`;

switch (command) {
  case "doctor": {
    const [state, instances] = await Promise.all([
      api("GET", "/api/bots?messages=0"),
      api("GET", "/api/instances"),
    ]);
    const available = instances.instances.filter((i) => i.snapshot?.state === "available");
    out({
      server: BASE,
      ok: available.length > 0,
      availableEngines: available.map((i) => i.instanceId),
      note: available.length ? undefined : "no engine available — verification sends will fail; configure an instance (tests use the fake CLI via config.json instances)",
      bots: state.bots.length,
      groups: state.groups.length,
      busy: state.bots.filter((b) => b.busy).map((b) => b.id),
    });
    break;
  }
  case "bots": {
    const state = await api("GET", "/api/bots?messages=0");
    out(state.bots.map((b) => ({ id: b.id, name: b.name, busy: Boolean(b.busy), engine: b.modelSelection?.instanceId, model: b.modelSelection?.model })));
    break;
  }
  case "new-bot": {
    const created = await api("POST", "/api/bots", {});
    const name = flag("name");
    if (name) await api("PATCH", `/api/bots/${created.bot.id}`, { name });
    out({ id: created.bot.id, threadId: created.bot.threadId, name: name ?? created.bot.name });
    break;
  }
  case "send": {
    const [botId, ...rest] = args.filter((a) => !a.startsWith("--"));
    const text = rest.join(" ");
    if (!botId || !text) die("send needs <botId> and <text>", "find ids with `bots`");
    out(await api("POST", `/api/bots/${botId}/messages`, { text }));
    break;
  }
  case "wait-turn": {
    const botId = args[0];
    if (!botId || botId.startsWith("--")) die("wait-turn needs <botId>");
    const timeoutS = Number(flag("timeout-s", "120"));
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const state = await api("GET", "/api/bots?messages=0");
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) die(`no bot ${botId}`, "find ids with `bots`");
      if (!bot.busy) { out({ settled: true, botId }); break; }
      if (Date.now() > deadline) die(`turn still running after ${timeoutS}s`, "raise --timeout-s, or `interrupt` the bot");
      await new Promise((r) => setTimeout(r, 500));
    }
    break;
  }
  case "transcript": {
    const botId = args[0];
    if (!botId || botId.startsWith("--")) die("transcript needs <botId>");
    const last = Number(flag("last", "10"));
    const state = await api("GET", "/api/bots");
    const bot = state.bots.find((b) => b.id === botId);
    if (!bot) die(`no bot ${botId}`, "find ids with `bots`");
    out(bot.messages.slice(-last).map((m) => ({
      role: m.role,
      kind: m.kind,
      text: m.text?.slice(0, 400),
      tool: m.tool?.name,
      at: m.at,
    })));
    break;
  }
  case "interrupt": {
    const botId = args[0];
    if (!botId) die("interrupt needs <botId>");
    out(await api("POST", `/api/bots/${botId}/interrupt`));
    break;
  }
  case "delete-bot": {
    const botId = args[0];
    if (!botId) die("delete-bot needs <botId>");
    out(await api("DELETE", `/api/bots/${botId}`));
    break;
  }
  case "config": {
    out(await api("GET", "/api/config"));
    break;
  }
  case "help":
  case "--help":
  case undefined:
    console.log(HELP);
    break;
  default:
    die(`unknown command ${JSON.stringify(command)}`, "run with --help for the command list");
}
