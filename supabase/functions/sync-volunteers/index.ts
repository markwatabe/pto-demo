// Pulls the Green Team sign-up responses from the Google Form's spreadsheet
// into the volunteers + availability tables. Admin-only. Mirrors
// scripts/import-volunteers.ts: upserts volunteers by (lowercased) email and
// REPLACES their availability rows; never touches volunteers absent from the
// sheet.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const SHEET_ID =
  Deno.env.get('GOOGLE_VOLUNTEERS_SHEET_ID') ?? '13B8L5uu5UhyIP1BVv0QKq3ZTsAfXZu_iQ8-LTjY9_mk';
const RESPONSES_GID = 702139134;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '\n')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The sheet is shared inside the Workspace only, so impersonation via
// domain-wide delegation is required (scope must match the DWD grant exactly).
async function googleAccessToken(
  saEmail: string,
  pem: string,
  impersonate: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: saEmail,
      sub: impersonate,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

// Column headers are long Google Forms questions — locate them by marker text.
function columnFor(headers: string[], marker: string): number {
  const i = headers.findIndex((h) => h.includes(marker));
  if (i === -1) throw new Error(`Sheet is missing a column containing "${marker}"`);
  return i;
}

// "Early Shift" -> early, "Late Shift" -> late, "Full Shift" -> both.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Admin gate: resolve the caller from their JWT, then check admins.
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json(401, { error: 'Not signed in.' });

    const db = createClient(supabaseUrl, serviceKey);
    const { data: adminRow } = await db
      .from('admins')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (!adminRow) return json(403, { error: 'Admins only.' });

    const saEmail = Deno.env.get('GOOGLE_SA_EMAIL');
    const saKey = Deno.env.get('GOOGLE_SA_PRIVATE_KEY');
    const impersonate = Deno.env.get('GOOGLE_IMPERSONATE_EMAIL');
    if (!saEmail || !saKey || !impersonate) {
      return json(500, {
        error:
          'Missing GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY / GOOGLE_IMPERSONATE_EMAIL function secrets.',
      });
    }

    const token = await googleAccessToken(saEmail, saKey, impersonate);
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

    const headers = rows[0]!;
    const emailCol = columnFor(headers, 'Email Address');
    const nameCol = columnFor(headers, 'Your name');
    const veteranCol = columnFor(headers, 'volunteered for Green Team before');
    const gradesCol = columnFor(headers, 'grade level');
    const frequencyCol = columnFor(headers, 'How often');
    const coriCol = columnFor(headers, 'CORI form');
    const backfillCol = columnFor(headers, 'emergency backfill');
    const notesCol = columnFor(headers, 'additional comments');
    const weekdayCols: Array<[number, number]> = [
      [1, columnFor(headers, '[Monday]')],
      [2, columnFor(headers, '[Tuesday]')],
      [3, columnFor(headers, '[Wednesday]')],
      [4, columnFor(headers, '[Thursday]')],
    ];

    let imported = 0;
    let skipped = 0;
    for (const row of rows.slice(1)) {
      const email = (row[emailCol] ?? '').trim().toLowerCase();
      const name = (row[nameCol] ?? '').trim();
      if (!email || !name) {
        skipped++;
        continue;
      }

      const { frequency, note } = frequencyFor(row[frequencyCol]);
      const { data: vol, error: upsertError } = await db
        .from('volunteers')
        .upsert(
          {
            email,
            name,
            veteran: (row[veteranCol] ?? '').trim().startsWith('Yes'),
            grades: (row[gradesCol] ?? '').trim() || null,
            frequency,
            frequency_note: note,
            cori: coriFor(row[coriCol]),
            backfill: (row[backfillCol] ?? '').trim() === 'Yes',
            notes: (row[notesCol] ?? '').trim() || null,
          },
          { onConflict: 'email' },
        )
        .select('id')
        .single();
      if (upsertError || !vol) {
        throw new Error(`Upsert failed for ${email}: ${upsertError?.message ?? 'no row returned'}`);
      }

      const { error: clearError } = await db
        .from('availability')
        .delete()
        .eq('volunteer_id', vol.id);
      if (clearError) {
        throw new Error(`Availability clear failed for ${email}: ${clearError.message}`);
      }

      const availabilityRows = weekdayCols.flatMap(([weekday, col]) =>
        slotsFor(row[col]).map((slot) => ({ volunteer_id: vol.id, weekday, slot })),
      );
      if (availabilityRows.length > 0) {
        const { error: insertError } = await db.from('availability').insert(availabilityRows);
        if (insertError) {
          throw new Error(`Availability insert failed for ${email}: ${insertError.message}`);
        }
      }
      imported++;
    }

    return json(200, { imported, skipped, responses: rows.length - 1 });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
