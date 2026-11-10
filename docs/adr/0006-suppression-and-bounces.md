# ADR 0006 — Suppression list, unsubscribe and hard bounces

Status: accepted.

## Context

A cold-email sender that keeps mailing people who unsubscribed, complained, or bounced harms deliverability and breaks the law in many places. The scheduler had no way to stop.

## Decision

- A per-user `Suppression` table (`UNSUBSCRIBE`, `BOUNCE`, `COMPLAINT`), unique per user and address.
- Every email carries a signed unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers. A GET shows a confirm page; only a POST unsubscribes (mail scanners prefetch links). The token is an HMAC of the email ID and can do nothing else.
- Adding an address cancels that user's unclaimed emails to it, and the worker checks the list again before every send, before pacing and quotas are charged.
- An SMTP 5xx is permanent: the email fails at once with no retry. 550, 551, 553 and 554 also add a `BOUNCE` suppression.
- Complaints enter through `POST /api/suppressions`, the hook a provider webhook would call.

## Consequences

- Suppressed recipients cost no quota and no SMTP call.
- Ethereal sends no asynchronous bounce messages, so only synchronous rejections are handled.
