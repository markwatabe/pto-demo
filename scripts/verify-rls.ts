/**
 * Verify RLS: unauthenticated (anon key, no session) reads must return zero
 * rows for every gated table; the service-role key must see the seeded data.
 *
 * Usage:  pnpm verify:rls   (run after pnpm seed)
 *
 * Seed-backed tables also assert service-role rows > 0. Roster/schedule
 * tables (volunteers, availability, shifts, school calendar) hold real data
 * that may legitimately be empty, so they are checked as anon-zero only.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env',
  );
}

const anonDb = createClient(url, anonKey, { auth: { persistSession: false } });
const adminDb = createClient(url, serviceKey, { auth: { persistSession: false } });

const TABLES = [
  'families',
  'parents',
  'children',
  'teachers',
  'child_past_teachers',
  'profiles',
  'admins',
  'green_team_shifts',
  'shift_volunteers',
  'volunteers',
  'availability',
  'school_year',
  'school_closures',
];

// Populated by pnpm seed — the service role must see rows here.
const SEEDED = new Set([
  'families',
  'parents',
  'children',
  'teachers',
  'child_past_teachers',
  'profiles',
  'admins',
]);

async function countRows(client: ReturnType<typeof createClient>, table: string) {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`Count failed for ${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  let failed = false;

  for (const table of TABLES) {
    const anonCount = await countRows(anonDb, table);
    const adminCount = await countRows(adminDb, table);

    const anonOk = anonCount === 0;
    const adminOk = SEEDED.has(table) ? adminCount > 0 : true;
    if (!anonOk || !adminOk) failed = true;

    const adminNote = SEEDED.has(table) ? ' (want > 0)' : '';
    console.log(
      `${anonOk && adminOk ? 'PASS' : 'FAIL'}  ${table}: anon sees ${anonCount} (want 0), ` +
        `service role sees ${adminCount}${adminNote}`,
    );
  }

  if (failed) {
    console.error('RLS verification FAILED.');
    process.exit(1);
  }
  console.log('RLS verification passed.');
}

main().catch((err) => {
  console.error('verify-rls failed:', err);
  process.exit(1);
});
