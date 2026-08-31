# Skills

Bundled skills (repo skills/) + user skills (~/.openmausbot/skills) mount
into turns by trigger terms and capabilities.

## How to get to it (user POV)
Just type a trigger ("/create-verification-skill …"); the bot receives the
skill's instructions that turn.

## Driving it
Send trigger text via control-omb, then assert in the engine dump's
--append-system-prompt for `<openmaus-skill id="…">` tags (pattern:
index.test "mounts the verification skill into a real turn").

## Gotchas
- Selection is substring on lowercased text — generic trigger terms
  over-mount; test both directions when adding one.
- User skills hot-load per turn; bundled skills load at boot.
