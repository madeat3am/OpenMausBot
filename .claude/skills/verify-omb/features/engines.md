# Engines & instances

Provider instances from config; custom ACP engines and OpenAI-compat
endpoints are zero-code config entries.

## Sub-features
- instances map in config.json (driver/environment/config.cli)
- customAcp: any ACP-stdio CLI; teaching shadow rows for blank cli
- model picker rail (subscription vs custom), Set CLI override

## How to get to it (user POV)
Model picker on a bot; Settings → Engines for CLI overrides.

## Driving it
`GET /api/instances` lists rows + snapshots. Add instances only via the
isolated $TMP config.json, then restart that server. Fake engines:
claudeAgent→fake-claude-cli.ts, grokAgent→fake-acp-cli.ts.

## Gotchas
- A schema-invalid config.json silently falls back to defaults for that
  boot — check `doctor`'s engine list matches what you configured.
- describe() probes CLIs; a missing binary is unavailable+reason, never
  an error.
