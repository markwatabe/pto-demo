/**
 * Pull the live Green Team sign-up responses from the Google Form's
 * spreadsheet and rewrite volunteers.csv (git-ignored — real PII).
 *
 * Usage:  pnpm fetch:volunteers   (runs this, then scripts/import-volunteers.ts)
 *
 * Auth: the PTO service account key (local file, never in git) impersonating
 * GOOGLE_IMPERSONATE_EMAIL via domain-wide delegation, Sheets scope.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const KEY_FILE =
  process.env.GOOGLE_SA_KEY_FILE ?? `${process.env.HOME}/.config/pto-calendar-sync-key.json`;
const SHEET_ID =
  process.env.GOOGLE_VOLUNTEERS_SHEET_ID ?? '13B8L5uu5UhyIP1BVv0QKq3ZTsAfXZu_iQ8-LTjY9_mk';
const RESPONSES_GID = 702139134;
const CSV_PATH = fileURLToPath(new URL('../volunteers.csv', import.meta.url));

const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL;
if (!impersonate) throw new Error('Missing GOOGLE_IMPERSONATE_EMAIL in .env');

type ServiceAccountKey = { client_email: string; private_key: string };

function googleAssertion(key: ServiceAccountKey): string {
  const b64u = (s: string) => Buffer.from(s).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(
    JSON.stringify({
      iss: key.client_email,
      sub: impersonate,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(key.private_key).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

async function accessToken(key: ServiceAccountKey): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: googleAssertion(key),
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

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
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as ServiceAccountKey;
  const token = await accessToken(key);
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
