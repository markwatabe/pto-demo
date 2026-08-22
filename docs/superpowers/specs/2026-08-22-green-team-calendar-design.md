# Green Team Shifts on the Calendar Page — Design

**Date:** 2026-08-22
**Status:** Approved (design agreed in-session)
**Builds on:** `2026-08-21-admin-approval-design.md` (merged to main). Ports the calendar
slice of the July volunteers/CORI spec (`2026-07-27-volunteers-cori-admins-design.md`)
to Supabase; that spec's volunteers badges, CORI, and shift-editing remain future work.

## Why

The Calendar page is a placeholder. The `@apygee/calendar` package (v0.2.x, in the
`../components` workspace alongside atoms/core/data-table) provides the timeline
`Calendar` component; this pass renders seeded Green Team lunch shifts in it, read-only.

## Decisions (made by the user)

1. **Data source:** Green Team lunch shifts per the July spec — two one-hour shifts per
   school day (11:30–12:30 and 12:30–13:30), 1–2 parent volunteers each.
2. Rendered with `@apygee/calendar`'s `Calendar` in week view (`defaultZoom: '3'`),
   opening on the current week, navigable via the component's built-in controls.
3. `parents.green_team_volunteer` is added now (the seed's volunteer pool needs it and
   the future volunteers feature wants it); Directory badges are NOT added this pass.

## Schema (added to `supabase/schema.sql`)

- `parents`: new column `green_team_volunteer boolean not null default false`.
- `green_team_shifts`: `id uuid PK default gen_random_uuid()`, `date date not null`,
  `slot text not null check (slot in ('11:30', '12:30'))`, `unique (date, slot)`,
  index on `date`.
- `shift_volunteers`: `shift_id → green_team_shifts (cascade)`, `parent_id → parents
  (cascade)`, composite PK.
- Drops added in dependency order (`shift_volunteers` → `green_team_shifts`, before
  `parents`); file stays idempotent drop-and-recreate.
- RLS: both new tables enabled with the same `"approved can read"` select policy
  (`using (public.is_approved())`, `to authenticated`) as the directory tables. No
  write policies — shifts are seed-only data this pass.

## Calendar page (`src/pages/Calendar.tsx`, full rewrite)

- `@apygee/calendar` added as a workspace dependency (`pnpm-workspace.yaml` gains
  `../components/packages/calendar`; `package.json` gains `"@apygee/calendar":
  "workspace:*"`). Its deps (atoms, core, types, suncalc) are already satisfied.
- One nested query, Directory-style: `green_team_shifts` selecting `id, date, slot`
  and `volunteers:parents!shift_volunteers (id, firstName:first_name,
  lastName:last_name)`.
- Each shift maps to a `CalendarEvent` (from `@apygee/types`):
  - `startsAt` = `` `${date}T${slot}:00` `` (local time), `endsAt` one hour later
    (`11:30`→`12:30`, `12:30`→`13:30`).
  - `title` = `"Green Team: Ava Chen, Leo Park"` (names joined with ", "; a
    one-volunteer shift shows the single name; a shift with no volunteers shows
    "unfilled").
  - `description` = slot range + the same names.
- Render: `<Calendar events viewStart onViewStartChange defaultZoom="3"
  getEventTone={() => 'success'} />` with `viewStart` state initialized to the start
  (Sunday) of the current week. Loading spinner and error `Alert` follow the
  Directory pattern; the query runs once on mount (no realtime).
- The page keeps its `PageHeader`; the "coming soon" Alert and placeholder Card go away.

## Seed (`scripts/seed.ts`)

- After building parents: mark each `green_team_volunteer` with 25% probability, then
  top up randomly to guarantee at least 20 in the pool.
- Shifts: for every weekday from 28 days before today through 56 days after
  (dates computed via `setDate` arithmetic, immune to DST; the real school calendar
  is ignored — demo data): two shifts (`'11:30'`, `'12:30'`). Each shift gets 2
  volunteers with 80% probability, else 1, drawn from the pool without duplicates
  within a shift. On ~25% of days one shared volunteer covers both slots.
- Clear list grows (before existing entries): `shift_volunteers`, `green_team_shifts`.
- Insert order: shifts and links after parents (`green_team_shifts` before
  `shift_volunteers`).
- `verify-rls` covers 9 tables (adds `green_team_shifts`, `shift_volunteers`).

## Error handling

Query errors surface `error.message` in the existing `Alert` pattern; the fetch hook
uses the standard `cancelled` cleanup flag.

## Out of scope (YAGNI)

Shift signup/editing, Directory volunteer badges, CORI, admin shift management,
realtime updates, a personal "my shifts" filter.

## Verification

- Static: `pnpm typecheck`, `pnpm build`.
- Live: apply updated schema (and re-apply once — idempotency), `pnpm seed` ×2,
  `pnpm verify:rls` 9/9.
- Browser (user): week view opens on the current week with two green shifts per
  weekday showing volunteer names; week navigation works across the ~12-week seeded
  window; pending users still see nothing (RLS).
