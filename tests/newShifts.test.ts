import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fillShifts,
  intervalWeeks,
  periodOn,
  spacingFor,
  planDay,
  timeChangeCost,
  type DayVolunteer,
  type FillVolunteer,
  type Placement,
  withAnyTime,
} from '../src/newShifts';
import { schoolDaysBetween, type AvailabilityRow } from '../src/schedule';

function p(name: string, opts: Partial<DayVolunteer> = {}): DayVolunteer {
  return { id: name, name, accepted: 'early', thirdGrader: false, fourthOrFifthGrader: true, veteran: true, available: ['early'], ...opts };
}
const names = (list: DayVolunteer[]) => list.map((v) => v.name).sort();

test('only a 3rd-grade parent is put on the third shift', () => {
  const plan = planDay([p('a', { accepted: 'late', available: ['late'] }), p('b'), p('c')]);
  assert.deepEqual(plan.third, []);
  assert.equal(plan.first.length + plan.second.length, 3);
});

test('a 3rd-grade parent covers the third shift when that adds coverage', () => {
  const plan = planDay([p('early1'), p('late3', { accepted: 'late', available: ['late'], thirdGrader: true })]);
  assert.deepEqual(names(plan.first), ['early1']);
  assert.deepEqual(names(plan.third), ['late3']);
});

test('coverage never pushes someone outside the time they offered', () => {
  // Two early-only people: both take First rather than one being sent to Second.
  const plan = planDay([p('a'), p('b')]);
  assert.equal(plan.first.length, 2);
  assert.equal(plan.second.length, 0);
});

test('someone who offered both parts of lunch moves to cover an empty shift', () => {
  const plan = planDay([p('a'), p('b', { available: ['early', 'late'] })]);
  assert.deepEqual(names(plan.first), ['a']);
  assert.deepEqual(names(plan.second), ['b']);
});

test('a lone late volunteer takes Second, not First', () => {
  const plan = planDay([p('x', { accepted: 'late', available: ['early', 'late'] })]);
  assert.deepEqual(names(plan.second), ['x']);
});

test('a full First overflows into Second rather than leaving anyone unseated', () => {
  const plan = planDay([p('a'), p('b'), p('c')]);
  assert.equal(plan.first.length, 2);
  assert.equal(plan.second.length, 1);
  assert.equal(plan.extra.length, 0);
});

test('two per first/second, one on third; overflow is reported, not dropped', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => p(n, { thirdGrader: n === 'f', accepted: 'late', available: ['late'] }));
  const plan = planDay(six);
  assert.equal(plan.first.length, 2);
  assert.equal(plan.second.length, 2);
  assert.deepEqual(names(plan.third), ['f']);
  assert.equal(plan.extra.length, 1);
});

test('a new volunteer is paired with a veteran when coverage allows', () => {
  const plan = planDay([
    p('vet1'),
    p('new1', { veteran: false }),
    p('vet2', { accepted: 'late', available: ['late'] }),
    p('vet3', { accepted: 'late', available: ['late'] }),
  ]);
  for (const shift of [plan.first, plan.second]) {
    if (shift.some((v) => !v.veteran)) assert.ok(shift.some((v) => v.veteran));
  }
});

test('time change costs follow the accepted window, then what they offered', () => {
  const late = { accepted: 'late' as const, available: ['late' as const] };
  assert.equal(timeChangeCost(p('x'), 'first'), 0);
  assert.equal(timeChangeCost(p('x', { available: ['early', 'late'] }), 'second'), 2);
  assert.equal(timeChangeCost(p('x'), 'second'), 3);
  assert.equal(timeChangeCost(p('x'), 'third'), 4);
  assert.equal(timeChangeCost(p('x', late), 'third'), 0);
  assert.equal(timeChangeCost(p('x', late), 'second'), 1);
  assert.equal(timeChangeCost(p('x', { ...late, available: ['early', 'late'] }), 'first'), 2);
  assert.equal(timeChangeCost(p('x', late), 'first'), 4);
  assert.equal(timeChangeCost(p('x', { accepted: 'both shifts' }), 'third'), 0);
});

// ---- fillShifts ----
// 2026-10-05 is a Monday; eight school weeks, no closures.
const DAYS = schoolDaysBetween('2026-10-05', '2026-11-26', new Set());
const fv = (id: string, opts: Partial<FillVolunteer> = {}): FillVolunteer => ({
  id, name: id, veteran: true, thirdGrader: false, fourthOrFifthGrader: true, intervalWeeks: 4, ...opts,
});
const avail = (id: string, list: Array<[number, 'early' | 'late']>): AvailabilityRow[] =>
  list.map(([weekday, slot]) => ({ volunteer_id: id, weekday, slot }));
const everyday = (id: string) => avail(id, [1, 2, 3, 4].flatMap((d) => [[d, 'early'], [d, 'late']] as Array<[number, 'early' | 'late']>));
const fill = (volunteers: FillVolunteer[], availability: AvailabilityRow[], extra: Partial<Parameters<typeof fillShifts>[0]> = {}) =>
  fillShifts({ days: DAYS, from: DAYS[0]!, placed: [], volunteers, availability, ...extra });
const mine = (added: Placement[], id: string) => added.filter((p) => p.volunteer_id === id).sort((a, b) => a.date.localeCompare(b.date));
const weekGap = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / (7 * 86400000));

test('fill: Third only goes to 3rd-grade parents with Late availability', () => {
  const added = fill(
    [fv('late3', { thirdGrader: true }), fv('early3', { thirdGrader: true }), fv('late')],
    [...avail('late3', [[1, 'late']]), ...avail('early3', [[1, 'early']]), ...avail('late', [[1, 'late']])],
  );
  const third = added.filter((p) => p.shift === 'third').map((p) => p.volunteer_id);
  assert.ok(third.length > 0);
  assert.ok(third.every((id) => id === 'late3'));
  assert.ok(mine(added, 'early3').every((p) => p.shift === 'first'));
});

test('fill: shifts follow availability halves (First = Early, Second/Third = Late)', () => {
  const added = fill([fv('e', { intervalWeeks: 1 }), fv('l', { intervalWeeks: 1 })], [...avail('e', [[2, 'early']]), ...avail('l', [[2, 'late']])]);
  assert.ok(mine(added, 'e').length > 0 && mine(added, 'e').every((p) => p.shift === 'first'));
  assert.ok(mine(added, 'l').length > 0 && mine(added, 'l').every((p) => p.shift === 'second'));
});

test('fill: cadence counts accepted placements and stays at least intervalWeeks apart', () => {
  const placed: Placement[] = [{ date: '2026-10-19', shift: 'first', volunteer_id: 'm' }];
  const added = fill([fv('m')], everyday('m'), { placed });
  const dates = ['2026-10-19', ...mine(added, 'm').map((p) => p.date)].sort();
  for (let i = 1; i < dates.length; i++) assert.ok(weekGap(dates[i - 1]!, dates[i]!) >= 4, dates.join(' '));
});

test('fill: first-year volunteers only join a veteran and never take Third alone', () => {
  const added = fill(
    [fv('vet', { intervalWeeks: 1 }), fv('rookie', { veteran: false, thirdGrader: true, intervalWeeks: 1 })],
    [...everyday('vet'), ...everyday('rookie')],
  );
  const all = [...added];
  for (const p of mine(added, 'rookie')) {
    assert.notEqual(p.shift, 'third');
    assert.ok(all.some((q) => q.date === p.date && q.shift === p.shift && q.volunteer_id === 'vet'));
  }
});

test('fill: nothing lands before `from`, inside a blackout, or twice on one day', () => {
  const added = fillShifts({
    days: DAYS,
    from: '2026-10-12',
    placed: [],
    volunteers: [fv('w', { intervalWeeks: 1 })],
    availability: everyday('w'),
    blackouts: [{ volunteer_id: 'w', starts_on: '2026-10-19', ends_on: '2026-10-30' }],
  });
  for (const p of added) assert.ok(p.date >= '2026-10-12' && (p.date < '2026-10-19' || p.date > '2026-10-30'));
  assert.equal(new Set(added.map((p) => p.date)).size, added.length);
});

test('fill: a standing both-shifts rule gives First and Second on that weekday', () => {
  const added = fill([fv('coord', { intervalWeeks: 1 })], everyday('coord'), {
    fixedShifts: [{ volunteer_id: 'coord', weekday: 2, slot: 'early' }, { volunteer_id: 'coord', weekday: 2, slot: 'late' }],
  });
  const tue = mine(added, 'coord').filter((p) => p.date === '2026-10-06').map((p) => p.shift).sort();
  assert.deepEqual(tue, ['first', 'second']);
  assert.ok(mine(added, 'coord').every((p) => new Date(p.date + 'T12:00:00').getDay() === 2));
});

test('fill: alternating volunteers flip between morning and afternoon', () => {
  const added = fill([fv('alt', { alternate: true, intervalWeeks: 2 })], everyday('alt'));
  const halves = mine(added, 'alt').map((p) => (p.shift === 'first' ? 'early' : 'late'));
  assert.ok(halves.length >= 3);
  for (let i = 1; i < halves.length; i++) assert.notEqual(halves[i], halves[i - 1]);
});

test('intervalWeeks reads "every N weeks" from a custom note', () => {
  assert.equal(intervalWeeks('custom', 'Once every 6 weeks only on Tuesday'), 6);
  assert.equal(intervalWeeks('custom', 'one time per month'), 4);
  assert.equal(intervalWeeks('biweekly'), 2);
  assert.equal(intervalWeeks('weekly', 'every 3 weeks'), 1);
});

test('fill: a first-year already seated alone gets a veteran beside them', () => {
  // One week, so the veteran has no empty shift to cover instead.
  const placed: Placement[] = [{ date: '2026-10-06', shift: 'first', volunteer_id: 'rookie' }];
  const added = fill([fv('rookie', { veteran: false }), fv('vet')], [...avail('rookie', [[2, 'early']]), ...avail('vet', [[2, 'early']])], { placed, days: DAYS.slice(0, 4) });
  assert.deepEqual(mine(added, 'vet').map((p) => `${p.date} ${p.shift}`), ['2026-10-06 first']);
});

test('fill: calendarMonth allows back-to-back months but never two in one month', () => {
  const placed: Placement[] = [{ date: '2026-10-29', shift: 'first', volunteer_id: 'm' }];
  const added = fill([fv('m', { calendarMonth: true, intervalWeeks: 1 })], everyday('m'), { placed });
  const months = ['2026-10-29', ...mine(added, 'm').map((p) => p.date)].map((d) => d.slice(0, 7));
  assert.equal(new Set(months).size, months.length);
  assert.ok(months.includes('2026-11'));
});

test('spacingFor: monthly means once per calendar month, at least 2 weeks apart', () => {
  assert.deepEqual(spacingFor('monthly'), { intervalWeeks: 2, calendarMonth: true });
  assert.deepEqual(spacingFor('custom', 'one time per month'), { intervalWeeks: 2, calendarMonth: true });
  assert.deepEqual(spacingFor('custom', 'Once every 6 weeks only on Tuesday'), { intervalWeeks: 6, calendarMonth: false });
  assert.deepEqual(spacingFor('biweekly'), { intervalWeeks: 2, calendarMonth: false });
  assert.deepEqual(spacingFor('weekly'), { intervalWeeks: 1, calendarMonth: false });
});

test('fill: a monthly volunteer gets one shift every month, never within 2 weeks', () => {
  const added = fill([fv('m', spacingFor('monthly'))], avail('m', [[1, 'early']]));
  const dates = mine(added, 'm').map((p) => p.date);
  assert.deepEqual([...new Set(dates.map((d) => d.slice(0, 7)))], ['2026-10', '2026-11']);
  assert.equal(dates.length, 2);
  assert.ok(weekGap(dates[0]!, dates[1]!) >= 2);
});

test('fill: "only" keeps a 3rd-grade parent on the Third shift', () => {
  const added = fill([fv('p3', { thirdGrader: true, intervalWeeks: 1, only: ['third'] }), fv('vet', { intervalWeeks: 1 })], [...everyday('p3'), ...everyday('vet')]);
  assert.ok(mine(added, 'p3').length > 0);
  assert.ok(mine(added, 'p3').every((p) => p.shift === 'third'));
});

test('fill: perMonth gives exactly the requested mix each month, never two in a week', () => {
  const v = fv('mix', { thirdGrader: true, ...spacingFor('monthly', null, { perMonth: { first: 1, third: 2 } }), perMonth: { first: 1, third: 2 } });
  const added = mine(fill([v], everyday('mix')), 'mix');
  for (const month of ['2026-10', '2026-11']) {
    const inMonth = added.filter((p) => p.date.startsWith(month));
    assert.equal(inMonth.filter((p) => p.shift === 'first').length, 1, month);
    assert.equal(inMonth.filter((p) => p.shift === 'third').length, 2, month);
    assert.equal(inMonth.filter((p) => p.shift === 'second').length, 0, month);
  }
  for (let i = 1; i < added.length; i++) assert.ok(weekGap(added[i - 1]!.date, added[i]!.date) >= 1);
});

test('planDay: an accepted volunteer limited to Third is not moved to Second', () => {
  const plan = planDay([p('lara', { accepted: 'late', available: ['late'], thirdGrader: true, only: ['third'] }), p('x', { accepted: 'late', available: ['late'] })]);
  assert.deepEqual(names(plan.third), ['lara']);
});

test('fill: a "together" volunteer takes Second and Third on the same day, never one alone', () => {
  const added = fill(
    [fv('pat', { thirdGrader: true, together: ['second', 'third'], ...spacingFor('monthly') }), fv('vet', { intervalWeeks: 1 })],
    [...avail('pat', [[2, 'late'], [4, 'late']]), ...everyday('vet')],
  );
  const pat = mine(added, 'pat');
  const byDay = new Map<string, string[]>();
  for (const p of pat) byDay.set(p.date, [...(byDay.get(p.date) ?? []), p.shift]);
  assert.ok(byDay.size >= 2);
  for (const [, shifts] of byDay) assert.deepEqual(shifts.sort(), ['second', 'third']);
  assert.equal(new Set([...byDay.keys()].map((d) => d.slice(0, 7))).size, byDay.size, 'still once a month');
});

test('planDay: an accepted "together" volunteer gets both shifts', () => {
  const plan = planDay([
    p('pat', { accepted: 'late', available: ['late'], thirdGrader: true, together: ['second', 'third'] }),
    p('al', { accepted: 'late', available: ['late'], thirdGrader: true }),
  ]);
  assert.deepEqual(names(plan.third), ['pat']);
  assert.deepEqual(names(plan.second), ['al', 'pat']);
});

test('fill: rebalancing moves a doubled-up veteran onto an empty shift', () => {
  // One school week. "flex" can do Mon early or Tue late; "mon" only Mon early.
  // Tue late also needs "flex" — the rebalance must not leave it empty.
  const week = DAYS.slice(0, 4);
  const added = fill(
    [fv('flex', { intervalWeeks: 4 }), fv('mon', { intervalWeeks: 4 }), fv('mon2', { intervalWeeks: 4 })],
    [...avail('flex', [[1, 'early'], [2, 'late']]), ...avail('mon', [[1, 'early']]), ...avail('mon2', [[1, 'early']])],
    { days: week },
  );
  const tueLate = added.filter((p) => p.date === '2026-10-06' && p.shift === 'second');
  assert.deepEqual(tueLate.map((p) => p.volunteer_id), ['flex']);
  const monFirst = added.filter((p) => p.date === '2026-10-05' && p.shift === 'first').map((p) => p.volunteer_id).sort();
  assert.deepEqual(monFirst, ['mon', 'mon2']);
});

test('withAnyTime opens both halves of offered weekdays only for anyTime volunteers', () => {
  const rows: AvailabilityRow[] = [
    { volunteer_id: 'k', weekday: 2, slot: 'early' },
    { volunteer_id: 'k', weekday: 4, slot: 'early' },
    { volunteer_id: 'o', weekday: 1, slot: 'early' },
  ];
  const out = withAnyTime(rows, (id) => id === 'k');
  const keys = out.map((r) => `${r.volunteer_id}|${r.weekday}|${r.slot}`).sort();
  assert.deepEqual(keys, ['k|2|early', 'k|2|late', 'k|4|early', 'k|4|late', 'o|1|early']);
  assert.equal(rows.length, 3, 'input is not modified');
});

test('spacingFor: a monthly mix can ask for every other week', () => {
  assert.deepEqual(spacingFor('biweekly', null, { perMonth: { first: 1, second: 1 }, weeksApart: 2 }), { intervalWeeks: 2, calendarMonth: false });
  assert.deepEqual(spacingFor('monthly', null, { perMonth: { first: 1, third: 1 } }), { intervalWeeks: 1, calendarMonth: false });
});

test('fill: one First and one Second a month, every other week', () => {
  const prefs = { perMonth: { first: 1, second: 1 }, weeksApart: 2 };
  const v = fv('d', { ...spacingFor('biweekly', null, prefs), perMonth: prefs.perMonth });
  const added = mine(fill([v], avail('d', [[2, 'early'], [2, 'late'], [4, 'early'], [4, 'late']])), 'd');
  for (const month of ['2026-10', '2026-11']) {
    assert.deepEqual(added.filter((p) => p.date.startsWith(month)).map((p) => p.shift).sort(), ['first', 'second'], month);
  }
  for (let i = 1; i < added.length; i++) assert.ok(weekGap(added[i - 1]!.date, added[i]!.date) >= 2, added.map((p) => p.date).join(' '));
});

test('fill: a period changes the shift, and opens the late half, only between its dates', () => {
  const periods = [{ from: '2026-11-02', to: '2026-11-26', only: ['second' as const], anyTime: true }];
  assert.equal(periodOn(periods, '2026-11-01'), undefined);
  assert.equal(periodOn(periods, '2026-11-26'), periods[0]);
  const added = mine(fill([fv('t', { intervalWeeks: 1, periods })], avail('t', [[2, 'early']])), 't');
  // (A message on every assert here: without one, node's runner hangs instead of failing.)
  assert.ok(added.some((p) => p.date < '2026-11-02'), 'has dates before the period');
  assert.ok(added.some((p) => p.date >= '2026-11-02'), 'has dates inside the period');
  for (const p of added) assert.equal(p.shift, p.date < '2026-11-02' ? 'first' : 'second', p.date);
});

test('fill: a period pauses alternating', () => {
  // A weekly alternator whose period allows Second only still works every week of it.
  const periods = [{ from: '2026-11-02', to: '2026-11-26', only: ['second' as const] }];
  const added = mine(fill([fv('alt', { alternate: true, intervalWeeks: 1, periods })], avail('alt', [[2, 'early'], [2, 'late']])), 'alt');
  assert.deepEqual(added.filter((p) => p.date >= '2026-11-02').map((p) => `${p.date} ${p.shift}`),
    ['2026-11-03 second', '2026-11-10 second', '2026-11-17 second', '2026-11-24 second'], 'every Tuesday in the period');
  const before = added.filter((p) => p.date < '2026-11-02').map((p) => p.shift);
  for (let i = 1; i < before.length; i++) assert.notEqual(before[i] === 'first', before[i - 1] === 'first', 'still alternates before it');
});

test('fill: shifts already worked in the new model count toward a monthly mix', () => {
  // A First on Oct 6 (before `from`) uses up October's First.
  const v = fv('mix', { thirdGrader: true, ...spacingFor('monthly', null, { perMonth: { first: 1, third: 1 } }), perMonth: { first: 1, third: 1 } });
  const added = mine(fill([v], everyday('mix'), { from: '2026-10-12', history: [{ date: '2026-10-06', volunteer_id: 'mix', half: 'early', shift: 'first' }] }), 'mix');
  assert.deepEqual(added.filter((p) => p.date.startsWith('2026-10')).map((p) => p.shift), ['third'], 'October gets only its Third');
  assert.deepEqual(added.filter((p) => p.date.startsWith('2026-11')).map((p) => p.shift).sort(), ['first', 'third'], 'November is untouched');
});

test('fill: standing weekday seats never move, even to cover an empty shift', () => {
  // x's accepted Tuesday First makes coord's standing Tuesday First a pair.
  const week = DAYS.slice(0, 4);
  const args = { days: week, placed: [{ date: '2026-10-06', shift: 'first' as const, volunteer_id: 'x' }] };
  const vols = [fv('coord', { intervalWeeks: 1 }), fv('x', { intervalWeeks: 1 })];
  const availability = [...everyday('coord'), ...avail('x', [[2, 'early']])];
  const one = fill(vols, availability, { ...args, fixedShifts: [{ volunteer_id: 'coord', weekday: 2, slot: 'early' }] });
  assert.deepEqual(mine(one, 'coord').map((p) => `${p.date} ${p.shift}`), ['2026-10-06 first'], 'one standing seat stays');
  const both = fill(vols, availability, { ...args, fixedShifts: [{ volunteer_id: 'coord', weekday: 2, slot: 'early' }, { volunteer_id: 'coord', weekday: 2, slot: 'late' }] });
  assert.deepEqual(mine(both, 'coord').map((p) => `${p.date} ${p.shift}`).sort(), ['2026-10-06 first', '2026-10-06 second'], 'a standing pair stays whole');
});

test('fill: an alternating volunteer limited to one half is never blocked by alternation', () => {
  const added = mine(fill([fv('alt', { alternate: true, intervalWeeks: 1, only: ['second'] })], everyday('alt')), 'alt');
  assert.equal(added.length, 8, 'one Second every week');
  assert.ok(added.every((p) => p.shift === 'second'), 'all Second');
});

test('fill: a day kept on another shift still moves off a double to fill an empty shift', () => {
  // s (Thursdays, Second only now) keeps Oct 8 as Second beside z, but Oct 15's Second
  // is empty: filling it comes before doubling up (coordinator, 2026-10-04).
  const added = fill(
    [fv('s', { only: ['second'], ...spacingFor('monthly') }), fv('z', { intervalWeeks: 4 })],
    [...avail('s', [[4, 'early'], [4, 'late']]), ...avail('z', [[4, 'late']])],
    { keep: [{ date: '2026-10-08', shift: 'first', volunteer_id: 's' }], placed: [{ date: '2026-10-08', shift: 'second', volunteer_id: 'z' }] },
  );
  assert.deepEqual(mine(added, 's').filter((p) => p.date.startsWith('2026-10')).map((p) => `${p.date} ${p.shift}`), ['2026-10-15 second']);
});

test('fill: an empty shift is covered from its own day before another day', () => {
  // Tuesday Second is empty. b (kept Monday First) and c (kept Tuesday First) could both
  // take it; c is already there that day, so c switches shift and b keeps Monday.
  const week = DAYS.slice(0, 4);
  const keep: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'b' }, { date: '2026-10-06', shift: 'first', volunteer_id: 'c' }];
  const placed: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'x' }, { date: '2026-10-06', shift: 'first', volunteer_id: 'y' }];
  const added = fill(
    [fv('b'), fv('c'), fv('x'), fv('y')],
    [...avail('b', [[1, 'early'], [2, 'late']]), ...avail('c', [[2, 'early'], [2, 'late']]), ...avail('x', [[1, 'early']]), ...avail('y', [[2, 'early']])],
    { days: week, placed, keep },
  );
  assert.deepEqual(mine(added, 'c').map((p) => `${p.date} ${p.shift}`), ['2026-10-06 second']);
  assert.deepEqual(mine(added, 'b').map((p) => `${p.date} ${p.shift}`), ['2026-10-05 first']);
});

test('fill: an alternating volunteer with a Second + Third set still gets every month', () => {
  // Second and Third are both afternoon, so alternation must not block the next month.
  const v = fv('val', { thirdGrader: true, alternate: true, together: ['second', 'third'], ...spacingFor('monthly') });
  const added = mine(fill([v], everyday('val')), 'val');
  assert.deepEqual([...new Set(added.map((p) => p.date.slice(0, 7)))], ['2026-10', '2026-11']);
});

test('fill: a doubled kept seat moves to an empty shift in another week', () => {
  // Two weeks: "a" is the second person on Monday's First while week 2's is empty.
  const twoWeeks = DAYS.slice(0, 8);
  const keep: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'a' }];
  const placed: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'x' }];
  const volunteers = [fv('a'), fv('x')];
  const availability = [...avail('a', [[1, 'early']]), ...avail('x', [[1, 'early']])];
  assert.deepEqual(mine(fill(volunteers, availability, { days: twoWeeks, placed }), 'a').map((p) => p.date), ['2026-10-12']);
  assert.deepEqual(mine(fill(volunteers, availability, { days: twoWeeks, placed, keep }), 'a').map((p) => `${p.date} ${p.shift}`), ['2026-10-12 first']);
});

test('fill: the doubled seat nearest an empty shift is the one that moves', () => {
  // Mondays only: a doubles Oct 5, b doubles Oct 26, Oct 19 is empty. b is a week away, a two.
  const days = ['2026-10-05', '2026-10-19', '2026-10-26'];
  const keep: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'a' }, { date: '2026-10-26', shift: 'first', volunteer_id: 'b' }];
  const placed: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'x' }, { date: '2026-10-26', shift: 'first', volunteer_id: 'y' }];
  const added = fillShifts({
    days, from: days[0]!, placed, keep,
    volunteers: ['a', 'b', 'x', 'y'].map((id) => fv(id)),
    availability: ['a', 'b', 'x', 'y'].flatMap((id) => avail(id, [[1, 'early']])),
  });
  assert.deepEqual(mine(added, 'b').map((p) => p.date), ['2026-10-19']);
  assert.deepEqual(mine(added, 'a').map((p) => p.date), ['2026-10-05']);
});

test('fill: a kept seat may move within its week to cover an empty shift', () => {
  const week = DAYS.slice(0, 4);
  const keep: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'a' }];
  const placed: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'x' }];
  const added = fill([fv('a'), fv('x')], [...avail('a', [[1, 'early'], [2, 'early']]), ...avail('x', [[1, 'early']])], { days: week, placed, keep });
  assert.deepEqual(mine(added, 'a').map((p) => `${p.date} ${p.shift}`), ['2026-10-06 first']);
});

test('fill: a kept seat may switch shifts on its own day to cover an empty one', () => {
  // Monday: First has two, Second is empty, and "a" can do both halves.
  const week = DAYS.slice(0, 4);
  const keep: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'a' }];
  const placed: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'x' }];
  const added = fill([fv('a'), fv('x')], [...avail('a', [[1, 'early'], [1, 'late']]), ...avail('x', [[1, 'early']])], { days: week, placed, keep });
  assert.deepEqual(mine(added, 'a').map((p) => `${p.date} ${p.shift}`), ['2026-10-05 second']);
});

test('fill: kept seats that now break a rule are dropped and the person is placed again', () => {
  const keep: Placement[] = [
    { date: '2026-10-06', shift: 'first', volunteer_id: 'b' }, // b is Second only now
    { date: '2026-10-07', shift: 'first', volunteer_id: 'c' }, // c is away that day now
    { date: '2026-11-04', shift: 'first', volunteer_id: 'c' }, // still fine
  ];
  const added = fill([fv('b', { only: ['second'], ...spacingFor('monthly') }), fv('c', spacingFor('monthly'))], [...everyday('b'), ...everyday('c')], {
    keep,
    blackouts: [{ volunteer_id: 'c', starts_on: '2026-10-07', ends_on: '2026-10-07' }],
  });
  assert.ok(mine(added, 'b').every((p) => p.shift === 'second'));
  assert.equal(mine(added, 'b').filter((p) => p.date.startsWith('2026-10')).length, 1, 'b still has an October shift');
  assert.ok(!mine(added, 'c').some((p) => p.date === '2026-10-07'));
  assert.ok(mine(added, 'c').some((p) => p.date === '2026-11-04' && p.shift === 'first'), 'the valid seat is kept');
  assert.equal(mine(added, 'c').filter((p) => p.date.startsWith('2026-10')).length, 1, 'c gets another October day');
});

test('fill: a "together" volunteer with half a set kept gets the whole set that day only if it is open', () => {
  const together = { thirdGrader: true, together: ['second' as const, 'third' as const], ...spacingFor('monthly') };
  // Third is someone else's that day: v doesn't keep the day.
  const taken = fill([fv('v', together), fv('p3', { thirdGrader: true, ...spacingFor('monthly') })], [...everyday('v'), ...everyday('p3')], {
    keep: [{ date: '2026-10-05', shift: 'second', volunteer_id: 'v' }, { date: '2026-10-05', shift: 'third', volunteer_id: 'p3' }],
  });
  assert.deepEqual(taken.filter((p) => p.date === '2026-10-05' && p.shift === 'third').map((p) => p.volunteer_id), ['p3']);
  const days = new Map<string, string[]>();
  for (const p of mine(taken, 'v')) days.set(p.date, [...(days.get(p.date) ?? []), p.shift]);
  assert.ok(days.size >= 2, 'v still works');
  for (const [, shifts] of days) assert.deepEqual(shifts.sort(), ['second', 'third']);
  // Third is free that day: v keeps the day with the whole set.
  const open = fill([fv('v', together)], everyday('v'), { keep: [{ date: '2026-10-07', shift: 'second', volunteer_id: 'v' }] });
  assert.deepEqual(mine(open, 'v').filter((p) => p.date.startsWith('2026-10')).map((p) => `${p.date} ${p.shift}`).sort(), ['2026-10-07 second', '2026-10-07 third']);
});

test('fill: fixed seats (extras by hand) take the seat but not the frequency', () => {
  const fixed: Placement[] = [{ date: '2026-10-06', shift: 'third', volunteer_id: 't' }];
  const added = fill([fv('t', { thirdGrader: true, only: ['third'], ...spacingFor('monthly') })], everyday('t'), { fixed });
  assert.ok(!added.some((p) => p.date === '2026-10-06'), 'the fixed seat is not filled again');
  assert.equal(mine(added, 't').filter((p) => p.date.startsWith('2026-10')).length, 1, 'still a regular October shift');
  // The seat is really taken: a one-person Third holding t's extra gets nobody else.
  const other = fill([fv('u', { thirdGrader: true, only: ['third'], ...spacingFor('monthly') })], everyday('u'), {
    fixed: [{ date: '2026-10-05', shift: 'third', volunteer_id: 't' }],
  });
  assert.ok(!mine(other, 'u').some((p) => p.date === '2026-10-05'), 'u does not share the fixed Third');
});

test('fill: someone whose kept seat now breaks a rule keeps the day on another shift if one is open', () => {
  const keep: Placement[] = [
    { date: '2026-10-08', shift: 'first', volunteer_id: 's' }, // s is Second only now (a plain fill would pick Oct 5)
    { date: '2026-10-07', shift: 'second', volunteer_id: 'full1' },
    { date: '2026-10-07', shift: 'second', volunteer_id: 'full2' },
    { date: '2026-10-07', shift: 'first', volunteer_id: 'e' }, // e is Second only too, but Wednesday's Second is full
  ];
  const added = fill(
    [fv('s', { only: ['second'], ...spacingFor('monthly') }), fv('e', { only: ['second'], ...spacingFor('monthly') }), fv('full1', spacingFor('monthly')), fv('full2', spacingFor('monthly'))],
    [...everyday('s'), ...everyday('e'), ...avail('full1', [[3, 'late']]), ...avail('full2', [[3, 'late']])],
    { keep },
  );
  assert.deepEqual(mine(added, 's').filter((p) => p.date.startsWith('2026-10')).map((p) => `${p.date} ${p.shift}`), ['2026-10-08 second'], 'same day, now Second');
  // e never takes a valid seat; full1 leaves only to fill an empty Wednesday Second.
  assert.deepEqual(added.filter((p) => p.date === '2026-10-07' && p.shift === 'second').map((p) => p.volunteer_id), ['full2'], 'valid seats are not displaced');
  assert.deepEqual(mine(added, 'full1').filter((p) => p.date.startsWith('2026-10')).map((p) => `${p.date} ${p.shift}`), ['2026-10-14 second']);
  assert.ok(!mine(added, 'e').some((p) => p.date === '2026-10-07'));
  assert.equal(mine(added, 'e').filter((p) => p.date.startsWith('2026-10')).length, 1, 'e gets another October day');
});

test('fill: inside the notice window kept seats stay put and nothing new lands', () => {
  // Same week as "a kept seat may move within its week", but Oct 5–8 is inside the notice window.
  const twoWeeks = DAYS.slice(0, 8);
  const keep: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'a' }];
  const placed: Placement[] = [{ date: '2026-10-05', shift: 'first', volunteer_id: 'x' }];
  const added = fill(
    [fv('a'), fv('x'), fv('b')],
    [...avail('a', [[1, 'early'], [2, 'early']]), ...avail('x', [[1, 'early']]), ...avail('b', [[3, 'early']])],
    { days: twoWeeks, placed, keep, noticeFrom: '2026-10-09' },
  );
  assert.deepEqual(mine(added, 'a').map((p) => `${p.date} ${p.shift}`), ['2026-10-05 first'], 'kept seat not moved to Tuesday');
  assert.deepEqual(mine(added, 'b').map((p) => p.date), ['2026-10-14'], 'new seat waits for the notice window');
});

test('planDay: only a 4th or 5th grade parent is put on the first shift', () => {
  // Three accepted for Second's two seats: the late volunteer is not pushed onto First.
  const plan = planDay([
    p('adam', { accepted: 'late', available: ['late'], fourthOrFifthGrader: false }),
    p('jason', { available: ['late'], only: ['second'], fourthOrFifthGrader: false }),
    p('zainab', { available: ['late'], only: ['second'], fourthOrFifthGrader: false }),
  ]);
  assert.deepEqual(plan.first, []);
  assert.deepEqual(names(plan.second), ['adam', 'jason']);
  assert.deepEqual(names(plan.extra), ['zainab']);
});

test('fill: First only goes to 4th or 5th grade parents', () => {
  const week = DAYS.slice(0, 4);
  // Alone, each would take the week's first open seat: Monday's First.
  const k = fill([fv('k', { fourthOrFifthGrader: false })], everyday('k'), { days: week });
  assert.deepEqual(k.map((p) => p.shift), ['second'], 'no First without a 4th or 5th grader');
  const five = fill([fv('five')], everyday('five'), { days: week });
  assert.deepEqual(five.map((p) => p.shift), ['first']);
});
