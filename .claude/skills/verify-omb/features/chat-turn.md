# Chat turn

Send a user message to a bot; a provider turn runs and replies.

## Sub-features
- steer queue: a mid-turn send waits and drains after the turn
- branches: editing a message forks; ‹ › switches versions
- turn artifacts: settle screenshots chain-insert at their turn

## How to get to it (user POV)
Pick a bot in the sidebar, type in the composer, press Enter.

## Driving it
```sh
BOT=$(node scripts/control-omb.mjs new-bot --name Probe | jq -r .id)
node scripts/control-omb.mjs send "$BOT" "hello"
node scripts/control-omb.mjs wait-turn "$BOT"
node scripts/control-omb.mjs transcript "$BOT" --last 5
```
Fake engine replies "hello from fake claude" + one Bash activity chip.

## Gotchas
- A send while busy returns 202 with `queued: true` — that's the steer
  queue, not a failure; the text lands after the turn settles.
- `wait-turn` default timeout is 120s; hang-mode fakes need `interrupt`.
