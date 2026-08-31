# Rooms & channels

Several bots in one thread; bot⇄bot ask/delegate mirrors into channels.

## Sub-features
- @mention routing, room lead, everyone/mentions policies
- ask_bot (sync) and delegate_bot (async ledger with receipts)

## How to get to it (user POV)
New Room from the sidebar, add members, @mention a bot.

## Driving it
`POST /api/groups` then `POST /api/groups/:id/messages` (control-omb has no
room verbs yet — use curl with the same JSON bodies; see server/comms.test.ts
for canonical payloads). Peer traffic: watch for "Messaged @X" activity
chips and the auto-created channel in `GET /api/bots` groups.

## Gotchas
- Busy peers queue as delegations ("asked while busy") instead of bouncing.
- Depth cap: one hop; a delegated turn cannot delegate further.
