# Assignment brief kept with the submission

Source: ReachInbox Software Development Intern Assignment and Software Development Engineer Internship pages (reviewed 28 October 2026).

## Product requirements

- Full stack email scheduler: accept API requests, schedule a future send, send through Ethereal fake SMTP, and preserve work across restarts.
- Use TypeScript, Express, BullMQ + Redis, and PostgreSQL/MySQL. Frontend: React or Next.js and modern CSS.
- Support multiple senders, configurable concurrency, minimum spacing between individual sends, and configurable hourly caps enforced safely across workers/instances. At capacity, keep jobs and move them into the next available hourly window.
- A live BullMQ dashboard, Elasticsearch-backed search, Google OAuth, Slack OAuth with a live notification on rate-limit hit, and disconnect/reconnect behavior.
- Dashboard: user profile/logout, scheduled/sent views, compose form, CSV/text recipient import and address count, start time, delay, hourly cap, loading/error/empty states.
- Idempotency and restart persistence are hard requirements; do not use cron.
- Submission material: setup/run instructions, architecture and scaling decisions, features mapped to the brief, demo checklist, assumptions/trade-offs. Private GitHub repo and reviewer access are submission steps for the candidate.

## Role signals

The internship page emphasizes full stack work, Node.js, MySQL, TypeScript, JavaScript, Git, API design/documentation, React, Tailwind/modern CSS, and good-to-have cloud, Docker, Kubernetes, database optimization, and microservices experience. The implementation and architecture notes prioritize those skills while keeping PostgreSQL (explicitly allowed by the assignment) as the relational store.

## Run-through checklist for the candidate

1. Configure Google, Slack, and Ethereal credentials locally.
2. Demonstrate Google sign-in, CSV import, and delayed campaign scheduling.
3. Show the scheduled and sent lists plus a search.
4. Demonstrate one Slack notification by temporarily setting a low sender hourly cap.
5. Stop and restart API/worker while future jobs are pending; confirm they remain queued and send.
6. Record a demo under five minutes, then submit the private repository link with reviewer access using the assignment’s form.
