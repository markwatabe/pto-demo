# Google Calendar Sync — Design

**Date:** 2026-09-03
**Status:** Approved (design agreed in-session)
**Builds on:** `2026-09-01-green-team-pivot-design.md` (merged to main)

## Why

Families live in Google Calendar. The PTO owns a Google Calendar that mirrors the
Green Team schedule; the app pushes to it on demand. Chosen over an iCal feed and
add-to-calendar links for the native Google experience.

## Decisions (made by the user)

1. **Sync to a shared, PTO-owned Google Calendar** via the Calendar API with a
   service account (no OAuth screens).
2. **Button-only trigger:** admins press "Sync Google Calendar" on the Schedule
   page. No automatic or scheduled sync (easy later addition).

## Architecture

The SPA can never hold Google credentials, so sync runs in a **Supabase Edge
Function** — the project's first server-side code:

```
Admin browser ── supabase.functions.invoke('sync-google-calendar') ──▶ Edge Function
                                                                        │ 1. verify caller is an app admin
                                                                        │ 2. read schedule (service role)
                                                                        │ 3. service-account JWT → Google token
                                                                        ▼
                                                              Google Calendar API (diff sync)
```

## One-time Google setup (manual, by the user)

1. Google Cloud console: create a project (e.g. `pto-green-team`), enable the
   **Google Calendar API**, create a **service account**, create a JSON key.
2. In Google Calendar (PTO account): create a calendar (e.g. "Fiske Green Team"),
   share it with the service-account email with **"Make changes to events"**, and
   copy the **Calendar ID** from its settings. Share the calendar with families
   however desired (public/link) — read access is independent of the sync.
3. In the Supabase dashboard (Edge Functions → Secrets), set:
   - `GOOGLE_SA_EMAIL` — the service account's email
   - `GOOGLE_SA_PRIVATE_KEY` — the `private_key` field from the JSON key (the
     full PEM including BEGIN/END lines; newlines may be literal `\n`)
   - `GOOGLE_CALENDAR_ID` — the calendar ID

Credentials never enter git or the browser bundle.

## Edge Function: `supabase/functions/sync-google-calendar/index.ts`

Deno runtime, deployed with `verify_jwt` on (Supabase rejects anonymous calls
before the function runs). Behavior:

1. **CORS:** answers `OPTIONS` preflight; all responses carry CORS headers (the
   button calls it from the browser).
2. **Admin gate:** resolves the caller from the request's `Authorization` JWT
   (`auth.getUser`), then checks the `admins` table with the service-role client.
   Non-admins get 403.
3. **Load schedule** (service role): `school_year` (400 with a clear message if
   unset — the sync window is the school year), `green_team_shifts` in
   `[starts_on, ends_on]` with assignments → volunteer names, `school_closures`.
4. **Google access token:** builds a service-account JWT (`RS256`, WebCrypto
   `importKey` of the PKCS#8 PEM; claims `iss` = SA email, `scope` =
   `https://www.googleapis.com/auth/calendar`, `aud` =
   `https://oauth2.googleapis.com/token`, 1h expiry) and exchanges it at the
   token endpoint.
5. **Diff sync (idempotent):** every managed event carries
   `extendedProperties.private = { managedBy: 'pto-demo', ptoKey }` where
   `ptoKey` is the shift id or `closure-<date>`.
   - List ALL existing managed events
     (`privateExtendedProperty=managedBy=pto-demo`, paginated, no time bounds —
     so events from a shrunk or shifted school year still get cleaned up).
   - Desired set: shifts → timed events (`America/New_York`,
     11:30–12:30 / 12:30–13:30), summary `"Green Team: <names sorted, ', '>
     (Early|Late)"` or `"Green Team: unfilled (…)"`; closures → all-day events
     `"No school · <reason>"` / `"No school"`.
   - Create missing, patch events whose summary or times differ, delete managed
     events with no matching `ptoKey`. Unmanaged events on the calendar are never
     touched.
   - No changes ⇒ no writes (re-run is a no-op).
6. **Response:** `{ created, updated, deleted, total }` on success; 4xx/5xx JSON
   `{ error }` otherwise (missing secrets, Google errors surfaced with status).

## UI: Schedule page

A "Google Calendar" card on `/admin/schedule` with one button — **Sync Google
Calendar** — using the page's established busy/notice/error patterns:
`supabase.functions.invoke('sync-google-calendar')`; success renders the counts
("Synced: 12 created, 3 updated, 1 removed"), failure surfaces the function's
error message. No other pages change.

## Deployment & verification

- Function deployed via the Supabase MCP (`deploy_edge_function`); redeploys are
  idempotent.
- Static: `pnpm typecheck` + `pnpm build` (the Deno function sits outside
  tsconfig; its gate is review plus live invocation).
- Live: after the user completes the Google setup and secrets — sync with real
  data, verify events in Google Calendar, re-sync (expect 0/0/0), adjust one
  shift and re-sync (expect 1 updated), non-admin invoke rejected.

## Out of scope (YAGNI)

Per-volunteer private calendars, Google→app reverse sync, attendee
invites/notifications, scheduled auto-sync, multi-calendar support, deleting the
whole calendar's contents (only `managedBy=pto-demo` events are ever modified).
