import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDraft,
  weekdayOf,
  isBlackedOut,
  type AvailabilityRow,
  type BlackoutRow,
  type FixedShiftRow,
  type RosterVolunteer,
} from '../src/schedule';

// 2026-09-07 is a Monday. Two school weeks: Sep 7–10 and Sep 14–17.
const FROM = '2026-09-07';
const TWO_WEEKS = '2026-09-18';
const EIGHT_WEEKS = '2026-10-30';

let nextId = 0;
const newId = () => `id-${++nextId}`;

function vol(
  id: string,
  opts: Partial<RosterVolunteer> = {},
): RosterVolunteer {
  return { id, name: id, frequency: 'monthly', backfill: false, veteran: true, ...opts };
}

// weekday 1..4 × slot cells
function cells(id: string, list: Array<[number, 'early' | 'late']>): AvailabilityRow[] {
  return list.map(([weekday, slot]) => ({ volunteer_id: id, weekday, slot }));
}
const ALL_CELLS: Array<[number, 'early' | 'late']> = [1, 2, 3, 4].flatMap((d) => [
  [d, 'early'] as [number, 'early'],
  [d, 'late'] as [number, 'late'],
]);

function draft(args: {
  to: string;
  volunteers: RosterVolunteer[];
  availability: AvailabilityRow[];
  existing?: { shifts: { id: string; date: string; slot: 'early' | 'late' }[]; assignments: { shift_id: string; volunteer_id: string }[] };
  blackouts?: BlackoutRow[];
  fixedShifts?: FixedShiftRow[];
}) {
  return buildDraft({
    blackouts: args.blackouts,
    fixedShifts: args.fixedShifts,
    from: FROM,
    to: args.to,
    closures: new Set(),
    existingShifts: args.existing?.shifts ?? [],
    existingAssignments: args.existing?.assignments ?? [],
    availability: args.availability,
    volunteers: args.volunteers,
    newId,
  });
}

test('rule 1: only availability cells, spaced by cadence', () => {
  const plan = draft({
    to: EIGHT_WEEKS,
    volunteers: [vol('a', { frequency: 'monthly' })],
    availability: cells('a', [[1, 'early']]),
  });
  const shiftById = new Map(plan.shiftInserts.map((s) => [s.id, s]));
  const dates = plan.assignmentInserts.map((x) => shiftById.get(x.shift_id)!);
  assert.ok(dates.length > 0);
  for (const s of dates) {
    assert.equal(weekdayOf(s.date), 1);
    assert.equal(s.slot, 'early');
  }
  // 8 weeks at a 4-week cadence → 2 shifts, 4 weeks apart.
  assert.equal(dates.length, 2);
  assert.deepEqual(dates.map((s) => s.date).sort(), ['2026-09-07', '2026-10-05']);
});

test('weekly cadence gives one shift per week, never two in a week', () => {
  const plan = draft({
    to: TWO_WEEKS,
    volunteers: [vol('a', { frequency: 'weekly' })],
    availability: cells('a', ALL_CELLS),
  });
  assert.equal(plan.assignmentInserts.length, 2);
});

test('rule 2: cover every shift before doubling anyone up', () => {
  // 8 shifts in one week, 8 weekly veterans → each shift gets exactly one.
  const vols = Array.from({ length: 8 }, (_, i) => vol(`v${i}`, { frequency: 'weekly' }));
  const plan = draft({
    to: '2026-09-11',
    volunteers: vols,
    availability: vols.flatMap((v) => cells(v.id, ALL_CELLS)),
  });
  assert.equal(plan.summary.emptyShifts, 0);
  assert.equal(plan.assignmentInserts.length, 8);
  const perShift = new Map<string, number>();
  for (const a of plan.assignmentInserts) perShift.set(a.shift_id, (perShift.get(a.shift_id) ?? 0) + 1);
  assert.ok([...perShift.values()].every((n) => n === 1));
});

test('rule 3: doubles up once everything is covered, capped at 2', () => {
  const vols = Array.from({ length: 20 }, (_, i) => vol(`v${i}`, { frequency: 'weekly' }));
  const plan = draft({
    to: '2026-09-11',
    volunteers: vols,
    availability: vols.flatMap((v) => cells(v.id, ALL_CELLS)),
  });
  assert.equal(plan.assignmentInserts.length, 16);
  assert.equal(plan.summary.openSlots, 0);
});

test('new volunteers are never alone and only join a veteran', () => {
  const plan = draft({
    to: '2026-09-11',
    volunteers: [vol('vet', { frequency: 'weekly' }), vol('new', { frequency: 'weekly', veteran: false })],
    availability: [...cells('vet', ALL_CELLS), ...cells('new', ALL_CELLS)],
  });
  const byVol = new Map(plan.assignmentInserts.map((a) => [a.volunteer_id, a.shift_id]));
  assert.equal(plan.assignmentInserts.length, 2);
  assert.equal(byVol.get('new'), byVol.get('vet'));
});

test('a new volunteer with no veteran available stays unplaced', () => {
  const plan = draft({
    to: '2026-09-11',
    volunteers: [vol('new', { veteran: false })],
    availability: cells('new', ALL_CELLS),
  });
  assert.equal(plan.assignmentInserts.length, 0);
  assert.equal(plan.summary.emptyShifts, 8);
});

test('existing assignments anchor the cadence and are never duplicated', () => {
  const shifts = [{ id: 's0', date: '2026-09-07', slot: 'early' as const }];
  const plan = draft({
    to: EIGHT_WEEKS,
    volunteers: [vol('a', { frequency: 'monthly' })],
    availability: cells('a', [[1, 'early']]),
    existing: { shifts, assignments: [{ shift_id: 's0', volunteer_id: 'a' }] },
  });
  const shiftById = new Map([...shifts, ...plan.shiftInserts].map((s) => [s.id, s]));
  const dates = plan.assignmentInserts.map((x) => shiftById.get(x.shift_id)!.date);
  assert.deepEqual(dates, ['2026-10-05']);
});

test('the person furthest behind their cadence is picked first', () => {
  // One Mon/early shift per week for 2 weeks; 'busy' already holds week 1.
  const shifts = [{ id: 's0', date: '2026-09-07', slot: 'early' as const }];
  const plan = draft({
    to: TWO_WEEKS,
    volunteers: [vol('busy', { frequency: 'weekly' }), vol('idle', { frequency: 'weekly' })],
    availability: [...cells('busy', [[1, 'early']]), ...cells('idle', [[1, 'early']])],
    existing: { shifts, assignments: [{ shift_id: 's0', volunteer_id: 'busy' }] },
  });
  const shiftById = new Map([...shifts, ...plan.shiftInserts].map((s) => [s.id, s]));
  const week2 = plan.assignmentInserts.filter((a) => shiftById.get(a.shift_id)!.date === '2026-09-14');
  // Both fit (cap 2) but 'idle' must be placed first.
  assert.equal(week2[0]!.volunteer_id, 'idle');
});

test('rule 1: blackout windows are never scheduled, cadence resumes after', () => {
  // Weekly, Mon/early only, 8 weeks; away for weeks 2–4 (Sep 21 – Oct 11).
  const blackouts: BlackoutRow[] = [{ volunteer_id: 'a', starts_on: '2026-09-21', ends_on: '2026-10-11' }];
  const plan = draft({
    to: EIGHT_WEEKS,
    volunteers: [vol('a', { frequency: 'weekly' })],
    availability: cells('a', [[1, 'early']]),
    blackouts,
  });
  const shiftById = new Map(plan.shiftInserts.map((s) => [s.id, s]));
  const dates = plan.assignmentInserts.map((x) => shiftById.get(x.shift_id)!.date).sort();
  assert.deepEqual(dates, ['2026-09-07', '2026-09-14', '2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(isBlackedOut('a', '2026-09-21', blackouts), true);
  assert.equal(isBlackedOut('a', '2026-10-11', blackouts), true);
  assert.equal(isBlackedOut('a', '2026-10-12', blackouts), false);
  assert.equal(isBlackedOut('b', '2026-09-21', blackouts), false);
});

test('weekday-limited blackout blocks only that weekday', () => {
  const blackouts: BlackoutRow[] = [{ volunteer_id: 'a', starts_on: '2026-09-01', ends_on: '2026-12-31', weekday: 2 }];
  assert.equal(isBlackedOut('a', '2026-09-08', blackouts), true); // Tuesday
  assert.equal(isBlackedOut('a', '2026-09-09', blackouts), false); // Wednesday
});

test('pass 0: a fixed weekday/slot rule is placed every week regardless of cadence', () => {
  // Monthly person with a standing "every Tuesday, both shifts" rule, 8 weeks.
  const plan = draft({
    to: EIGHT_WEEKS,
    volunteers: [vol('boss', { frequency: 'monthly' })],
    availability: cells('boss', ALL_CELLS),
    fixedShifts: [
      { volunteer_id: 'boss', weekday: 2, slot: 'early' },
      { volunteer_id: 'boss', weekday: 2, slot: 'late' },
    ],
  });
  const shiftById = new Map(plan.shiftInserts.map((s) => [s.id, s]));
  const placed = plan.assignmentInserts.map((x) => shiftById.get(x.shift_id)!);
  const tuesdays = placed.filter((s) => weekdayOf(s.date) === 2);
  assert.equal(tuesdays.length, 16); // 8 Tuesdays × 2 slots
  // Cadence rule then keeps them off every other day that week (weekly gap 0 < 4).
  assert.equal(placed.length - tuesdays.length, 0);
});
