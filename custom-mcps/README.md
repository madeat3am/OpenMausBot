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

One-time setup (operator):

1. Create an app at <https://my.freshbooks.com/#/developer> with redirect URI
   exactly `https://127.0.0.1/freshbooks-callback` (HTTPS is mandatory; the page
   404s on purpose, the `code=` is read from the address bar). Scopes: read
   invoices, clients, payments, expenses, user profile.
2. Escrow `client_id` / `client_secret` in 1Password (`Citadel Runtime` →
   `Runtime - FreshBooks OAuth Client`) and register the server in OMB with
   those two env values plus `FRESHBOOKS_TOKEN_DIR=/data/.openmausbot/freshbooks`.
3. Authorize each business inside the container:

```bash
docker compose exec omb node /custom-mcps/freshbooks-mcp.mjs auth-url
# open the URL logged in as that business's FreshBooks user, approve, copy code=
docker compose exec omb node /custom-mcps/freshbooks-mcp.mjs auth --alias meridian-row --code <code>
docker compose exec omb node /custom-mcps/freshbooks-mcp.mjs auth --alias seed --code <code>
docker compose exec omb node /custom-mcps/freshbooks-mcp.mjs whoami
```

(`docker compose exec` needs the same `FRESHBOOKS_*` env the server gets; pass
`-e` flags or run through the app's MCP once tokens exist.)

Tools: `freshbooks_list_businesses`, `freshbooks_list_invoices`,
`freshbooks_get_invoice`, `freshbooks_list_clients`, `freshbooks_list_payments`,
`freshbooks_list_expenses`; every call takes `alias`. Refresh tokens are
single-use: the server refreshes single-flight per alias and persists the new
pair atomically before use. Proof of health: `freshbooks_list_businesses`
returns both businesses with `account_id`.
