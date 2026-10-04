/**
 * The three-shift lunch model (coordinator, 2026-09-30), replacing
 * early/late. Pure: no I/O. `planDay` places the people already committed
 * to a date into the new shifts (it never moves anyone to another day);
 * `fillShifts` then fills the remaining seats from the roster.
 */
import {
  isBlackedOut,
  toLocalDate,
  weekdayOf,
  type AvailabilityRow,
  type BlackoutRow,
  type FixedShiftRow,
  type Frequency,
  type Slot,
} from './schedule';

export type NewShift = 'first' | 'second' | 'third';
export const NEW_SHIFTS: readonly NewShift[] = ['first', 'second', 'third'] as const;

export const NEW_SHIFT_INFO: Record<
  NewShift,
  {
    label: string; start: string; end: string; time: string; grades: string; target: number;
    /** Each grade group's lunch within the shift, in order. */
    lunches: readonly { grades: string; time: string }[];
  }
> = {
  first: {
    label: 'First', start: '11:05', end: '12:00', time: '11:05–12:00', grades: '4th & 5th', target: 2,
    lunches: [{ grades: '4th', time: '11:05–11:30' }, { grades: '5th', time: '11:35–12:00' }],
  },
  second: {
    label: 'Second', start: '12:05', end: '13:00', time: '12:05–1:00', grades: 'K, 1st & 2nd', target: 2,
    lunches: [{ grades: 'K & 2nd', time: '12:05–12:30' }, { grades: '1st', time: '12:35–1:00' }],
  },
  third: {
    label: 'Third', start: '13:20', end: '13:45', time: '1:20–1:45', grades: '3rd', target: 1,
    lunches: [{ grades: '3rd', time: '1:20–1:45' }],
  },
};

/**
 * Availability as the scheduler should see it: for volunteers whose prefs set
 * `anyTime`, every weekday they offered counts for both early and late.
 */
export function withAnyTime(
  availability: readonly AvailabilityRow[],
  anyTime: (volunteerId: string) => boolean,
): AvailabilityRow[] {
  const result = [...availability];
  const have = new Set(availability.map((r) => `${r.volunteer_id}|${r.weekday}|${r.slot}`));
  for (const r of availability) {
    if (!anyTime(r.volunteer_id)) continue;
    for (const slot of ['early', 'late'] as const) {
      const key = `${r.volunteer_id}|${r.weekday}|${slot}`;
      if (!have.has(key)) { have.add(key); result.push({ volunteer_id: r.volunteer_id, weekday: r.weekday, slot }); }
    }
  }
  return result;
}

/** What they accepted under the old model. */
export type AcceptedKind = 'early' | 'late' | 'both shifts';

export type DayVolunteer = {
  id: string;
  name: string;
  accepted: AcceptedKind;
  /** Only parents of a 3rd grader may take the third shift. */
  thirdGrader: boolean;
  /** Only parents of a 4th or 5th grader may take the first shift (coordinator, 2026-10-04). */
  fourthOrFifthGrader: boolean;
  veteran: boolean;
  /** Old slots they said they can do on this weekday. */
  available: readonly Slot[];
  /** Restrict to these shifts (see ShiftPrefs.only). */
  only?: readonly NewShift[];
  /** Always takes all of these shifts on a day they work (see ShiftPrefs.together). */
  together?: readonly NewShift[];
};

/**
 * How far a new shift is from what they signed up for ("offered" = the slot
 * they accepted plus their stated availability for that weekday):
 *   0 — inside the window they accepted (early → first, late → third)
 *   1 — late → second: same afternoon, starting 15 minutes earlier
 *   2 — a different part of lunch they still offered
 *   3 — early-only → second: runs 40 minutes past what they offered
 *   4 — no overlap with anything they offered
 * 3 and up count as outside what they offered.
 */
export function timeChangeCost(v: Pick<DayVolunteer, 'accepted' | 'available'>, shift: NewShift): number {
  if (v.accepted === 'both shifts') return 0;
  const offers = (s: Slot) => v.accepted === s || v.available.includes(s);
  if (shift === 'first') return v.accepted === 'early' ? 0 : offers('early') ? 2 : 4;
  if (shift === 'third') return v.accepted === 'late' ? 0 : offers('late') ? 2 : 4;
  return v.accepted === 'late' ? 1 : offers('late') ? 2 : 3;
}
export const OUTSIDE_OFFERED = 3;

export type DayPlan = Record<NewShift, DayVolunteer[]> & {
  /** More people than seats that day — nobody is dropped silently. */
  extra: DayVolunteer[];
};

/**
 * Seat one day's committed volunteers, one shift each (or their `together`
 * pair). Hard rules: at most two per first/second shift, one on the third,
 * only a 4th or 5th grade parent on the first and only a 3rd-grade parent on
 * the third. Among valid seatings, prefer (in order):
 *   1. everyone seated
 *   2. fewer people moved outside the time they offered (they'd likely decline)
 *   3. people with a `together` preference get their whole set
 *   4. more shifts with at least one parent
 *   5. fewer shifts where a new volunteer has no veteran beside them
 *   6. the smallest total change from the time they accepted
 */
export function planDay(people: readonly DayVolunteer[]): DayPlan {
  type Pick = readonly NewShift[] | 'extra';
  const sorted = [...people].sort((a, b) => a.name.localeCompare(b.name));
  const optionsFor = (v: DayVolunteer): Pick[] => [
    ...(v.together ? [v.together] : []),
    ...NEW_SHIFTS.filter((s) => !v.together || v.together.includes(s)).map((s) => [s]),
    'extra',
  ];
  let best: { score: number[]; picks: Pick[] } | null = null;
  const picks: Pick[] = [];

  const score = (): number[] => {
    const seated: Record<NewShift, DayVolunteer[]> = { first: [], second: [], third: [] };
    let extra = 0;
    let outside = 0;
    let broken = 0;
    let cost = 0;
    sorted.forEach((v, i) => {
      const p = picks[i]!;
      if (p === 'extra') { extra++; return; }
      if (v.together && p.length < v.together.length) broken++;
      for (const s of p) {
        seated[s].push(v);
        const c = timeChangeCost(v, s);
        cost += c;
        if (c >= OUTSIDE_OFFERED) outside++;
      }
    });
    const covered = NEW_SHIFTS.filter((s) => seated[s].length > 0).length;
    const unpaired = NEW_SHIFTS.filter(
      (s) => seated[s].some((v) => !v.veteran) && !seated[s].some((v) => v.veteran),
    ).length;
    return [extra, outside, broken, -covered, unpaired, cost];
  };
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return false;
  };
  const count = (s: NewShift) => picks.filter((p) => p !== 'extra' && p.includes(s)).length;

  const walk = (i: number) => {
    if (i === sorted.length) {
      const s = score();
      if (!best || better(s, best.score)) best = { score: s, picks: [...picks] };
      return;
    }
    const v = sorted[i]!;
    for (const option of optionsFor(v)) {
      if (option !== 'extra') {
        if (option.includes('third') && !v.thirdGrader) continue;
        if (option.includes('first') && !v.fourthOrFifthGrader) continue;
        if (v.only && option.some((s) => !v.only!.includes(s))) continue;
        if (option.some((s) => count(s) >= NEW_SHIFT_INFO[s].target)) continue;
      }
      picks.push(option);
      walk(i + 1);
      picks.pop();
    }
  };
  walk(0);

  const plan: DayPlan = { first: [], second: [], third: [], extra: [] };
  const chosen = (best as { picks: Pick[] } | null)?.picks ?? [];
  sorted.forEach((v, i) => {
    const p = chosen[i] ?? 'extra';
    if (p === 'extra') plan.extra.push(v);
    else for (const s of p) plan[s].push(v);
  });
  return plan;
}

/**
 * Which half of the old sign-up availability a new shift draws on. Sign-ups
 * offered Early (11:10–12:20) and/or Late (12:20–1:45): First sits inside
 * Early; Second (mostly) and Third sit inside Late. Also decides what counts
 * as morning vs afternoon for people who alternate.
 */
export const HALF_OF: Record<NewShift, Slot> = { first: 'early', second: 'late', third: 'late' };

/**
 * Nominal weeks between shifts. weekly = 1, biweekly = 2, monthly = 4;
 * custom is 4 unless the coordinator's note says "every N weeks".
 */
export function intervalWeeks(frequency: Frequency, note?: string | null): number {
  if (frequency === 'weekly') return 1;
  if (frequency === 'biweekly') return 2;
  const n = frequency === 'custom' ? /every\s+(\d+)\s+weeks?/i.exec(note ?? '')?.[1] : undefined;
  return n ? Number(n) : 4;
}

/** Monthly volunteers never get two shifts closer than this (coordinator, 2026-09-30). */
export const MONTHLY_MIN_GAP_WEEKS = 2;

/**
 * How a volunteer's shifts are spaced. Monthly means once per calendar month
 * (at least MONTHLY_MIN_GAP_WEEKS apart) rather than every 4 weeks, so one
 * late shift doesn't push the rest of their year back (coordinator,
 * 2026-09-30). Everyone else is spaced by intervalWeeks().
 */
export function spacingFor(
  frequency: Frequency,
  note?: string | null,
  prefs?: ShiftPrefs | null,
): Pick<FillVolunteer, 'intervalWeeks' | 'calendarMonth'> {
  // A monthly mix sets its own count; never two in one week, or `weeksApart` if they asked.
  if (prefs?.perMonth) return { intervalWeeks: prefs.weeksApart ?? 1, calendarMonth: false };
  const weeks = intervalWeeks(frequency, note);
  return weeks === 4 ? { intervalWeeks: MONTHLY_MIN_GAP_WEEKS, calendarMonth: true } : { intervalWeeks: weeks, calendarMonth: false };
}

/**
 * A volunteer's own terms under the three-shift model (e.g. a 3rd-grade
 * parent who asked for 3rd grade only, or "one early and one 3rd grade a
 * month"). Applied on top of availability, blackouts and pairing.
 */
export type ShiftPrefs = {
  /** Only ever these shifts. */
  only?: NewShift[];
  /** This many of each shift per calendar month, replacing their frequency. Unlisted shifts are 0. */
  perMonth?: Partial<Record<NewShift, number>>;
  /** On any day they work, they take all of these shifts (e.g. Second then Third). */
  together?: NewShift[];
  /**
   * May take Third: has a 3rd grader the roster's grades don't show, or a
   * coordinator exception (e.g. someone working a full First+Second+Third day).
   */
  thirdGrader?: boolean;
  /** May take First without a 4th or 5th grader on the roster (a coordinator exception, e.g. the backup). */
  fourthOrFifthGrader?: boolean;
  /**
   * Works whichever shift the coordinator assigns on any weekday they offered,
   * early or late (e.g. signed up early but moved to Second). Their availability
   * on record is left as they gave it; see withAnyTime().
   */
  anyTime?: boolean;
  /** How often they work, overriding their sign-up answer (e.g. offered weekly later). */
  frequency?: Frequency;
  /** With perMonth: at least this many weeks between their shifts (2 = every other week). */
  weeksApart?: number;
  /** Different shifts for part of the year (e.g. Second from April); see ShiftPeriod. */
  periods?: ShiftPeriod[];
  /** Where the preference came from, for people reading the data. */
  note?: string;
};

/**
 * Shift rules for part of the year, `from` to `to` inclusive (YYYY-MM-DD).
 * Inside the period its `only` replaces the year-round one, and `anyTime`
 * counts every weekday they offered as both early and late (as
 * ShiftPrefs.anyTime does for the whole year).
 */
export type ShiftPeriod = { from: string; to: string; only?: NewShift[]; anyTime?: boolean; note?: string };

/** The period, if any, that covers this date. */
export function periodOn(periods: readonly ShiftPeriod[] | undefined, date: string): ShiftPeriod | undefined {
  return periods?.find((p) => date >= p.from && date <= p.to);
}

export type FillVolunteer = {
  id: string;
  name: string;
  veteran: boolean;
  thirdGrader: boolean;
  fourthOrFifthGrader: boolean;
  alternate?: boolean;
  intervalWeeks: number;
  /** At most one shift per calendar month, on top of `intervalWeeks` spacing. */
  calendarMonth?: boolean;
  only?: readonly NewShift[];
  perMonth?: Partial<Record<NewShift, number>>;
  together?: readonly NewShift[];
  periods?: readonly ShiftPeriod[];
};
export type Placement = { date: string; shift: NewShift; volunteer_id: string };

/** A new-model seat already worked, as carried inside each preview page. */
export type WorkedSeat = { date: string; shift: NewShift; id: string };

/**
 * What a revision starting `from` knows about shifts already worked, given the
 * preview it revises (`base`, its embedded data; null for a first preview):
 * `modelFrom`, where the first three-shift preview began (database rows before
 * it are the old early/late history), and `worked`, every seat earlier versions
 * scheduled before `from` except extras by hand (which never count toward
 * frequency). Each preview stores both, so V4 still knows what V2 had.
 */
export function carryWorked(
  base: { from?: unknown; modelFrom?: unknown; worked?: unknown; days?: unknown } | null,
  from: string,
): { modelFrom: string; worked: WorkedSeat[] } {
  if (!base) return { modelFrom: from, worked: [] };
  const modelFrom = typeof base.modelFrom === 'string' ? base.modelFrom : typeof base.from === 'string' ? base.from : from;
  const worked = new Map<string, WorkedSeat>();
  const add = (w: WorkedSeat) => { if (w.date < from) worked.set(`${w.date}|${w.shift}|${w.id}`, w); };
  for (const w of (base.worked ?? []) as WorkedSeat[]) add(w);
  for (const d of (base.days ?? []) as { date: string; seats: Partial<Record<NewShift, { id: string; extra?: boolean }[]>> }[]) {
    for (const shift of NEW_SHIFTS) for (const s of d.seats[shift] ?? []) if (!s.extra) add({ date: d.date, shift, id: s.id });
  }
  return { modelFrom, worked: [...worked.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
}

/**
 * Fill every open seat the roster can cover, around seats already taken.
 * Rules (hard): the seat's half is in their weekday availability; First is
 * 4th and 5th grade parents only, Third 3rd-grade parents only; never inside a blackout; never before `from`; one
 * shift a day; shifts at least `intervalWeeks` apart and, for `calendarMonth`
 * people, one per month (both counting `placed` and `history`); `only` and
 * `perMonth` preferences (quotas count `placed` and new seats); a `together`
 * volunteer takes their whole set of shifts or none that day; alternating people flip morning/afternoon against their
 * neighbours; a first-year volunteer only joins a shift that has a veteran
 * (so never Third, which is one person).
 *
 * Order, as in buildDraft: standing weekday rules (early -> First,
 * late -> Second; may give one person both), then the seats of a previous
 * plan (`keep`) that every rule still allows, veteran alternators in date
 * order, one veteran on every empty shift (hardest shift first, person
 * furthest behind their cadence), a veteran beside any first-year already
 * seated alone, first-year alternators, then a second person on First and
 * Second. Finally a rebalancing loop moves newly placed veterans from
 * two-person shifts onto empty ones when every rule allows it, kept seats
 * included, nearest seat first (so a move on the same day comes first).
 *
 * `fixed` seats (extra shifts handed out by hand) are taken but, like those
 * extras, don't count toward anyone's frequency. Returned placements include
 * the kept ones.
 *
 * `noticeFrom` (default `from`) is the earliest date a NEW seat may land on
 * (MIN_LEAD_DAYS, coordinator 2026-09-23). Before it, kept seats stay where
 * they are (or on another shift the same day) and nobody is added or moved in.
 */
export function fillShifts(args: {
  days: readonly string[];
  from: string;
  noticeFrom?: string;
  placed: readonly Placement[];
  fixed?: readonly Placement[];
  keep?: readonly Placement[];
  /** Shifts already worked; a `shift` (new model) also counts toward perMonth quotas. */
  history?: readonly { date: string; volunteer_id: string; half: Slot; shift?: NewShift }[];
  volunteers: readonly FillVolunteer[];
  availability: readonly AvailabilityRow[];
  blackouts?: readonly BlackoutRow[];
  fixedShifts?: readonly FixedShiftRow[];
}): Placement[] {
  const { days, from } = args;
  const noticeFrom = args.noticeFrom ?? from;
  if (days.length === 0) return [];
  const blackouts = args.blackouts ?? [];
  const volunteersById = new Map(args.volunteers.map((v) => [v.id, v]));

  const first = toLocalDate(days[0]!);
  const origin = new Date(first.getFullYear(), first.getMonth(), first.getDate() - (weekdayOf(days[0]!) - 1));
  // Whole days first: across a daylight-saving change local midnights are 23 or 25 hours apart.
  const weekOf = (iso: string) => Math.floor(Math.round((toLocalDate(iso).getTime() - origin.getTime()) / (24 * 3600 * 1000)) / 7);
  const maxWeek = weekOf(days[days.length - 1]!);

  const cells = new Map<string, Set<string>>();
  for (const r of args.availability) {
    const set = cells.get(r.volunteer_id) ?? new Set<string>();
    set.add(`${r.weekday}|${r.slot}`);
    cells.set(r.volunteer_id, set);
  }

  const seats = new Map(days.map((d) => [d, { first: [], second: [], third: [] } as Record<NewShift, string[]>]));
  const taken = new Map<string, { date: string; half: Slot }[]>();
  // "volunteerId|YYYY-MM|shift" -> placements that month, for perMonth quotas.
  const monthly = new Map<string, number>();
  const bump = (id: string, date: string, shift: NewShift) => {
    const k = `${id}|${date.slice(0, 7)}|${shift}`;
    monthly.set(k, (monthly.get(k) ?? 0) + 1);
  };
  const weeks = new Map<string, Set<number>>();
  const inRange = new Map<string, number>();
  const note = (id: string, date: string, half: Slot) => {
    taken.set(id, [...(taken.get(id) ?? []), { date, half }]);
    const w = weeks.get(id) ?? new Set<number>();
    w.add(weekOf(date));
    weeks.set(id, w);
  };
  for (const h of args.history ?? []) {
    note(h.volunteer_id, h.date, h.half);
    if (h.shift) bump(h.volunteer_id, h.date, h.shift);
  }
  for (const p of args.placed) {
    const day = seats.get(p.date);
    if (!day) continue;
    const already = NEW_SHIFTS.some((sh) => day[sh].includes(p.volunteer_id));
    day[p.shift].push(p.volunteer_id);
    note(p.volunteer_id, p.date, HALF_OF[p.shift]);
    bump(p.volunteer_id, p.date, p.shift);
    if (!already) inRange.set(p.volunteer_id, (inRange.get(p.volunteer_id) ?? 0) + 1);
  }
  for (const p of args.fixed ?? []) seats.get(p.date)?.[p.shift].push(p.volunteer_id);

  const added: Placement[] = [];
  // A `together` volunteer takes their whole set; it still counts as one day worked.
  const place = (v: FillVolunteer, date: string, shift: NewShift) => {
    for (const s of v.together ?? [shift]) {
      seats.get(date)![s].push(v.id);
      note(v.id, date, HALF_OF[s]);
      bump(v.id, date, s);
      added.push({ date, shift: s, volunteer_id: v.id });
    }
    inRange.set(v.id, (inRange.get(v.id) ?? 0) + 1);
  };

  const hasVeteran = (ids: readonly string[]) => ids.some((id) => volunteersById.get(id)?.veteran);
  // Who may ever take this shift on this date: grade, preferences (a period's
  // `only` replaces the year-round one) and availability (a period's `anyTime`
  // opens both halves of every weekday they offered).
  const allowed = (v: FillVolunteer, date: string, shift: NewShift): boolean => {
    if (shift === 'third' && !v.thirdGrader) return false;
    if (shift === 'first' && !v.fourthOrFifthGrader) return false;
    const period = periodOn(v.periods, date);
    const only = period?.only ?? v.only;
    if (only && !only.includes(shift)) return false;
    if (v.perMonth && !(v.perMonth[shift] ?? 0)) return false;
    const offered = cells.get(v.id);
    const wd = weekdayOf(date);
    return period?.anyTime
      ? Boolean(offered?.has(`${wd}|early`) || offered?.has(`${wd}|late`))
      : Boolean(offered?.has(`${wd}|${HALF_OF[shift]}`));
  };
  // Alternating flips between morning (First) and afternoon (Second/Third), so
  // it needs both halves offered and allowed. A `together` set is the same
  // every day, so it never alternates.
  const alternates = new Map(
    args.volunteers.map((v) => {
      const c = [...(cells.get(v.id) ?? [])];
      const halves = new Set(
        NEW_SHIFTS.filter(
          (s) => (s !== 'third' || v.thirdGrader) && (s !== 'first' || v.fourthOrFifthGrader) && (!v.only || v.only.includes(s)) && (!v.perMonth || (v.perMonth[s] ?? 0) > 0),
        ).map((s) => HALF_OF[s]),
      );
      const ok = Boolean(v.alternate) && !v.together && halves.size === 2 &&
        c.some((x) => x.endsWith('|early')) && c.some((x) => x.endsWith('|late'));
      return [v.id, ok];
    }),
  );
  const canAlternate = (v: FillVolunteer) => alternates.get(v.id) === true;
  const alternationClash = (v: FillVolunteer, date: string, half: Slot) => {
    if (!canAlternate(v)) return false;
    let before: { date: string; half: Slot } | undefined;
    let after: { date: string; half: Slot } | undefined;
    for (const t of taken.get(v.id) ?? []) {
      if (t.date < date && (!before || t.date > before.date)) before = t;
      if (t.date > date && (!after || t.date < after.date)) after = t;
    }
    return before?.half === half || after?.half === half;
  };

  // Can they sit in this one seat? (capacity, grade, preferences, availability, pairing)
  const seatOk = (v: FillVolunteer, date: string, shift: NewShift): boolean => {
    const day = seats.get(date);
    if (!day || day[shift].length >= NEW_SHIFT_INFO[shift].target) return false;
    if (!allowed(v, date, shift)) return false;
    if (v.perMonth && (monthly.get(`${v.id}|${date.slice(0, 7)}|${shift}`) ?? 0) >= (v.perMonth[shift] ?? 0)) return false;
    if (!v.veteran && !hasVeteran(day[shift])) return false;
    return !day[shift].includes(v.id);
  };

  // `keeping`: a seat from a previous plan (or its same-day replacement), allowed inside the notice window.
  const canTake = (v: FillVolunteer, date: string, shift: NewShift, standing = false, keeping = false): boolean => {
    if (date < from || !seats.has(date)) return false;
    if (date < noticeFrom && !standing && !keeping) return false;
    if (v.together && !v.together.includes(shift)) return false;
    if (!(v.together ?? [shift]).every((s) => seatOk(v, date, s))) return false;
    if (isBlackedOut(v.id, date, blackouts)) return false;
    if (standing) return true;
    const day = seats.get(date)!;
    if (NEW_SHIFTS.some((s) => day[s].includes(v.id))) return false;
    // A period sets its own shifts, so it pauses alternating.
    if (!periodOn(v.periods, date) && alternationClash(v, date, HALF_OF[shift])) return false;
    if (v.calendarMonth && (taken.get(v.id) ?? []).some((t) => t.date.slice(0, 7) === date.slice(0, 7))) return false;
    const w = weekOf(date);
    const mine = weeks.get(v.id);
    for (let k = 1 - v.intervalWeeks; k < v.intervalWeeks; k++) if (mine?.has(w + k)) return false;
    return true;
  };

  // How many shifts each person could have in range, for "furthest behind" ordering.
  const weeksInRange = maxWeek + 1;
  const monthsInRange = new Set(days.map((d) => d.slice(0, 7))).size;
  const target = new Map(
    args.volunteers.map((v) => [
      v.id,
      Math.max(
        1,
        v.perMonth
          ? monthsInRange * Object.values(v.perMonth).reduce((a, b) => a + (b ?? 0), 0)
          : v.calendarMonth
            ? monthsInRange
            : Math.ceil(weeksInRange / v.intervalWeeks),
      ),
    ]),
  );
  const flexibility = new Map(
    args.volunteers.map((v) => [
      v.id,
      days.filter((d) => d >= from).reduce((n, d) => n + NEW_SHIFTS.filter((s) => allowed(v, d, s)).length, 0),
    ]),
  );
  const byNeed = (a: FillVolunteer, b: FillVolunteer) =>
    (inRange.get(a.id) ?? 0) / target.get(a.id)! - (inRange.get(b.id) ?? 0) / target.get(b.id)! ||
    flexibility.get(a.id)! - flexibility.get(b.id)! ||
    a.name.localeCompare(b.name);

  const allShifts = days.filter((d) => d >= from).flatMap((date) => NEW_SHIFTS.map((shift) => ({ date, shift })));
  const size = (date: string, shift: NewShift) => seats.get(date)![shift].length;

  // Standing weekday rules first, regardless of cadence. These seats never move.
  const standing = new Set<string>(); // "date|volunteerId"
  for (const { date, shift } of allShifts) {
    for (const rule of args.fixedShifts ?? []) {
      if (rule.weekday !== weekdayOf(date) || (rule.slot === 'early' ? 'first' : 'second') !== shift) continue;
      const v = volunteersById.get(rule.volunteer_id);
      if (v && canTake(v, date, shift, true)) {
        place(v, date, shift);
        standing.add(`${date}|${v.id}`);
      }
    }
  }

  // A previous plan's seats stay, in date order, wherever every rule still
  // allows them, so a revision only moves the people it has to. A `together`
  // volunteer's seat stays as it was only where that plan gave them their
  // whole set. Then whoever lost a seat keeps the day if another shift (or,
  // for `together`, their whole set) is open that day (e.g. First -> Second
  // for someone now on Second only), the way accepted invites keep their day.
  const kept = new Set<string>(); // "date|volunteerId"
  const keep = [...(args.keep ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const keepKeys = new Set(keep.map((p) => `${p.date}|${p.shift}|${p.volunteer_id}`));
  const lost: Placement[] = [];
  for (const p of keep) {
    const v = volunteersById.get(p.volunteer_id);
    if (!v || kept.has(`${p.date}|${v.id}`)) continue;
    const whole = !v.together || v.together.every((s) => keepKeys.has(`${p.date}|${s}|${v.id}`));
    if (!whole || !canTake(v, p.date, p.shift, false, true)) { lost.push(p); continue; }
    place(v, p.date, p.shift);
    kept.add(`${p.date}|${v.id}`);
  }
  for (const p of lost) {
    const v = volunteersById.get(p.volunteer_id)!;
    if (kept.has(`${p.date}|${v.id}`)) continue;
    const shift = NEW_SHIFTS.find((s) => s !== p.shift && canTake(v, p.date, s, false, true));
    if (!shift) continue;
    place(v, p.date, shift);
    kept.add(`${p.date}|${v.id}`);
  }

  // Alternators walk the calendar at their cadence so they can flip halves.
  const placeAlternators = (veterans: boolean) => {
    for (const v of [...args.volunteers].sort(byNeed)) {
      if (!canAlternate(v) || v.veteran !== veterans) continue;
      let week = weekOf(from);
      while (week <= maxWeek) {
        const last = (taken.get(v.id) ?? []).filter((t) => weekOf(t.date) < week).sort((a, b) => b.date.localeCompare(a.date))[0];
        const want: Slot = last?.half === 'early' ? 'late' : 'early';
        const pick = allShifts
          .filter((s) => weekOf(s.date) === week && canTake(v, s.date, s.shift))
          .sort((a, b) =>
            Number(HALF_OF[a.shift] !== want) - Number(HALF_OF[b.shift] !== want) ||
            size(a.date, a.shift) - size(b.date, b.shift) ||
            a.date.localeCompare(b.date),
          )[0];
        if (pick) {
          place(v, pick.date, pick.shift);
          week += v.intervalWeeks;
        } else week += 1;
      }
    }
  };

  // Hardest-to-fill shift first, given to whoever is furthest behind.
  const fillPass = (inPool: (date: string, shift: NewShift) => boolean, candidates: readonly FillVolunteer[]) => {
    for (;;) {
      let best: { date: string; shift: NewShift; eligible: FillVolunteer[] } | null = null;
      for (const { date, shift } of allShifts) {
        if (!inPool(date, shift)) continue;
        const eligible = candidates.filter((v) => canTake(v, date, shift));
        if (eligible.length && (!best || eligible.length < best.eligible.length)) best = { date, shift, eligible };
      }
      if (!best) return;
      place(best.eligible.sort(byNeed)[0]!, best.date, best.shift);
    }
  };

  const veterans = args.volunteers.filter((v) => v.veteran);
  placeAlternators(true);
  fillPass((d, s) => size(d, s) === 0, veterans);
  // An accepted first-year sitting alone gets a veteran next, before general doubling up.
  fillPass((d, s) => size(d, s) > 0 && !hasVeteran(seats.get(d)![s]), veterans);
  placeAlternators(false);
  fillPass((d, s) => size(d, s) < NEW_SHIFT_INFO[s].target, args.volunteers);

  // Rebalance: the passes above never revisit a choice, so a veteran can end
  // up as the second person on one shift while another shift sits empty. Move
  // newly placed veterans off shared shifts onto empty ones whenever every
  // rule still holds, refill what that frees up, and repeat until nothing moves.
  const unplace = (v: FillVolunteer, date: string): NewShift[] => {
    const day = seats.get(date)!;
    const removed = NEW_SHIFTS.filter((s) => day[s].includes(v.id));
    for (const s of removed) {
      day[s].splice(day[s].indexOf(v.id), 1);
      monthly.set(`${v.id}|${date.slice(0, 7)}|${s}`, (monthly.get(`${v.id}|${date.slice(0, 7)}|${s}`) ?? 1) - 1);
    }
    const left = (taken.get(v.id) ?? []).filter((t) => t.date !== date);
    taken.set(v.id, left);
    weeks.set(v.id, new Set(left.map((t) => weekOf(t.date))));
    inRange.set(v.id, (inRange.get(v.id) ?? 1) - 1);
    for (let i = added.length - 1; i >= 0; i--) if (added[i]!.volunteer_id === v.id && added[i]!.date === date) added.splice(i, 1);
    return removed;
  };
  const moveOne = (): boolean => {
    for (const hole of allShifts.filter(({ date, shift }) => size(date, shift) === 0)) {
      // Filling a hole beats keeping a doubled seat where it was (coordinator, 2026-10-04);
      // the nearest seat goes first, so anyone already on the hole's day moves least.
      const away = (date: string) => Math.abs(toLocalDate(date).getTime() - toLocalDate(hole.date).getTime());
      const candidates = [...added].sort((a, b) => away(a.date) - away(b.date));
      for (const p of candidates) {
        if (standing.has(`${p.date}|${p.volunteer_id}`) || p.date < noticeFrom) continue;
        const v = volunteersById.get(p.volunteer_id)!;
        if (!v.veteran) continue; // an empty shift needs a veteran
        const mine = v.together ?? [p.shift];
        if (mine.some((s) => size(p.date, s) < 2)) continue; // would just move the hole
        const stay = seats.get(p.date)!;
        // Someone with another seat that day (accepted or standing) stays put.
        if (NEW_SHIFTS.filter((s) => stay[s].includes(v.id)).length !== mine.length) continue;
        if (mine.some((s) => stay[s].some((id) => id !== v.id && !volunteersById.get(id)?.veteran))) continue; // don't strand a first-year
        const removed = unplace(v, p.date);
        if (canTake(v, hole.date, hole.shift)) {
          place(v, hole.date, hole.shift);
          // Still the seat they had, moved: it stays kept.
          if (kept.delete(`${p.date}|${v.id}`)) kept.add(`${hole.date}|${v.id}`);
          return true;
        }
        place(v, p.date, removed[0]!);
      }
    }
    return false;
  };
  for (let round = 0; round < 50; round++) {
    let moved = 0;
    while (moveOne()) moved++;
    const before = added.length;
    fillPass((d, s) => size(d, s) < NEW_SHIFT_INFO[s].target, args.volunteers);
    if (!moved && added.length === before) break;
  }
  return added;
}
