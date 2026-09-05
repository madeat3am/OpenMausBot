# OMB custom MCP servers (Citadel fork)

Source of record for the stdio MCP servers that OpenMausBot mounts from the
host directory `/home/trey/omb/custom-mcps` (bind-mounted read-only at
`/custom-mcps` in `deploy-omb-1`, see `deploy/docker-compose.override.yml`).
Registered in the app under Settings → MCP servers (persisted in
`/data/.openmausbot/config.json` → `mcpServers`, API `GET/POST /api/mcp/servers`).
Secrets travel only as `env` values through the connector sidecar; never commit
them here.

| server name (in OMB)  | file                    | runtime | env (names only)                                                                 |
|-----------------------|-------------------------|---------|----------------------------------------------------------------------------------|
| `citadel-bluebubbles` | `bluebubbles-mcp.py --mcp` | python3 | `BB_URL`, `BB_PASSWORD`                                                       |
| `citadel-wiki`        | `wiki-anyllm-mcp.mjs`   | node    | `CLUSTER_ANYLLM_URL/KEY`, `PERSONAL_ANYLLM_URL/KEY`                              |
| `citadel-twenty`      | `twentycrm-mcp/dist/index.js` (mirror repo `cl-citadel/twentycrm-mcp-mirror`) | node | `TWENTY_API_URL`, `TWENTY_API_KEY`, `TWENTY_WRITABLE_ENTITIES`, … |
| `citadel-freshbooks`  | `freshbooks-mcp.mjs`    | node    | `FRESHBOOKS_CLIENT_ID`, `FRESHBOOKS_CLIENT_SECRET`, `FRESHBOOKS_TOKEN_DIR`, `FRESHBOOKS_REDIRECT_URI` |

## Deploy a change

```bash
# on macbook-air-ubuntu (OMB host), from the fork checkout at the deployed revision
git -C ~/omb/OpenMausBot fetch fork && git -C ~/omb/OpenMausBot checkout <sha>
rsync -a --exclude twentycrm-mcp ~/omb/OpenMausBot/custom-mcps/ ~/omb/custom-mcps/
# bots pick the new file up on their next MCP spawn (per task); no container restart needed
```

## citadel-freshbooks (direct FreshBooks API)

Why it exists: Composio's FreshBooks toolkit exposes only
`FRESHBOOKS_LIST_BUSINESSES`, `FRESHBOOKS_LIST_PROJECTS`,
`FRESHBOOKS_LIST_JOURNAL_ENTRIES2` (verified 2026-09-05), so invoices, clients,
payments and expenses were unreachable. This server uses FreshBooks OAuth2
directly, one grant per business login (`meridian-row`, `seed`), and stores the
rotating token pair under `FRESHBOOKS_TOKEN_DIR` (default
`/data/.openmausbot/freshbooks`, the writable data volume). Read-only in v1.

Deployment facts (live 2026-09-05): custom MCP children are spawned by the
connector sidecar (`deploy-connector-proxy-1`, uid 65532), so the token store is
`FRESHBOOKS_TOKEN_DIR=/var/lib/openmausbot-connector-proxy/freshbooks` (the
sidecar's rw state bind; `/data` there is owned by `maus` and read-only for the
sidecar). `POST /api/mcp/servers` fails with `EROFS` by design (the
`/run/omb-sidecar` bind is read-only): add a server by editing the three host
files the way `prepare-omb-connector-secrets.py` writes them — secret values only
in `~/.config/openmausbot/authority/sidecar/mcp-secrets.json` (65532, 0600),
placeholder `""` env in `sidecar/connector-config.json` and in the data volume's
`.openmausbot/config.json` — then `docker compose up -d --force-recreate
connector-proxy omb` after a bot-idle check.

One-time setup (operator):

1. Create an app at <https://my.freshbooks.com/#/developer> with redirect URI
   exactly `https://127.0.0.1/freshbooks-callback` (HTTPS is mandatory; the page
   shows "refused to connect" on purpose, the `code=` is read from the address
   bar). One app serves every business.
2. Escrow `client_id` / `client_secret` in 1Password (`Citadel Runtime` →
   `Runtime - FreshBooks OAuth Client`, fields `client_id`, `client_secret`).
3. Authorize each business. FreshBooks reuses the browser session and never
   asks which account: sign out first (or use a private window), sign in as the
   business's owner, then open the authorize URL. Verify the `user.email` in
   the `auth` readback before trusting the alias (three grants landed on the SEED
   owner before the Meridian Row login was used). Aliases in production:
   `meridian-row` (trey@meridianrow.io → Meridian Row LLC `vpEvjV`) and `seed`
   (chadktracy@gmail.com → SEED Creates, LLC `pJ1jl`; SeismIQ `VxGNX5` is on the
   same grant but FreshBooks reports that account inactive, HTTP 402).

```bash
# on the OMB host; credentials come from 1Password over stdin, never argv
printf '%s\n%s\n%s\n' "$CLIENT_ID" "$CLIENT_SECRET" "$CODE" | docker compose exec -T connector-proxy sh -c '
  read CID; read CSEC; read CODE
  export FRESHBOOKS_CLIENT_ID="$CID" FRESHBOOKS_CLIENT_SECRET="$CSEC" \
         FRESHBOOKS_TOKEN_DIR=/var/lib/openmausbot-connector-proxy/freshbooks
  node /custom-mcps/freshbooks-mcp.mjs auth --alias <alias> --code "$CODE"'
```

Recovery: token files live in `~/.local/state/openmausbot-connector-proxy/freshbooks/`
on the host; if lost, repeat step 3 (two minutes per business).

Tools: `freshbooks_list_businesses`, `freshbooks_list_invoices`,
`freshbooks_get_invoice`, `freshbooks_list_clients`, `freshbooks_list_payments`,
`freshbooks_list_expenses`; every call takes `alias`. Refresh tokens are
single-use: the server refreshes single-flight per alias and persists the new
pair atomically before use. Proof of health: `freshbooks_list_businesses`
returns both businesses with `account_id`.
