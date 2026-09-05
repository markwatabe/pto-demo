/**
 * Wipe all shift assignments and regenerate the whole school year with the
 * person-centric scheduler (src/schedule.ts). Shift rows are kept/created;
 * only assignments are replaced. Attendance history is lost — run this only
 * when a fresh year is wanted.
 *
 * Usage:  pnpm tsx scripts/regenerate-year.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  buildDraft,
  type AssignmentRow,
  type AvailabilityRow,
  type RosterVolunteer,
  type ShiftRow,
} from '../src/schedule';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

async function chunkedInsert(table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from(table).insert(rows.slice(i, i + 200));
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
  }
}

async function main() {
  const { data: year, error: yearError } = await db
    .from('school_year')
    .select('starts_on, ends_on')
    .maybeSingle();
  if (yearError || !year) throw new Error(yearError?.message ?? 'No school year set.');

  const [shiftsRes, closuresRes, volunteersRes, availabilityRes] = await Promise.all([
    db.from('green_team_shifts').select('id, date, slot'),
    db.from('school_closures').select('date'),
    db.from('volunteers').select('id, name, frequency, backfill'),
    db.from('availability').select('volunteer_id, weekday, slot'),
  ]);
  const fetchError =
    shiftsRes.error ?? closuresRes.error ?? volunteersRes.error ?? availabilityRes.error;
  if (fetchError) throw new Error(fetchError.message);

  const existingShifts = (shiftsRes.data ?? []) as ShiftRow[];

  // Wipe every assignment (the whole year is being redrawn).
  const { error: wipeError, count } = await db
    .from('shift_volunteers')
    .delete({ count: 'exact' })
    .gte('shift_id', '00000000-0000-0000-0000-000000000000');
  if (wipeError) throw new Error(`Assignment wipe failed: ${wipeError.message}`);
  console.log(`Cleared ${count ?? '?'} existing assignments.`);

  const plan = buildDraft({
    from: year.starts_on,
    to: year.ends_on,
    closures: new Set(((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date)),
    existingShifts,
    existingAssignments: [] as AssignmentRow[],
    availability: (availabilityRes.data ?? []) as AvailabilityRow[],
    volunteers: (volunteersRes.data ?? []) as RosterVolunteer[],
    newId: () => randomUUID(),
  });

  await chunkedInsert('green_team_shifts', plan.shiftInserts);
  await chunkedInsert('shift_volunteers', plan.assignmentInserts);

  const { schoolDays, shiftsCreated, assignments, openSlots } = plan.summary;
  console.log(
    `Regenerated ${year.starts_on} → ${year.ends_on}: ${schoolDays} school days, ` +
      `${shiftsCreated} new shift rows, ${assignments} assignments, ${openSlots} open slots.`,
  );

  // Per-volunteer counts for a quick eyeball.
  const nameById = new Map(
    ((volunteersRes.data ?? []) as RosterVolunteer[]).map((v) => [v.id, v.name]),
  );
  const perVolunteer = new Map<string, number>();
  for (const a of plan.assignmentInserts) {
    perVolunteer.set(a.volunteer_id, (perVolunteer.get(a.volunteer_id) ?? 0) + 1);
  }
  for (const [id, n] of [...perVolunteer.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${nameById.get(id) ?? id}: ${n} shifts`);
  }
}

main().catch((err) => {
  console.error('Regenerate failed:', err);
  process.exit(1);
});
