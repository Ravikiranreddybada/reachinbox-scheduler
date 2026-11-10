# Assignment brief kept with the submission

Single source of truth for the ReachInbox assignment. Keep this file updated as work moves.

Sources (reviewed 10 November 2026):

- Assignment: https://sumptuous-word-80f.notion.site/Software-Development-Intern-Assignment-2bc1596f45e88080995cec1180a2bc60
- Job page: Software Development Engineer - Internship (ReachInbox / Outbox Labs, Notion)
- Figma: https://www.figma.com/design/kOTwGlESjijCYnMgtHfvfU/Outbox-Labs-Assignment
- Submission form: https://forms.clickup.com/9005062261/f/8cbwp3n-8876/6NNNJ92DV93PQTAYST

Note: full text verified against the complete assignment text pasted by the candidate (10 November 2026).

## Deadline and rules

- Maximum 48 hours to complete the task.
- No plagiarism. All GitHub code is reviewed. Plagiarism = rejection.

## Problem statement

Build a production-grade email scheduler service + dashboard:

- Accept email send requests via API.
- Schedule send at a specific time.
- BullMQ + Redis as persistent scheduler. No cron.
- Send through fake SMTP (Ethereal Email).
- Survive restarts: no lost jobs, no restart from scratch.
- Frontend dashboard: schedule new emails, view scheduled, view sent.

## Tech requirements

- Backend: TypeScript, Express.js, BullMQ (Redis), MySQL or PostgreSQL (ORM/query builder free), Ethereal SMTP.
- Frontend: React.js or Next.js, Tailwind CSS or modern CSS library, TypeScript preferred.
- Infra: Redis + DB via Docker recommended, not mandatory.
- They judge: real backend structure, correct queue wiring, clean frontend.

## Backend requirements

### 1. Core scheduler

- Accept scheduling requests via API.
- Store in relational DB.
- Schedule with BullMQ delayed jobs (or custom Redis/DB scheduler). No cron.
- Send from multiple senders via Ethereal SMTP.
- Sent/scheduled emails searchable via Elasticsearch (index them).
- Live BullMQ dashboard for real-time queue visibility.
- After restart, future emails still send at correct time.
- No duplicates, no restart from scratch.

### 2. Throughput, rate limiting, concurrency

- Worker concurrency: configurable. Safe when jobs run in parallel.
- Delay between individual sends (mimic provider throttling): BullMQ limiter or custom worker delay. Document the chosen delay in README (e.g. min 2 s).
- Emails per hour: global (MAX_EMAILS_PER_HOUR=200) or per sender/tenant (MAX_EMAILS_PER_HOUR_PER_SENDER). Multiple senders required. Values from env/config, no hardcoding.
- Must be safe across multiple workers / instances. Use Redis or DB counters (key: hour_window + sender). Not in-memory only.
- Do not drop or permanently fail jobs. Move to next available hour window, keep order as much as possible.
- README: explain approach (BullMQ limiter, Redis counters, custom logic, trade-offs).
- Slack integration:
  - User clicks "Connect Slack" in dashboard, real OAuth authorize flow, backend stores token/webhook per user/tenant.
  - Send a real Slack message the moment a sender hourly limit is reached. Must be live and verifiable in demo, not a log line.
  - Disconnect/reconnect: Slack not connected = no notification, no crash. Connect later = works without redeploy.
- Behavior under load: define behavior for 1000+ emails at about the same time, and for rate limit exceeded. No need to send thousands via Ethereal, but logic must handle it.

### 3. Hard constraints (non-negotiable)

- No OS cron. No Node cron libs (node-cron, agenda).
- Use BullMQ delayed jobs, or custom Redis/DB next-run scheduler (not cron).
- Future emails send at right time.
- No re-send / no restart from day 1.
- Idempotency: same email never sent more than once.

## Frontend requirements

Match the Figma as closely as possible. Talk to own backend APIs.

1. Google login: real OAuth, no mock. Redirect to dashboard after login. Show name, email, avatar. Logout.
2. Main dashboard: top header (user info + logout), tabs/sections for Scheduled Emails and Sent Emails, primary "Compose New Email" button. Layout and styling closely follow Figma.
3. Compose: subject, body, upload a CSV/text file of email leads (parse and show number of addresses detected), start time (when scheduling begins), delay between emails, hourly limit, Schedule button posts to backend schedule API. Modal or separate page per Figma.
4. Scheduled list: email, subject, scheduled time, status. Loading state, empty state.
5. Sent list: email, subject, sent time, status (sent/failed). Loading state, empty state.
6. Code quality: clean folders, reusable components (buttons, inputs, tables, modals), DRY, types for API responses/props, loading indicators, empty states, error handling (messages/toasts).

## Submission guidelines

1. Private GitHub repo (monorepo or separate backend/frontend folders). Grant access to: **Mitrajit** and **Yadav036**.
2. README must cover:
   - How to run backend (Express, Redis, DB, BullMQ worker).
   - How to run frontend.
   - How to set up Ethereal and env vars.
   - Architecture overview: how scheduling works, how persistence on restart works, how rate limiting + concurrency work.
   - Features done: backend (scheduler, persistence, rate limiting, concurrency), frontend (login, dashboard, compose, tables).
3. Short demo video, **max 5 minutes** (show):
   - Create scheduled emails (frontend or Postman).
   - Dashboard with Scheduled and Sent.
   - Stop server, start again, future emails still send.
   - Bonus: rate limiting / delay under load.
4. Note assumptions, shortcuts, trade-offs.
5. Fill the ClickUp submission form with links and details.

## Role signals (job page)

- Role: Software Development Engineer Intern, full stack. Stipend INR 30,000-40,000, internship with PPO, 6 months to 1 year, Remote / HSR Layout Bangalore, start within 15 days.
- Must have: NodeJS, MySQL, TypeScript, JavaScript, Git, portfolio, API design and documentation, React.js or Next.js, Tailwind CSS.
- Good to have: AWS/Azure, Docker, Kubernetes, database optimization, microservices.
- Application: CV + photo ready, link to previous internship company sites, live hosted project links, full stack portfolio.
- This repo keeps PostgreSQL (allowed by the assignment) as relational store.

## Run-through checklist for the candidate

1. Configure Google, Slack, and Ethereal credentials locally.
2. Demonstrate Google sign-in, CSV import, and delayed campaign scheduling.
3. Show the scheduled and sent lists plus a search.
4. Demonstrate one Slack notification by temporarily setting a low sender hourly cap.
5. Stop and restart API/worker while future jobs are pending; confirm they remain queued and send.
6. Record a demo (max five minutes), then submit the private repo link with reviewer access via the form.

## Status tracker

Fill in as work is verified. Audited against the repo on 10 Nov 2026.

| Item                                                                                            | Status                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| API schedule + Postgres store                                                                   | verified 10 Nov 2026 (real stack)                                                              |
| BullMQ delayed jobs, no cron                                                                    | verified 10 Nov 2026 (jobs use delay; no cron libs; reconciler uses setInterval + leader lock) |
| Ethereal SMTP, multiple senders                                                                 | verified 10 Nov 2026 (sent via worker)                                                         |
| Restart persistence                                                                             | verified 10 Nov 2026 twice (kill -9 API+worker; future emails sent on time, attempts=1)        |
| Idempotency                                                                                     | covered by integration tests                                                                   |
| Worker concurrency (env)                                                                        | verified 10 Nov 2026 (WORKER_CONCURRENCY, default 8; 37 integration tests pass)                |
| Min delay between sends (documented)                                                            | verified 10 Nov 2026 (MIN_SEND_INTERVAL_MS=2000, in README config table)                       |
| Hourly cap per sender, Redis counters, next-window reschedule                                   | verified 10 Nov 2026 (Lua counters; integration tests; live Slack alert)                       |
| Elasticsearch indexing + search                                                                 | verified 10 Nov 2026 (index = Postgres; fuzzy "restrt" finds "Restart demo" in UI)             |
| Live BullMQ dashboard                                                                           | verified 10 Nov 2026 (/admin/queues shows email-delivery, search-sync; 403 for non-admin)      |
| Google OAuth + profile + logout                                                                 | verified 10 Nov 2026 (real Google login, dashboard redirect, name+avatar+email, logout)        |
| Slack OAuth + live rate-limit message + disconnect/reconnect                                    | verified 10 Nov 2026 (check Slack channel once)                                                |
| Compose form (CSV/text, count, start, delay, cap)                                               | verified in browser 10 Nov 2026                                                                |
| Scheduled + Sent tables with loading/empty/error                                                | verified in browser 10 Nov 2026                                                                |
| Matches Figma                                                                                   | verified 10 Nov 2026 (compose, Send Later, lists); login page matches                          |
| Repository verification (format, unit + integration tests, typecheck, builds, Prisma schema)    | verified 10 Nov 2026 (`pnpm verify`, `pnpm test:integration`, `prisma validate`)               |
| Quota hardening (sliding window, refund, Redis-loss rebuild, global cap, no resend after crash) | verified 10 Nov 2026 (77 tests pass: 34 unit, 43 integration on real Redis + Postgres)         |
| README (run, Ethereal, architecture, features, trade-offs)                                      | done 10 Nov 2026 (added Features done + Assumptions)                                           |
| Demo video                                                                                      | todo (owner: you)                                                                              |
| Private repo + access for Mitrajit, Yadav036                                                    | repo is private; add collaborators (owner: you)                                                |
| ClickUp form submitted                                                                          | todo (owner: you)                                                                              |
