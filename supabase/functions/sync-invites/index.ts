// Keeps one Google Calendar invite per volunteer per day on the Green Team
// calendar in step with the schedule: "{name}: Fiske Green Team ({early|
// late|both shifts})" with the volunteer as guest. Creates, updates and
// cancels (sendUpdates=all) for every assignment from today onward.
//
// DRY RUN unless body.confirm === true — creating invites emails every
// volunteer, so the first run for a real roster is deliberate.
// Auth: admin JWT (like sync-google-calendar) or x-cron-secret.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
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

type GoogleEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: { email?: string; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const db = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Auth: cron secret, or a signed-in admin.
    if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      });
      const { data: userData } = await userClient.auth.getUser();
      if (!userData?.user) return json(401, { error: 'Not signed in.' });
      const { data: adminRow } = await db.from('admins').select('user_id').eq('user_id', userData.user.id).maybeSingle();
      if (!adminRow) return json(403, { error: 'Admins only.' });
    }
    const body = (await req.json().catch(() => ({}))) as { confirm?: boolean; email?: string };
    const confirm = body.confirm === true;
    const onlyEmail = body.email?.toLowerCase();

    // Desired: one event per volunteer per day, from today onward.
    const today = todayInNewYork();
    const { data: rows, error } = await db
      .from('shift_volunteers')
      .select('shift:green_team_shifts ( date, slot ), volunteer:volunteers ( id, name, email )')
      .gte('shift.date', today);
    if (error) throw new Error(error.message);
    type Row = { shift: { date: string; slot: string } | null; volunteer: { id: string; name: string; email: string } | null };
    const byPerson = new Map<string, { v: { id: string; name: string; email: string }; date: string; slots: Set<string> }>();
    for (const r of (rows ?? []) as unknown as Row[]) {
      if (!r.shift || !r.volunteer) continue;
      if (onlyEmail && r.volunteer.email.toLowerCase() !== onlyEmail) continue;
      const k = `${r.volunteer.id}|${r.shift.date}`;
      const e = byPerson.get(k) ?? { v: r.volunteer, date: r.shift.date, slots: new Set<string>() };
      e.slots.add(r.shift.slot);
      byPerson.set(k, e);
    }
    const desired = new Map<string, ReturnType<typeof inviteEventBody>>();
    for (const { v, date, slots } of byPerson.values()) {
      const kind: InviteKind = slots.size === 2 ? 'both shifts' : slots.has('early') ? 'early' : 'late';
      desired.set(`${v.id}|${date}|${kind}`, inviteEventBody(v, date, kind));
    }

    // Existing invite events (all, so stale ones get cancelled).
    const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/calendar');
    const existing = new Map<string, GoogleEvent>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ privateExtendedProperty: `managedBy=${INVITE_MARKER}`, maxResults: '2500', showDeleted: 'false' });
      if (pageToken) params.set('pageToken', pageToken);
      const pageData = await gfetch<{ items?: GoogleEvent[]; nextPageToken?: string }>(token, `${calendarBase()}?${params}`);
      for (const ev of pageData.items ?? []) {
        const key = ev.extendedProperties?.private?.ptoKey;
        if (!key) continue;
        if (onlyEmail && (ev.extendedProperties?.private?.email ?? '').toLowerCase() !== onlyEmail) continue;
        existing.set(key, ev);
      }
      pageToken = pageData.nextPageToken;
    } while (pageToken);

    const same = (g: GoogleEvent, d: ReturnType<typeof inviteEventBody>) =>
      g.summary === d.summary &&
      Boolean(g.start?.dateTime?.startsWith(d.start.dateTime)) &&
      Boolean(g.end?.dateTime?.startsWith(d.end.dateTime));

    const toCreate = [...desired].filter(([k]) => !existing.has(k));
    const toUpdate = [...desired].filter(([k, d]) => existing.has(k) && !same(existing.get(k)!, d));
    // Only cancel future events; past ones are history. Declined ones the webhook already handles.
    const toDelete = [...existing].filter(([k, g]) => !desired.has(k) && (g.start?.dateTime ?? '') >= today);

    const plan = { create: toCreate.length, update: toUpdate.length, cancel: toDelete.length, volunteers: byPerson.size };
    if (!confirm) return json(200, { dryRun: true, ...plan, hint: 'POST {"confirm":true} to send.' });

    for (const [, d] of toCreate) await gfetch(token, `${calendarBase()}?sendUpdates=all`, { method: 'POST', body: JSON.stringify(d) });
    for (const [k, d] of toUpdate) await gfetch(token, `${calendarBase()}/${existing.get(k)!.id}?sendUpdates=all`, { method: 'PATCH', body: JSON.stringify(d) });
    for (const [, g] of toDelete) await gfetch(token, `${calendarBase()}/${g.id}?sendUpdates=all`, { method: 'DELETE' }).catch(() => {});
    return json(200, { dryRun: false, ...plan });
  } catch (err) {
    console.error(err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
