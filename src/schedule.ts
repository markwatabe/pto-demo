/**
 * Pure, deterministic Green Team scheduling: school-day math and the
 * draft-schedule generator. No I/O — the Schedule page fetches rows and
 * persists the returned plan.
 */

export type Slot = 'early' | 'late';
export const SLOTS: readonly Slot[] = ['early', 'late'] as const;

/** The single source of truth for shift clock times (local school time). */
export const SLOT_TIMES: Record<Slot, { start: string; end: string }> = {
  early: { start: '11:05', end: '12:15' },
  late: { start: '12:20', end: '13:30' },
};

export const SLOT_LABEL: Record<Slot, string> = {
  early: 'Early (11:05–12:15)',
  late: 'Late (12:20–1:30)',
};

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'custom';

export type RosterVolunteer = {
  id: string;
  name: string;
  frequency: Frequency;
  backfill: boolean;
  /** Veterans may take a shift alone; new volunteers must pair with one. */
  veteran: boolean;
  /** Consecutive shifts must alternate early/late (when both slots are in their availability). */
  alternate?: boolean;
};

export type AvailabilityRow = { volunteer_id: string; weekday: number; slot: Slot };
/**
 * An inclusive date window a volunteer can't do (vacation etc.). With a
 * `weekday` (1=Mon..4=Thu) only that weekday inside the window is blocked.
 */
export type BlackoutRow = {
  volunteer_id: string;
  starts_on: string;
  ends_on: string;
  weekday?: number | null;
};
/** Standing rule: always on this weekday/slot, placed before anything else. */
export type FixedShiftRow = { volunteer_id: string; weekday: number; slot: Slot };
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

/** True when `iso` falls inside any of the volunteer's blackout windows. */
export function isBlackedOut(
  volunteerId: string,
  iso: string,
  blackouts: readonly BlackoutRow[],
): boolean {
  return blackouts.some(
    (b) =>
      b.volunteer_id === volunteerId &&
      iso >= b.starts_on &&
      iso <= b.ends_on &&
      (b.weekday == null || b.weekday === weekdayOf(iso)),
  );
}

/** Weeks between assignments: weekly = 1, biweekly = 2, monthly/custom = 4. */
export function intervalWeeksFor(frequency: Frequency): number {
  if (frequency === 'weekly') return 1;
  return frequency === 'biweekly' ? 2 : 4;
}

export type DraftPlan = {
  shiftInserts: ShiftRow[];
  assignmentInserts: AssignmentRow[];
  summary: {
    schoolDays: number;
    shiftsCreated: number;
    assignments: number;
    /** Shift slots in range still holding fewer than 2 people — fine; volunteers can claim them. */
    openSlots: number;
    /** Shifts in range with nobody at all — no eligible veteran was free. */
    emptyShifts: number;
  };
};

/**
 * Build a draft schedule for [from, to]. Priorities, in order:
 *
 *  1. Respect every volunteer's rules: only their availability cells, never
 *     inside one of their blackout windows, never two shifts closer
 *     together than their cadence (weekly = 1 week apart, biweekly = 2,
 *     monthly/custom = 4), and for "alternate" volunteers never the same
 *     slot as the shift before or after.
 *  0. Fixed shifts: anyone with a standing weekday/slot rule is placed on
 *     every such school day first (still skipping their blackouts). Then
 *     alternating volunteers are walked through the range in date order at
 *     their cadence, flipping early/late each time — they need sequence,
 *     which the scarcity-driven passes below can't give them.
 *  2. Fill every shift with at least one person. Only veterans may hold a
 *     shift alone, so this pass places veterans — hardest-to-fill shifts
 *     first, always choosing the person furthest behind their cadence.
 *  3. Double up: add a second person wherever someone eligible remains.
 *     New volunteers only ever join a shift that already has a veteran.
 *
 * Every school day gets both shift rows whether or not anyone is placed;
 * volunteers claim open slots from the public schedule. Shifts cap at 2.
 * Existing assignments are never removed and count toward each person's
 * cadence, so re-runs only extend a schedule.
 */
export function buildDraft(args: {
  from: string;
  to: string;
  closures: ReadonlySet<string>;
  existingShifts: readonly ShiftRow[];
  existingAssignments: readonly AssignmentRow[];
  availability: readonly AvailabilityRow[];
  blackouts?: readonly BlackoutRow[];
  fixedShifts?: readonly FixedShiftRow[];
  volunteers: readonly RosterVolunteer[];
  newId: () => string;
}): DraftPlan {
  const { from, to, closures, newId } = args;
  const blackouts = args.blackouts ?? [];
  const fixedShifts = args.fixedShifts ?? [];

  const shiftsByKey = new Map(args.existingShifts.map((s) => [`${s.date}|${s.slot}`, s]));
  const shiftsById = new Map(args.existingShifts.map((s) => [s.id, s]));

  // Every school day in range gets both shift rows, assigned or not — the
  // public schedule renders them all and lets volunteers claim open ones.
  const shiftInserts: ShiftRow[] = [];
  const days = schoolDaysBetween(from, to, closures);
  for (const date of days) {
    for (const slot of SLOTS) {
      const key = `${date}|${slot}`;
      if (!shiftsByKey.has(key)) {
        const shift = { id: newId(), date, slot };
        shiftsByKey.set(key, shift);
        shiftsById.set(shift.id, shift);
        shiftInserts.push(shift);
      }
    }
  }

  // Week math: week 0 starts the Monday of `from`'s week. Assignments before
  // `from` land in negative weeks and still count for cadence spacing.
  const fromDate = toLocalDate(from);
  const origin = new Date(
    fromDate.getFullYear(),
    fromDate.getMonth(),
    fromDate.getDate() - (weekdayOf(from) - 1),
  );
  const weekOf = (iso: string): number =>
    Math.floor((toLocalDate(iso).getTime() - origin.getTime()) / (7 * 24 * 3600 * 1000));
  const weeksInRange = weekOf(to) + 1;

  const volunteersById = new Map(args.volunteers.map((v) => [v.id, v]));
  const cellsByVolunteer = new Map<string, Set<string>>();
  for (const row of args.availability) {
    let cells = cellsByVolunteer.get(row.volunteer_id);
    if (!cells) {
      cells = new Set();
      cellsByVolunteer.set(row.volunteer_id, cells);
    }
    cells.add(`${row.weekday}|${row.slot}`);
  }

  const shiftAssignees = new Map<string, Set<string>>();
  const weeksByVolunteer = new Map<string, number[]>();
  const takenByVolunteer = new Map<string, { date: string; slot: Slot }[]>();
  const inRangeCount = new Map<string, number>();
  const record = (volunteerId: string, shift: ShiftRow) => {
    let set = shiftAssignees.get(shift.id);
    if (!set) {
      set = new Set();
      shiftAssignees.set(shift.id, set);
    }
    set.add(volunteerId);
    const weeks = weeksByVolunteer.get(volunteerId) ?? [];
    weeks.push(weekOf(shift.date));
    weeksByVolunteer.set(volunteerId, weeks);
    const taken = takenByVolunteer.get(volunteerId) ?? [];
    taken.push({ date: shift.date, slot: shift.slot });
    takenByVolunteer.set(volunteerId, taken);
    if (shift.date >= from && shift.date <= to) {
      inRangeCount.set(volunteerId, (inRangeCount.get(volunteerId) ?? 0) + 1);
    }
  };
  for (const a of args.existingAssignments) {
    const shift = shiftsById.get(a.shift_id);
    if (shift) record(a.volunteer_id, shift);
  }

  const shiftsInRange = days.flatMap((date) =>
    SLOTS.map((slot) => shiftsByKey.get(`${date}|${slot}`)!),
  );
  const hasVeteran = (shiftId: string): boolean =>
    [...(shiftAssignees.get(shiftId) ?? [])].some((id) => volunteersById.get(id)?.veteran);

  // Alternation applies only to people who can actually do both slots.
  const canAlternate = (volunteer: RosterVolunteer): boolean => {
    if (!volunteer.alternate) return false;
    const cells = cellsByVolunteer.get(volunteer.id);
    if (!cells) return false;
    let early = false;
    let late = false;
    for (const c of cells) {
      if (c.endsWith('|early')) early = true;
      if (c.endsWith('|late')) late = true;
    }
    return early && late;
  };
  // The slot they'd need next to this date: the opposite of the nearest
  // assignment before AND after it. Null when nothing constrains it.
  const alternationClash = (volunteer: RosterVolunteer, shift: ShiftRow): boolean => {
    if (!canAlternate(volunteer)) return false;
    const taken = takenByVolunteer.get(volunteer.id) ?? [];
    let before: { date: string; slot: Slot } | undefined;
    let after: { date: string; slot: Slot } | undefined;
    for (const t of taken) {
      if (t.date < shift.date && (!before || t.date > before.date)) before = t;
      if (t.date > shift.date && (!after || t.date < after.date)) after = t;
    }
    return before?.slot === shift.slot || after?.slot === shift.slot;
  };

  // Rule check: the cell is in their availability, the date isn't blacked
  // out, no other assignment of theirs sits within `interval` weeks, and
  // an alternating volunteer isn't repeating the slot of a neighbour.
  const canTake = (volunteer: RosterVolunteer, shift: ShiftRow): boolean => {
    if (!cellsByVolunteer.get(volunteer.id)?.has(`${weekdayOf(shift.date)}|${shift.slot}`)) {
      return false;
    }
    if (isBlackedOut(volunteer.id, shift.date, blackouts)) return false;
    if (alternationClash(volunteer, shift)) return false;
    if (shiftAssignees.get(shift.id)?.has(volunteer.id)) return false;
    const interval = intervalWeeksFor(volunteer.frequency);
    const week = weekOf(shift.date);
    return (weeksByVolunteer.get(volunteer.id) ?? []).every((w) => Math.abs(w - week) >= interval);
  };

  // How many shifts in range they could take at their cadence, and how many
  // shifts in range match their availability at all (less flexible people
  // are placed first on ties so flexible ones stay free for hard slots).
  const target = new Map<string, number>();
  const flexibility = new Map<string, number>();
  for (const v of args.volunteers) {
    target.set(v.id, Math.max(1, Math.ceil(weeksInRange / intervalWeeksFor(v.frequency))));
    const cells = cellsByVolunteer.get(v.id);
    flexibility.set(
      v.id,
      cells ? shiftsInRange.filter((s) => cells.has(`${weekdayOf(s.date)}|${s.slot}`)).length : 0,
    );
  }
  const behind = (id: string) => (inRangeCount.get(id) ?? 0) / target.get(id)!;
  const byNeed = (a: RosterVolunteer, b: RosterVolunteer) =>
    behind(a.id) - behind(b.id) ||
    flexibility.get(a.id)! - flexibility.get(b.id)! ||
    a.name.localeCompare(b.name);

  const assignmentInserts: AssignmentRow[] = [];

  // Repeatedly take the shift with the fewest eligible candidates (hardest
  // to fill) and give it to the candidate furthest behind their cadence,
  // until no shift in the pool can take anyone.
  const fillPass = (
    inPool: (shift: ShiftRow) => boolean,
    candidates: (shift: ShiftRow) => readonly RosterVolunteer[],
  ) => {
    for (;;) {
      let best: { shift: ShiftRow; eligible: RosterVolunteer[] } | null = null;
      for (const shift of shiftsInRange) {
        if (!inPool(shift)) continue;
        const eligible = candidates(shift).filter((v) => canTake(v, shift));
        if (eligible.length === 0) continue;
        if (!best || eligible.length < best.eligible.length) best = { shift, eligible };
      }
      if (!best) return;
      const pick = [...best.eligible].sort(byNeed)[0]!;
      record(pick.id, best.shift);
      assignmentInserts.push({ shift_id: best.shift.id, volunteer_id: pick.id });
    }
  };

  const size = (shift: ShiftRow) => shiftAssignees.get(shift.id)?.size ?? 0;
  const veterans = args.volunteers.filter((v) => v.veteran);

  // Pass 0 — standing rules, regardless of cadence (but never on a blackout
  // day, never onto a full shift, and a new volunteer still needs a veteran).
  for (const shift of shiftsInRange) {
    for (const rule of fixedShifts) {
      if (rule.weekday !== weekdayOf(shift.date) || rule.slot !== shift.slot) continue;
      const volunteer = volunteersById.get(rule.volunteer_id);
      if (!volunteer || size(shift) >= 2) continue;
      if (shiftAssignees.get(shift.id)?.has(volunteer.id)) continue;
      if (isBlackedOut(volunteer.id, shift.date, blackouts)) continue;
      if (!volunteer.veteran && !hasVeteran(shift.id)) continue;
      record(volunteer.id, shift);
      assignmentInserts.push({ shift_id: shift.id, volunteer_id: volunteer.id });
    }
  }

  // Pass 0b — alternators, chronologically at their cadence. A week with no
  // usable shift slides the cadence by one week rather than dropping a turn.
  const maxWeek = weeksInRange - 1;
  const dayWeek = new Map(days.map((d) => [d, weekOf(d)]));
  for (const volunteer of [...args.volunteers].sort(byNeed)) {
    if (!canAlternate(volunteer)) continue;
    const interval = intervalWeeksFor(volunteer.frequency);
    const taken = takenByVolunteer.get(volunteer.id) ?? [];
    const last = taken.reduce<{ date: string; slot: Slot } | undefined>(
      (a, b) => (!a || b.date > a.date ? b : a),
      undefined,
    );
    let want: Slot = last ? (last.slot === 'early' ? 'late' : 'early') : 'early';
    let week = last ? weekOf(last.date) + interval : 0;
    while (week <= maxWeek) {
      const options = shiftsInRange
        .filter((sh) => dayWeek.get(sh.date) === week && sh.slot === want && canTake(volunteer, sh))
        .filter((sh) => size(sh) < 2 && (volunteer.veteran || hasVeteran(sh.id)))
        .sort((a, b) => size(a) - size(b) || a.date.localeCompare(b.date));
      const pick = options[0];
      if (pick) {
        record(volunteer.id, pick);
        assignmentInserts.push({ shift_id: pick.id, volunteer_id: volunteer.id });
        want = want === 'early' ? 'late' : 'early';
        week += interval;
      } else {
        week += 1;
      }
    }
  }

  // Pass 1 — cover every empty shift with one veteran.
  fillPass(
    (shift) => size(shift) === 0,
    () => veterans,
  );
  // Pass 2 — double up. New volunteers may only join a veteran.
  fillPass(
    (shift) => size(shift) === 1,
    (shift) => (hasVeteran(shift.id) ? args.volunteers : veterans),
  );

  let openSlots = 0;
  let emptyShifts = 0;
  for (const shift of shiftsInRange) {
    if (size(shift) < 2) openSlots++;
    if (size(shift) === 0) emptyShifts++;
  }

  return {
    shiftInserts,
    assignmentInserts,
    summary: {
      schoolDays: days.length,
      shiftsCreated: shiftInserts.length,
      assignments: assignmentInserts.length,
      openSlots,
      emptyShifts,
    },
  };
}
