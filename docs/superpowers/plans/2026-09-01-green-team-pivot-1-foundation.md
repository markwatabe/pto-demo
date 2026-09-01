# Green Team Pivot — Plan 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the volunteer roster — schema v2 (volunteers/availability/school-year/closures, reassigned shift assignments), CSV import of the real sign-up form, a self-service My-availability page, and calendar/nav rewiring so scheduling is the app's center.

**Architecture:** New tables join the existing approval-gated schema; a signed-in user links to their `volunteers` row purely by email match (`auth.jwt() ->> 'email'`), enforced in RLS for self-service writes. A service-role script imports `volunteers.csv` (real PII, git-ignored) with upsert-by-email + replace-availability semantics. The calendar's assignment source flips from seeded parents to the roster; home becomes the calendar. Schedule *generation* is Plan 2.

**Tech Stack:** Supabase (Postgres + RLS + `auth.jwt()`), React 19, `@apygee/atoms` + `@apygee/calendar`, `@supabase/supabase-js` v2, `csv-parse`, pnpm, tsx.

**Spec:** `docs/superpowers/specs/2026-09-01-green-team-pivot-design.md`

## Global Constraints

- Table/column names exactly as in Task 1's SQL: `volunteers(id, email, name, veteran, grades, frequency, frequency_note, cori, backfill, notes)`; `availability(volunteer_id, weekday, slot)` PK all three, weekday 1=Mon…4=Thu; `school_year(id, starts_on, ends_on)` single-row; `school_closures(date, reason)`; `shift_volunteers(shift_id, volunteer_id)`.
- Enum literals exactly: frequency `'monthly' | 'biweekly' | 'custom'`; cori `'yes' | 'no' | 'unsure'`; slots `'11:30' | '12:30'`.
- Self/owner RLS predicate exactly: `lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))` (via a `volunteers` subquery for `availability`).
- Emails stored lowercased everywhere (import lowercases; the availability page lowercases before compare/insert).
- `volunteers.csv` is real PII: already git-ignored; scripts read it from the repo root; it must never be committed or copied into tracked files (including plans/reports — do not paste row contents anywhere).
- `parents.green_team_volunteer` is dropped; seed no longer touches shift/volunteer tables.
- `supabase/schema.sql` stays idempotent drop-and-recreate; drops in dependency order.
- UI uses only these `@apygee/atoms` exports (all proven in this codebase): Alert, Body, Button, Caption, Card, Divider, Inline, NavLink, PageHeader, PageShell, SectionTitle, Spinner, Stack, Strong, TextField. Toggle-style state uses Button variants (no Checkbox/Select atoms).
- Every commit must leave `pnpm typecheck` passing; `pnpm build` additionally gates Tasks 3–4. No test framework — do not add one.
- Live-project steps (apply schema, seed, import, verify) are the controller's post-task runtime pass.
- Branch: `green-team-pivot` (already created, stacked on `green-team-calendar`).

---

### Task 1: Schema v2

**Files:**
- Modify: `supabase/schema.sql` (five edits below)

**Interfaces:**
- Consumes: existing schema (directory tables, approval machinery, `green_team_shifts`, `public.is_admin()`/`is_approved()`).
- Produces: tables `volunteers`, `availability`, `school_year`, `school_closures`; `shift_volunteers` keyed by `volunteer_id`; `parents.green_team_volunteer` gone. Tasks 2–5 and Plan 2 rely on these exact shapes.

- [ ] **Step 1: Update the drop block**

Replace:

```sql
drop table if exists shift_volunteers;
drop table if exists green_team_shifts;
```

with:

```sql
drop table if exists shift_volunteers;
drop table if exists green_team_shifts;
drop table if exists availability;
drop table if exists volunteers;
drop table if exists school_closures;
drop table if exists school_year;
```

- [ ] **Step 2: Remove the parents volunteer flag**

In `create table parents (...)`, replace:

```sql
  mobile_phone text,
  -- Green Team volunteer pool; shown as directory badges in a future pass.
  green_team_volunteer boolean not null default false
```

with:

```sql
  mobile_phone text
```

- [ ] **Step 3: Insert the roster tables and re-key shift_volunteers**

Replace the current `shift_volunteers` block:

```sql
create table shift_volunteers (
  shift_id uuid not null references green_team_shifts (id) on delete cascade,
  parent_id uuid not null references parents (id) on delete cascade,
  primary key (shift_id, parent_id)
);
```

with (volunteers/availability/school tables first — `shift_volunteers` now references `volunteers`):

```sql
-- Volunteer roster: imported from the sign-up form (volunteers.csv) and
-- edited in-app. Linked to signed-in users by email match only.
create table volunteers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  veteran boolean not null default false,
  grades text,
  frequency text not null default 'monthly' check (frequency in ('monthly', 'biweekly', 'custom')),
  frequency_note text,
  cori text not null default 'unsure' check (cori in ('yes', 'no', 'unsure')),
  backfill boolean not null default false,
  notes text
);

-- Recurring weekly availability: weekday 1=Mon .. 4=Thu (lunch shifts run
-- Monday-Thursday only); slot values match green_team_shifts.slot.
create table availability (
  volunteer_id uuid not null references volunteers (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 4),
  slot text not null check (slot in ('11:30', '12:30')),
  primary key (volunteer_id, weekday, slot)
);

-- Single-row school-year window; school days are Mon-Thu inside it minus closures.
create table school_year (
  id boolean primary key default true check (id),
  starts_on date not null,
  ends_on date not null
);

create table school_closures (
  date date primary key,
  reason text
);

create table shift_volunteers (
  shift_id uuid not null references green_team_shifts (id) on delete cascade,
  volunteer_id uuid not null references volunteers (id) on delete cascade,
  primary key (shift_id, volunteer_id)
);
```

- [ ] **Step 4: Enable RLS on the new tables**

In the enable-RLS block, after `alter table shift_volunteers enable row level security;`, add:

```sql
alter table volunteers enable row level security;
alter table availability enable row level security;
alter table school_year enable row level security;
alter table school_closures enable row level security;
```

- [ ] **Step 5: Add policies**

After the existing seven `"approved can read"` policies (before the profiles policies), add:

```sql
create policy "approved can read" on volunteers
  for select to authenticated using (public.is_approved());
create policy "approved can read" on availability
  for select to authenticated using (public.is_approved());
create policy "approved can read" on school_year
  for select to authenticated using (public.is_approved());
create policy "approved can read" on school_closures
  for select to authenticated using (public.is_approved());

-- Self-service: a signed-in user manages their own roster row and
-- availability, matched by email. Admins manage everyone.
create policy "admin or self can insert" on volunteers
  for insert to authenticated
  with check (public.is_admin() or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "admin or self can update" on volunteers
  for update to authenticated
  using (public.is_admin() or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (public.is_admin() or lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "admin can delete" on volunteers
  for delete to authenticated using (public.is_admin());

create policy "admin or owner can insert" on availability
  for insert to authenticated
  with check (public.is_admin() or exists (
    select 1 from volunteers v
    where v.id = volunteer_id
      and lower(v.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));
create policy "admin or owner can delete" on availability
  for delete to authenticated
  using (public.is_admin() or exists (
    select 1 from volunteers v
    where v.id = volunteer_id
      and lower(v.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));

create policy "admin can set" on school_year
  for insert to authenticated with check (public.is_admin());
create policy "admin can update" on school_year
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin can add" on school_closures
  for insert to authenticated with check (public.is_admin());
create policy "admin can remove" on school_closures
  for delete to authenticated using (public.is_admin());

-- The schedule generator and roster editor run client-side as an admin.
create policy "admin can add" on green_team_shifts
  for insert to authenticated with check (public.is_admin());
create policy "admin can remove" on green_team_shifts
  for delete to authenticated using (public.is_admin());
create policy "admin can assign" on shift_volunteers
  for insert to authenticated with check (public.is_admin());
create policy "admin can unassign" on shift_volunteers
  for delete to authenticated using (public.is_admin());
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck` — expected exit 0.

```bash
git add supabase/schema.sql
git commit -m "feat: roster schema — volunteers, availability, school year, closures"
```

---

### Task 2: CSV import script

**Files:**
- Create: `scripts/import-volunteers.ts`
- Modify: `package.json` (one devDependency via pnpm, one script entry)

**Interfaces:**
- Consumes: Task 1's `volunteers`/`availability` tables; `volunteers.csv` at the repo root (git-ignored, real data); env `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Produces: `pnpm import:volunteers` command.

- [ ] **Step 1: Add the parser dependency and script entry**

```bash
pnpm add -D csv-parse
```

In `package.json` `"scripts"`, after `"verify:rls"`, add:

```json
"import:volunteers": "tsx scripts/import-volunteers.ts"
```

- [ ] **Step 2: Write `scripts/import-volunteers.ts`**

```ts
/**
 * Import Green Team volunteer sign-ups from volunteers.csv (Google Forms export).
 *
 * Usage:  pnpm import:volunteers
 *
 * Upserts volunteers by (lowercased) email and REPLACES their availability
 * rows, so it is safe to re-run as new form responses arrive. Never touches
 * volunteers absent from the CSV.
 *
 * volunteers.csv holds real PII — it is git-ignored; never commit it.
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const CSV_PATH = fileURLToPath(new URL('../volunteers.csv', import.meta.url));

type Row = Record<string, string>;

// Column headers are long Google Forms questions — locate them by marker text.
function headerFor(rows: Row[], marker: string): string {
  const keys = Object.keys(rows[0] ?? {});
  const key = keys.find((k) => k.includes(marker));
  if (!key) throw new Error(`CSV is missing a column containing "${marker}"`);
  return key;
}

// "Early Shift" -> 11:30, "Late Shift" -> 12:30, "Full Shift" -> both.
// Cells can list several, comma-separated; "N/A" or empty means none.
function slotsFor(cell: string | undefined): string[] {
  const text = (cell ?? '').trim();
  if (!text) return [];
  const slots = new Set<string>();
  if (text.includes('Early Shift')) slots.add('11:30');
  if (text.includes('Late Shift')) slots.add('12:30');
  if (text.includes('Full Shift')) {
    slots.add('11:30');
    slots.add('12:30');
  }
  return [...slots];
}

function frequencyFor(cell: string | undefined): { frequency: string; note: string | null } {
  const text = (cell ?? '').trim();
  if (text === 'Once a month') return { frequency: 'monthly', note: null };
  if (text === 'Every other week') return { frequency: 'biweekly', note: null };
  return { frequency: 'custom', note: text || null };
}

function coriFor(cell: string | undefined): 'yes' | 'no' | 'unsure' {
  const text = (cell ?? '').trim().toLowerCase();
  if (text === 'yes') return 'yes';
  if (text === 'no') return 'no';
  return 'unsure';
}

async function main() {
  const rows = parse(readFileSync(CSV_PATH, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  }) as Row[];
  if (rows.length === 0) throw new Error('volunteers.csv has no data rows');

  const emailKey = headerFor(rows, 'Email Address');
  const nameKey = headerFor(rows, 'Your name');
  const veteranKey = headerFor(rows, 'volunteered for Green Team before');
  const gradesKey = headerFor(rows, 'grade level');
  const frequencyKey = headerFor(rows, 'How often');
  const coriKey = headerFor(rows, 'CORI form');
  const backfillKey = headerFor(rows, 'emergency backfill');
  const notesKey = headerFor(rows, 'additional comments');
  const weekdayKeys: Array<[number, string]> = [
    [1, headerFor(rows, '[Monday]')],
    [2, headerFor(rows, '[Tuesday]')],
    [3, headerFor(rows, '[Wednesday]')],
    [4, headerFor(rows, '[Thursday]')],
  ];

  let imported = 0;
  for (const row of rows) {
    const email = (row[emailKey] ?? '').trim().toLowerCase();
    const name = (row[nameKey] ?? '').trim();
    if (!email || !name) {
      console.warn('  skipping a row with missing email or name');
      continue;
    }

    const { frequency, note } = frequencyFor(row[frequencyKey]);
    const { data: vol, error: upsertError } = await db
      .from('volunteers')
      .upsert(
        {
          email,
          name,
          veteran: (row[veteranKey] ?? '').trim().startsWith('Yes'),
          grades: (row[gradesKey] ?? '').trim() || null,
          frequency,
          frequency_note: note,
          cori: coriFor(row[coriKey]),
          backfill: (row[backfillKey] ?? '').trim() === 'Yes',
          notes: (row[notesKey] ?? '').trim() || null,
        },
        { onConflict: 'email' },
      )
      .select('id')
      .single();
    if (upsertError || !vol) {
      throw new Error(`Upsert failed for ${email}: ${upsertError?.message ?? 'no row returned'}`);
    }

    const { error: clearError } = await db.from('availability').delete().eq('volunteer_id', vol.id);
    if (clearError) throw new Error(`Availability clear failed for ${email}: ${clearError.message}`);

    const availabilityRows = weekdayKeys.flatMap(([weekday, key]) =>
      slotsFor(row[key]).map((slot) => ({ volunteer_id: vol.id, weekday, slot })),
    );
    if (availabilityRows.length > 0) {
      const { error: insertError } = await db.from('availability').insert(availabilityRows);
      if (insertError) throw new Error(`Availability insert failed for ${email}: ${insertError.message}`);
    }

    console.log(`  imported ${email} (${availabilityRows.length} availability slots)`);
    imported++;
  }

  console.log(`Imported ${imported} volunteers.`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
```

(Log line prints only the email — names and notes stay out of terminal scrollback beyond what the operator already has open. Do not add more verbose logging.)

- [ ] **Step 3: Verify and commit**

Run: `pnpm typecheck` — expected exit 0. Do NOT run the import (controller's runtime pass does; the schema may not be applied yet).

```bash
git add scripts/import-volunteers.ts package.json pnpm-lock.yaml
git commit -m "feat: import volunteer sign-ups from CSV"
```

---

### Task 3: My availability page

**Files:**
- Create: `src/pages/Availability.tsx`

**Interfaces:**
- Consumes: `supabase` from `src/supabase.ts`; `useAuth()` from `src/auth.ts` (`{ isLoading, user }`, `user.email`); Task 1's tables + self/owner RLS.
- Produces: `AvailabilityPage()` (no props). Task 4 routes it.

- [ ] **Step 1: Write `src/pages/Availability.tsx`**

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  Inline,
  PageHeader,
  PageShell,
  SectionTitle,
  Spinner,
  Stack,
  Strong,
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';
import { useAuth } from '../auth';

type Frequency = 'monthly' | 'biweekly' | 'custom';

type Volunteer = {
  id: string;
  email: string;
  name: string;
  frequency: Frequency;
  frequency_note: string | null;
  backfill: boolean;
  notes: string | null;
};

const WEEKDAYS = [
  { weekday: 1, label: 'Monday' },
  { weekday: 2, label: 'Tuesday' },
  { weekday: 3, label: 'Wednesday' },
  { weekday: 4, label: 'Thursday' },
] as const;

const SLOTS = [
  { slot: '11:30', label: 'Early (11:30–12:30)' },
  { slot: '12:30', label: 'Late (12:30–1:30)' },
] as const;

const FREQUENCIES: Array<{ value: Frequency; label: string }> = [
  { value: 'monthly', label: 'Once a month' },
  { value: 'biweekly', label: 'Every other week' },
  { value: 'custom', label: 'Custom' },
];

const cellKey = (weekday: number, slot: string) => `${weekday}:${slot}`;

export function AvailabilityPage() {
  const { user } = useAuth();
  const email = (user?.email ?? '').toLowerCase();

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [volunteer, setVolunteer] = useState<Volunteer | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [frequencyNote, setFrequencyNote] = useState('');
  const [backfill, setBackfill] = useState(false);
  const [notes, setNotes] = useState('');
  const [joinName, setJoinName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!email) return;
    setError(null);
    const { data: vol, error: volError } = await supabase
      .from('volunteers')
      .select('id, email, name, frequency, frequency_note, backfill, notes')
      .eq('email', email)
      .maybeSingle();
    if (volError) {
      setError(volError.message);
      setIsLoading(false);
      return;
    }
    if (vol) {
      const v = vol as Volunteer;
      setVolunteer(v);
      setFrequency(v.frequency);
      setFrequencyNote(v.frequency_note ?? '');
      setBackfill(v.backfill);
      setNotes(v.notes ?? '');
      const { data: slots, error: availError } = await supabase
        .from('availability')
        .select('weekday, slot')
        .eq('volunteer_id', v.id);
      if (availError) {
        setError(availError.message);
      } else {
        setSelected(new Set((slots ?? []).map((s) => cellKey(s.weekday as number, s.slot as string))));
      }
    }
    setIsLoading(false);
  }, [email]);

  useEffect(() => {
    load();
  }, [load]);

  async function join(event: FormEvent) {
    event.preventDefault();
    const name = joinName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    const { error: insertError } = await supabase
      .from('volunteers')
      .insert({ email, name });
    setBusy(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setIsLoading(true);
    await load();
  }

  function toggle(weekday: number, slot: string) {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const key = cellKey(weekday, slot);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    if (!volunteer) return;
    setBusy(true);
    setError(null);
    setSaved(false);

    const { data: updated, error: updateError } = await supabase
      .from('volunteers')
      .update({
        frequency,
        frequency_note: frequency === 'custom' ? frequencyNote.trim() || null : null,
        backfill,
        notes: notes.trim() || null,
      })
      .eq('id', volunteer.id)
      .select('id');
    if (updateError || (updated ?? []).length === 0) {
      setBusy(false);
      setError(updateError?.message ?? 'Could not save your details.');
      return;
    }

    const { error: clearError } = await supabase
      .from('availability')
      .delete()
      .eq('volunteer_id', volunteer.id);
    if (clearError) {
      setBusy(false);
      setError(clearError.message);
      return;
    }
    // cellKey(1, '11:30') is "1:11:30" — weekday is everything before the
    // FIRST colon, slot is everything after it.
    const rows = [...selected].map((key) => {
      const sep = key.indexOf(':');
      return {
        volunteer_id: volunteer.id,
        weekday: Number(key.slice(0, sep)),
        slot: key.slice(sep + 1),
      };
    });
    if (rows.length > 0) {
      const { error: insertError } = await supabase.from('availability').insert(rows);
      if (insertError) {
        setBusy(false);
        setError(insertError.message);
        return;
      }
    }
    setBusy(false);
    setSaved(true);
  }

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team"
          title="My availability"
          description="Tell us when you can cover a lunch shift. Admins build the schedule from this."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}
        {saved ? <Alert tone="info" title="Saved" description="Your availability is up to date." /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : !volunteer ? (
          <Card padding="lg" surface="raised">
            <form onSubmit={join}>
              <Stack gap="md">
                <SectionTitle>Join the Green Team</SectionTitle>
                <Body>{`You're signed in as ${email}, but you're not on the volunteer roster yet.`}</Body>
                <TextField
                  label="Your name"
                  name="joinName"
                  placeholder="First Last"
                  value={joinName}
                  onChange={(e) => setJoinName(e.currentTarget.value)}
                  required
                />
                <Button type="submit" disabled={busy || !joinName.trim()}>
                  {busy ? 'Joining…' : 'Join'}
                </Button>
              </Stack>
            </form>
          </Card>
        ) : (
          <>
            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Weekly availability</SectionTitle>
                <Caption>Tap the shifts you can usually cover. Lunch shifts run Monday–Thursday.</Caption>
                <Stack gap="md">
                  {WEEKDAYS.map(({ weekday, label }) => (
                    <Stack key={weekday} gap="xs">
                      <Strong>{label}</Strong>
                      <Inline gap="sm" wrap>
                        {SLOTS.map(({ slot, label: slotLabel }) => {
                          const on = selected.has(cellKey(weekday, slot));
                          return (
                            <Button
                              key={slot}
                              variant={on ? 'primary' : 'secondary'}
                              onClick={() => toggle(weekday, slot)}
                            >
                              {on ? `✓ ${slotLabel}` : slotLabel}
                            </Button>
                          );
                        })}
                      </Inline>
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>How often</SectionTitle>
                <Inline gap="sm" wrap>
                  {FREQUENCIES.map(({ value, label }) => (
                    <Button
                      key={value}
                      variant={frequency === value ? 'primary' : 'secondary'}
                      onClick={() => {
                        setSaved(false);
                        setFrequency(value);
                      }}
                    >
                      {frequency === value ? `✓ ${label}` : label}
                    </Button>
                  ))}
                </Inline>
                {frequency === 'custom' ? (
                  <TextField
                    label="Describe your custom cadence"
                    name="frequencyNote"
                    value={frequencyNote}
                    onChange={(e) => setFrequencyNote(e.currentTarget.value)}
                  />
                ) : null}

                <Divider />

                <Inline gap="sm" align="center" wrap>
                  <Button
                    variant={backfill ? 'primary' : 'secondary'}
                    onClick={() => {
                      setSaved(false);
                      setBackfill(!backfill);
                    }}
                  >
                    {backfill ? '✓ On the emergency backfill list' : 'Join the emergency backfill list'}
                  </Button>
                  <Caption>Flexible schedule? We may ping you for last-minute gaps.</Caption>
                </Inline>

                <TextField
                  label="Notes for the coordinators"
                  name="notes"
                  placeholder="Blackout dates, alternating weeks, anything else…"
                  value={notes}
                  onChange={(e) => setNotes(e.currentTarget.value)}
                />

                <Button onClick={save} disabled={busy}>
                  {busy ? 'Saving…' : 'Save availability'}
                </Button>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </PageShell>
  );
}
```

- [ ] **Step 2: Verify compile and build**

Run: `pnpm typecheck` — expected exit 0.
Run: `pnpm build` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Availability.tsx
git commit -m "feat: self-service availability page"
```

---

### Task 4: Calendar reads the roster; nav/home rewiring

**Files:**
- Modify: `src/pages/Calendar.tsx` (query plumbing + own-shift tone; render skeleton unchanged)
- Modify: `src/App.tsx` (routes)
- Modify: `src/components/AppLayout.tsx` (nav order)

**Interfaces:**
- Consumes: Task 1's `shift_volunteers(volunteer_id)` + `volunteers(name, email)`; `AvailabilityPage` from Task 3; `useAuth()` for the signed-in email.
- Produces: home = `/calendar`; `/availability` routed.

- [ ] **Step 1: Update `src/pages/Calendar.tsx`**

Add `useAuth` to the imports:

```tsx
import { useAuth } from '../auth';
```

Replace the `Volunteer` type and `SHIFTS_SELECT`:

```tsx
type Volunteer = { id: string; name: string; email: string };
```

```tsx
// Shifts with their assigned volunteers from the roster.
const SHIFTS_SELECT = `
  id, date, slot,
  volunteers:volunteers!shift_volunteers ( id, name, email )
`;
```

Replace `shiftToEvent` (names now come from `volunteers.name`):

```tsx
function shiftToEvent(shift: Shift): CalendarEvent {
  const names = shift.volunteers
    .map((v) => v.name)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
  return {
    id: shift.id,
    title: `Green Team: ${names || 'unfilled'}`,
    description: `Lunch shift ${shift.slot}–${SLOT_END[shift.slot]} · ${names || 'no volunteers yet'}`,
    startsAt: `${shift.date}T${shift.slot}:00`,
    endsAt: `${shift.date}T${SLOT_END[shift.slot]}:00`,
  };
}
```

In `CalendarPage`, highlight the signed-in user's own shifts — replace the component body's first lines and the `<Calendar ... />` element:

```tsx
export function CalendarPage() {
  const { user } = useAuth();
  const myEmail = (user?.email ?? '').toLowerCase();
  const [viewStart, setViewStart] = useState<Date>(() => startOfWeek(new Date()));
  const { isLoading, error, shifts } = useShifts();

  const events = useMemo(() => shifts.map(shiftToEvent), [shifts]);
  const myShiftIds = useMemo(
    () =>
      new Set(
        shifts
          .filter((s) => s.volunteers.some((v) => v.email.toLowerCase() === myEmail))
          .map((s) => s.id),
      ),
    [shifts, myEmail],
  );
```

```tsx
          <Calendar
            events={events}
            viewStart={viewStart}
            onViewStartChange={setViewStart}
            defaultZoom="3"
            getEventTone={(event) => (myShiftIds.has(String(event.id)) ? 'info' : 'success')}
          />
```

Update the `PageHeader` description to match the pivot:

```tsx
        <PageHeader
          eyebrow="Green Team"
          title="Shift calendar"
          description="Lunch shifts Monday–Thursday. Shifts you're on are highlighted."
        />
```

Everything else (SLOT_END, startOfWeek, useShifts, loading/error rendering) stays as-is.

- [ ] **Step 2: Update routes in `src/App.tsx`**

Add the import:

```tsx
import { AvailabilityPage } from './pages/Availability';
```

In the approved `<Routes>` block, add after the `/calendar` route:

```tsx
        <Route path="/availability" element={<AvailabilityPage />} />
```

and change both catch-all redirects — replace:

```tsx
        <Route path="/" element={<Navigate to="/directory" replace />} />
        <Route path="*" element={<Navigate to="/directory" replace />} />
```

with:

```tsx
        <Route path="/" element={<Navigate to="/calendar" replace />} />
        <Route path="*" element={<Navigate to="/calendar" replace />} />
```

and the login redirect — replace `<Route path="/login" element={<Navigate to="/directory" replace />} />` with:

```tsx
      <Route path="/login" element={<Navigate to="/calendar" replace />} />
```

(The `/admin` non-admin redirect target stays `/directory`? No — change it to `/calendar` too, for consistency: `element={isAdmin ? <AdminPage /> : <Navigate to="/calendar" replace />}`.)

- [ ] **Step 3: Reorder nav in `src/components/AppLayout.tsx`**

Replace the `NAV_ITEMS` constant:

```tsx
const NAV_ITEMS = [
  { to: '/directory', label: 'Directory' },
  { to: '/calendar', label: 'My calendar' },
  { to: '/forms', label: 'Forms' },
  { to: '/our-pto', label: 'Our PTO' },
] as const;
```

with:

```tsx
const NAV_ITEMS = [
  { to: '/calendar', label: 'Shift calendar' },
  { to: '/availability', label: 'My availability' },
  { to: '/directory', label: 'Directory' },
  { to: '/forms', label: 'Forms' },
  { to: '/our-pto', label: 'Our PTO' },
] as const;
```

(The admin-only `Admin` NavLink block stays where it is, after the map.)

- [ ] **Step 4: Verify compile and build**

Run: `pnpm typecheck` — expected exit 0.
Run: `pnpm build` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Calendar.tsx src/App.tsx src/components/AppLayout.tsx
git commit -m "feat: calendar reads roster, availability route, scheduling-first nav"
```

---

### Task 5: Seed cleanup + verify-rls v2

**Files:**
- Modify: `scripts/seed.ts` (three removals below)
- Modify: `scripts/verify-rls.ts` (full replacement below)

**Interfaces:**
- Consumes: Task 1's table set.
- Produces: `pnpm seed` = directory mock + admin bootstrap only; `pnpm verify:rls` covers 12 tables with seeded-table awareness.

- [ ] **Step 1: Remove shift generation from `scripts/seed.ts`**

Three removals (nothing else changes):

1. In the clearing loop's table list, DELETE these two lines (shifts/assignments are real data now — seed must never wipe them):

```ts
    ['shift_volunteers', 'shift_id'],
    ['green_team_shifts', 'id'],
```

2. DELETE the entire block from the comment `// --- Green Team volunteer pool ---` through the end of the shift-generation loop (the block ends with the closing brace after the `shiftVolunteerRows.push(...)` loop, just before `// Insert in FK order:`). This removes `pool`, `shiftRows`, `shiftVolunteerRows`, and the `pad`/date loop inside `main()`.

3. In the insert/report section, DELETE these lines:

```ts
  await insertAll('green_team_shifts', shiftRows);
  await insertAll('shift_volunteers', shiftVolunteerRows);
```

```ts
  console.log(
    `Seeded ${shiftRows.length} green team shifts (${shiftVolunteerRows.length} volunteer slots, pool of ${pool.length}).`,
  );
```

Also update the header comment's idempotency line from:

```ts
 * Idempotent: deletes all existing families/parents/children/teachers first,
 * then recreates a fresh random sample. Safe to re-run.
```

to:

```ts
 * Idempotent: deletes all existing families/parents/children/teachers first,
 * then recreates a fresh random sample. Safe to re-run. Never touches the
 * real Green Team data (volunteers, availability, shifts, school calendar).
```

- [ ] **Step 2: Replace `scripts/verify-rls.ts` entirely**

```ts
/**
 * Verify RLS: unauthenticated (anon key, no session) reads must return zero
 * rows for every gated table; the service-role key must see the seeded data.
 *
 * Usage:  pnpm verify:rls   (run after pnpm seed)
 *
 * Seed-backed tables also assert service-role rows > 0. Roster/schedule
 * tables (volunteers, availability, shifts, school calendar) hold real data
 * that may legitimately be empty, so they are checked as anon-zero only.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env',
  );
}

const anonDb = createClient(url, anonKey, { auth: { persistSession: false } });
const adminDb = createClient(url, serviceKey, { auth: { persistSession: false } });

const TABLES = [
  'families',
  'parents',
  'children',
  'teachers',
  'child_past_teachers',
  'profiles',
  'admins',
  'green_team_shifts',
  'shift_volunteers',
  'volunteers',
  'availability',
  'school_year',
  'school_closures',
];

// Populated by pnpm seed — the service role must see rows here.
const SEEDED = new Set([
  'families',
  'parents',
  'children',
  'teachers',
  'child_past_teachers',
  'profiles',
  'admins',
]);

async function countRows(client: ReturnType<typeof createClient>, table: string) {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`Count failed for ${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  let failed = false;

  for (const table of TABLES) {
    const anonCount = await countRows(anonDb, table);
    const adminCount = await countRows(adminDb, table);

    const anonOk = anonCount === 0;
    const adminOk = SEEDED.has(table) ? adminCount > 0 : true;
    if (!anonOk || !adminOk) failed = true;

    const adminNote = SEEDED.has(table) ? ' (want > 0)' : '';
    console.log(
      `${anonOk && adminOk ? 'PASS' : 'FAIL'}  ${table}: anon sees ${anonCount} (want 0), ` +
        `service role sees ${adminCount}${adminNote}`,
    );
  }

  if (failed) {
    console.error('RLS verification FAILED.');
    process.exit(1);
  }
  console.log('RLS verification passed.');
}

main().catch((err) => {
  console.error('verify-rls failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm typecheck` — expected exit 0. (scripts/ is outside tsconfig include — read the diff: no dangling references to `pool`, `shiftRows`, `shiftVolunteerRows`, or the removed clear-list entries remain anywhere in seed.ts.)

```bash
git add scripts/seed.ts scripts/verify-rls.ts
git commit -m "feat: seed leaves real green team data alone, verify 13 tables"
```
