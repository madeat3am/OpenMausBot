# Connect apps through Composio

OpenMausBot uses one Composio project API key and one reusable Composio Session. That project key is the only Composio credential users need to provide. The Session enables Composio's multi-account mode with explicit account selection, so one OpenMausBot installation can keep several Slack, Gmail, Calendar, or other accounts connected without silently replacing the first one.

## Packaged desktop app

1. Open the [Composio Dashboard](https://dashboard.composio.dev).
2. Select **Platform**, select or create a project, then open **Settings → API Keys**.
3. Copy a project key beginning with `ak_`.
4. In OpenMausBot, open **App Settings → Connections** and save it under **Composio project key**.
5. Open **Connected apps** and choose Gmail, GitHub, Slack, or another service. Authentication happens in your normal browser.
6. To connect another account for the same app, choose **Add account**, give it a unique label such as `work` or `personal`, and finish the second authorization in your browser.

The Connected tab lists every account separately. **Disconnect** revokes only the account named on that row. OpenMausBot requires a label for a second account and configures Composio to require explicit selection when more than one account could run a tool; a new OAuth flow never silently becomes the default for an existing connection.

The desktop app validates the key before saving it. The key is encrypted using Electron's operating-system-backed `safeStorage`; the local JSON configuration stores only the non-secret Composio user and Session identifiers.

## Policy-bounded autonomous actions

Set `OMB_AUTONOMY_POLICY_PATH` to an owner-controlled, read-only policy file matching `openmausbot.autonomy-policy.v1`. The checked-in `autonomy-policy.example.json` contains no account or recipient secrets. Each turn receives a short-lived capability bound to its bot, thread, wake kind, owning routine or trigger, and the policy digest.

Codex and Claude pre-approve only OpenMausBot's guarded connector proxy. The proxy sees the exact nested provider tool, account selection, and arguments before forwarding. Discovery remains available; an action runs only when one exact rule matches. Money, deletion, permission, credential, security, connection-management, remote-shell, and workbench effects fail closed with a structured terminal receipt and no approval card. A mixed `COMPOSIO_MULTI_EXECUTE_TOOL` batch is rejected in full if any nested action is denied.

Missing or invalid policy and expired capabilities deny provider actions. OAuth renewal and other operator-only prerequisites are terminal blockers; connect or repair accounts from **Connected apps**, not from a bot turn. Decision storage contains rule, account alias, tool, argument digest, provider result reference, and outcome, never raw arguments.

## Credential-isolated hosted mode

Hosted deployments can run connector execution in a distinct-UID sidecar. Set `OMB_CONNECTOR_SIDECAR_URL`, mount the same owner-generated `OMB_CONNECTOR_SIDECAR_TOKEN_FILE`, `OMB_AUTONOMY_POLICY_PATH`, and `OMB_AUTONOMY_SIGNING_KEY_FILE` into the server and sidecar, and set `OMB_CONNECTOR_SIDECAR_REQUIRED=1` on the server. Mount `COMPOSIO_API_KEY_FILE`, `OMB_MCP_SECRETS_FILE`, and the connector-only state directory on the sidecar only. Do not expose the sidecar port outside an internal container network.

Set `OMB_EXACT_NONCE_FILE` to a sidecar-owned mode-0600 path in that connector state directory. It preserves single-use capability replay protection across sidecar restarts.

In this mode the OMB container, Codex, Claude, and bot shells receive no Composio or custom-MCP provider credentials. The sidecar independently rechecks policy and exact capabilities before execution, rejects mixed batches atomically, and consumes outbound/operator-exception capabilities once. Provider connection inventory and account-management calls also traverse the private sidecar. The Composio key becomes host-managed; the general settings API refuses to replace it.

## Signed trigger wakes

The hosted surface accepts Composio V3 trigger callbacks at `POST /api/webhooks/composio` when `COMPOSIO_WEBHOOK_SECRET` or `COMPOSIO_WEBHOOK_SECRET_FILE` is configured. It verifies the standard raw-body signature and timestamp with a five-minute tolerance, deduplicates stable event/log ids for 30 days, and suppresses unchanged material for 24 hours. Exact trigger-to-bot routes come from the autonomy policy.

A callback is a wake, not source truth. Its bot is explicitly instructed to re-read the connected application before acting. If the published OMB address cannot receive this route, ingress is a deployment prerequisite; do not add a polling service or another broker.

## Scoped key permissions

A default project API key works without additional configuration. For a least-privilege scoped key, grant:

- **Sessions:** read and write
- **Toolkits:** read
- **Connected accounts:** read and write

Connected-account write access is required so **Disconnect** can revoke the upstream provider grant before removing the connection.

## Running from source

Set the key in the server environment:

```sh
COMPOSIO_API_KEY=ak_your_project_key pnpm dev:server
```

The browser-only development UI can also save a key to the owner-only `~/.openmausbot/config.json` file. Using the environment variable is preferred for headless and shared development machines.

OpenMausBot creates a stable random user identifier for the installation, stores the returned Session identifier, and reuses that Session across launches. No Gmail, GitHub, Slack, or other provider tokens are stored by OpenMausBot; Composio owns their connection lifecycle.

Sessions created by older OpenMausBot versions are upgraded in place by creating a multi-account Session for the same stable Composio user. Connected accounts belong to that user, so existing grants remain available while the new Session adds explicit multi-account routing. Each toolkit is capped at five usable accounts.

## Multiple Google and Slack accounts

Yes. Gmail, Google Calendar, Google Drive, and the other Google toolkits can each hold multiple labeled authorizations, and Slack can hold multiple labeled workspace/account authorizations. Accounts are scoped to the OpenMausBot installation's stable Composio user and appear by alias and connected-account ID in **Connected apps**.

If a provider or restricted Composio project policy prevents another authorization, the safe fallback is a separate OpenMausBot installation/configuration with its own Composio user. Re-authorizing the same single-account Session is not a safe workaround: it can change which grant is selected. Do not share raw provider tokens or place them in bot prompts.

The hosted/managed connected-apps broker exposes the same account-aware response shape and account-specific removal routes as the self-hosted project-key mode; it does not send broker or provider credentials to the renderer.

## Renderer-neutral connection inventory

Desktop, web, and mobile clients can load the complete account inventory in one request:

```http
GET /api/connectors/connected
```

```json
{
  "configured": true,
  "services": {
    "gmail": {
      "connected": true,
      "pending": false,
      "status": "ACTIVE",
      "accounts": [
        { "id": "ca_123", "alias": "work", "status": "ACTIVE" }
      ]
    }
  }
}
```

This operation cursor-paginates both the Session toolkit state and the user's connected accounts directly. It merges no-auth toolkits and the Session-selected account with the full multi-account inventory, without deriving service slugs from marketplace cards, so account visibility is independent of catalog ordering and pagination. If a scoped project key can read the Session but cannot list raw connected accounts, the response safely falls back to the Session-selected and no-auth toolkit inventory rather than making those services appear disconnected. The managed broker provides the same behavior and response at `GET /v1/connectors/connected`; the local server adds the normal `configured: false` empty response when no connection service is configured. Responses expose only connected-account IDs, user-supplied aliases, and lifecycle status—never project keys, broker tokens, provider tokens, or write-only authorization fields.

The existing scoped `GET /api/connectors?services=gmail,slack` operation remains available for lightweight post-OAuth polling and backward compatibility.
