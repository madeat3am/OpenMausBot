# Custom MCP servers

User-configured stdio MCP servers mounted into every capable engine,
permission-carded by default.

## How to get to it (user POV)
`"mcpServers"` section in config.json; restart; tools appear to bots.

## Driving it
Configure in the isolated $TMP config, run a turn, then read the engine's
dump: claude → mcp-config file must contain the server but NOT its
`mcp__<name>` in --allowedTools (that's the carding).

## Gotchas
- Reserved names (computer/agents/composio/…) are skipped with a logged
  teaching line — absence from a dump may mean a name collision, not a bug.
- stdio only; url entries skip with a note.
