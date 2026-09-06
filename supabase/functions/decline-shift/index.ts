// A roster volunteer taps "Can't make it" on one of their own shifts in the
// public /fiske-schedule view (no login — identified by roster email). For
// now this only emails the coordinator; the assignment is left in place so
// the coordinator decides what to do with the slot.
//
// Mail goes out through the Gmail API as GOOGLE_IMPERSONATE_EMAIL (service
// account + domain-wide delegation, scope gmail.send — that scope must be on
// the DWD grant). Recipient: DECLINE_NOTIFY_EMAIL, defaulting to the
// impersonated account.
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

const SLOT_LABEL: Record<string, string> = {
  early: 'Early (11:05–12:15)',
  late: 'Late (12:20–1:30)',
};

function todayInNewYork(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// "2026-09-14" -> "Monday, September 14, 2026"
function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

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

async function googleAccessToken(
  saEmail: string,
  pem: string,
  impersonate: string,
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: saEmail,
      sub: impersonate,
      scope,
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
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).access_token as string;
}

async function sendGmail(args: {
  token: string;
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
}): Promise<void> {
  const raw = [
    `From: Fiske Green Team <${args.from}>`,
    `To: ${args.to}`,
    `Reply-To: ${args.replyTo}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    args.text,
  ].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      date?: string;
      slot?: string;
    };
    const email = (body.email ?? '').trim().toLowerCase();
    const date = body.date ?? '';
    const slot = body.slot ?? '';
    if (!email.includes('@')) return json(400, { error: 'A valid email is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'Invalid date.' });
    if (slot !== 'early' && slot !== 'late') return json(400, { error: 'Invalid slot.' });
    if (date < todayInNewYork()) return json(400, { error: 'That shift is in the past.' });

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: volunteer } = await db
      .from('volunteers')
      .select('id, name')
      .eq('email', email)
      .maybeSingle();
    if (!volunteer) {
      return json(403, {
        error: 'This email is not on the volunteer roster — check with the coordinator.',
      });
    }

    const { data: shift } = await db
      .from('green_team_shifts')
      .select('id, assignments:shift_volunteers ( volunteer:volunteers ( id, name ) )')
      .eq('date', date)
      .eq('slot', slot)
      .maybeSingle();
    type Assignment = { volunteer: { id: string; name: string } | null };
    const assignees = ((shift?.assignments ?? []) as unknown as Assignment[])
      .map((a) => a.volunteer)
      .filter((v): v is { id: string; name: string } => v !== null);
    if (!shift || !assignees.some((v) => v.id === volunteer.id)) {
      return json(409, { error: "You're not on this shift." });
    }
    const others = assignees.filter((v) => v.id !== volunteer.id).map((v) => v.name);

    const saEmail = Deno.env.get('GOOGLE_SA_EMAIL');
    const saKey = Deno.env.get('GOOGLE_SA_PRIVATE_KEY');
    const impersonate = Deno.env.get('GOOGLE_IMPERSONATE_EMAIL');
    if (!saEmail || !saKey || !impersonate) {
      return json(500, { error: 'Email is not configured on the server.' });
    }
    const notify = Deno.env.get('DECLINE_NOTIFY_EMAIL') ?? impersonate;

    const when = `${longDate(date)} — ${SLOT_LABEL[slot]}`;
    const token = await googleAccessToken(
      saEmail,
      saKey,
      impersonate,
      'https://www.googleapis.com/auth/gmail.send',
    );
    await sendGmail({
      token,
      from: impersonate,
      to: notify,
      replyTo: email,
      subject: `Can't make it: ${volunteer.name} — ${longDate(date)} ${slot} shift`,
      text: [
        `${volunteer.name} (${email}) can't make their Green Team lunch shift.`,
        '',
        `When: ${when}`,
        `Also on this shift: ${others.length ? others.join(', ') : 'nobody'}`,
        '',
        'They are still listed on the shift — remove them or find cover from the admin schedule:',
        'https://pto-demo.onrender.com/admin/schedule',
        '',
        'Reply to this email to reach them directly.',
      ].join('\n'),
    });

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
