// Coordinator "nudge": emails a volunteer who hasn't responded to their
// calendar invite, asking them to accept or decline. Triggered from the
// coordinator's copy of the public schedule (/fiske-admin). Guard rails:
// only works for a pending (not accepted) assignment on a future shift, and
// at most one nudge per volunteer+shift per 20 hours (nudge_log).
// POST {test:true, to} sends a sample of the template instead.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---- Google auth + mail helpers (duplicated per function; functions are standalone) ----
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

async function googleAccessToken(sub: string, scope: string): Promise<string> {
  const saEmail = Deno.env.get('GOOGLE_SA_EMAIL');
  const pem = Deno.env.get('GOOGLE_SA_PRIVATE_KEY');
  if (!saEmail || !pem) throw new Error('Missing GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY secrets.');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: saEmail, sub, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token as string;
}

const MAIL_FROM = Deno.env.get('MAIL_FROM_EMAIL') ?? 'greenteam@fiskeschoolpto.org';
const COORDINATOR = Deno.env.get('DECLINE_NOTIFY_EMAIL') ?? 'mwatabe@fiskeschoolpto.org';
const TZ = 'America/New_York';
const SLOT_LABEL: Record<string, string> = { early: 'Early (11:05–12:15)', late: 'Late (12:20–1:30)' };

async function sendMail(args: { to: string; subject: string; text: string }): Promise<void> {
  const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/gmail.send');
  const raw = [
    `From: Fiske Green Team <${MAIL_FROM}>`,
    `To: ${args.to}`,
    `Reply-To: ${COORDINATOR}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    args.text,
  ].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
}

function todayInNewYork(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// "2026-09-10" -> "Thursday, September 10"
function longDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function nudgeEmail(name: string, date: string, slot: string): { subject: string; text: string } {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return {
    subject: `Quick check: your Green Team shift ${longDate(date)}`,
    text: [
      `Hi ${first},`,
      '',
      `Just checking in about your Green Team lunch shift on ${longDate(date)} — ${SLOT_LABEL[slot] ?? slot}.`,
      '',
      "You haven't responded to the calendar invite yet. When you get a moment, please:",
      '',
      '  • ACCEPT the invite if you can make it, or',
      "  • DECLINE it if you can't — declining takes you off the shift right away so we can find cover.",
      '',
      `The invite is in your inbox and Google Calendar (look for "${name}: Fiske Green Team").`,
      '',
      'Thank you for volunteering!',
      '— Fiske Green Team',
    ].join('\n'),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      test?: boolean;
      to?: string;
      date?: string;
      slot?: string;
      name?: string;
    };

    if (body.test === true) {
      const to = (body.to ?? '').trim().toLowerCase();
      if (!to.includes('@')) return json(400, { error: 'test mode needs "to".' });
      const sample = nudgeEmail('Tara Mathur', todayInNewYork(), 'late');
      await sendMail({ to, subject: `[TEST] ${sample.subject}`, text: sample.text });
      return json(200, { ok: true, test: true, to });
    }

    const date = body.date ?? '';
    const slot = body.slot ?? '';
    const name = (body.name ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'Invalid date.' });
    if (slot !== 'early' && slot !== 'late') return json(400, { error: 'Invalid slot.' });
    if (!name) return json(400, { error: 'A volunteer name is required.' });
    if (date < todayInNewYork()) return json(400, { error: 'That shift is in the past.' });

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: shift } = await db
      .from('green_team_shifts')
      .select('id, assignments:shift_volunteers ( accepted, volunteer:volunteers ( id, name, email ) )')
      .eq('date', date)
      .eq('slot', slot)
      .maybeSingle();
    if (!shift) return json(404, { error: 'No such shift.' });

    type Row = { accepted: boolean; volunteer: { id: string; name: string; email: string } | null };
    const matches = (shift.assignments as unknown as Row[]).filter(
      (a) => a.volunteer && a.volunteer.name.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1) {
      return json(404, { error: 'That volunteer is not on this shift.' });
    }
    const row = matches[0]!;
    if (row.accepted) return json(409, { error: 'They already accepted this shift.' });

    // One nudge per volunteer+shift per 20 hours.
    const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: recent } = await db
      .from('nudge_log')
      .select('id')
      .eq('volunteer_id', row.volunteer!.id)
      .eq('date', date)
      .eq('slot', slot)
      .gte('sent_at', cutoff)
      .limit(1);
    if (recent && recent.length > 0) {
      return json(429, { error: 'Already nudged for this shift in the last day.' });
    }

    const mail = nudgeEmail(row.volunteer!.name, date, slot);
    await sendMail({ to: row.volunteer!.email, subject: mail.subject, text: mail.text });
    await db.from('nudge_log').insert({ volunteer_id: row.volunteer!.id, date, slot });

    return json(200, { ok: true, nudged: row.volunteer!.name });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
