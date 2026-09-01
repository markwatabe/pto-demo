# Green Team Pivot — Design

**Date:** 2026-09-01
**Status:** Approved (design agreed in-session)
**Builds on:** `2026-08-22-green-team-calendar-design.md` (branch `green-team-calendar`, unmerged; this branch stacks on it)

## Why

The app pivots to focus 100% on Green Team lunch-shift scheduling. A real Google Forms
export (`volunteers.csv`, 18 respondents) revealed the actual domain: volunteers state
**recurring weekly availability** (Mon–Thu, Early/Late/Full lunch shifts) plus a
**frequency budget** ("once a month", "every other week"), CORI status, and an
emergency-backfill flag. Scheduling means turning availability into a fair shift
roster — not self-service join/leave.

Auth + admin approval stay exactly as built. The family directory stays but is demoted
(calendar becomes home). Nobody enters children; people sign up, get approved, and are
matched to the volunteer roster by email.

## Decisions (made by the user)

1. **Directory: keep, demoted.** Pages and tables untouched; home route and nav lead
   with scheduling.
2. **CSV import + in-app edits.** One-time (re-runnable) import of `volunteers.csv`;
   thereafter the app is the source of truth — admins edit anyone, a signed-in
   volunteer (matched by email) edits their own availability.
3. **Auto-draft + admin adjust.** Admin generates a fair draft schedule for a date
   range; then adds/removes people per shift from an availability-aware picker.

## Privacy

`volunteers.csv` holds real PII (names, emails, children's grades, notes). It is
git-ignored and never committed. The import script reads it from the repo root at run
time. The database is gated: only **approved** users read anything (existing RLS).

## Data model (changes to `supabase/schema.sql`)

Unchanged: families, parents (except one dropped column), children, teachers,
child_past_teachers, profiles, admins, `green_team_shifts`, all approval machinery.

- **Drop** `parents.green_team_volunteer` (vestigial — volunteers are no longer parents).
- **`volunteers`** — the roster:
  `id uuid PK default gen_random_uuid()`, `email text not null unique` (stored
  lowercased), `name text not null`, `veteran boolean not null default false`,
  `grades text` (raw form text), `frequency text not null default 'monthly'
  check in ('monthly','biweekly','custom')`, `frequency_note text`,
  `cori text not null default 'unsure' check in ('yes','no','unsure')`,
  `backfill boolean not null default false`, `notes text`.
- **`availability`** — `volunteer_id uuid FK → volunteers (cascade)`,
  `weekday smallint check (weekday between 1 and 4)` (1=Mon … 4=Thu),
  `slot text check in ('11:30','12:30')`, PK `(volunteer_id, weekday, slot)`.
  "Full Shift" = both slot rows; "N/A" = none.
- **`school_year`** — single row: `id boolean PK default true check (id)`,
  `starts_on date not null`, `ends_on date not null`.
- **`school_closures`** — `date date PK`, `reason text`.
- **`shift_volunteers`** — redefined as `(shift_id → green_team_shifts cascade,
  volunteer_id → volunteers cascade)`, composite PK. Assignments now reference the
  roster, not seeded parents.

A **school day** is a Mon–Thu date within `[starts_on, ends_on]` that is not in
`school_closures`.

## Identity model

A signed-in user is linked to their `volunteers` row purely by
`lower(volunteers.email) = lower(auth.jwt() ->> 'email')`. No FK to auth; the CSV and
sign-ups can arrive in either order.

## RLS

All new tables: select for approved users (`public.is_approved()`), `to authenticated`.
Writes:

| Table | insert | update | delete |
|---|---|---|---|
| volunteers | admin OR self (email match, enforced in `with check`) | admin OR self | admin |
| availability | admin OR owner (email match via volunteers subquery) | — (edit = delete + insert) | admin OR owner |
| school_year | admin | admin | — |
| school_closures | admin | — | admin |
| green_team_shifts | admin (generator runs client-side as admin) | — | admin |
| shift_volunteers | admin | — | admin |

"Self/owner" predicate: `lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))`,
via a `volunteers` subquery for `availability`.

## CSV import (`scripts/import-volunteers.ts`, `pnpm import:volunteers`)

Service-role script; parses `volunteers.csv` with a proper CSV parser (`csv-parse`
devDependency — the file has quoted commas). Per row:

- email → lowercased key; **upsert** volunteer by email.
- name → trimmed `name`; "Yes, I'm a veteran!" → `veteran = true`.
- grades column → raw text into `grades`.
- Weekday columns Mon–Thu → availability rows: cell contains "Early Shift" → `11:30`,
  "Late Shift" → `12:30`, "Full Shift" → both; "N/A" (or empty) → none. A cell can list
  several (comma-separated) — union them. Existing availability for that volunteer is
  **replaced** on import.
- Frequency: "Once a month" → `monthly`; "Every other week" → `biweekly`; anything else
  → `custom` with the raw text in `frequency_note`.
- CORI: "Yes" → `yes`; "No" → `no`; anything else → `unsure`.
- Backfill "Yes" → true. Comments column → `notes`.
- Prints a per-row summary and total counts. Re-runnable: upserts + replace.

## Schedule generation (client-side, admin-triggered, deterministic)

Admin picks a range `[from, to]` (clamped to the school year). Then:

1. For every school day × both slots in range, insert missing `green_team_shifts` rows.
2. Walk shifts chronologically (date, then slot). For each shift with fewer than 2
   assignees, fill up to 2 from candidates = volunteers whose availability contains
   (weekday, slot) and who aren't already on this shift.
3. Scoring: budget per trailing 28 days — `monthly` = 1, `biweekly` = 2, `custom` = 1.
   Pick the candidate with the lowest `assignedInTrailing28Days / budget`; ties → fewest
   total assignments in the range; ties → longest time since last assignment; ties →
   name ascending (fully deterministic).
4. A volunteer already assigned to the *other slot the same day* is deprioritized (only
   chosen if the shift would otherwise stay below 2) — Full-Shift folk can cover both.
5. Existing assignments are never removed by generation; re-running fills gaps only.
6. Writes happen as the admin's client-side inserts (RLS: admin-only), chunked.

Admin can afterwards remove anyone from a shift or add anyone from a picker that shows
available volunteers first (with frequency-usage hint), then `backfill: true` volunteers
as suggestions, then everyone else.

## Pages & navigation

- **Home** (`/`) → redirects to `/calendar` (was `/directory`).
- **Calendar** (existing page, updated): shift titles/details use `volunteers.name`;
  shifts that include the signed-in user (email match) render in a distinct tone;
  school closures render as background-kind CalendarEvents labeled with the reason
  ("No school · Thanksgiving"). Still read-only for non-admins.
- **My availability** (`/availability`, new): the signed-in user's volunteer record —
  a Mon–Thu × Early/Late checkbox grid, frequency select, backfill toggle, notes.
  If no volunteer row matches their email, the page offers "Join the Green Team" which
  creates their row (name prefilled from email prompt) — RLS permits self-insert.
- **Admin → Schedule** (`/admin/schedule`, new, admin-gated like `/admin`): school-year
  start/end editor, closures list (add date + reason, remove), "Generate schedule" for
  a date range with a result summary (shifts created, slots filled, unfilled list),
  and a per-shift roster editor for the generated window.
- **Nav order:** My calendar, My availability, [Admin, Schedule — admins only],
  Directory, Forms, Our PTO. Sign-out unchanged.

## Seed & scripts

- `scripts/seed.ts`: keeps admin bootstrap + mock directory (80 families). **Removes**
  shift/volunteer-pool generation and the `green_team_volunteer` logic. Never touches
  `volunteers`, `availability`, `school_year`, `school_closures`, `green_team_shifts`,
  `shift_volunteers` (real data now).
- `scripts/verify-rls.ts`: table list becomes the 11 read-gated tables (adds
  `volunteers`, `availability`, `school_closures`; `school_year` excluded from the
  service-role `> 0` assertion until an admin sets it — verified as anon-0 only).
- Applying the new schema wipes shifts/assignments (drop-and-recreate); that is
  acceptable now — the real schedule is regenerated from imported availability.

## Error handling

Existing patterns: all supabase calls surface `error.message` via `Alert`; buttons
disable in flight; RLS-filtered writes use `.select()` row-count verification for admin
actions (same as the approve/revoke pattern).

## Execution decomposition

- **Plan 1 (foundation):** schema v2 + CSV import + My availability page + calendar
  reading `volunteers` + nav/home rewiring + seed/verify updates. Shippable: roster
  imported and self-serviceable, calendar shows (initially empty) real schedule.
- **Plan 2 (scheduling):** school-year/closures admin UI + generator + per-shift roster
  editor + closure bands on the calendar. Shippable: full scheduling workflow.

## Out of scope (YAGNI)

Email notifications/reminders, iCal export, shift swap requests, CORI paperwork
workflow, Friday shifts, multi-school support, mobile-specific UI, automated blackout
parsing from free-text notes (the two volunteers with blackout windows are handled by
admins editing the draft).
