/**
 * Redraw the assignments inside one date window, leaving the rest of the
 * year untouched. Assignments outside the window still anchor everyone's
 * cadence, alternation and pairing rules.
 *
 *   pnpm tsx scripts/reschedule-window.ts --from 2026-09-08 --to 2026-09-21 [--flexible-only] [--only email]
 *
 * --only: redraw just this volunteer — only their assignments in the window
 * are cleared and only they are placed; everyone else stays put.
 *
 * --flexible-only: inside the window only volunteers who said they have a
 * flexible schedule (the "emergency backfill" question → volunteers.backfill)
 * are eligible. Standing weekday rules still apply.
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

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const from = arg('--from');
const to = arg('--to');
const flexibleOnly = process.argv.includes('--flexible-only');
const only = arg('--only')?.toLowerCase();
if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  throw new Error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--flexible-only]');
}

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

async function main() {
  const [shiftsRes, closuresRes, volunteersRes, availabilityRes, blackoutsRes, fixedRes, assignRes] =
    await Promise.all([
      db.from('green_team_shifts').select('id, date, slot'),
      db.from('school_closures').select('date'),
      db.from('volunteers').select('id, name, email, frequency, backfill, veteran, alternate'),
      db.from('availability').select('volunteer_id, weekday, slot'),
      db.from('volunteer_blackouts').select('volunteer_id, starts_on, ends_on, weekday'),
      db.from('volunteer_fixed_shifts').select('volunteer_id, weekday, slot'),
      db.from('shift_volunteers').select('shift_id, volunteer_id'),
    ]);
  const err =
    shiftsRes.error ?? closuresRes.error ?? volunteersRes.error ?? availabilityRes.error ??
    blackoutsRes.error ?? fixedRes.error ?? assignRes.error;
  if (err) throw new Error(err.message);

  const shifts = (shiftsRes.data ?? []) as ShiftRow[];
  const inWindow = new Set(shifts.filter((s) => s.date >= from && s.date <= to).map((s) => s.id));
  type Vol = RosterVolunteer & { email: string };
  const volunteers = (volunteersRes.data ?? []) as Vol[];
  const onlyVol = only ? volunteers.find((v) => v.email.toLowerCase() === only) : undefined;
  if (only && !onlyVol) throw new Error(`No volunteer with email ${only}`);
  const all = (assignRes.data ?? []) as AssignmentRow[];
  const clears = (a: AssignmentRow) => inWindow.has(a.shift_id) && (!onlyVol || a.volunteer_id === onlyVol.id);
  const keep = all.filter((a) => !clears(a));
  const dropped = all.length - keep.length;

  if (inWindow.size > 0) {
    let q = db.from('shift_volunteers').delete().in('shift_id', [...inWindow]);
    if (onlyVol) q = q.eq('volunteer_id', onlyVol.id);
    const { error } = await q;
    if (error) throw new Error(`clear failed: ${error.message}`);
  }
  console.log(`Cleared ${dropped} assignments in ${from} → ${to}.`);

  const plan = buildDraft({
    from,
    to,
    closures: new Set(((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date)),
    existingShifts: shifts,
    existingAssignments: keep,
    availability: (availabilityRes.data ?? []) as AvailabilityRow[],
    blackouts: (blackoutsRes.data ?? []) as BlackoutRow[],
    fixedShifts: (fixedRes.data ?? []) as FixedShiftRow[],
    volunteers,
    eligible: (v) => (!flexibleOnly || v.backfill) && (!onlyVol || v.id === onlyVol.id),
    newId: () => randomUUID(),
  });
  for (let i = 0; i < plan.shiftInserts.length; i += 200) {
    const { error } = await db.from('green_team_shifts').insert(plan.shiftInserts.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  for (let i = 0; i < plan.assignmentInserts.length; i += 200) {
    const { error } = await db.from('shift_volunteers').insert(plan.assignmentInserts.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  const { schoolDays, assignments, openSlots, emptyShifts } = plan.summary;
  console.log(
    `Redrew ${from} → ${to}${flexibleOnly ? ' (flexible people only)' : ''}: ${schoolDays} school days, ` +
      `${assignments} assignments, ${openSlots} open slots, ${emptyShifts} shifts with nobody.`,
  );
  const nameById = new Map(volunteers.map((v) => [v.id, v]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const byDate = new Map<string, string[]>();
  for (const a of plan.assignmentInserts) {
    const s = shiftById.get(a.shift_id)!;
    const k = `${s.date} ${s.slot}`;
    byDate.set(k, [...(byDate.get(k) ?? []), nameById.get(a.volunteer_id)!.name]);
  }
  for (const k of [...byDate.keys()].sort()) console.log(`  ${k.padEnd(17)} ${byDate.get(k)!.join(', ')}`);
}

main().catch((e) => {
  console.error('reschedule-window failed:', e);
  process.exit(1);
});
