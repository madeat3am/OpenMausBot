# Routines

Scheduled/recurring work, always behind a user confirm card.

## Sub-features
- propose_routine / propose_routine_action (agent-side, card-gated)
- for_bot_id: schedule onto ANOTHER bot (runs under its engine)
- detached execution thread + run receipts

## How to get to it (user POV)
Ask a bot to schedule something; confirm the card it shows. Manage in the
Routines page.

## Driving it
Internal API needs the per-turn comms token (see the fake-claude dump's
mcpConfig in server/index.test.ts "keeps chat-created routines inert").
User-level: `POST /api/routines/:id/run`, `GET /api/routines`.

## Gotchas
- Nothing exists until the card is confirmed — a proposal is not a routine.
- Cloud-destination proposals 409 without a configured runner.
