/**
 * Fill open seats without disturbing anyone who is already scheduled.
 *
 *   pnpm fill:gaps                       # dry run: who would go where
 *   pnpm fill:gaps --apply               # write assignments + send their invites
 *   pnpm fill:gaps --who all             # also let under-used existing volunteers take seats
 *   pnpm fill:gaps --skip a@x.com,b@y.com
 *
 * Default (--who unassigned): only volunteers with no future assignments are
 * placed. Existing assignments, blackouts (including every recorded decline
 * day), cadence, veteran pairing, alternation and standing rules all apply —
 * this is the normal generator run with everyone else frozen. Pass 1 covers
 * shifts with nobody (veterans only), pass 2 adds a second person.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  buildDraft,
  type AssignmentRow,
  type AvailabilityRow,
  type BlackoutRow,
  type FixedShiftRow,
  type RosterVolunteer,
  type ShiftRow,
} from '../src/schedule';

const APPLY = process.argv.includes('--apply');
const arg = (n: string) => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
const WHO = arg('--who') ?? 'unassigned';
const SKIP = new Set((arg('--skip') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function main() {
  const rs = await Promise.all([
    db.from('school_year').select('starts_on, ends_on').maybeSingle(),
    db.from('green_team_shifts').select('id, date, slot').limit(5000),
    db.from('school_closures').select('date'),
    db.from('volunteers').select('id, name, email, frequency, backfill, veteran, alternate'),
    db.from('availability').select('volunteer_id, weekday, slot'),
    db.from('volunteer_blackouts').select('volunteer_id, starts_on, ends_on, weekday'),
    db.from('volunteer_fixed_shifts').select('volunteer_id, weekday, slot'),
    db.from('shift_volunteers').select('shift_id, volunteer_id').limit(5000),
  ]);
  for (const r of rs) if (r.error) throw new Error(r.error.message);
  const [yearRes, shiftsRes, closuresRes, volsRes, availRes, blackRes, fixedRes, assignRes] = rs;
  const year = yearRes.data as { starts_on: string; ends_on: string } | null;
  if (!year) throw new Error('No school year set.');
  const from = addDays(todayNY(), 1);
  const to = year.ends_on;

  type Vol = RosterVolunteer & { email: string };
  const volunteers = (volsRes.data ?? []) as Vol[];
  const shifts = (shiftsRes.data ?? []) as ShiftRow[];
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const existing = (assignRes.data ?? []) as AssignmentRow[];
  const futureCount = new Map<string, number>();
  for (const a of existing) if ((byId.get(a.shift_id)?.date ?? '') >= from) futureCount.set(a.volunteer_id, (futureCount.get(a.volunteer_id) ?? 0) + 1);

  const eligibleIds = new Set(
    volunteers
      .filter((v) => !SKIP.has(v.email.toLowerCase()))
      .filter((v) => (WHO === 'all' ? true : (futureCount.get(v.id) ?? 0) === 0))
      .map((v) => v.id),
  );

  const plan = buildDraft({
    from,
    to,
    closures: new Set(((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date)),
    existingShifts: shifts,
    existingAssignments: existing,
    availability: (availRes.data ?? []) as AvailabilityRow[],
    blackouts: (blackRes.data ?? []) as BlackoutRow[],
    fixedShifts: (fixedRes.data ?? []) as FixedShiftRow[],
    volunteers,
    eligible: (v) => eligibleIds.has(v.id),
    newId: () => randomUUID(),
  });

  const nameOf = new Map(volunteers.map((v) => [v.id, v]));
  const byPerson = new Map<string, ShiftRow[]>();
  for (const a of plan.assignmentInserts) {
    const s = byId.get(a.shift_id) ?? plan.shiftInserts.find((x) => x.id === a.shift_id)!;
    byPerson.set(a.volunteer_id, [...(byPerson.get(a.volunteer_id) ?? []), s]);
  }
  const emptyBefore = shifts.filter((s) => s.date >= from && !existing.some((a) => a.shift_id === s.id)).length;
  console.log(`${from} → ${to} | eligible: ${eligibleIds.size} volunteer(s) (${WHO}) | new assignments: ${plan.assignmentInserts.length} | shifts with nobody: ${emptyBefore} → ${plan.summary.emptyShifts}`);
  for (const [vid, list] of [...byPerson].sort((a, b) => nameOf.get(a[0])!.name.localeCompare(nameOf.get(b[0])!.name))) {
    const v = nameOf.get(vid)!;
    console.log(`  ${v.name.padEnd(18)} ${(v.veteran ? 'vet' : 'new').padEnd(4)} +${String(list.length).padStart(2)}: ${list.sort((a, b) => a.date.localeCompare(b.date)).map((s) => `${s.date.slice(5)}${s.slot[0]!.toUpperCase()}`).join(' ')}`);
  }
  const unplaced = [...eligibleIds].filter((id) => !byPerson.has(id)).map((id) => nameOf.get(id)!.name);
  if (unplaced.length) console.log(`  nothing fit for: ${unplaced.join(', ')}`);
  if (!APPLY) { console.log('(dry run — add --apply to write and send invites)'); return; }

  for (let i = 0; i < plan.shiftInserts.length; i += 200) { const { error } = await db.from('green_team_shifts').insert(plan.shiftInserts.slice(i, i + 200)); if (error) throw new Error(error.message); }
  for (let i = 0; i < plan.assignmentInserts.length; i += 200) { const { error } = await db.from('shift_volunteers').insert(plan.assignmentInserts.slice(i, i + 200)); if (error) throw new Error(error.message); }
  // Invites for the people who gained shifts (creates only — nothing is cancelled here).
  const H = { 'Content-Type': 'application/json', apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY ?? ''}`, 'x-cron-secret': process.env.CRON_SECRET ?? '' };
  for (const vid of byPerson.keys()) {
    const v = nameOf.get(vid)!;
    const r = await fetch(`${url}/functions/v1/sync-invites`, { method: 'POST', headers: H, body: JSON.stringify({ email: v.email, confirm: true }) });
    const d = (await r.json().catch(() => ({}))) as { created?: number; error?: string };
    console.log(`  invites: ${v.name} created ${d.created ?? '?'}${d.error ? ` (${d.error})` : ''}`);
  }
  console.log('APPLIED');
}

main().catch((e) => { console.error('fill-gaps failed:', e); process.exit(1); });
