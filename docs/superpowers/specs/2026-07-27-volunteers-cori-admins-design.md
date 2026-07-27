# Volunteers, CORI status, Admins, and Green Team scheduling — Design

**Date:** 2026-07-27
**Status:** Approved

## Goal

Expand the PTO family directory to support volunteer coordination:

1. Mark parents as **Green Team volunteers** and/or **classroom volunteers**, visible to all signed-in users.
2. Track whether a parent has a **CORI on file** (right to visit the school), visible **only to admins** — enforced at the database layer, not just the UI.
3. Introduce **admins**: a role that can see CORI status, edit volunteer/CORI data, and grant or revoke admin for others.
4. Schedule **Green Team lunch shifts** — two one-hour shifts per school day (11:30–12:30 and 12:30–1:30) — and render them on the calendar page using the `@apygee/calendar` component. This pass is view-only, driven by seeded mock data.

## Background

The app is a React 19 + InstantDB (`@instantdb/react` 0.21) SPA with magic-code auth. Data model: `families` → `parents` / `children`, `children` → `teachers`. The directory page is read-only; all data comes from an idempotent seed script (`scripts/seed.ts`, admin SDK). `src/instant.perms.ts` currently has no rules.

Key constraint: **InstantDB permission rules are per-entity, not per-field.** A field on `parents` cannot be hidden from non-admins at the database layer, so CORI must live in its own entity.

## Schema changes (`src/instant.schema.ts`)

### `parents` — new optional fields

- `greenTeamVolunteer: i.boolean().optional()`
- `classroomVolunteer: i.boolean().optional()`

### New entity: `coriRecords`

- `onFile: i.boolean()` — CORI check is on file
- `expiresOn: i.string().optional()` — ISO date; absent means no known expiration

Link `parentCori`: `parents` has one `cori`; reverse `coriRecords` has one `parent` with `onDelete: "cascade"` so a CORI record dies with its parent.

### New entity: `greenTeamShifts`

- `date: i.string().indexed()` — ISO date of the school day, e.g. `"2026-07-27"`
- `slot: i.string()` — shift start time, `"11:30"` or `"12:30"`; every shift is one hour

Link `shiftVolunteers`: `greenTeamShifts` has many `volunteers` (parents); reverse `parents` has many `shifts`. Up to 2 volunteers per shift in practice (sometimes only 1 signs up); the same parent may take both slots of a day. The model doesn't hard-enforce the cap — the seed (and any future signup flow) is responsible for it.

### New entity: `adminRoles`

- `email: i.string().unique().indexed()` — denormalized for display in the admin list
- `grantedAt: i.string()` — ISO timestamp

Link `adminRoleUser`: `adminRoles` has one `user` → `$users`; reverse `$users` has one `adminRole`. A user is an admin iff an `adminRoles` record links to their `$users` record. `onDelete: "cascade"` from the user side.

## Permissions (`src/instant.perms.ts`)

Shared bind used by every rule set:

```
isAdmin: "auth.id != null && auth.ref('$user.adminRole.id') != []"
```

| Entity | view | create / update / delete |
|---|---|---|
| `families`, `parents`, `children`, `teachers`, `greenTeamShifts` | signed in (`auth.id != null`) | `isAdmin` |
| `coriRecords` | `isAdmin` | `isAdmin` |
| `adminRoles` | `isAdmin` | create/delete `isAdmin`; update denied (grant/revoke only, no edits) |
| `$users` | self (`auth.id == data.id`) or `isAdmin` | denied (Instant restricts `$users` writes anyway) |

Consequences:

- Non-admins querying the `cori` link on parents silently get nothing — database-enforced privacy.
- A non-admin's "am I an admin?" query over `adminRoles` returns empty, which is the correct answer.
- Admins can look up `$users` by email to grant admin.
- The previously wide-open entities become read-only for non-admins (they were only ever written by the seed script's admin SDK, which bypasses rules).

## UI changes

### Directory page (`src/pages/Directory.tsx`)

- Directory query additionally fetches `parents.cori`.
- Volunteer badges ("Green Team", "Classroom") render next to a parent's name when the flag is true — visible to everyone.
- A CORI caption per parent — "CORI on file · expires <Mon YYYY>", "CORI expired", or "CORI on file" when no date — renders whenever the `cori` link comes back. No admin special-casing in the component: permissions strip the link for non-admins, so the caption simply never renders for them.

### Calendar page (`src/pages/Calendar.tsx`)

Replace the placeholder with the `Calendar` component from `@apygee/calendar`, added as a workspace dependency alongside atoms/core/data-table (requires adding `../components/packages/calendar` to `pnpm-workspace.yaml`).

- Query `greenTeamShifts` with linked `volunteers`; map each shift to a `CalendarEvent`:
  - `startsAt` / `endsAt` built from `date` + `slot` (11:30–12:30 or 12:30–13:30, local time),
  - `title`: volunteer names, e.g. `"Green Team: Ava Chen, Leo Park"`; a one-volunteer shift shows the single name,
  - `description`: shift details (slot label, volunteer full names).
- `defaultZoom: '3'` (week view), `viewStart` initialized to the start of the current week, navigable via the component's built-in controls.
- All shift events use a consistent `success` tone via `getEventTone`.
- Visible to all signed-in users; no editing or signup interaction in this pass.

### New Admin page (`src/pages/Admin.tsx`, route `/admin`)

Nav item appears only for admins; the route itself redirects non-admins to `/directory`. Admin status in the client comes from a small `useIsAdmin()` hook querying `adminRoles` where `user.id == auth.id` (returns empty for non-admins).

Two sections:

1. **Admins** — list current admins (email, granted date); grant admin by email (looks up `$users` by email; shows an error if that person has never signed in, since InstantDB only knows users after first sign-in); revoke admin. Revoking your own admin is allowed but the UI asks for confirmation.
2. **Volunteers & CORI** — table of all parents (name, family) with:
   - toggles for `greenTeamVolunteer` and `classroomVolunteer` (writes directly to `parents`),
   - CORI editing: on-file checkbox plus optional expiration date; creates/updates/deletes the linked `coriRecords` entity.

## Seed script (`scripts/seed.ts`)

- Also clears `coriRecords` and `greenTeamShifts` (leaves `adminRoles` and `$users` alone so admin grants survive reseeding).
- Assigns `greenTeamVolunteer` with ~25% probability and `classroomVolunteer` with ~35% probability per parent, guaranteeing at least 20 green-team parents so the shift schedule has a workable pool.
- **Green Team shifts:** for every weekday from 4 weeks before today through 8 weeks after (dates ignore the real school calendar — this is demo data), creates two `greenTeamShifts` (slots `"11:30"` and `"12:30"`), each linked to 1–2 green-team parents (~80% get 2, ~20% get 1). Sometimes (~25% of days) one volunteer covers both slots of the same day.
- Creates a `coriRecords` entity for ~40% of parents: mostly valid future expiration dates, some expired, some with no date.
- **Admin bootstrap:** reads `SEED_ADMIN_EMAIL` from `.env` (default `m.watabe@gmail.com`); ensures the `$users` record exists via the admin SDK (`db.auth.createToken(email)` creates the user if needed) and upserts an `adminRoles` record linked to it. This solves the chicken-and-egg problem of needing an admin to create the first admin.
- `.env.example` documents `SEED_ADMIN_EMAIL`.

## Rollout

1. Add `@apygee/calendar` to `pnpm-workspace.yaml` + `package.json`; `pnpm install`.
2. Push schema and perms to InstantDB (`npx instant-cli@latest push`).
3. Run `pnpm seed`.
4. `pnpm typecheck` must pass.

## Error handling

- Granting admin to an unknown email → inline form error ("That person hasn't signed in yet").
- Admin mutations (`transact`) surface failures via the existing `Alert` pattern.
- Directory behavior for non-admins is unchanged except for the new badges.

## Testing

No test framework exists in the repo; verification is `pnpm typecheck` plus manual checks:

- Non-admin account: sees badges, sees no CORI data (verify network response, not just UI), gets redirected from `/admin`, cannot write to `parents`.
- Admin account: sees CORI captions in the directory, can toggle volunteers, edit CORI, grant/revoke admins.
- Calendar page: week view shows two Green Team shifts per weekday with volunteer names; navigating weeks within the seeded window keeps showing shifts.

## Out of scope

- Shift signup/editing UI (this pass renders seeded shifts read-only), additional role types (a `volunteerRoles` entity was considered and rejected as YAGNI), CORI paperwork pipeline states, editing family/parent/child core data.
