# ReachInbox project rules

## Scope: assignment only, never production

- This is an interview assignment. It runs locally. It will NOT go to production.
- Do not add production work: no hosting, deploy steps, prod env values, prod URLs, scaling or hardening beyond what the brief asks.
- Do not suggest "for production, do X". Skip it.
- Demo uses localhost, Ethereal SMTP, Docker Postgres/Redis/Elasticsearch.

## Browser testing

- Never ask permission to use the Chrome browser (or Playwright) on localhost for this project. Just use it.
- This overrides the global rule that says to ask first.
- Still never type real passwords or 2FA codes. The user does Google login.

## Read the brief first

Before any plan, feature, change, or "what is next" answer, read the brief:

@docs/project/assignment-brief.md

- The brief is the single source of truth for requirements, rules, and submission steps.
- Judge every idea against it. If it is not in the brief, it is out of scope unless the user asks.
- Re-read it when you are unsure, when the user asks for status, and before you tell the user a task is done.
- Hard rules from the brief: no cron, BullMQ delayed jobs, no duplicate sends, survive restarts, limits from env.
- When work is verified, update the Status tracker table in the brief.
