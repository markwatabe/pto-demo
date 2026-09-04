/**
 * Import Green Team volunteer sign-ups from volunteers.csv (Google Forms export).
 *
 * Usage:  pnpm import:volunteers
 *
 * Upserts volunteers by (lowercased) email and REPLACES their availability
 * rows, so it is safe to re-run as new form responses arrive. Never touches
 * volunteers absent from the CSV.
 *
 * volunteers.csv holds real PII — it is git-ignored; never commit it.
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const CSV_PATH = fileURLToPath(new URL('../volunteers.csv', import.meta.url));

type Row = Record<string, string>;

// Column headers are long Google Forms questions — locate them by marker text.
function headerFor(rows: Row[], marker: string): string {
  const keys = Object.keys(rows[0] ?? {});
  const key = keys.find((k) => k.includes(marker));
  if (!key) throw new Error(`CSV is missing a column containing "${marker}"`);
  return key;
}

// "Early Shift" -> early, "Late Shift" -> late, "Full Shift" -> both.
// Cells can list several, comma-separated; "N/A" or empty means none.
function slotsFor(cell: string | undefined): string[] {
  const text = (cell ?? '').trim();
  if (!text) return [];
  const slots = new Set<string>();
  if (text.includes('Early Shift')) slots.add('early');
  if (text.includes('Late Shift')) slots.add('late');
  if (text.includes('Full Shift')) {
    slots.add('early');
    slots.add('late');
  }
  return [...slots];
}

function frequencyFor(cell: string | undefined): { frequency: string; note: string | null } {
  const text = (cell ?? '').trim();
  if (text === 'Once a month') return { frequency: 'monthly', note: null };
  if (text === 'Every other week') return { frequency: 'biweekly', note: null };
  return { frequency: 'custom', note: text || null };
}

function coriFor(cell: string | undefined): 'yes' | 'no' | 'unsure' {
  const text = (cell ?? '').trim().toLowerCase();
  if (text === 'yes') return 'yes';
  if (text === 'no') return 'no';
  return 'unsure';
}

async function main() {
  const rows = parse(readFileSync(CSV_PATH, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  }) as Row[];
  if (rows.length === 0) throw new Error('volunteers.csv has no data rows');

  const emailKey = headerFor(rows, 'Email Address');
  const nameKey = headerFor(rows, 'Your name');
  const veteranKey = headerFor(rows, 'volunteered for Green Team before');
  const gradesKey = headerFor(rows, 'grade level');
  const frequencyKey = headerFor(rows, 'How often');
  const coriKey = headerFor(rows, 'CORI form');
  const backfillKey = headerFor(rows, 'emergency backfill');
  const notesKey = headerFor(rows, 'additional comments');
  const weekdayKeys: Array<[number, string]> = [
    [1, headerFor(rows, '[Monday]')],
    [2, headerFor(rows, '[Tuesday]')],
    [3, headerFor(rows, '[Wednesday]')],
    [4, headerFor(rows, '[Thursday]')],
  ];

  let imported = 0;
  for (const row of rows) {
    const email = (row[emailKey] ?? '').trim().toLowerCase();
    const name = (row[nameKey] ?? '').trim();
    if (!email || !name) {
      console.warn('  skipping a row with missing email or name');
      continue;
    }

    const { frequency, note } = frequencyFor(row[frequencyKey]);
    const { data: vol, error: upsertError } = await db
      .from('volunteers')
      .upsert(
        {
          email,
          name,
          veteran: (row[veteranKey] ?? '').trim().startsWith('Yes'),
          grades: (row[gradesKey] ?? '').trim() || null,
          frequency,
          frequency_note: note,
          cori: coriFor(row[coriKey]),
          backfill: (row[backfillKey] ?? '').trim() === 'Yes',
          notes: (row[notesKey] ?? '').trim() || null,
        },
        { onConflict: 'email' },
      )
      .select('id')
      .single();
    if (upsertError || !vol) {
      throw new Error(`Upsert failed for ${email}: ${upsertError?.message ?? 'no row returned'}`);
    }

    const { error: clearError } = await db.from('availability').delete().eq('volunteer_id', vol.id);
    if (clearError) throw new Error(`Availability clear failed for ${email}: ${clearError.message}`);

    const availabilityRows = weekdayKeys.flatMap(([weekday, key]) =>
      slotsFor(row[key]).map((slot) => ({ volunteer_id: vol.id, weekday, slot })),
    );
    if (availabilityRows.length > 0) {
      const { error: insertError } = await db.from('availability').insert(availabilityRows);
      if (insertError) throw new Error(`Availability insert failed for ${email}: ${insertError.message}`);
    }

    console.log(`  imported ${email} (${availabilityRows.length} availability slots)`);
    imported++;
  }

  console.log(`Imported ${imported} volunteers.`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
