# OpenMausBot feature map (dev/verification)

Driveable features of the harness server, from a user's point of view.
One file per feature; each has `Sub-features`, `How to get to it (user
POV)`, `Driving it`, and `Gotchas`.

- [chat-turn.md](chat-turn.md) — send a message, run a turn, read the reply
- [rooms.md](rooms.md) — multi-bot rooms and bot⇄bot channels
- [routines.md](routines.md) — scheduled work with confirm cards
- [engines.md](engines.md) — instances, custom ACP engines, model selection
- [custom-mcp.md](custom-mcp.md) — user-configured MCP servers
- [skills.md](skills.md) — bundled + user skills mounting into turns

Renderer-only surfaces (browser tab, settings UI, VM panel) need the
desktop app and are out of headless scope — verify those parts by test
suite + note the gap.
