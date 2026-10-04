/**
 * Make a new-shifts preview the live schedule. From the page's first day on
 * (never before today) the database holds exactly the page's First/Second/
 * Third shifts: one row per shift per school day, with the page's seats as
 * assignments. Earlier days are history and stay as they are. Someone who had
 * accepted their invite for a day keeps `accepted` on their new seats that
 * day; the calendar webhook keeps it in step from then on.
 *
 * DRY RUN unless --apply. Calendar invites follow separately (sync-invites).
 * Safe to re-run: it clears its own earlier rows before writing.
 *
 *   pnpm apply:new-shifts new-shifts-preview-v4.html            # show the plan
 *   pnpm apply:new-shifts new-shifts-preview-v4.html --apply
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { NEW_SHIFTS, type NewShift } from '../src/newShifts';
import { readNewShiftsPreviewData } from './lib/render-new-shifts-preview';

const input = process.argv.slice(2).find((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!input) throw new Error('usage: pnpm apply:new-shifts <preview.html> [--apply]');

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

type Day = { date: string; seats: Record<NewShift, { id: string }[]> };
type ShiftRow = { id: string; date: string; slot: string; assignments: { volunteer_id: string; accepted: boolean }[] };

async function main() {
  const data = readNewShiftsPreviewData(readFileSync(input!, 'utf8'));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const from = [String(data.from), today].sort()[1]!;
  const days = (data.days as Day[]).filter((d) => d.date >= from);

  const { data: rows, error } = await db
    .from('green_team_shifts')
    .select('id, date, slot, assignments:shift_volunteers ( volunteer_id, accepted )')
    .gte('date', from)
    .limit(5000);
  if (error) throw new Error(error.message);
  const current = (rows ?? []) as unknown as ShiftRow[];
  const acceptedDay = new Set(current.flatMap((s) => s.assignments.filter((a) => a.accepted).map((a) => `${a.volunteer_id}|${s.date}`)));

  const shifts = days.flatMap((d) => NEW_SHIFTS.map((slot) => ({ date: d.date, slot, ids: d.seats[slot].map((s) => s.id) })));
  const seats = shifts.reduce((n, s) => n + s.ids.length, 0);
  const keptAccepted = shifts.reduce((n, s) => n + s.ids.filter((id) => acceptedDay.has(`${id}|${s.date}`)).length, 0);
  const count = (slot: string) => current.filter((s) => s.slot === slot);
  console.log(`From ${from} (${days.length} school days):`);
  for (const slot of ['early', 'late', 'first', 'second', 'third']) {
    const c = count(slot);
    if (c.length) console.log(`  remove ${c.length} ${slot} shifts (${c.reduce((n, s) => n + s.assignments.length, 0)} assignments)`);
  }
  console.log(`  add ${shifts.length} First/Second/Third shifts with ${seats} assignments (${keptAccepted} keep "accepted" from their day)`);
  if (!APPLY) return console.log('Dry run. Pass --apply to write.');

  // 1. Clear any rows an earlier run of this script wrote, 2. write the new ones, 3. drop the old early/late days.
  const clear = async (slots: string[]) => {
    const { error: e } = await db.from('green_team_shifts').delete().gte('date', from).in('slot', slots);
    if (e) throw new Error(`delete ${slots.join('/')} failed: ${e.message}`);
  };
  await clear([...NEW_SHIFTS]);
  for (let i = 0; i < shifts.length; i += 200) {
    const batch = shifts.slice(i, i + 200);
    const { data: made, error: e } = await db.from('green_team_shifts').insert(batch.map(({ date, slot }) => ({ date, slot }))).select('id, date, slot');
    if (e) throw new Error(`insert shifts failed: ${e.message}`);
    const idOf = new Map((made ?? []).map((m) => [`${m.date}|${m.slot}`, m.id as string]));
    const assignments = batch.flatMap((s) => s.ids.map((volunteer_id) => ({ shift_id: idOf.get(`${s.date}|${s.slot}`)!, volunteer_id, accepted: acceptedDay.has(`${volunteer_id}|${s.date}`) })));
    if (assignments.length) {
      const { error: e2 } = await db.from('shift_volunteers').insert(assignments);
      if (e2) throw new Error(`insert assignments failed: ${e2.message}`);
    }
  }
  await clear(['early', 'late']);
  console.log('Applied.');
}

main().catch((e) => { console.error('apply-new-shifts failed:', e); process.exit(1); });
