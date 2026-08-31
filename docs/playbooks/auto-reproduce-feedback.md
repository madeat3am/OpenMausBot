# Playbook: auto-reproduce user feedback

Turn incoming user reports into reproduced, evidenced findings — without a
human in the loop until there's something real to look at.

## Ingredients (all shipped)

- a **webhook** delivering feedback into a bot's thread (Slack/a form/anything
  that can POST) — the webhook receiver runs on 127.0.0.1:8800
- a **verification skill** for your app — ask any bot:
  `/create-verification-skill for <your app>` (it generates the skill, the
  feature map, and offers the maintenance routine)
- a bot with the right **surface**: browser for web apps, a cloud/Local VM
  computer for desktop apps, the phone harness for Android

## The loop

1. Feedback arrives → the bot's turn starts with the report text.
2. The bot's standing instructions (persona or a routine) say: *"For every
   incoming report, use the verify-<app> skill: doctor first, then follow
   the feature map to the reported area, attempt to reproduce exactly what
   the user described, and capture evidence either way."*
3. Outcome lands in chat:
   - **Reproduced** — steps + screenshots/transcript, feature-map entry
     that covers it, ready for a fix task.
   - **Not reproduced** — what was tried, on which paths, with evidence,
     so a human triages with facts instead of vibes.
4. Optional escalation: the bot delegates the fix to a coder bot
   (`delegate_bot`) and the fix turn re-runs the same verification as its
   own proof.

## Why this works here

The reproduction quality is exactly the quality of the verification skill —
keep `/maintain-verification-skill` on its daily routine so drive recipes
never go stale. Every claim carries evidence because the skill's Evidence
rules demand it; a report the bot cannot reproduce is still valuable
because the map shows what WAS checked.

## Trust boundaries

Feedback text is untrusted input. The bot acts under its normal permission
cards; auto-fix without review is a choice you make per bot (auto mode),
not a default. Destructive repro steps (deleting data, sending messages)
must stop at a card.
