# Green Team Pivot — Plan 2 (Scheduling) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins manage the school year and no-school days, auto-generate a fair draft shift schedule from real availability, and adjust any day's roster; the calendar shows closures.

**Architecture:** A pure, deterministic scheduling library (`src/schedule.ts` — date math + `buildDraft`) is consumed by a new admin-only `/admin/schedule` page that persists via ordinary client-side supabase calls (RLS already grants admins shift/assignment/closure/year writes). The calendar adds closure events. No server code; no schema changes (Plan 1 created all tables).

**Tech Stack:** React 19, `@apygee/atoms`, `@supabase/supabase-js` v2, `crypto.randomUUID()` (browser), existing Plan-1 schema.

**Spec:** `docs/superpowers/specs/2026-09-01-green-team-pivot-design.md`

## Global Constraints

- No schema changes — Plan 1's tables/policies are final for this plan: `school_year(id=true, starts_on, ends_on)`, `school_closures(date, reason)`, `green_team_shifts(id, date, slot)`, `shift_volunteers(shift_id, volunteer_id)`, `volunteers`, `availability`.
- Generator algorithm exactly as the spec's "Schedule generation" section: school days = Mon–Thu in `[starts_on, ends_on]` minus closures; fill each shift to 2; budget per trailing 28 days (`monthly`=1, `biweekly`=2, `custom`=1); tie-breaks ratio → fewest in-range total → longest since last assignment → name ascending; same-day other-slot volunteers deprioritized (used only when the shift would otherwise stay under 2); existing assignments never removed; re-runs fill gaps only.
- All admin writes verify effect with `.select(...)` row-count checks (established pattern); buttons disable in flight; errors surface via `Alert`.
- Adding a closure also deletes that date's shifts (cascade removes assignments) and reports the count — marking a non-school day removes its shifts by intent.
- Slot literals `'11:30' | '12:30'`; weekday numbering 1=Mon…4=Thu (7=Sun in the helper, availability only uses 1–4). Dates are `YYYY-MM-DD` strings; all date math via local-midnight `Date` constructors (DST-safe), never ms arithmetic.
- UI uses only proven atoms (Alert, Body, Button, Caption, Card, Divider, Inline, NavLink, PageHeader, PageShell, SectionTitle, Spinner, Stack, Strong, TextField); toggle/choice state via Button variants.
- Every commit must leave `pnpm typecheck` passing; `pnpm build` additionally gates Tasks 2–3.
- Live verification is the controller's post-task runtime pass; browser checks are the user's.
- Branch: `green-team-pivot` (continuing after Plan 1).

---

### Task 1: Scheduling library

**Files:**
- Create: `src/schedule.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (Task 2 imports exactly these): types `Slot`, `Frequency`, `RosterVolunteer`, `AvailabilityRow`, `ShiftRow`, `AssignmentRow`, `DraftPlan`; constants `SLOTS`, `TRAILING_WINDOW_DAYS`; functions `toLocalDate(iso): Date`, `isoDate(d): string`, `weekdayOf(iso): number`, `isSchoolDay(iso, closures): boolean`, `schoolDaysBetween(from, to, closures): string[]`, `budgetFor(frequency): number`, `buildDraft(args): DraftPlan`.

- [ ] **Step 1: Write `src/schedule.ts`**

```ts
/**
 * Pure, deterministic Green Team scheduling: school-day math and the
 * draft-schedule generator. No I/O — the Schedule page fetches rows and
 * persists the returned plan.
 */

export type Slot = '11:30' | '12:30';
export const SLOTS: readonly Slot[] = ['11:30', '12:30'] as const;

export type Frequency = 'monthly' | 'biweekly' | 'custom';

export type RosterVolunteer = {
  id: string;
  name: string;
  frequency: Frequency;
  backfill: boolean;
};

export type AvailabilityRow = { volunteer_id: string; weekday: number; slot: Slot };
export type ShiftRow = { id: string; date: string; slot: Slot };
export type AssignmentRow = { shift_id: string; volunteer_id: string };

export const TRAILING_WINDOW_DAYS = 28;

/** "2026-09-08" -> local-midnight Date. */
export function toLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 1=Mon .. 7=Sun (availability.weekday uses 1-4 only). */
export function weekdayOf(iso: string): number {
  const day = toLocalDate(iso).getDay();
  return day === 0 ? 7 : day;
}

export function isSchoolDay(iso: string, closures: ReadonlySet<string>): boolean {
  const wd = weekdayOf(iso);
  return wd >= 1 && wd <= 4 && !closures.has(iso);
}

export function schoolDaysBetween(
  from: string,
  to: string,
  closures: ReadonlySet<string>,
): string[] {
  const days: string[] = [];
  const end = toLocalDate(to);
  for (
    let d = toLocalDate(from);
    d <= end;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    const iso = isoDate(d);
    if (isSchoolDay(iso, closures)) days.push(iso);
  }
  return days;
}

/** Assignments allowed per trailing 28-day window. */
export function budgetFor(frequency: Frequency): number {
  return frequency === 'biweekly' ? 2 : 1;
}

export type DraftPlan = {
  shiftInserts: ShiftRow[];
  assignmentInserts: AssignmentRow[];
  summary: {
    schoolDays: number;
    shiftsCreated: number;
    slotsFilled: number;
    unfilled: { date: string; slot: Slot; assigned: number }[];
  };
};

/**
 * Build a draft schedule for [from, to]. Deterministic: candidates are scored
 * by (trailing-28-day assignments / frequency budget), ties broken by fewest
 * in-range assignments, then longest time since last assignment (never
 * assigned wins), then name ascending. Volunteers already on the other slot
 * of the same day are used only when a shift would otherwise stay under 2.
 * Existing assignments are never removed; re-runs fill gaps only.
 */
export function buildDraft(args: {
  from: string;
  to: string;
  closures: ReadonlySet<string>;
  existingShifts: readonly ShiftRow[];
  existingAssignments: readonly AssignmentRow[];
  availability: readonly AvailabilityRow[];
  volunteers: readonly RosterVolunteer[];
  newId: () => string;
}): DraftPlan {
  const { from, to, closures, newId } = args;

  const volunteersById = new Map(args.volunteers.map((v) => [v.id, v]));

  // (weekday:slot) -> volunteer ids available then, in stable input order.
  const availableFor = new Map<string, string[]>();
  for (const row of args.availability) {
    if (!volunteersById.has(row.volunteer_id)) continue;
    const key = `${row.weekday}:${row.slot}`;
    const list = availableFor.get(key) ?? [];
    list.push(row.volunteer_id);
    availableFor.set(key, list);
  }

  const shiftsByKey = new Map(args.existingShifts.map((s) => [`${s.date}|${s.slot}`, s]));
  const shiftsById = new Map(args.existingShifts.map((s) => [s.id, s]));

  const shiftAssignees = new Map<string, Set<string>>();
  const assignedDates = new Map<string, string[]>();
  const record = (volunteerId: string, shiftId: string, date: string) => {
    let set = shiftAssignees.get(shiftId);
    if (!set) {
      set = new Set();
      shiftAssignees.set(shiftId, set);
    }
    set.add(volunteerId);
    const dates = assignedDates.get(volunteerId) ?? [];
    dates.push(date);
    assignedDates.set(volunteerId, dates);
  };
  for (const a of args.existingAssignments) {
    const shift = shiftsById.get(a.shift_id);
    if (shift) record(a.volunteer_id, a.shift_id, shift.date);
  }

  // Assignments inside [from, to] per volunteer (tie-break #2).
  const inRangeCount = new Map<string, number>();
  for (const [volId, dates] of assignedDates) {
    inRangeCount.set(volId, dates.filter((d) => d >= from && d <= to).length);
  }

  const windowStartFor = (date: string): string => {
    const d = toLocalDate(date);
    return isoDate(
      new Date(d.getFullYear(), d.getMonth(), d.getDate() - (TRAILING_WINDOW_DAYS - 1)),
    );
  };

  const pickBest = (candidateIds: string[], date: string): string | null => {
    const windowStart = windowStartFor(date);
    let best: { id: string; ratio: number; total: number; last: string } | null = null;
    for (const id of candidateIds) {
      const vol = volunteersById.get(id)!;
      const dates = assignedDates.get(id) ?? [];
      const inWindow = dates.filter((d) => d >= windowStart && d <= date).length;
      const cand = {
        id,
        ratio: inWindow / budgetFor(vol.frequency),
        total: inRangeCount.get(id) ?? 0,
        // Highest ISO date = most recent; '' sorts before everything, so
        // never-assigned volunteers win the "longest since last" tie-break.
        last: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : '',
      };
      const better =
        !best ||
        cand.ratio < best.ratio ||
        (cand.ratio === best.ratio && cand.total < best.total) ||
        (cand.ratio === best.ratio && cand.total === best.total && cand.last < best.last) ||
        (cand.ratio === best.ratio &&
          cand.total === best.total &&
          cand.last === best.last &&
          vol.name.localeCompare(volunteersById.get(best.id)!.name) < 0);
      if (better) best = cand;
    }
    return best?.id ?? null;
  };

  const shiftInserts: ShiftRow[] = [];
  const assignmentInserts: AssignmentRow[] = [];
  const unfilled: DraftPlan['summary']['unfilled'] = [];
  let slotsFilled = 0;

  const days = schoolDaysBetween(from, to, closures);
  for (const date of days) {
    const weekday = weekdayOf(date);

    // Everyone already on either slot of this date (deprioritized pool).
    const onThisDate = new Set<string>();
    for (const slot of SLOTS) {
      const existing = shiftsByKey.get(`${date}|${slot}`);
      if (existing) {
        for (const volId of shiftAssignees.get(existing.id) ?? []) onThisDate.add(volId);
      }
    }

    for (const slot of SLOTS) {
      const key = `${date}|${slot}`;
      let shift = shiftsByKey.get(key);
      if (!shift) {
        shift = { id: newId(), date, slot };
        shiftsByKey.set(key, shift);
        shiftsById.set(shift.id, shift);
        shiftInserts.push(shift);
      }

      const availableIds = availableFor.get(`${weekday}:${slot}`) ?? [];
      while ((shiftAssignees.get(shift.id)?.size ?? 0) < 2) {
        const current = shiftAssignees.get(shift.id) ?? new Set<string>();
        const fresh = availableIds.filter((id) => !current.has(id) && !onThisDate.has(id));
        const sameDay = availableIds.filter((id) => !current.has(id) && onThisDate.has(id));
        const picked = pickBest(fresh, date) ?? pickBest(sameDay, date);
        if (!picked) break;
        record(picked, shift.id, date);
        inRangeCount.set(picked, (inRangeCount.get(picked) ?? 0) + 1);
        assignmentInserts.push({ shift_id: shift.id, volunteer_id: picked });
        onThisDate.add(picked);
        slotsFilled++;
      }

      const assigned = shiftAssignees.get(shift.id)?.size ?? 0;
      if (assigned < 2) unfilled.push({ date, slot, assigned });
    }
  }

  return {
    shiftInserts,
    assignmentInserts,
    summary: {
      schoolDays: days.length,
      shiftsCreated: shiftInserts.length,
      slotsFilled,
      unfilled,
    },
  };
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm typecheck` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/schedule.ts
git commit -m "feat: deterministic schedule generator library"
```

---

### Task 2: Admin Schedule page + routing

**Files:**
- Create: `src/pages/Schedule.tsx`
- Modify: `src/App.tsx` (one import + one route)
- Modify: `src/components/AppLayout.tsx` (admin nav block)

**Interfaces:**
- Consumes: everything Task 1 produces; `supabase`, `useAuth` patterns as in `Admin.tsx`; Plan-1 RLS (admin writes on school_year/school_closures/green_team_shifts/shift_volunteers).
- Produces: `SchedulePage()` (no props) at `/admin/schedule`.

- [ ] **Step 1: Write `src/pages/Schedule.tsx`**

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
import {
  buildDraft,
  isSchoolDay,
  weekdayOf,
  type AssignmentRow,
  type AvailabilityRow,
  type DraftPlan,
  type RosterVolunteer,
  type ShiftRow,
  type Slot,
} from '../schedule';

type Closure = { date: string; reason: string | null };
type SchoolYear = { starts_on: string; ends_on: string };
type DayShift = ShiftRow & { volunteers: { id: string; name: string }[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_LABEL: Record<Slot, string> = {
  '11:30': 'Early (11:30–12:30)',
  '12:30': 'Late (12:30–1:30)',
};

async function chunkedInsert(table: string, rows: Record<string, unknown>[]): Promise<string | null> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 200));
    if (error) return error.message;
  }
  return null;
}

export function SchedulePage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // School year
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [savingYear, setSavingYear] = useState(false);

  // Closures
  const [closures, setClosures] = useState<Closure[]>([]);
  const [closureDate, setClosureDate] = useState('');
  const [closureReason, setClosureReason] = useState('');
  const [closureBusy, setClosureBusy] = useState<string | null>(null);

  // Generation
  const [genFrom, setGenFrom] = useState('');
  const [genTo, setGenTo] = useState('');
  const [generating, setGenerating] = useState(false);
  const [summary, setSummary] = useState<DraftPlan['summary'] | null>(null);

  // Day editor
  const [dayDate, setDayDate] = useState('');
  const [dayShifts, setDayShifts] = useState<DayShift[] | null>(null);
  const [roster, setRoster] = useState<RosterVolunteer[]>([]);
  const [dayAvailability, setDayAvailability] = useState<AvailabilityRow[]>([]);
  const [dayBusy, setDayBusy] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    setError(null);
    const [yearRes, closuresRes] = await Promise.all([
      supabase.from('school_year').select('starts_on, ends_on').maybeSingle(),
      supabase.from('school_closures').select('date, reason').order('date', { ascending: true }),
    ]);
    if (yearRes.error || closuresRes.error) {
      setError((yearRes.error ?? closuresRes.error)!.message);
    } else {
      if (yearRes.data) {
        const year = yearRes.data as SchoolYear;
        setStartsOn(year.starts_on);
        setEndsOn(year.ends_on);
        setGenFrom((prev) => prev || year.starts_on);
        setGenTo((prev) => prev || year.ends_on);
      }
      setClosures((closuresRes.data ?? []) as Closure[]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  async function saveYear(event: FormEvent) {
    event.preventDefault();
    if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn) || endsOn < startsOn) {
      setError('School year needs valid YYYY-MM-DD dates with the end after the start.');
      return;
    }
    setSavingYear(true);
    setError(null);
    setNotice(null);
    const { data, error: upsertError } = await supabase
      .from('school_year')
      .upsert({ id: true, starts_on: startsOn, ends_on: endsOn })
      .select('id');
    setSavingYear(false);
    if (upsertError || (data ?? []).length === 0) {
      setError(upsertError?.message ?? 'Could not save the school year.');
      return;
    }
    setNotice('School year saved.');
  }

  async function addClosure(event: FormEvent) {
    event.preventDefault();
    if (!DATE_RE.test(closureDate)) {
      setError('Closure date must be YYYY-MM-DD.');
      return;
    }
    setClosureBusy('add');
    setError(null);
    setNotice(null);
    const { data, error: insertError } = await supabase
      .from('school_closures')
      .insert({ date: closureDate, reason: closureReason.trim() || null })
      .select('date');
    if (insertError || (data ?? []).length === 0) {
      setClosureBusy(null);
      setError(insertError?.message ?? 'Could not add the closure.');
      return;
    }
    // Marking a non-school day removes its shifts (cascade removes assignments).
    const { data: removedShifts, error: deleteError } = await supabase
      .from('green_team_shifts')
      .delete()
      .eq('date', closureDate)
      .select('id');
    setClosureBusy(null);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setNotice(
      `Closure added${(removedShifts ?? []).length ? ` — removed ${removedShifts!.length} shifts on that day` : ''}.`,
    );
    setClosureDate('');
    setClosureReason('');
    await loadBase();
  }

  async function removeClosure(date: string) {
    setClosureBusy(date);
    setError(null);
    setNotice(null);
    const { data, error: deleteError } = await supabase
      .from('school_closures')
      .delete()
      .eq('date', date)
      .select('date');
    setClosureBusy(null);
    if (deleteError || (data ?? []).length === 0) {
      setError(deleteError?.message ?? 'Could not remove the closure.');
      return;
    }
    await loadBase();
  }

  async function generate() {
    if (!DATE_RE.test(genFrom) || !DATE_RE.test(genTo) || genTo < genFrom) {
      setError('Generation range needs valid YYYY-MM-DD dates with the end after the start.');
      return;
    }
    if (!startsOn || !endsOn) {
      setError('Set the school year first.');
      return;
    }
    const from = genFrom < startsOn ? startsOn : genFrom;
    const to = genTo > endsOn ? endsOn : genTo;
    setGenerating(true);
    setError(null);
    setNotice(null);
    setSummary(null);

    // Trailing window: budget scoring needs assignments up to 27 days back.
    const [wy, wm, wd] = from.split('-').map(Number);
    const windowStart = new Date(wy!, (wm ?? 1) - 1, (wd ?? 1) - 27);
    const pad = (n: number) => String(n).padStart(2, '0');
    const windowStartIso = `${windowStart.getFullYear()}-${pad(windowStart.getMonth() + 1)}-${pad(windowStart.getDate())}`;

    const [shiftsRes, availabilityRes, volunteersRes, closuresRes] = await Promise.all([
      supabase
        .from('green_team_shifts')
        .select('id, date, slot')
        .gte('date', windowStartIso)
        .lte('date', to),
      supabase.from('availability').select('volunteer_id, weekday, slot'),
      supabase.from('volunteers').select('id, name, frequency, backfill'),
      supabase.from('school_closures').select('date, reason'),
    ]);
    const fetchError =
      shiftsRes.error ?? availabilityRes.error ?? volunteersRes.error ?? closuresRes.error;
    if (fetchError) {
      setGenerating(false);
      setError(fetchError.message);
      return;
    }
    const existingShifts = (shiftsRes.data ?? []) as ShiftRow[];
    let existingAssignments: AssignmentRow[] = [];
    const shiftIds = existingShifts.map((s) => s.id);
    for (let i = 0; i < shiftIds.length; i += 150) {
      const { data, error: aErr } = await supabase
        .from('shift_volunteers')
        .select('shift_id, volunteer_id')
        .in('shift_id', shiftIds.slice(i, i + 150));
      if (aErr) {
        setGenerating(false);
        setError(aErr.message);
        return;
      }
      existingAssignments = existingAssignments.concat((data ?? []) as AssignmentRow[]);
    }

    const plan = buildDraft({
      from,
      to,
      closures: new Set(((closuresRes.data ?? []) as Closure[]).map((c) => c.date)),
      existingShifts,
      existingAssignments,
      availability: (availabilityRes.data ?? []) as AvailabilityRow[],
      volunteers: (volunteersRes.data ?? []) as RosterVolunteer[],
      newId: () => crypto.randomUUID(),
    });

    const shiftError = await chunkedInsert('green_team_shifts', plan.shiftInserts);
    if (shiftError) {
      setGenerating(false);
      setError(shiftError);
      return;
    }
    const assignError = await chunkedInsert('shift_volunteers', plan.assignmentInserts);
    setGenerating(false);
    if (assignError) {
      setError(assignError);
      return;
    }
    setSummary(plan.summary);
    if (dayShifts) await loadDay();
  }

  const loadDay = useCallback(async () => {
    if (!DATE_RE.test(dayDate)) {
      setError('Day to adjust must be YYYY-MM-DD.');
      return;
    }
    setError(null);
    const weekday = weekdayOf(dayDate);
    const [shiftsRes, rosterRes, availRes] = await Promise.all([
      supabase
        .from('green_team_shifts')
        .select('id, date, slot, volunteers:volunteers!shift_volunteers ( id, name )')
        .eq('date', dayDate),
      supabase.from('volunteers').select('id, name, frequency, backfill').order('name'),
      supabase
        .from('availability')
        .select('volunteer_id, weekday, slot')
        .eq('weekday', weekday),
    ]);
    const loadError = shiftsRes.error ?? rosterRes.error ?? availRes.error;
    if (loadError) {
      setError(loadError.message);
      return;
    }
    const shifts = ((shiftsRes.data ?? []) as unknown as DayShift[]).sort((a, b) =>
      a.slot.localeCompare(b.slot),
    );
    setDayShifts(shifts);
    setRoster((rosterRes.data ?? []) as RosterVolunteer[]);
    setDayAvailability((availRes.data ?? []) as AvailabilityRow[]);
  }, [dayDate]);

  async function addToShift(shift: DayShift, volunteerId: string) {
    setDayBusy(`${shift.id}:${volunteerId}`);
    setError(null);
    const { data, error: insertError } = await supabase
      .from('shift_volunteers')
      .insert({ shift_id: shift.id, volunteer_id: volunteerId })
      .select('shift_id');
    setDayBusy(null);
    if (insertError || (data ?? []).length === 0) {
      setError(insertError?.message ?? 'Could not add the volunteer.');
      return;
    }
    await loadDay();
  }

  async function removeFromShift(shift: DayShift, volunteerId: string) {
    setDayBusy(`${shift.id}:${volunteerId}`);
    setError(null);
    const { data, error: deleteError } = await supabase
      .from('shift_volunteers')
      .delete()
      .eq('shift_id', shift.id)
      .eq('volunteer_id', volunteerId)
      .select('shift_id');
    setDayBusy(null);
    if (deleteError || (data ?? []).length === 0) {
      setError(deleteError?.message ?? 'Could not remove the volunteer.');
      return;
    }
    await loadDay();
  }

  function candidatesFor(shift: DayShift): { available: RosterVolunteer[]; backfill: RosterVolunteer[]; others: RosterVolunteer[] } {
    const assigned = new Set(shift.volunteers.map((v) => v.id));
    const availableIds = new Set(
      dayAvailability.filter((a) => a.slot === shift.slot).map((a) => a.volunteer_id),
    );
    const available: RosterVolunteer[] = [];
    const backfill: RosterVolunteer[] = [];
    const others: RosterVolunteer[] = [];
    for (const v of roster) {
      if (assigned.has(v.id)) continue;
      if (availableIds.has(v.id)) available.push(v);
      else if (v.backfill) backfill.push(v);
      else others.push(v);
    }
    return { available, backfill, others };
  }

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Green Team · Admin"
          title="Schedule"
          description="Set the school year, mark no-school days, and generate the shift schedule."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}
        {notice ? <Alert tone="info" title="Done" description={notice} /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : (
          <>
            <Card padding="lg" surface="raised">
              <form onSubmit={saveYear}>
                <Stack gap="md">
                  <SectionTitle>School year</SectionTitle>
                  <Inline gap="md" wrap>
                    <TextField
                      label="First day"
                      name="startsOn"
                      placeholder="2026-09-08"
                      value={startsOn}
                      onChange={(e) => setStartsOn(e.currentTarget.value)}
                    />
                    <TextField
                      label="Last day"
                      name="endsOn"
                      placeholder="2027-06-18"
                      value={endsOn}
                      onChange={(e) => setEndsOn(e.currentTarget.value)}
                    />
                  </Inline>
                  <Button type="submit" disabled={savingYear}>
                    {savingYear ? 'Saving…' : 'Save school year'}
                  </Button>
                </Stack>
              </form>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>No-school days</SectionTitle>
                {closures.length === 0 ? (
                  <Body>No closures yet — holidays and vacation days go here.</Body>
                ) : (
                  <Stack gap="sm">
                    {closures.map((c) => (
                      <Inline key={c.date} gap="md" align="center" wrap>
                        <Strong>{c.date}</Strong>
                        {c.reason ? <Body>{c.reason}</Body> : null}
                        <Button
                          variant="secondary"
                          onClick={() => removeClosure(c.date)}
                          disabled={closureBusy === c.date}
                        >
                          {closureBusy === c.date ? 'Removing…' : 'Remove'}
                        </Button>
                      </Inline>
                    ))}
                  </Stack>
                )}
                <Divider />
                <form onSubmit={addClosure}>
                  <Stack gap="md">
                    <Inline gap="md" wrap>
                      <TextField
                        label="Date"
                        name="closureDate"
                        placeholder="2026-11-26"
                        value={closureDate}
                        onChange={(e) => setClosureDate(e.currentTarget.value)}
                      />
                      <TextField
                        label="Reason (optional)"
                        name="closureReason"
                        placeholder="Thanksgiving"
                        value={closureReason}
                        onChange={(e) => setClosureReason(e.currentTarget.value)}
                      />
                    </Inline>
                    <Caption>
                      Adding a closure also removes any shifts already scheduled that day.
                    </Caption>
                    <Button type="submit" disabled={closureBusy === 'add'}>
                      {closureBusy === 'add' ? 'Adding…' : 'Add no-school day'}
                    </Button>
                  </Stack>
                </form>
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Generate schedule</SectionTitle>
                <Caption>
                  Fills every school-day shift up to 2 volunteers from availability, respecting how
                  often each person wants to serve. Existing assignments are kept.
                </Caption>
                <Inline gap="md" wrap>
                  <TextField
                    label="From"
                    name="genFrom"
                    placeholder="2026-09-08"
                    value={genFrom}
                    onChange={(e) => setGenFrom(e.currentTarget.value)}
                  />
                  <TextField
                    label="To"
                    name="genTo"
                    placeholder="2026-12-18"
                    value={genTo}
                    onChange={(e) => setGenTo(e.currentTarget.value)}
                  />
                </Inline>
                <Button onClick={generate} disabled={generating}>
                  {generating ? 'Generating…' : 'Generate draft'}
                </Button>
                {summary ? (
                  <Stack gap="xs">
                    <Body>
                      {`${summary.schoolDays} school days · ${summary.shiftsCreated} new shifts · ${summary.slotsFilled} slots filled`}
                    </Body>
                    {summary.unfilled.length > 0 ? (
                      <Caption>
                        {`Understaffed: ${summary.unfilled
                          .map((u) => `${u.date} ${SLOT_LABEL[u.slot]} (${u.assigned}/2)`)
                          .join(', ')}`}
                      </Caption>
                    ) : (
                      <Caption>Every shift has 2 volunteers.</Caption>
                    )}
                  </Stack>
                ) : null}
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Adjust a day</SectionTitle>
                <Inline gap="md" align="center" wrap>
                  <TextField
                    label="Date"
                    name="dayDate"
                    placeholder="2026-09-15"
                    value={dayDate}
                    onChange={(e) => setDayDate(e.currentTarget.value)}
                  />
                  <Button onClick={loadDay}>Load day</Button>
                </Inline>

                {dayShifts === null ? null : dayShifts.length === 0 ? (
                  <Body>
                    {isSchoolDay(dayDate, new Set(closures.map((c) => c.date)))
                      ? 'No shifts exist for this date yet — generate the schedule first.'
                      : 'Not a school day (weekend or closure).'}
                  </Body>
                ) : (
                  <Stack gap="lg">
                    {dayShifts.map((shift) => {
                      const groups = candidatesFor(shift);
                      return (
                        <Stack key={shift.id} gap="sm">
                          <Strong>{SLOT_LABEL[shift.slot]}</Strong>
                          {shift.volunteers.length === 0 ? (
                            <Body>Nobody assigned.</Body>
                          ) : (
                            <Stack gap="xs">
                              {shift.volunteers.map((v) => (
                                <Inline key={v.id} gap="sm" align="center" wrap>
                                  <Body>{v.name}</Body>
                                  <Button
                                    variant="secondary"
                                    onClick={() => removeFromShift(shift, v.id)}
                                    disabled={dayBusy === `${shift.id}:${v.id}`}
                                  >
                                    {dayBusy === `${shift.id}:${v.id}` ? 'Removing…' : 'Remove'}
                                  </Button>
                                </Inline>
                              ))}
                            </Stack>
                          )}
                          {(
                            [
                              ['Available', groups.available],
                              ['Backfill list', groups.backfill],
                              ['Everyone else', groups.others],
                            ] as const
                          ).map(([label, group]) =>
                            group.length === 0 ? null : (
                              <Stack key={label} gap="xs">
                                <Caption>{label}</Caption>
                                <Inline gap="sm" wrap>
                                  {group.map((v) => (
                                    <Button
                                      key={v.id}
                                      variant="ghost"
                                      onClick={() => addToShift(shift, v.id)}
                                      disabled={dayBusy === `${shift.id}:${v.id}`}
                                    >
                                      {dayBusy === `${shift.id}:${v.id}` ? 'Adding…' : `+ ${v.name}`}
                                    </Button>
                                  ))}
                                </Inline>
                              </Stack>
                            ),
                          )}
                          <Divider />
                        </Stack>
                      );
                    })}
                  </Stack>
                )}
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </PageShell>
  );
}
```

- [ ] **Step 2: Route in `src/App.tsx`**

Add the import:

```tsx
import { SchedulePage } from './pages/Schedule';
```

Add after the `/admin` route:

```tsx
        <Route
          path="/admin/schedule"
          element={isAdmin ? <SchedulePage /> : <Navigate to="/calendar" replace />}
        />
```

- [ ] **Step 3: Admin nav in `src/components/AppLayout.tsx`**

Replace the existing admin NavLink block:

```tsx
              {isAdmin ? (
                <NavLink to="/admin" end>
                  Admin
                </NavLink>
              ) : null}
```

with:

```tsx
              {isAdmin ? (
                <>
                  <NavLink to="/admin" end>
                    Admin
                  </NavLink>
                  <NavLink to="/admin/schedule" end>
                    Schedule
                  </NavLink>
                </>
              ) : null}
```

- [ ] **Step 4: Verify compile and build**

Run: `pnpm typecheck` — expected exit 0.
Run: `pnpm build` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Schedule.tsx src/App.tsx src/components/AppLayout.tsx
git commit -m "feat: admin schedule page — school year, closures, generator, day editor"
```

---

### Task 3: Closures on the calendar

**Files:**
- Modify: `src/pages/Calendar.tsx` (closure fetch + events + tone)

**Interfaces:**
- Consumes: `school_closures(date, reason)`; existing `useShifts`/`shiftToEvent`/tone plumbing.
- Produces: nothing — page-internal.

- [ ] **Step 1: Extend `src/pages/Calendar.tsx`**

Add a closure type and mapper after the `Shift` type:

```tsx
type Closure = { date: string; reason: string | null };

// Closures render as labeled all-school-hours events; no shifts exist on
// these days so they never compete for lanes.
function closureToEvent(closure: Closure): CalendarEvent {
  return {
    id: `closure-${closure.date}`,
    title: closure.reason ? `No school · ${closure.reason}` : 'No school',
    startsAt: `${closure.date}T08:00:00`,
    endsAt: `${closure.date}T15:00:00`,
  };
}
```

In `useShifts`, fetch closures alongside shifts — replace the hook's state type and effect body:

```tsx
type ShiftsResult = {
  isLoading: boolean;
  error: { message: string } | null;
  shifts: Shift[];
  closures: Closure[];
};

function useShifts(): ShiftsResult {
  const [result, setResult] = useState<ShiftsResult>({
    isLoading: true,
    error: null,
    shifts: [],
    closures: [],
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from('green_team_shifts').select(SHIFTS_SELECT),
      supabase.from('school_closures').select('date, reason'),
    ]).then(([shiftsRes, closuresRes]) => {
      if (cancelled) return;
      setResult({
        isLoading: false,
        error: shiftsRes.error ?? closuresRes.error,
        shifts: (shiftsRes.data ?? []) as unknown as Shift[],
        closures: (closuresRes.data ?? []) as Closure[],
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}
```

In `CalendarPage`, consume closures and merge events — replace the destructure and the `events` memo:

```tsx
  const { isLoading, error, shifts, closures } = useShifts();

  const events = useMemo(
    () => [...shifts.map(shiftToEvent), ...closures.map(closureToEvent)],
    [shifts, closures],
  );
```

and extend the tone callback:

```tsx
            getEventTone={(event) => {
              const id = String(event.id);
              if (id.startsWith('closure-')) return 'neutral';
              return myShiftIds.has(id) ? 'primary' : 'success';
            }}
```

- [ ] **Step 2: Verify compile and build**

Run: `pnpm typecheck` — expected exit 0.
Run: `pnpm build` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Calendar.tsx
git commit -m "feat: render no-school days on the calendar"
```
