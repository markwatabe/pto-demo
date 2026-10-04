/**
 * Preview the three-shift schedule. Read-only: reads accepted-invites.csv
 * (from `pnpm pull:accepted`) plus the roster and school calendar, writes a
 * standalone HTML page. Changes nothing anywhere else.
 *
 *   pnpm preview:new-shifts            # -> new-shifts-preview.html (git-ignored, real PII)
 *   pnpm preview:new-shifts --in accepted-invites.csv --out new-shifts-preview.html
 *   pnpm preview:new-shifts --skip a@x.com,b@y.com   # never schedule these (backups)
 *   pnpm preview:new-shifts --base new-shifts-preview.html --out new-shifts-preview-v2.html --version V2
 *
 * --base revises an earlier preview instead of starting over: every seat it
 * had stays wherever the current rules (prefs, blocked days, availability,
 * frequency) still allow it, so only the people affected by a change move.
 * Its hand-added extras stay too, as long as extra-shifts.json still lists
 * them, and its seats before today count as shifts already worked. --out may
 * not be the --base file. --version labels the page and its text version
 * (e.g. "V2").
 *
 * Per-volunteer shift preferences ("3rd grade only", "1 early + 1 3rd a
 * month") come from shift-prefs.json (git-ignored, keyed by email; --prefs
 * <file> for what-ifs) until they have a home in the database. Extra shifts
 * handed out by hand (on top of anyone's usual frequency, and even for
 * people left out with --skip) come from extra-shifts.json, applied after the
 * fill so nobody's regular shifts move to make room ("extraSeat": true goes
 * past a full shift, e.g. a third person on Second). Pinned shifts
 * (pinned-shifts.json, same entry format; --pinned <file>) go the other way:
 * they are seated before the fill, like accepted invites, and count toward
 * the person's usual frequency.
 *
 * The new shifts start today (no minimum-notice gap); earlier days keep the
 * old schedule. A --base revision keeps the minimum notice (MIN_LEAD_DAYS):
 * its seats inside that window stay put and nobody new is added there. Accepted invites are the fixed starting point: each person keeps that day
 * and planDay() picks their new shift. Unanswered invites are ignored.
 * fillShifts() then fills every other open seat from the roster.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readNewShiftsPreviewData, renderNewShiftsPreview } from './lib/render-new-shifts-preview';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import {
  earliestAssignableDate,
  isBlackedOut,
  schoolDaysBetween,
  weekdayOf,
  type AvailabilityRow,
  type BlackoutRow,
  type FixedShiftRow,
  type Frequency,
  type Slot,
} from '../src/schedule';
import {
  carryWorked,
  fillShifts,
  HALF_OF,
  intervalWeeks,
  periodOn,
  spacingFor,
  NEW_SHIFT_INFO,
  NEW_SHIFTS,
  planDay,
  timeChangeCost,
  type AcceptedKind,
  type DayVolunteer,
  type NewShift,
  type Placement,
  type ShiftPrefs,
  withAnyTime,
} from '../src/newShifts';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
const IN = arg('--in') ?? 'accepted-invites.csv';
const OUT = arg('--out') ?? 'new-shifts-preview.html';
const PREFS_FILE = arg('--prefs') ?? 'shift-prefs.json';
const PREFS: Record<string, ShiftPrefs> = existsSync(PREFS_FILE)
  ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(PREFS_FILE, 'utf8')) as Record<string, ShiftPrefs>).map(([e, p]) => [e.toLowerCase(), p]))
  : {};
const SKIP = new Set((arg('--skip') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const BASE_FILE = arg('--base');
const VERSION = arg('--version');
// The base is a page volunteers may already have; never write over it.
if (BASE_FILE && resolve(BASE_FILE) === resolve(OUT)) throw new Error(`--out ${OUT} would overwrite the --base preview; pass a new --out`);

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

type CsvRow = { date: string; current_shift: AcceptedKind; email: string; available_that_weekday: string };
type Volunteer = {
  id: string;
  name: string;
  email: string;
  frequency: Frequency;
  frequency_note: string | null;
  veteran: boolean;
  alternate: boolean;
  grades: string | null;
};
/**
 * Everyone has been trained (coordinator, 2026-09-30), so nobody needs a
 * veteran beside them: every volunteer is scheduled as a veteran. The
 * database's `veteran` flag still records who volunteered before.
 */
const ALL_TRAINED = true;


async function main() {
  const rows = parse(readFileSync(IN, 'utf8'), { columns: true, skip_empty_lines: true }) as CsvRow[];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const rs = await Promise.all([
    db.from('school_year').select('starts_on, ends_on').maybeSingle(),
    db.from('school_closures').select('date'),
    db.from('volunteers').select('id, name, email, frequency, frequency_note, veteran, alternate, grades'),
    db.from('availability').select('volunteer_id, weekday, slot'),
    db.from('volunteer_blackouts').select('volunteer_id, starts_on, ends_on, weekday, note'),
    db.from('volunteer_fixed_shifts').select('volunteer_id, weekday, slot'),
    db.from('shift_volunteers').select('volunteer_id, shift:green_team_shifts ( date, slot )').limit(5000),
  ]);
  for (const r of rs) if (r.error) throw new Error(r.error.message);
  const [yearRes, closuresRes, volsRes, availRes, blackRes, fixedRes, assignRes] = rs;
  const year = yearRes.data as { starts_on: string; ends_on: string } | null;
  if (!year) throw new Error('No school year set.');
  const closures = new Set(((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date));
  const volunteers = ((volsRes.data ?? []) as Volunteer[]).map((v) => ({ ...v, name: v.name.trim() }));
  const byEmail = new Map(volunteers.map((v) => [v.email.toLowerCase(), v]));
  // anyTime volunteers (shift-prefs.json) count as early and late on the weekdays they offered.
  const emailById = new Map(volunteers.map((v) => [v.id, v.email.toLowerCase()]));
  const availability = withAnyTime((availRes.data ?? []) as AvailabilityRow[], (id) => PREFS[emailById.get(id) ?? '']?.anyTime === true);
  const blackouts = (blackRes.data ?? []) as BlackoutRow[];
  const skippedIds = new Set(volunteers.filter((v) => SKIP.has(v.email.toLowerCase())).map((v) => v.id));
  const fixedShifts = ((fixedRes.data ?? []) as FixedShiftRow[]).filter((f) => !skippedIds.has(f.volunteer_id));
  const thirdGrader = (v: Volunteer) => /\b3rd\b/i.test(v.grades ?? '') || PREFS[v.email.toLowerCase()]?.thirdGrader === true;
  // First is 4th and 5th grade lunch: their parents only (coordinator, 2026-10-04).
  const fourthOrFifthGrader = (v: Volunteer) => /\b(4th|5th)\b/i.test(v.grades ?? '') || PREFS[v.email.toLowerCase()]?.fourthOrFifthGrader === true;
  // Their shift limits on a given date: a period in shift-prefs.json replaces the
  // year-round `only`, and its `anyTime` opens both halves of their weekdays.
  const rulesOn = (v: Volunteer, date: string) => {
    const pr = PREFS[v.email.toLowerCase()];
    const period = periodOn(pr?.periods, date);
    return { only: period?.only ?? pr?.only, anyTime: (period?.anyTime ?? pr?.anyTime) === true };
  };
  const offers = (v: Volunteer, date: string, shift: NewShift) => {
    const mine = availability.filter((a) => a.volunteer_id === v.id && a.weekday === weekdayOf(date));
    return rulesOn(v, date).anyTime ? mine.length > 0 : mine.some((a) => a.slot === HALF_OF[shift]);
  };

  // The new shifts start today; earlier days stay on the old early/late
  // schedule, and whoever worked them counts as history.
  const from = today;
  const days = schoolDaysBetween(from, year.ends_on, closures);

  // 1. Accepted invites: keep the day, pick the new shift.
  const byDate = new Map<string, DayVolunteer[]>();
  for (const r of rows) {
    if (r.date < from) continue;
    const v = byEmail.get(r.email.toLowerCase());
    if (!v) { console.warn(`  accepted invite for ${r.email} on ${r.date}: not on the roster, skipped`); continue; }
    const rules = rulesOn(v, r.date);
    byDate.set(r.date, [
      ...(byDate.get(r.date) ?? []),
      { id: v.id, name: v.name, accepted: r.current_shift, thirdGrader: thirdGrader(v), fourthOrFifthGrader: fourthOrFifthGrader(v), veteran: ALL_TRAINED || v.veteran, available: rules.anyTime ? ['early', 'late'] : (r.available_that_weekday.split('+').filter(Boolean) as Slot[]), only: rules.only, together: PREFS[v.email.toLowerCase()]?.together },
    ]);
  }
  const accepted = new Map<string, { accepted: AcceptedKind; cost: number }>(); // "date|shift|id"
  const placed: Placement[] = [];
  const extras = new Map<string, string[]>();
  for (const date of days) {
    const plan = planDay(byDate.get(date) ?? []);
    for (const shift of NEW_SHIFTS) {
      for (const v of plan[shift]) {
        placed.push({ date, shift, volunteer_id: v.id });
        accepted.set(`${date}|${shift}|${v.id}`, { accepted: v.accepted, cost: timeChangeCost(v, shift) });
      }
    }
    if (plan.extra.length) extras.set(date, plan.extra.map((v) => v.id));
  }

  // 1b. Pinned shifts (pinned-shifts.json): seated before the fill, like accepted
  //     invites, so they win the seat and count toward the person's cadence.
  //     Same checks as any seat: a school day in range, room left, not blocked,
  //     Third only for those who may take it, one seat per shift per person.
  const PINNED_FILE = arg('--pinned') ?? 'pinned-shifts.json';
  const pinnedIn = existsSync(PINNED_FILE) ? (JSON.parse(readFileSync(PINNED_FILE, 'utf8')) as { date: string; shift: NewShift; email: string }[]) : [];
  let pinned = 0;
  const seatedPins = new Set<string>(); // "volunteerId|date"
  for (const x of pinnedIn) {
    if (x.date < from) continue; // already worked (or not); a later revision's history covers it
    const v = byEmail.get(x.email.toLowerCase());
    const together = v ? PREFS[v.email.toLowerCase()]?.together : undefined;
    const sameDay = v ? placed.filter((p) => p.date === x.date && p.volunteer_id === v.id).map((p) => p.shift) : [];
    const why = !v ? 'not on the roster'
      : !days.includes(x.date) ? 'not a school day in range'
      : x.shift === 'third' && !thirdGrader(v) ? 'may not take Third'
      : x.shift === 'first' && !fourthOrFifthGrader(v) ? 'may not take First'
      : sameDay.includes(x.shift) ? 'already seated there'
      : sameDay.length && ![x.shift, ...sameDay].every((s) => together?.includes(s)) ? 'already working another shift that day'
      : placed.filter((p) => p.date === x.date && p.shift === x.shift).length >= NEW_SHIFT_INFO[x.shift].target ? 'shift is already full'
      : isBlackedOut(v.id, x.date, blackouts) ? 'blocked that day'
      : '';
    if (why) { console.warn(`  pinned shift skipped: ${x.email} ${x.date} ${x.shift} — ${why}`); continue; }
    // A pin is the coordinator's call, so it may go past someone's preferences, but say so.
    const pr = PREFS[v!.email.toLowerCase()];
    const only = rulesOn(v!, x.date).only;
    const past = [
      only && !only.includes(x.shift) ? `outside their shifts (${only.join(', ')})` : '',
      pr?.perMonth && !pr.perMonth[x.shift] ? 'outside their monthly mix' : '',
      !offers(v!, x.date, x.shift) ? 'outside their availability' : '',
    ].filter(Boolean);
    if (past.length) console.warn(`  pinned shift ${past.join(' and ')}: ${x.email} ${x.date} ${x.shift}`);
    placed.push({ date: x.date, shift: x.shift, volunteer_id: v!.id });
    seatedPins.add(`${v!.id}|${x.date}`);
    pinned++;
  }
  for (const key of seatedPins) {
    const [id, date] = key.split('|') as [string, string];
    const v = volunteers.find((x) => x.id === id)!;
    const together = PREFS[v.email.toLowerCase()]?.together;
    const have = placed.filter((p) => p.date === date && p.volunteer_id === id).map((p) => p.shift);
    if (together && !together.every((s) => have.includes(s))) console.warn(`  pinned to part of a together set (${together.join(' + ')}): ${v.email} ${date} has ${have.join(', ')}`);
  }

  // 2. Everything already worked (before today) counts toward cadence and
  //    alternation: the old early/late assignments in the database before the
  //    first three-shift preview, then every seat the previews since then had
  //    scheduled before today (carried from page to page; extras by hand never
  //    count toward anyone's frequency).
  const baseData = BASE_FILE ? readNewShiftsPreviewData(readFileSync(BASE_FILE, 'utf8')) : null;
  const carried = carryWorked(baseData, from);
  // Every seat the --base preview had; extras by hand are flagged.
  type BaseDay = { date: string; seats: Partial<Record<NewShift, { id: string; extra?: boolean }[]>> };
  const baseAll = ((baseData?.days ?? []) as BaseDay[]).flatMap((d) =>
    NEW_SHIFTS.flatMap((shift) => (d.seats[shift] ?? []).map((s) => ({ date: d.date, shift, volunteer_id: s.id, extra: s.extra === true }))),
  );
  type AssignRow = { volunteer_id: string; shift: { date: string; slot: Slot } | null };
  const history = [
    ...((assignRes.data ?? []) as unknown as AssignRow[])
      .filter((a) => a.shift && a.shift.date < from && a.shift.date < carried.modelFrom)
      .map((a) => ({ volunteer_id: a.volunteer_id, date: a.shift!.date, half: a.shift!.slot })),
    ...carried.worked.map((w) => ({ volunteer_id: w.id, date: w.date, half: HALF_OF[w.shift], shift: w.shift })),
  ];

  // 3. Extra shifts handed out by hand (extra-shifts.json). Frequency, monthly
  //    mix and --skip don't apply; availability, grade, blocked days and
  //    one-shift-a-day still do. They go in after the fill so nobody's regular
  //    shifts move to make room, except those the --base preview already had,
  //    which keep their seat. `extraSeat: true` puts someone on a shift that
  //    is already full (a third person on Second, say): it never takes a seat,
  //    so it always goes in after the fill, in every revision.
  type ExtraIn = { date: string; shift: NewShift; email: string; extraSeat?: boolean };
  const EXTRAS_FILE = arg('--extras') ?? 'extra-shifts.json';
  const extrasIn = existsSync(EXTRAS_FILE) ? (JSON.parse(readFileSync(EXTRAS_FILE, 'utf8')) as ExtraIn[]) : [];
  const manual: Placement[] = [];
  const seatExtra = (x: ExtraIn, taken: readonly Placement[]) => {
    const v = byEmail.get(x.email.toLowerCase());
    const why =
      !v ? 'not on the roster'
      : !days.includes(x.date) ? 'not a school day in range'
      : !x.extraSeat && taken.filter((p) => p.date === x.date && p.shift === x.shift).length >= NEW_SHIFT_INFO[x.shift].target ? 'shift is already full'
      : taken.some((p) => p.date === x.date && p.volunteer_id === v.id) ? 'already working that day'
      : x.shift === 'third' && !thirdGrader(v) ? 'no 3rd grader'
      : x.shift === 'first' && !fourthOrFifthGrader(v) ? 'no 4th or 5th grader'
      : !offers(v, x.date, x.shift) ? 'not available then'
      : isBlackedOut(v.id, x.date, blackouts) ? 'away or declined that day'
      : null;
    if (why) { console.warn(`  extra shift skipped: ${x.email} ${x.date} ${x.shift} — ${why}`); return; }
    manual.push({ date: x.date, shift: x.shift, volunteer_id: v!.id });
  };

  // 4. The --base preview: its seats from today on are kept wherever every rule still allows them.
  const baseSeats = baseAll.filter((s) => s.date >= from);
  const keep: Placement[] = baseSeats.filter((s) => !s.extra).map(({ date, shift, volunteer_id }) => ({ date, shift, volunteer_id }));
  // Base extras are seated before the fill so they keep their seat; an extraSeat has none to keep.
  const inBase = (x: ExtraIn) =>
    !x.extraSeat && baseSeats.some((s) => s.extra && s.date === x.date && s.shift === x.shift && s.volunteer_id === byEmail.get(x.email.toLowerCase())?.id);
  for (const x of extrasIn.filter(inBase)) seatExtra(x, [...placed, ...manual]);
  const baseExtras = [...manual];

  // 5. Fill the rest from the roster.
  const fillVolunteers = volunteers.filter((v) => !SKIP.has(v.email.toLowerCase())).map((v) => ({
    id: v.id,
    name: v.name,
    veteran: ALL_TRAINED || v.veteran,
    thirdGrader: thirdGrader(v),
    fourthOrFifthGrader: fourthOrFifthGrader(v),
    alternate: v.alternate,
    ...spacingFor(PREFS[v.email.toLowerCase()]?.frequency ?? v.frequency, v.frequency_note, PREFS[v.email.toLowerCase()]),
    only: PREFS[v.email.toLowerCase()]?.only,
    perMonth: PREFS[v.email.toLowerCase()]?.perMonth,
    together: PREFS[v.email.toLowerCase()]?.together,
    periods: PREFS[v.email.toLowerCase()]?.periods,
  }));
  const noticeFrom = BASE_FILE ? earliestAssignableDate() : from;
  const added = fillShifts({ days, from, noticeFrom, placed, fixed: baseExtras, keep, history, volunteers: fillVolunteers, availability, blackouts, fixedShifts });

  for (const x of extrasIn.filter((x) => !inBase(x))) seatExtra(x, [...placed, ...added, ...manual]);
  const manualKeys = new Set(manual.map((p) => `${p.date}|${p.shift}|${p.volunteer_id}`));

  const all = [...placed, ...added, ...manual];
  const plannedDays = days.map((date) => ({
    date,
    seats: Object.fromEntries(
      NEW_SHIFTS.map((shift) => [
        shift,
        all
          .filter((p) => p.date === date && p.shift === shift)
          .map((p) => ({
            id: p.volunteer_id,
            ...(accepted.get(`${date}|${shift}|${p.volunteer_id}`) ?? {}),
            ...(manualKeys.has(`${date}|${shift}|${p.volunteer_id}`) ? { extra: true } : {}),
          })),
      ]),
    ) as Record<NewShift, { id: string; accepted?: AcceptedKind; cost?: number; extra?: boolean }[]>,
    extra: extras.get(date) ?? [],
  }));

  const keptKeys = new Set(keep.map((p) => `${p.date}|${p.shift}|${p.volunteer_id}`));
  const keptCount = added.filter((p) => keptKeys.has(`${p.date}|${p.shift}|${p.volunteer_id}`)).length;
  const data = {
    generatedAt: new Date().toISOString(),
    ...(VERSION ? { version: VERSION } : {}),
    today,
    from,
    to: year.ends_on,
    // What later revisions need to know about shifts already worked (see carryWorked).
    modelFrom: carried.modelFrom,
    worked: carried.worked,
    acceptedInvites: placed.length - pinned,
    added: added.length - keptCount,
    ...(BASE_FILE ? { keptFromBase: keptCount } : {}),
    shifts: NEW_SHIFT_INFO,
    people: Object.fromEntries(
      volunteers.map((v) => {
        const pr = PREFS[v.email.toLowerCase()];
        const weeks = intervalWeeks(pr?.frequency ?? v.frequency, v.frequency_note);
        const label = (s: NewShift) => NEW_SHIFT_INFO[s].label;
        // How often, in the words the coordinator uses.
        const spacing = skippedIds.has(v.id)
          ? 'Backup: only shifts assigned by hand'
          : pr?.perMonth
            ? `Each month: ${Object.entries(pr.perMonth).filter(([, n]) => n).map(([s, n]) => `${n} ${label(s as NewShift)}`).join(' + ')}` +
              (pr.weeksApart === 2 ? ', every other week' : pr.weeksApart && pr.weeksApart > 2 ? `, ${pr.weeksApart} weeks apart` : '')
            : weeks === 1 ? 'Every week'
            : weeks === 2 ? 'Every other week'
            : weeks === 4 ? 'Once a month (at least 2 weeks apart)'
            : `Every ${weeks} weeks`;
        return [
          v.id,
          {
            name: v.name,
            grades: v.grades ?? '',
            thirdGrader: thirdGrader(v),
            fourthOrFifthGrader: fourthOrFifthGrader(v),
            spacing,
            // A weekday blocked for the whole range (e.g. "Mondays and Tuesdays only") isn't offered.
            avail: availability
              .filter((a) => a.volunteer_id === v.id && !blackouts.some((b) => b.volunteer_id === v.id && b.weekday === a.weekday && b.starts_on <= from && b.ends_on >= year.ends_on))
              .map((a) => [a.weekday, a.slot]),
            prefs: pr ?? null,
            // renderNewShiftsPreview() trims each person to what the shared page shows.
          },
        ];
      }),
    ),
    days: plannedDays,
    // Mon–Thu closures in range, shown as "No lunch shift" rows.
    closedDays: [...closures].filter((d) => d >= from && d <= year.ends_on && weekdayOf(d) <= 4).sort(),
  };

  writeFileSync(OUT, renderNewShiftsPreview(data));

  const seatsFilled = all.length;
  console.log(`${days.length} school days ${from} → ${year.ends_on} | accepted kept ${placed.length - pinned} | pinned ${pinned}${BASE_FILE ? ` | kept from ${BASE_FILE} ${keptCount}` : ''} | newly scheduled ${added.length - keptCount} | extra by hand ${manual.length} | seats filled ${seatsFilled}/${days.length * 5}`);
  for (const s of NEW_SHIFTS) {
    const t = NEW_SHIFT_INFO[s].target;
    const full = plannedDays.filter((d) => d.seats[s].length >= t).length;
    const some = plannedDays.filter((d) => d.seats[s].length > 0).length;
    console.log(`  ${NEW_SHIFT_INFO[s].label.padEnd(6)} full ${full}, partly ${some - full}, empty ${days.length - some}`);
  }
  for (const [date, ids] of extras) console.warn(`  accepted but no seat left on ${date}: ${ids.map((id) => volunteers.find((v) => v.id === id)?.name ?? id).join(', ')}`);

  // Who moved, against the --base preview: the people to tell about this version.
  if (BASE_FILE) {
    const key = (p: { date: string; shift: NewShift }) => `${p.date} ${NEW_SHIFT_INFO[p.shift].label}`;
    const before = new Map<string, Set<string>>();
    const after = new Map<string, Set<string>>();
    for (const p of baseSeats) before.set(p.volunteer_id, (before.get(p.volunteer_id) ?? new Set()).add(key(p)));
    for (const p of all) after.set(p.volunteer_id, (after.get(p.volunteer_id) ?? new Set()).add(key(p)));
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .map((id) => {
        const was = before.get(id) ?? new Set<string>();
        const now = after.get(id) ?? new Set<string>();
        return { name: volunteers.find((v) => v.id === id)?.name ?? id, off: [...was].filter((k) => !now.has(k)).sort(), on: [...now].filter((k) => !was.has(k)).sort() };
      })
      .filter((c) => c.off.length || c.on.length)
      .sort((a, b) => a.name.localeCompare(b.name));
    console.log(`\nChanged from ${BASE_FILE}: ${changed.length} people`);
    for (const c of changed) {
      console.log(`  ${c.name}`);
      if (c.off.length) console.log(`    - ${c.off.join(', ')}`);
      if (c.on.length) console.log(`    + ${c.on.join(', ')}`);
    }
  }
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error('preview-new-shifts failed:', e); process.exit(1); });
