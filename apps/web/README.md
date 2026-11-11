# @reachinbox/web

Next.js dashboard that follows the Figma ("ONB") screens: login, Scheduled and Sent lists, email detail, compose with Send Later. Cookie session; live status changes over Server-Sent Events.

## Routes

| Route         | Screen                                                                |
| ------------- | --------------------------------------------------------------------- |
| `/login`      | Google OAuth and email + password                                     |
| `/scheduled`  | Scheduled emails: recipient, subject, scheduled time, status, star    |
| `/sent`       | Sent emails: recipient, subject, sent time, Sent / Failed status      |
| `/email/[id]` | Detail: star, archive, delete, attachments, retry for failed sends    |
| `/compose`    | Rich-text compose, lead list upload (shows count), Send Later, limits |

Every list has loading, empty and error states. Toasts report results.

## Files

| Path                             | Role                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `app/(app)/layout.tsx`           | Session guard + toasts + live updates (`AppProvider`) |
| `app/(app)/(mailbox)/layout.tsx` | Sidebar shell for Scheduled / Sent                    |
| `components/MailList.tsx`        | Search, filter, refresh, rows, pagination             |
| `components/RichTextEditor.tsx`  | Toolbar + contentEditable editor                      |
| `components/SlackCard.tsx`       | Connect / disconnect Slack, log out                   |
| `components/UserMenu.tsx`        | Account card with name, email, avatar                 |
| `components/ConfirmDialog.tsx`   | Reusable confirm modal                                |
| `lib/api.ts`, `lib/types.ts`     | API client and shared types                           |
| `lib/format.ts`                  | Date, size and lead-file helpers                      |

Import with the `@/` alias (maps to this folder).

## Run

```bash
pnpm dev     # from repo root: API :4000 + web :3000
```

`WEB_ORIGIN` on the API must match the web origin (CORS + CSRF check).

## Notes

- Next.js version has breaking changes.
- Image: `Dockerfile`.
- API contract: [../../docs/api/openapi.yaml](../../docs/api/openapi.yaml).
