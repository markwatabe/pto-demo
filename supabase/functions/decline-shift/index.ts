// A roster volunteer taps "Can't make it" on one of their own shifts in the
// public /fiske-schedule view (no login — identified by roster email). Same
// handling as a calendar decline (see calendar-webhook): they come off the
// shift, their invite is cancelled, the coordinator is emailed, and if the
// shift is within URGENT_DAYS volunteers who could cover are emailed.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const URGENT_DAYS = 7;

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

type GoogleEvent = { id: string; extendedProperties?: { private?: Record<string, string> } };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: string; date?: string; slot?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const date = body.date ?? '';
    const slot = body.slot ?? '';
    if (!email.includes('@')) return json(400, { error: 'A valid email is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'Invalid date.' });
    if (slot !== 'early' && slot !== 'late') return json(400, { error: 'Invalid slot.' });
    if (date < todayInNewYork()) return json(400, { error: 'That shift is in the past.' });

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: volunteer } = await db.from('volunteers').select('id, name').eq('email', email).maybeSingle();
    if (!volunteer) return json(403, { error: 'This email is not on the volunteer roster — check with the coordinator.' });

    const { data: shift } = await db
      .from('green_team_shifts')
      .select('id, assignments:shift_volunteers ( volunteer:volunteers ( id, name ) )')
      .eq('date', date)
      .eq('slot', slot)
      .maybeSingle();
    type Assignment = { volunteer: { id: string; name: string } | null };
    const assignees = ((shift?.assignments ?? []) as unknown as Assignment[]).map((a) => a.volunteer).filter(Boolean) as { id: string; name: string }[];
    if (!shift || !assignees.some((v) => v.id === volunteer.id)) return json(409, { error: "You're not on this shift." });
    const others = assignees.filter((v) => v.id !== volunteer.id).map((v) => v.name);

    // 1. Off the shift.
    const { error: delError } = await db.from('shift_volunteers').delete().eq('shift_id', shift.id).eq('volunteer_id', volunteer.id);
    if (delError) return json(500, { error: delError.message });

    // 2. Cancel (or shrink) their calendar invite for that day, quietly.
    try {
      const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/calendar');
      const params = new URLSearchParams({ maxResults: '50' });
      params.append('privateExtendedProperty', `managedBy=${INVITE_MARKER}`);
      params.append('privateExtendedProperty', `email=${email}`);
      const list = await gfetch<{ items?: GoogleEvent[] }>(token, `${calendarBase()}?${params}`);
      for (const ev of list.items ?? []) {
        const [vid, d, kind] = (ev.extendedProperties?.private?.ptoKey ?? '').split('|');
        if (vid !== volunteer.id || d !== date) continue;
        if (kind === 'both shifts') {
          // They keep the other half of the day.
          const remaining = (slot === 'early' ? 'late' : 'early') as InviteKind;
          await gfetch(token, `${calendarBase()}/${ev.id}?sendUpdates=all`, {
            method: 'PATCH',
            body: JSON.stringify(inviteEventBody({ id: volunteer.id, name: volunteer.name, email }, date, remaining)),
          });
        } else {
          await gfetch(token, `${calendarBase()}/${ev.id}?sendUpdates=none`, { method: 'DELETE' });
        }
      }
    } catch (e) {
      console.error('invite cleanup failed', e);
    }

    // 3. Urgent → ask people who could cover.
    const urgent = daysUntil(date) <= URGENT_DAYS;
    let coverSent = 0;
    if (urgent) {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/cover-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': Deno.env.get('CRON_SECRET') ?? '' },
        body: JSON.stringify({ action: 'shift', date, slot, exclude: email }),
      });
      coverSent = Number(((await res.json().catch(() => ({}))) as { sent?: number }).sent ?? 0);
    }

    await db.from('shift_declines').insert({
      volunteer_id: volunteer.id,
      volunteer_email: email,
      volunteer_name: volunteer.name,
      date,
      slot,
      source: 'app',
      handling: urgent ? 'urgent-cover-request' : 'deferred-to-weekly',
      cover_emails_sent: coverSent,
    });

    // 4. Coordinator FYI.
    await sendMail({
      to: COORDINATOR,
      replyTo: email,
      subject: `Can't make it: ${volunteer.name} — ${shortDate(date)} ${slot} shift`,
      text: [
        `${volunteer.name} (${email}) tapped "Can't make it" and has been taken off the shift.`,
        '',
        `• ${shortDate(date)} — ${SLOT_LABEL[slot]}: now ${others.length ? others.join(', ') : 'NOBODY'}` +
          (urgent ? ` (cover request sent to ${coverSent} volunteer${coverSent === 1 ? '' : 's'})` : ''),
        '',
        urgent
          ? `This is within ${URGENT_DAYS} days, so volunteers who are available have been asked to cover.`
          : 'This is more than a week out — the Sunday-night gap check will handle it.',
        '',
        `Schedule: ${SITE}/admin/schedule`,
      ].join('\n'),
    });

    return json(200, { ok: true, removed: true, coverSent });
  } catch (err) {
    console.error(err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
