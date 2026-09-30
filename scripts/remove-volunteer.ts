/**
 * A volunteer has left: delete their record (assignments, availability and
 * blackouts cascade), cancel their future calendar invites quietly, and drop
 * their row from Sheet2 so a resync can't bring them back.
 *
 *   pnpm remove:volunteer someone@example.com
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { googleAccessToken, googleFetch, SCOPES, SHEETS_USER } from './lib/google';

const ROSTER = process.env.GOOGLE_VOLUNTEERS_SHEET_ID ?? '1jak9GvwPYAg7hBNguGTp0fN7DXnga-yZMCBjzWj4Qrk';
const SHEET2_GID = 1074567362;
const EMAIL = (process.argv[2] ?? '').trim().toLowerCase();
if (!EMAIL.includes('@')) throw new Error('Usage: pnpm remove:volunteer <email>');
const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cronSecret = process.env.CRON_SECRET;
if (!url || !serviceKey) throw new Error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
if (!cronSecret) throw new Error('Missing CRON_SECRET in .env (needed to cancel invites)');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

async function main() {
  const { data: v } = await db.from('volunteers').select('id,name').eq('email', EMAIL).maybeSingle();
  if (!v) { console.log(`${EMAIL} is not on the roster.`); }
  else {
    const { data: a } = await db.from('shift_volunteers').select('shift:green_team_shifts(date,slot)').eq('volunteer_id', v.id);
    const mine = (a ?? []).map((x) => (x as { shift: { date: string; slot: string } }).shift).sort((p, q) => p.date.localeCompare(q.date));
    console.log(`${v.name}: ${mine.length} shift(s) → ${mine.map((s) => s.date.slice(5) + s.slot[0]!.toUpperCase()).join(' ') || '-'}`);
    const { error } = await db.from('volunteers').delete().eq('id', v.id);
    if (error) throw new Error(error.message);
    console.log('deleted from the roster (assignments, availability, blackouts removed)');
    const affected = mine.filter((s) => s.date >= new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    if (affected.length) {
      const { data: sh } = await db.from('green_team_shifts').select('date,slot,assignments:shift_volunteers(volunteer:volunteers(name,veteran))').in('date', affected.map((s) => s.date));
      console.log('their future shifts now:');
      for (const s of (sh ?? []) as { date: string; slot: string; assignments: { volunteer: { name: string; veteran: boolean } }[] }[]) {
        if (!affected.some((m) => m.date === s.date && m.slot === s.slot)) continue;
        console.log(`  ${s.date} ${s.slot}: ${s.assignments.map((x) => x.volunteer.name + (x.volunteer.veteran ? '' : ' (new)')).join(', ') || '(nobody)'}`);
      }
    }
  }
  const H = { 'Content-Type': 'application/json', apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY ?? ''}`, 'x-cron-secret': cronSecret };
  const d = (await (await fetch(`${url}/functions/v1/sync-invites`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, confirm: true, limit: 100 }) })).json()) as { cancelled?: number; error?: string };
  console.log(`calendar invites cancelled quietly: ${d.cancelled ?? 0}${d.error ? ` (${d.error})` : ''}`);
  const t = await googleAccessToken(SHEETS_USER, SCOPES.sheets);
  const rows = (await googleFetch<{ values?: string[][] }>(t, `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER}/values/${encodeURIComponent('Sheet2!A1:B1000')}`)).values ?? [];
  const i = rows.findIndex((r, idx) => idx > 0 && (r[1] ?? '').trim().toLowerCase() === EMAIL);
  if (i > 0) {
    await googleFetch(t, `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: SHEET2_GID, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }] }) });
    console.log(`Sheet2 row ${i + 1} removed`);
  } else console.log('not in Sheet2');
}

main().catch((e) => { console.error('remove-volunteer failed:', e); process.exit(1); });
