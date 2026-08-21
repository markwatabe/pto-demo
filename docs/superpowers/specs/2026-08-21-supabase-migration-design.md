# Supabase Migration Design

**Date:** 2026-08-21
**Status:** Approved (research done in-session; Supabase chosen over Convex/Firebase/PocketBase)

## Why

InstantDB is shutting down. The app needs a replacement for **both** auth and database.
Supabase was chosen because it is the closest fit with the least new code:

- `signInWithOtp` / `verifyOtp` is a near 1:1 swap for Instant's magic-code flow.
- The relational schema (families → parents/children → teachers) maps directly to
  Postgres tables with foreign keys, queried client-side via `supabase-js` nested selects.
- Row Level Security replaces `instant.perms.ts`; the service-role key replaces
  `@instantdb/admin` for the seed script.
- Open source, self-hostable, mature — low shutdown risk.

## Requirements

1. **Auth:** Email + 6-digit code sign-in, same two-step UX as today (`Login.tsx`).
   Signed-in state gates all routes (`App.tsx`); sign-out in the sidebar (`AppLayout.tsx`).
2. **Data:** Family directory with nested parents, children, each child's current
   teacher and past teachers — one client-side query, no backend server.
3. **Permissions:** Directory readable only by signed-in (authenticated) users.
   No client-side writes; all writes go through the seed script using the secret key.
4. **Seeding:** `pnpm seed` stays idempotent — wipes and recreates 50 families,
   teachers K–5 (3 per grade), parents, children, past-teacher links.
5. **No InstantDB code or dependencies remain** at the end.

## Data model (Postgres)

| Table | Columns | Notes |
|---|---|---|
| `families` | `id uuid pk`, `name text` | indexed on `name` |
| `teachers` | `id uuid pk`, `first_name`, `last_name`, `grade smallint` | K stored as 0 |
| `parents` | `id uuid pk`, `family_id fk → families (cascade)`, `first_name`, `last_name`, `email`, optional `street/city/state/zip/home_phone/work_phone/mobile_phone` | |
| `children` | `id uuid pk`, `family_id fk → families (cascade)`, `current_teacher_id fk → teachers`, `first_name`, `last_name`, `birth_date date` | |
| `child_past_teachers` | `child_id fk (cascade)`, `teacher_id fk (cascade)`, composite pk | many-to-many join |

Postgres uses snake_case; the React code keeps camelCase via supabase-js select
aliases (`firstName:first_name`), so `Directory.tsx` render code is untouched.

## RLS policy

Every table: RLS enabled, one `SELECT` policy for role `authenticated`, no
insert/update/delete policies (service role bypasses RLS for seeding).

## Auth flow

- Send: `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`
- Verify: `supabase.auth.verifyOtp({ email, token, type: 'email' })`
- Session: `useAuth()` hook wrapping `getSession()` + `onAuthStateChange`.
- Dashboard config: "Magic Link" and "Confirm signup" email templates changed to
  send `{{ .Token }}` (the 6-digit code) instead of `{{ .ConfirmationURL }}`.
- Supabase's built-in mailer is rate-limited (~2–4 emails/hour) — fine for demo;
  custom SMTP (e.g. Resend) is a later production step, out of scope here.

## Environment variables

| Var | Exposure | Used by |
|---|---|---|
| `VITE_SUPABASE_URL` | public | client + scripts |
| `VITE_SUPABASE_ANON_KEY` | public (publishable) | client + RLS verification |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | `scripts/seed.ts`, `scripts/verify-rls.ts` |

Replaces `VITE_INSTANT_APP_ID` / `INSTANT_ADMIN_TOKEN`.

## Out of scope

- Realtime subscriptions (the directory is read-only; a page load fetch is enough).
- Custom SMTP, production email deliverability.
- Supabase CLI local dev / migration tooling — schema is applied once via the
  SQL editor from a committed `supabase/schema.sql`.
- The Calendar/Forms/OurPto pages (they don't touch the database).
