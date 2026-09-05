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

/** Weeks between assignments: biweekly = 2, monthly/custom = 4. */
export function intervalWeeksFor(frequency: Frequency): number {
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
  };
};

/**
 * Build a draft schedule for [from, to] — person-centric, not coverage-
 * centric. Every school day gets its two shift rows, then each volunteer
 * (name order) is walked through the range at their own cadence
 * (biweekly = every 2 weeks, monthly/custom = every 4), rotating through
 * their availability cells so someone available for both slots alternates
 * early/late across assignments. Empty slots are expected and fine —
 * volunteers claim them from the public schedule. Shifts cap at 2 people.
 * Existing assignments are never removed and anchor each volunteer's
 * cadence, so re-runs only extend a schedule.
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

  const shiftsByKey = new Map(args.existingShifts.map((s) => [`${s.date}|${s.slot}`, s]));
  const shiftsById = new Map(args.existingShifts.map((s) => [s.id, s]));

  const shiftAssignees = new Map<string, Set<string>>();
  const assignedDates = new Map<string, Set<string>>();
  const record = (volunteerId: string, shiftId: string, date: string) => {
    let set = shiftAssignees.get(shiftId);
    if (!set) {
      set = new Set();
      shiftAssignees.set(shiftId, set);
    }
    set.add(volunteerId);
    let dates = assignedDates.get(volunteerId);
    if (!dates) {
      dates = new Set();
      assignedDates.set(volunteerId, dates);
    }
    dates.add(date);
  };
  for (const a of args.existingAssignments) {
    const shift = shiftsById.get(a.shift_id);
    if (shift) record(a.volunteer_id, a.shift_id, shift.date);
  }

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

  // Week math: week 0 starts the Monday of `from`'s week.
  const fromDate = toLocalDate(from);
  const origin = new Date(
    fromDate.getFullYear(),
    fromDate.getMonth(),
    fromDate.getDate() - (weekdayOf(from) - 1),
  );
  const weekOf = (iso: string): number =>
    Math.floor((toLocalDate(iso).getTime() - origin.getTime()) / (7 * 24 * 3600 * 1000));
  const dateOf = (week: number, weekday: number): string =>
    isoDate(
      new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + week * 7 + weekday - 1),
    );
  const maxWeek = weekOf(to);

  const cellsByVolunteer = new Map<string, AvailabilityRow[]>();
  for (const row of args.availability) {
    const list = cellsByVolunteer.get(row.volunteer_id) ?? [];
    list.push(row);
    cellsByVolunteer.set(row.volunteer_id, list);
  }

  const assignmentInserts: AssignmentRow[] = [];
  const volunteers = [...args.volunteers].sort((a, b) => a.name.localeCompare(b.name));
  for (const volunteer of volunteers) {
    const cells = (cellsByVolunteer.get(volunteer.id) ?? [])
      .slice()
      .sort((a, b) => a.weekday - b.weekday || a.slot.localeCompare(b.slot));
    if (cells.length === 0) continue;

    const interval = intervalWeeksFor(volunteer.frequency);
    const myDates = assignedDates.get(volunteer.id) ?? new Set<string>();
    // Rotation continues across re-runs; last assignment anchors the cadence.
    let rotation = [...myDates].filter((d) => d >= from && d <= to).length;
    const last = [...myDates].reduce((a, b) => (a > b ? a : b), '');
    let week = last ? Math.max(weekOf(last) + interval, 0) : 0;

    while (week <= maxWeek) {
      let placed = false;
      for (let c = 0; c < cells.length && !placed; c++) {
        const cell = cells[(rotation + c) % cells.length]!;
        const date = dateOf(week, cell.weekday);
        if (date < from || date > to || !isSchoolDay(date, closures)) continue;
        const shift = shiftsByKey.get(`${date}|${cell.slot}`);
        if (!shift) continue;
        if ((shiftAssignees.get(shift.id)?.size ?? 0) >= 2) continue;
        if (myDates.has(date)) continue;
        record(volunteer.id, shift.id, date);
        assignmentInserts.push({ shift_id: shift.id, volunteer_id: volunteer.id });
        rotation++;
        placed = true;
      }
      // A week that can't take them (closure, full shifts) slides the
      // cadence by one week instead of dropping the assignment.
      week += placed ? interval : 1;
    }
  }

  let openSlots = 0;
  for (const date of days) {
    for (const slot of SLOTS) {
      const shift = shiftsByKey.get(`${date}|${slot}`)!;
      if ((shiftAssignees.get(shift.id)?.size ?? 0) < 2) openSlots++;
    }
  }

  return {
    shiftInserts,
    assignmentInserts,
    summary: {
      schoolDays: days.length,
      shiftsCreated: shiftInserts.length,
      assignments: assignmentInserts.length,
      openSlots,
    },
  };
}
