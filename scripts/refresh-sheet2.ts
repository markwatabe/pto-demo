/**
 * Bring the curated roster sheet (Sheet2) up to date with the sign-up form:
 *   - people in the form but missing from Sheet2 are appended,
 *   - people who resubmitted get their Sheet2 row replaced by their LATEST
 *     response (columns A–M; anything you keep in later columns is untouched).
 * Then run `pnpm fetch:volunteers` to import. Dry run unless --apply.
 *
 *   pnpm sheet2:refresh            # show what would change
 *   pnpm sheet2:refresh --apply
 *
 * Rows you removed from Sheet2 on purpose (people who left) come back only if
 * they submit the form again — deleted rows are not re-added from old responses.
 */
import 'dotenv/config';
import { googleAccessToken, googleFetch, SCOPES, SHEETS_USER } from './lib/google';

const FORM = process.env.GOOGLE_FORM_SHEET_ID ?? '13B8L5uu5UhyIP1BVv0QKq3ZTsAfXZu_iQ8-LTjY9_mk';
const ROSTER = process.env.GOOGLE_VOLUNTEERS_SHEET_ID ?? '1jak9GvwPYAg7hBNguGTp0fN7DXnga-yZMCBjzWj4Qrk';
const APPLY = process.argv.includes('--apply');
const COLS = 13;
const WATCH = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // veteran, grades, Mon–Thu, frequency, CORI, backfill, comments

async function main() {
  const t = await googleAccessToken(SHEETS_USER, SCOPES.sheets);
  const read = async (id: string, range: string) =>
    (await googleFetch<{ values?: string[][] }>(t, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`)).values ?? [];
  const form = await read(FORM, "'Form Responses 1'!A1:M1000");
  const sheet = await read(ROSTER, 'Sheet2!A1:M1000');
  const norm = (e?: string) => (e ?? '').trim().toLowerCase();

  const latest = new Map<string, string[]>();
  for (const r of form.slice(1)) if (r[1]) latest.set(norm(r[1]), r); // form is chronological; last wins
  const rowOf = new Map<string, number>();
  sheet.forEach((r, i) => { if (i > 0 && r[1]) rowOf.set(norm(r[1]), i + 1); });

  const appends: string[][] = [];
  const updates: { row: number; name: string; changes: string[]; values: string[] }[] = [];
  for (const [email, r] of latest) {
    const values = Array.from({ length: COLS }, (_, k) => r[k] ?? '');
    const row = rowOf.get(email);
    if (!row) { appends.push(values); continue; }
    const cur = sheet[row - 1]!;
    const changes = WATCH.filter((c) => (cur[c] ?? '').trim() !== (r[c] ?? '').trim()).map((c) => `${'ABCDEFGHIJKLM'[c]}: "${cur[c] ?? ''}" → "${r[c] ?? ''}"`);
    if (changes.length) updates.push({ row, name: r[2]!.trim(), changes, values });
  }
  console.log(`form: ${latest.size} people | Sheet2: ${rowOf.size} | to append: ${appends.length} | to update: ${updates.length}`);
  for (const a of appends) console.log(`  + ${a[2]!.trim()} <${a[1]}> (${a[0]})`);
  for (const u of updates) { console.log(`  ~ ${u.name} (row ${u.row})`); for (const c of u.changes) console.log(`      ${c}`); }
  if (!APPLY) { console.log('(dry run — add --apply, then run pnpm fetch:volunteers)'); return; }
  if (updates.length) {
    await googleFetch(t, `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates.map((u) => ({ range: `Sheet2!A${u.row}:M${u.row}`, values: [u.values] })) }),
    });
  }
  if (appends.length) {
    await googleFetch(t, `https://sheets.googleapis.com/v4/spreadsheets/${ROSTER}/values/${encodeURIComponent('Sheet2!A1:M1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: appends }),
    });
  }
  console.log(`Sheet2 updated: ${appends.length} appended, ${updates.length} replaced. Now run: pnpm fetch:volunteers`);
}

main().catch((e) => { console.error('refresh-sheet2 failed:', e); process.exit(1); });
