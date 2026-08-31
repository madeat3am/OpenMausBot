---
name: verify-omb
description: "Drive a real OpenMausBot harness server to prove changes work — launch an isolated instance, run turns on the fake engine, read transcripts, capture evidence. Use before claiming any server/product change works, and for reproducing user reports."
---

# Verify OpenMausBot

The lever is `scripts/control-omb.mjs` (JSON out, teaching errors, `--help`).
The map of driveable features is in [`features/`](features/README.md).

## Launch (isolated — never drive the user's live app)

```sh
TMP=$(mktemp -d) && mkdir -p "$TMP/.openmausbot"
# fake engine so full turns run headless with no credentials:
cat > "$TMP/.openmausbot/config.json" <<'JSON'
{ "instances": { "claude": { "driver": "claudeAgent",
    "config": { "cli": "<REPO>/server/testing/fake-claude-cli.ts" } } } }
JSON
chmod +x server/testing/fake-claude-cli.ts
HOME="$TMP" USERPROFILE="$TMP" OMB_PORT=18987 node server/index.ts &
```

Ready when `/api/health` answers (~10s). `export OMB_URL=http://127.0.0.1:18987`
so every control-omb call targets this instance. Different fake behaviors:
`FAKE_CLAUDE_MODE` env on the server (hang, exit-early, …) — see
`server/testing/fake-claude-cli.ts` header.

## Doctor

`node scripts/control-omb.mjs doctor` — `ok: true` with at least one
`availableEngines` entry, or it names what to fix. Run it first whenever
anything looks off.

## Drive

One command per step; find recipes per feature in the map. Core loop:
`new-bot` → `send <botId> "<text>"` → `wait-turn <botId>` →
`transcript <botId> --last 5`.

## Evidence

The transcript IS the evidence for server-side behavior: capture the
relevant `transcript` output (and server log lines from `$TMP/server.log`)
into your report. Exercise the real user path (`send`), never internal
setters. For renderer/Electron behavior this headless recipe cannot reach,
say so explicitly instead of claiming visual verification.

## Cleanup

`delete-bot` what you created, `kill` the server PID you started (never by
name), `rm -rf "$TMP"`. Evidence you captured must survive — keep it
outside `$TMP`.
