# Green Team Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render seeded Green Team lunch shifts (two per school day, 1–2 parent volunteers each) read-only in the `@apygee/calendar` week view on the Calendar page.

**Architecture:** Two new tables (`green_team_shifts`, `shift_volunteers`) plus a `parents.green_team_volunteer` flag, RLS-gated by the existing `is_approved()` helper; the seed script generates ~12 weeks of weekday shifts from a ≥20-parent volunteer pool; the Calendar page fetches shifts with a nested supabase-js select (Directory pattern) and maps them to `CalendarEvent`s for `@apygee/calendar`'s `Calendar` component.

**Tech Stack:** Supabase (Postgres + RLS), React 19, `@apygee/calendar` + `@apygee/types` (workspace packages from `../components`), `@supabase/supabase-js` v2, pnpm, tsx.

**Spec:** `docs/superpowers/specs/2026-08-22-green-team-calendar-design.md`

## Global Constraints

- Table/column names exactly: `green_team_shifts(id, date, slot)` with `unique (date, slot)` and slot check `('11:30', '12:30')`; `shift_volunteers(shift_id, parent_id)` composite PK; `parents.green_team_volunteer boolean not null default false`.
- RLS on both new tables: one select policy named `"approved can read"`, `to authenticated`, `using (public.is_approved())`. No write policies.
- `supabase/schema.sql` stays idempotent drop-and-recreate; drops in dependency order.
- Event mapping exactly: `startsAt` = `` `${date}T${slot}:00` ``, `endsAt` one hour later (`11:30`→`12:30`, `12:30`→`13:30`); title `"Green Team: <names joined with ', '>"`, `"Green Team: unfilled"` when no volunteers.
- Calendar: `defaultZoom="3"`, `viewStart` = Sunday of the current week, `getEventTone={() => 'success'}`, read-only.
- Seed distribution: 25% volunteer probability topped up to ≥ 20; weekdays from 28 days before today through 56 days after; 2 volunteers at 80% else 1; ~25% of days one shared volunteer covers both slots; date arithmetic via `setDate` (DST-safe).
- Every commit must leave `pnpm typecheck` passing; no test framework — gates are typecheck, `pnpm build`, and the scripts.
- Live-project steps (apply schema, seed, verify:rls, browser check) are the controller's post-task runtime pass — not part of any task's steps.
- Do not touch `@apygee/*` package sources, Directory, Login, Admin, Waiting, auth/access/supabase modules.
- Branch: `green-team-calendar` (already created, off `main`).

---

### Task 1: Schema — shifts tables, volunteer flag, RLS

**Files:**
- Modify: `supabase/schema.sql` (four edits below)

**Interfaces:**
- Consumes: existing `parents` table, `public.is_approved()` helper, the file's drop/create/RLS structure.
- Produces: `green_team_shifts` / `shift_volunteers` tables and `parents.green_team_volunteer` column with exact names above. Tasks 2–3 rely on them.

- [ ] **Step 1: Add drops**

In the drop block, insert these two lines immediately after `drop trigger if exists on_auth_user_created on auth.users;` (they must precede `drop table if exists parents;`):

```sql
drop table if exists shift_volunteers;
drop table if exists green_team_shifts;
```

- [ ] **Step 2: Add the volunteer flag to `parents`**

In `create table parents (...)`, add after the `mobile_phone text` line (add a trailing comma to `mobile_phone text`):

```sql
  -- Green Team volunteer pool; shown as directory badges in a future pass.
  green_team_volunteer boolean not null default false
```

- [ ] **Step 3: Add the new tables**

Insert immediately after the `create table child_past_teachers (...)` statement (before the profiles/admins block):

```sql
-- Green Team lunch shifts: two one-hour slots per school day, each covered
-- by 1–2 parent volunteers. Seed-only data this pass (no client writes).
create table green_team_shifts (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  slot text not null check (slot in ('11:30', '12:30')),
  unique (date, slot)
);
create index green_team_shifts_date_idx on green_team_shifts (date);

create table shift_volunteers (
  shift_id uuid not null references green_team_shifts (id) on delete cascade,
  parent_id uuid not null references parents (id) on delete cascade,
  primary key (shift_id, parent_id)
);
```

- [ ] **Step 4: RLS**

Add to the enable-RLS block, after the existing seven lines:

```sql
alter table green_team_shifts enable row level security;
alter table shift_volunteers enable row level security;
```

Add after the five existing `"approved can read"` policies (before the profiles policies):

```sql
create policy "approved can read" on green_team_shifts
  for select to authenticated using (public.is_approved());
create policy "approved can read" on shift_volunteers
  for select to authenticated using (public.is_approved());
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck` — expected exit 0 (SQL-only change; confirms no accidental breakage).

```bash
git add supabase/schema.sql
git commit -m "feat: add green team shift tables, volunteer flag, RLS"
```

---

### Task 2: Calendar dependency + Calendar page

**Files:**
- Modify: `pnpm-workspace.yaml` (one line)
- Modify: `package.json` (one dependency, via pnpm)
- Modify: `src/pages/Calendar.tsx` (full replacement below)

**Interfaces:**
- Consumes: `supabase` from `src/supabase.ts`; `Calendar` from `@apygee/calendar`; `CalendarEvent` from `@apygee/types`; Task 1's tables (`green_team_shifts`, `shift_volunteers`, aliased parent columns).
- Produces: `CalendarPage()` (no props — same export App already routes).

- [ ] **Step 1: Add the workspace package**

In `pnpm-workspace.yaml`, add to the `packages:` list after the `data-table` line:

```yaml
  - '../components/packages/calendar'
```

Then run:

```bash
pnpm add @apygee/calendar@workspace:*
```

(Verify `package.json` dependencies now contain `"@apygee/calendar": "workspace:*"`.)

- [ ] **Step 2: Replace `src/pages/Calendar.tsx` entirely**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Alert, PageHeader, PageShell, Spinner, Stack } from '@apygee/atoms';
import { Calendar } from '@apygee/calendar';
import type { CalendarEvent } from '@apygee/types';
import { supabase } from '../supabase';

type Volunteer = { id: string; firstName: string; lastName: string };
type Shift = {
  id: string;
  date: string; // ISO date, e.g. "2026-08-24"
  slot: '11:30' | '12:30';
  volunteers: Volunteer[];
};

// Shifts with their volunteers' names; snake_case columns aliased to camelCase.
const SHIFTS_SELECT = `
  id, date, slot,
  volunteers:parents!shift_volunteers ( id, firstName:first_name, lastName:last_name )
`;

const SLOT_END: Record<Shift['slot'], string> = { '11:30': '12:30', '12:30': '13:30' };

// Sunday of the week containing d, at local midnight.
function startOfWeek(d: Date): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  day.setDate(day.getDate() - day.getDay());
  return day;
}

function shiftToEvent(shift: Shift): CalendarEvent {
  const names = shift.volunteers.map((v) => `${v.firstName} ${v.lastName}`).join(', ');
  return {
    id: shift.id,
    title: `Green Team: ${names || 'unfilled'}`,
    description: `Lunch shift ${shift.slot}–${SLOT_END[shift.slot]} · ${names || 'no volunteers yet'}`,
    startsAt: `${shift.date}T${shift.slot}:00`,
    endsAt: `${shift.date}T${SLOT_END[shift.slot]}:00`,
  };
}

type ShiftsResult = {
  isLoading: boolean;
  error: { message: string } | null;
  shifts: Shift[];
};

function useShifts(): ShiftsResult {
  const [result, setResult] = useState<ShiftsResult>({
    isLoading: true,
    error: null,
    shifts: [],
  });

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('green_team_shifts')
      .select(SHIFTS_SELECT)
      .then(({ data, error }) => {
        if (cancelled) return;
        setResult({
          isLoading: false,
          error,
          shifts: (data ?? []) as unknown as Shift[],
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}

export function CalendarPage() {
  const [viewStart, setViewStart] = useState<Date>(() => startOfWeek(new Date()));
  const { isLoading, error, shifts } = useShifts();

  const events = useMemo(() => shifts.map(shiftToEvent), [shifts]);

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Planning"
          title="My calendar"
          description="Green Team lunch shifts — two one-hour shifts each school day."
        />

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : error ? (
          <Alert tone="danger" title="Could not load shifts" description={error.message} />
        ) : (
          <Calendar
            events={events}
            viewStart={viewStart}
            onViewStartChange={setViewStart}
            defaultZoom="3"
            getEventTone={() => 'success'}
          />
        )}
      </Stack>
    </PageShell>
  );
}
```

- [ ] **Step 3: Verify compile and build**

Run: `pnpm typecheck` — expected exit 0. If `getEventTone={() => 'success'}` fails the `StatusTone` type, check the exact members of `StatusTone` in `../components/packages/types/dist/design.d.ts` and use the closest success-green tone it defines — report the substitution in your report rather than silently choosing.
Run: `pnpm build` — expected exit 0.

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml src/pages/Calendar.tsx
git commit -m "feat: render green team shifts with @apygee/calendar"
```

---

### Task 3: Seed shifts + verify-rls extension

**Files:**
- Modify: `scripts/seed.ts` (three edits below)
- Modify: `scripts/verify-rls.ts` (one edit)

**Interfaces:**
- Consumes: Task 1's tables/columns; existing seed helpers `chance`, `pick`, `shuffle`, `rand`, `randomUUID`, `insertAll`, `clearTable`, and the `parentRows` array built in `main()`.
- Produces: `pnpm seed` populates `green_team_shifts`/`shift_volunteers`; `pnpm verify:rls` covers 9 tables.

- [ ] **Step 1: Extend the clear list in `scripts/seed.ts`**

In `main()`, the clearing loop's table list currently starts with `['child_past_teachers', 'child_id'],`. Insert BEFORE that line:

```ts
    ['shift_volunteers', 'shift_id'],
    ['green_team_shifts', 'id'],
```

- [ ] **Step 2: Generate volunteers and shifts**

In `main()`, after the family loop ends (after the closing brace of `for (let f = 0; f < FAMILY_COUNT; f++) { ... }`) and BEFORE the `// Insert in FK order:` comment, insert:

```ts
  // --- Green Team volunteer pool ---------------------------------------------
  // ~25% of parents volunteer; top up randomly to guarantee a workable pool.
  for (const p of parentRows) p.green_team_volunteer = chance(0.25);
  let pool = parentRows.filter((p) => p.green_team_volunteer);
  if (pool.length < 20) {
    const extras = shuffle(parentRows.filter((p) => !p.green_team_volunteer)).slice(
      0,
      20 - pool.length,
    );
    for (const p of extras) p.green_team_volunteer = true;
    pool = parentRows.filter((p) => p.green_team_volunteer);
  }

  // --- Green Team shifts: two per weekday, ~12 weeks around today -------------
  // Dates ignore the real school calendar — this is demo data.
  const shiftRows: Record<string, unknown>[] = [];
  const shiftVolunteerRows: Record<string, unknown>[] = [];
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  for (let offset = -28; offset <= 56; offset++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // school days only

    const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    // ~25% of days one volunteer covers both slots.
    const sharedVolunteerId = chance(0.25) ? (pick(pool).id as string) : null;

    for (const slot of ['11:30', '12:30'] as const) {
      const shiftId = randomUUID();
      shiftRows.push({ id: shiftId, date, slot });

      const count = chance(0.8) ? 2 : 1;
      const volunteerIds = new Set<string>();
      if (sharedVolunteerId) volunteerIds.add(sharedVolunteerId);
      while (volunteerIds.size < count) volunteerIds.add(pick(pool).id as string);
      for (const parentId of volunteerIds) {
        shiftVolunteerRows.push({ shift_id: shiftId, parent_id: parentId });
      }
    }
  }
```

- [ ] **Step 3: Insert and report**

Replace the insert/report block at the end of `main()`:

```ts
  // Insert in FK order: families before parents/children, children before links.
  await insertAll('families', familyRows);
  await insertAll('parents', parentRows);
  await insertAll('children', childRows);
  await insertAll('child_past_teachers', pastTeacherRows);

  console.log(
    `Seeded ${familyRows.length} families, ${parentRows.length} parents, ${childRows.length} children.`,
  );
  console.log('Done.');
```

with:

```ts
  // Insert in FK order: families before parents/children, children before links,
  // parents before shift links.
  await insertAll('families', familyRows);
  await insertAll('parents', parentRows);
  await insertAll('children', childRows);
  await insertAll('child_past_teachers', pastTeacherRows);
  await insertAll('green_team_shifts', shiftRows);
  await insertAll('shift_volunteers', shiftVolunteerRows);

  console.log(
    `Seeded ${familyRows.length} families, ${parentRows.length} parents, ${childRows.length} children.`,
  );
  console.log(
    `Seeded ${shiftRows.length} green team shifts (${shiftVolunteerRows.length} volunteer slots, pool of ${pool.length}).`,
  );
  console.log('Done.');
```

- [ ] **Step 4: Extend `scripts/verify-rls.ts`**

In the `TABLES` array, add after `'admins',`:

```ts
  'green_team_shifts',
  'shift_volunteers',
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck` — expected exit 0. (`scripts/` is outside tsconfig's include — read your diff carefully: every referenced symbol exists, column keys are snake_case, `pool` is in scope at the final `console.log`.)

```bash
git add scripts/seed.ts scripts/verify-rls.ts
git commit -m "feat: seed green team shifts, verify RLS on shift tables"
```
