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
