# Admin Approval for New Sign-ups — Design

**Date:** 2026-08-21
**Status:** Approved (design agreed in-session; waiting-room UX, admins table with seeded first admin, profiles + DB trigger)
**Builds on:** `2026-08-21-supabase-migration-design.md` (branch `supabase-migration`, unmerged)

## Why

After the Supabase migration, `shouldCreateUser: true` plus a read-for-any-authenticated-user
RLS policy means anyone with any email can sign up and read the whole family directory.
Before the app holds real family data, new sign-ups must be approved by a PTO admin.

This also introduces the **admin role** the July volunteers/CORI spec wanted, rebuilt on
Supabase. When that feature is revived, its `adminRoles` entity is superseded by this
spec's `admins` table.

## Decisions (made by the user)

1. **Waiting room:** anyone can complete email-code sign-in, but unapproved users land on
   a "waiting for approval" screen and RLS hides all directory data until approved. No
   Edge Functions; approval is a client-side `UPDATE` by an admin.
2. **Admins table + seeded first admin:** an `admins` table keyed to `auth.users`; admins
   approve sign-ups and grant/revoke admin. The seed script bootstraps the first admin
   from an `ADMIN_EMAIL` env var.
3. **profiles + DB trigger:** a trigger on `auth.users` insert creates a
   `profiles(status='pending')` row at sign-up time — the pending record exists even if
   the user closes the tab.

## Schema (added to `supabase/schema.sql`)

```sql
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users (id)
);

create table admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users (id)
);
```

Helper functions — `security definer` so RLS policies can call them without recursion,
`stable`, `set search_path = public`:

- `is_admin()` — true iff an `admins` row has `user_id = auth.uid()`.
- `is_approved()` — true iff own profile has `status = 'approved'` **or** `is_admin()`
  (an admin never waits in their own waiting room).

Trigger — `handle_new_user()` (`security definer`, plpgsql): `after insert on auth.users`,
inserts `profiles (id, email)` with `on conflict (id) do nothing`.

The schema file stays idempotent drop-and-recreate. Re-running it wipes approval state;
`pnpm seed` re-bootstraps the admin. Acceptable for a demo; noted in the file's header
comment.

## RLS

| Table | select | insert | update | delete |
|---|---|---|---|---|
| families, teachers, parents, children, child_past_teachers | `is_approved()` (replaces `using (true)`) | — | — | — |
| profiles | own row (`id = auth.uid()`) or `is_admin()` | — (trigger bypasses RLS) | `is_admin()` (the approve action) | — |
| admins | own row (`user_id = auth.uid()`) or `is_admin()` | `is_admin()` | — | `is_admin() and user_id <> auth.uid()` (no self-revoke, enforced at the DB) |

All policies `to authenticated`. The service-role key bypasses RLS for seeding.

## Bootstrap (seed script)

`ADMIN_EMAIL` is a new **required** env var (added to `.env.example`). `pnpm seed`:

1. Finds the auth user by email via `auth.admin.listUsers()`; if absent, creates it with
   `auth.admin.createUser({ email, email_confirm: true })`.
2. Upserts their `profiles` row with `status='approved'`.
3. Upserts their `admins` row.

Seed does **not** wipe `profiles`/`admins` (real users, not demo data) — the clear list
stays the five directory tables. `verify-rls` adds `profiles` and `admins` to its checks
(anon sees 0; service role sees ≥ 1 after seeding, so the existing `> 0` assertion works).

## Client

- **`src/access.ts` — `useAccess()`** (new): wraps `useAuth()`; when signed in, fetches
  own profile and own admins row in parallel. Returns
  `{ isLoading, user, status: 'pending' | 'approved' | null, isAdmin, refresh() }`.
  `refresh()` re-runs the fetch (used by the waiting room's "Check again" button).
  A signed-in user whose profile row is missing or errored is treated as `pending`
  (fail closed).
- **`src/pages/Waiting.tsx`** (new): "Your account is waiting for PTO admin approval."
  + Check again (calls `refresh`) + Sign out. Shown for every route while pending.
- **`src/App.tsx`**: uses `useAccess()` instead of `useAuth()`. Signed-in + pending →
  Waiting page for all routes; approved → existing routes; `/admin` route added,
  rendering `AdminPage` for admins and a redirect to `/directory` otherwise.
- **`src/components/AppLayout.tsx`**: takes an `isAdmin` prop from App; shows an "Admin"
  nav item only when true.
- **`src/pages/Admin.tsx`** (new, route `/admin`): three sections, plain fetch-and-refresh
  after each action (no realtime):
  - **Pending sign-ups** — profiles with `status='pending'` ordered by `requested_at`;
    Approve button → `update profiles set status='approved', approved_at=now(),
    approved_by=auth.uid()`.
  - **Members** — approved profiles, read-only list.
  - **Admins** — current admins; grant-by-email (looks up `profiles` by email; if none:
    "No account with that email has signed in yet."); Revoke button on every admin except
    yourself (the DB policy also blocks self-revoke).
- **Unchanged:** `Login.tsx`, `Directory.tsx`, `src/auth.ts`, `src/supabase.ts` — RLS does
  the data gating.

## Error handling

- All supabase calls in Admin/Waiting surface `error.message` via the existing `Alert`
  atom pattern; actions disable their button while in flight.
- `useAccess` treats a missing profile row as pending, never as approved.

## Out of scope (YAGNI)

Reject/ban states (admins simply don't approve), deleting auth users, email
notifications, self-service profile editing, realtime admin-page updates, pagination
(a school's sign-up volume doesn't need it).

## Verification

- Static: `pnpm typecheck`, `pnpm build`.
- `pnpm verify:rls` extended with the two new tables.
- Live pass (needs the Supabase project): sign up with a fresh email → waiting room;
  approve from the admin account → Check again → directory visible; grant/revoke admin;
  confirm pending user's direct REST reads return empty (RLS, not UI, is the gate);
  confirm self-revoke is rejected by the DB.
