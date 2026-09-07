// One-click "I'll take it" links from cover-request emails. The link carries
// an HMAC-signed {email, date, slot, expiry}; on GET we claim the shift via
// claim-shift (same rules as the app: roster email, school day, capacity,
// veteran pairing), send the volunteer a per-person calendar invite, and
// render a small confirmation page. No login.
const CLAIM_SECRET = Deno.env.get('CLAIM_LINK_SECRET') ?? '';

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

/** Service-account token acting as Workspace user `sub` (domain-wide delegation). */
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

/** fetch() a Google API; throws with the body on non-2xx; returns parsed JSON ({} for empty). */
async function gfetch<T = Record<string, unknown>>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.split('?')[0]} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const MAIL_FROM = Deno.env.get('MAIL_FROM_EMAIL') ?? 'greenteam@fiskeschoolpto.org';
const CALENDAR_ID = Deno.env.get('GOOGLE_CALENDAR_ID') ?? MAIL_FROM;
const COORDINATOR = Deno.env.get('DECLINE_NOTIFY_EMAIL') ?? 'mwatabe@fiskeschoolpto.org';
const SITE = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://pto-demo.onrender.com';
const TZ = 'America/New_York';
const INVITE_MARKER = 'pto-demo-invite';
const SLOT_TIMES: Record<string, { start: string; end: string }> = {
  early: { start: '11:05', end: '12:15' },
  late: { start: '12:20', end: '13:30' },
};
const SLOT_LABEL: Record<string, string> = { early: 'Early (11:05–12:15)', late: 'Late (12:20–1:30)' };

/** Plain-text email from the Green Team mailbox. */
async function sendMail(args: { to: string; subject: string; text: string; replyTo?: string }): Promise<void> {
  const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/gmail.send');
  const raw = [
    `From: Fiske Green Team <${MAIL_FROM}>`,
    `To: ${args.to}`,
    args.replyTo ? `Reply-To: ${args.replyTo}` : '',
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    args.text,
  ]
    .filter((l) => l !== '')
    .join('\r\n');
  await gfetch(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: b64url(raw) }),
  });
}

function todayInNewYork(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Calendar days from today (NY) to an ISO date. */
function daysUntil(iso: string): number {
  return Math.round((Date.parse(iso + 'T12:00:00Z') - Date.parse(todayInNewYork() + 'T12:00:00Z')) / 86400000);
}

/** 1=Mon .. 7=Sun for a YYYY-MM-DD taken as a plain calendar date. */
function weekdayOf(iso: string): number {
  const day = new Date(iso + 'T12:00:00Z').getUTCDay();
  return day === 0 ? 7 : day;
}

// "2026-09-14" -> "Mon, Sep 14"
function shortDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

const calendarBase = () => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

type InviteKind = 'early' | 'late' | 'both shifts';
const slotsForKind = (kind: InviteKind): string[] => (kind === 'both shifts' ? ['early', 'late'] : [kind]);

/** Body of a per-person invite event: "{name}: Fiske Green Team ({kind})" with the volunteer as guest. */
// Google Calendar event colors: 5 Banana (yellow), 8 Graphite (gray), 10 Basil (green).
const KIND_COLOR: Record<InviteKind, string> = { early: '5', late: '8', 'both shifts': '10' };

function inviteEventBody(v: { id: string; name: string; email: string }, date: string, kind: InviteKind) {
  const slots = slotsForKind(kind);
  return {
    summary: `${v.name}: Fiske Green Team (${kind})`,
    colorId: KIND_COLOR[kind],
    description: `Your Green Team lunch shift at Fiske.\n\nCan't make it? Decline this invitation, or open ${SITE}/fiske-schedule and tap "Can't make it" on this shift.`,
    start: { dateTime: `${date}T${SLOT_TIMES[slots[0]!]!.start}:00`, timeZone: TZ },
    end: { dateTime: `${date}T${SLOT_TIMES[slots[slots.length - 1]!]!.end}:00`, timeZone: TZ },
    attendees: [{ email: v.email, displayName: v.name }],
    guestsCanInviteOthers: false,
    extendedProperties: { private: { managedBy: INVITE_MARKER, ptoKey: `${v.id}|${date}|${kind}`, email: v.email } },
  };
}
// ---- end helpers ----

function page(title: string, body: string, ok: boolean): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f7f4;margin:0;padding:24px;color:#1f2a1f}main{max-width:28rem;margin:8vh auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:1.35rem;margin:0 0 12px;color:${ok ? '#2f6b3a' : '#8a3b2f'}}p{line-height:1.5;margin:0 0 12px}a{color:#2f6b3a}</style></head>
<body><main><h1>${title}</h1>${body}<p style="margin-top:20px"><a href="${SITE}/fiske-schedule">Open the schedule</a></p></main></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function verifyToken(t: string): Promise<{ e: string; d: string; s: string; x: number } | null> {
  const [payload, sig] = t.split('.');
  if (!payload || !sig || !CLAIM_SECRET) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(CLAIM_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  if (expected !== sig) return null;
  try {
    const pad = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const data = JSON.parse(atob(pad.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof data.e !== 'string' || typeof data.d !== 'string' || typeof data.s !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const t = new URL(req.url).searchParams.get('t') ?? '';
  const claim = await verifyToken(t);
  if (!claim) return page("This link isn't valid", '<p>It may have been copied incompletely. Open the schedule and claim the shift there instead.</p>', false);
  if (claim.x && claim.x * 1000 < Date.now()) return page('This link has expired', '<p>The shift date has passed.</p>', false);

  const when = `${shortDate(claim.d)} — ${SLOT_LABEL[claim.s] ?? claim.s}`;
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/claim-shift`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_ANON_KEY') ?? ''}`,
      },
      body: JSON.stringify({ email: claim.e, date: claim.d, slot: claim.s }),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) {
      const already = res.status === 409 && /already/i.test(out.error ?? '');
      return page(
        already ? "You're already on this shift" : "Couldn't add you to this shift",
        `<p><strong>${when}</strong></p><p>${out.error ?? 'Please try again or open the schedule.'}</p>`,
        already,
      );
    }

    // Calendar invite for the new assignment.
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: v } = await db.from('volunteers').select('id, name, email').eq('email', claim.e.toLowerCase()).maybeSingle();
    if (v) {
      const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/calendar');
      await gfetch(token, `${calendarBase()}?sendUpdates=all`, {
        method: 'POST',
        body: JSON.stringify(inviteEventBody(v as { id: string; name: string; email: string }, claim.d, claim.s as InviteKind)),
      }).catch((e) => console.error('invite create failed', e));
    }
    return page("You're on it — thank you!", `<p><strong>${when}</strong></p><p>A calendar invitation from the Green Team is on its way to ${claim.e}.</p>`, true);
  } catch (err) {
    console.error(err);
    return page('Something went wrong', `<p><strong>${when}</strong></p><p>${err instanceof Error ? err.message : String(err)}</p>`, false);
  }
});
