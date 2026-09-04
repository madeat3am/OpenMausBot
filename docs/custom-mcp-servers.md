# Bring your own MCP servers

Open **Plugins → MCP servers → Add server** to give your bots tools from a
trusted local MCP server. Add the executable, put each argument on its own
line, and add any environment variables as `KEY=value`.

OpenMausBot saves a new server switched off. Use **Test** to start it briefly,
complete the MCP handshake, and see the tools it advertises. Then turn it on.
It becomes available to compatible bots on their next task; no app restart is
needed.

This first version supports local stdio commands. It deliberately does not
accept remote MCP URLs or shell command strings.

## Advanced: edit the file

The same registry lives in `~/.openmausbot/config.json`:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@example/notes-mcp"],
      "env": { "NOTES_TOKEN": "" }
    }
  }
}
```

Put the corresponding values in an owner-controlled mode-0600 file and set
`OMB_MCP_SECRETS_FILE=/run/openmausbot/mcp-secrets.json`:

```json
{
  "schema": "openmausbot.mcp-secrets.v1",
  "servers": { "notes": { "NOTES_TOKEN": "replace-on-host" } }
}
```

The external value wins over a legacy inline value, and only the selected
server's subtree is passed to that MCP child. Set
`OMB_MCP_INLINE_SECRETS=reject` after migration; in that mode any remaining
inline value makes the server fail closed. Diagnostics expose only
`resolved`, `missing`, or `invalid`.

OpenMausBot resolves those values only in the server and injects one server's
subtree into that MCP child. Codex, Claude, and ACP engines receive a
credential-free localhost proxy and a short-lived policy capability. A
container deployment must additionally deny engine profiles access to the
secret mount, peer process environments, and ptrace; externalizing a value is
not by itself an operating-system boundary.

On the packaged desktop, legacy inline values are copied into Electron
`safeStorage` (`credentials.bin`) before the active JSON values are blanked.
Future Settings writes use the same private utility-process channel and expose
only key names to the renderer and server config. No provider-side rotation is
part of this migration. A separately encrypted 1Password copy may be retained
for recovery, but OMB never reads 1Password at runtime and does not embed its
CLI.

If you edit the file by hand, restart OpenMausBot. Every bot whose engine can
mount custom MCP servers gets the enabled tools on its next task.

## Rules that keep this safe

- **Policy-bounded without approval cards.** Custom tool calls are pre-approved
  only at the engine layer because the OMB proxy already sees the exact server,
  tool, and arguments. A matching `custom-mcp` rule executes; missing, expired,
  malformed, hard-denied, or unmatched authority returns a terminal denial and
  never reaches the provider.
- **Reserved names are refused** (`computer`, `agents`, `composio`,
  `browser`, `phone`, `dweb`, `ogb`, …) so a custom entry can never shadow
  a built-in tool surface. Names are lowercase letters/digits/`_`/`-`, max
  32 chars, starting with a letter.
- **One bad entry never takes the fleet down.** Invalid entries are skipped
  with a logged reason; the rest still mount.
- **Credentials are write-only in the UI.** The API returns environment names,
  never their values. Headless acceptance uses the external file above.
- **Credentials stay out of engines and argv.** Model processes receive only
  proxy routing metadata. The OMB server starts the selected MCP child with a
  small ambient environment plus that server's secret subtree. Legacy direct
  mounting exists only behind `OMB_CUSTOM_MCP_DIRECT_COMPAT=1` for an explicit
  rollback and must not be enabled in the autonomous deployment.
- **Testing is bounded.** The test command is stopped after the handshake (or
  eight seconds), its output is capped, and its stderr is never sent to the UI.
  It inherits none of OpenMausBot's workspace or provider credentials; only
  the environment variables configured for that MCP server are added.
- `"enabled": false` parks an entry without deleting it.
- Stdio servers only for now — `url` transports are a planned follow-up and
  are skipped with a note.
