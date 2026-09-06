/**
 * Pull the curated Green Team volunteer sheet ("Current Greenteam
 * volunteers", tab Sheet2 — same columns as the sign-up form responses) and
 * rewrite volunteers.csv (git-ignored — real PII).
 *
 * Usage:  pnpm fetch:volunteers   (runs this, then scripts/import-volunteers.ts)
 *
 * Auth: the PTO service account key (local file, never in git) impersonating
 * the sheet owner via domain-wide delegation — see scripts/lib/google.ts.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { googleAccessToken, SCOPES, SHEETS_USER } from './lib/google';

const SHEET_ID =
  process.env.GOOGLE_VOLUNTEERS_SHEET_ID ?? '1jak9GvwPYAg7hBNguGTp0fN7DXnga-yZMCBjzWj4Qrk';
const RESPONSES_GID = 1074567362;
const CSV_PATH = fileURLToPath(new URL('../volunteers.csv', import.meta.url));

// RFC 4180 quoting; every row padded to the header's width so the importer
// always sees a value (possibly empty) for every column.
function toCsv(rows: string[][]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const width = rows[0]?.length ?? 0;
  return (
    rows
      .map((r) => Array.from({ length: width }, (_, i) => esc(r[i])).join(','))
      .join('\n') + '\n'
  );
}

async function main() {
  const token = await googleAccessToken(SHEETS_USER, SCOPES.sheets);
  const gHeaders = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,
    { headers: gHeaders },
  );
  const meta = await metaRes.json();
  if (meta.error) throw new Error(`Sheets metadata failed: ${JSON.stringify(meta.error)}`);
  type TabProps = { title: string; sheetId: number };
  const tabs = (meta.sheets as { properties: TabProps }[]).map((s) => s.properties);
  const tab = tabs.find((t) => t.sheetId === RESPONSES_GID) ?? tabs[0];
  if (!tab) throw new Error('Spreadsheet has no tabs');

  const valsRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab.title)}?majorDimension=ROWS`,
    { headers: gHeaders },
  );
  const vals = await valsRes.json();
  if (vals.error) throw new Error(`Sheets values failed: ${JSON.stringify(vals.error)}`);
  const rows = (vals.values ?? []) as string[][];
  if (rows.length < 2) throw new Error(`Tab "${tab.title}" has no response rows`);

  writeFileSync(CSV_PATH, toCsv(rows));
  console.log(`Fetched "${tab.title}": ${rows.length - 1} responses -> volunteers.csv`);
}

main().catch((err) => {
  console.error('Fetch failed:', err);
  process.exit(1);
});
