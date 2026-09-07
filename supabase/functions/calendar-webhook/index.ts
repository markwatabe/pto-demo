// Receives Google Calendar push notifications for the Green Team calendar
// (and an hourly cron fallback), incrementally syncs changed events, and
// acts on declined per-person invites:
//   - the volunteer is removed from the shift and their event cancelled,
//   - the coordinator gets an FYI email,
//   - if the shift is within URGENT_DAYS, cover-requests emails volunteers
//     who could take it; otherwise the Sunday-night digest picks it up.
// Also serves Search Console verification (GET) and registers/renews the
// push channel (action "renew-watch").
//
// Auth: Google pushes carry X-Goog-Channel-Token = CALENDAR_WEBHOOK_TOKEN;
// cron/manual calls carry x-cron-secret = CRON_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const URGENT_DAYS = 7;
const WATCH_TTL_MS = 7 * 24 * 3600 * 1000;
const RENEW_WITHIN_MS = 2 * 24 * 3600 * 1000;

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
  status?: string;
  attendees?: { email?: string; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};
type SyncState = {
  sync_token: string | null;
  channel_id: string | null;
  resource_id: string | null;
  channel_expires_at: string | null;
};

const db = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function loadState(): Promise<SyncState> {
  const { data } = await db().from('calendar_sync').select('*').eq('id', true).maybeSingle();
  return (data as SyncState | null) ?? { sync_token: null, channel_id: null, resource_id: null, channel_expires_at: null };
}
async function saveState(patch: Partial<SyncState>) {
  const { error } = await db()
    .from('calendar_sync')
    .upsert({ id: true, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(`calendar_sync save failed: ${error.message}`);
}

/** Pull changed events (incremental when we hold a sync token) and handle declines. */
async function syncCalendar() {
  const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/calendar');
  const state = await loadState();
  let syncToken = state.sync_token;
  let pageToken: string | undefined;
  const changed: GoogleEvent[] = [];
  let nextSyncToken: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ maxResults: '2500', showDeleted: 'true' });
    if (syncToken) params.set('syncToken', syncToken);
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${calendarBase()}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 410 && syncToken) {
      // Token expired — start over with a full sync.
      syncToken = null;
      pageToken = undefined;
      continue;
    }
    if (!res.ok) throw new Error(`Calendar list failed (${res.status}): ${await res.text()}`);
    const page = await res.json();
    changed.push(...((page.items ?? []) as GoogleEvent[]));
    pageToken = page.nextPageToken;
    if (!pageToken) {
      nextSyncToken = page.nextSyncToken;
      break;
    }
  }

  let declines = 0;
  for (const ev of changed) {
    const ext = ev.extendedProperties?.private;
    if (!ext || ext.managedBy !== INVITE_MARKER || ev.status === 'cancelled') continue;
    const email = (ext.email ?? '').toLowerCase();
    const attendee = ev.attendees?.find((a) => (a.email ?? '').toLowerCase() === email);
    if (attendee?.responseStatus !== 'declined') continue;
    const [volunteerId, date, kind] = (ext.ptoKey ?? '').split('|');
    if (!volunteerId || !date || !kind) continue;
    if (await handleDecline(token, ev.id, volunteerId, email, date, kind as InviteKind)) declines++;
  }
  if (nextSyncToken) await saveState({ sync_token: nextSyncToken });
  return { scanned: changed.length, declines, full: !state.sync_token };
}

/** Returns true if this decline was new (assignment existed and was removed). */
async function handleDecline(
  token: string,
  eventId: string,
  volunteerId: string,
  email: string,
  date: string,
  kind: InviteKind,
): Promise<boolean> {
  const client = db();
  const { data: volunteer } = await client.from('volunteers').select('id, name, email').eq('id', volunteerId).maybeSingle();
  const name = volunteer?.name ?? email;

  const removed: { slot: string; others: string[] }[] = [];
  for (const slot of slotsForKind(kind)) {
    const { data: shift } = await client
      .from('green_team_shifts')
      .select('id, assignments:shift_volunteers ( volunteer:volunteers ( id, name ) )')
      .eq('date', date)
      .eq('slot', slot)
      .maybeSingle();
    if (!shift) continue;
    type Row = { volunteer: { id: string; name: string } | null };
    const assignees = (shift.assignments as unknown as Row[]).map((a) => a.volunteer).filter(Boolean) as { id: string; name: string }[];
    if (!assignees.some((a) => a.id === volunteerId)) continue;
    const { error } = await client.from('shift_volunteers').delete().eq('shift_id', shift.id).eq('volunteer_id', volunteerId);
    if (error) throw new Error(`unassign failed: ${error.message}`);
    removed.push({ slot, others: assignees.filter((a) => a.id !== volunteerId).map((a) => a.name) });
  }
  if (removed.length === 0) return false;

  const urgent = daysUntil(date) <= URGENT_DAYS;
  const handling = urgent ? 'urgent-cover-request' : 'deferred-to-weekly';

  // Cancel their invite quietly (they already declined).
  await gfetch(token, `${calendarBase()}/${eventId}?sendUpdates=none`, { method: 'DELETE' }).catch(() => {});

  const coverSent: Record<string, number> = {};
  if (urgent) {
    for (const r of removed) {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/cover-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': Deno.env.get('CRON_SECRET') ?? '' },
        body: JSON.stringify({ action: 'shift', date, slot: r.slot, exclude: email }),
      });
      const out = await res.json().catch(() => ({}));
      coverSent[r.slot] = Number(out.sent ?? 0);
    }
  }

  await client.from('shift_declines').insert(
    removed.map((r) => ({
      volunteer_id: volunteer?.id ?? null,
      volunteer_email: email,
      volunteer_name: name,
      date,
      slot: r.slot,
      source: 'calendar',
      handling,
      cover_emails_sent: coverSent[r.slot] ?? 0,
    })),
  );

  const lines = removed.map(
    (r) =>
      `• ${shortDate(date)} — ${SLOT_LABEL[r.slot]}: now ${r.others.length ? r.others.join(', ') : 'NOBODY'}` +
      (urgent ? ` (cover request sent to ${coverSent[r.slot] ?? 0} volunteer${coverSent[r.slot] === 1 ? '' : 's'})` : ''),
  );
  await sendMail({
    to: COORDINATOR,
    replyTo: email,
    subject: `Declined: ${name} — ${shortDate(date)} (${kind})`,
    text: [
      `${name} (${email}) declined their calendar invite and has been taken off the shift.`,
      '',
      ...lines,
      '',
      urgent
        ? `This is within ${URGENT_DAYS} days, so volunteers who are available have been asked to cover.`
        : 'This is more than a week out — the Sunday-night gap check will handle it.',
      '',
      `Schedule: ${SITE}/admin/schedule`,
    ].join('\n'),
  });
  return true;
}

/** Register (or renew, when within RENEW_WITHIN_MS of expiry) the push channel. */
async function renewWatch(force: boolean) {
  const address = Deno.env.get('CALENDAR_WEBHOOK_URL');
  const channelToken = Deno.env.get('CALENDAR_WEBHOOK_TOKEN');
  if (!address || !channelToken) throw new Error('Missing CALENDAR_WEBHOOK_URL / CALENDAR_WEBHOOK_TOKEN secrets.');
  const state = await loadState();
  const expires = state.channel_expires_at ? Date.parse(state.channel_expires_at) : 0;
  if (!force && expires - Date.now() > RENEW_WITHIN_MS) {
    return { ok: true, skipped: true, channel_expires_at: state.channel_expires_at };
  }
  const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/calendar');
  const id = crypto.randomUUID();
  const created = await gfetch<{ resourceId: string; expiration: string }>(token, `${calendarBase()}/watch`, {
    method: 'POST',
    body: JSON.stringify({ id, type: 'web_hook', address, token: channelToken, expiration: String(Date.now() + WATCH_TTL_MS) }),
  });
  if (state.channel_id && state.resource_id) {
    await gfetch(token, 'https://www.googleapis.com/calendar/v3/channels/stop', {
      method: 'POST',
      body: JSON.stringify({ id: state.channel_id, resourceId: state.resource_id }),
    }).catch(() => {});
  }
  const channel_expires_at = new Date(Number(created.expiration)).toISOString();
  await saveState({ channel_id: id, resource_id: created.resourceId, channel_expires_at });
  return { ok: true, renewed: true, channel_expires_at };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    // Search Console verification for a URL-prefix property on this function's URL:
    // HTML-tag method (meta on the root) or file method (/googleXXXX.html).
    const verification = Deno.env.get('GOOGLE_SITE_VERIFICATION') ?? '';
    const file = url.pathname.match(/\/(google[0-9a-f]+\.html)$/i)?.[1];
    if (file && verification === file) {
      return new Response(`google-site-verification: ${file}`, { headers: { 'Content-Type': 'text/html' } });
    }
    const meta = verification && !verification.endsWith('.html') ? `<meta name="google-site-verification" content="${verification}">` : '';
    return new Response(`<!doctype html><html><head>${meta}<title>Green Team calendar webhook</title></head><body>ok</body></html>`, {
      headers: { 'Content-Type': 'text/html' },
    });
  }
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const resourceState = req.headers.get('x-goog-resource-state');
    if (resourceState) {
      if (req.headers.get('x-goog-channel-token') !== Deno.env.get('CALENDAR_WEBHOOK_TOKEN')) {
        return json(401, { error: 'Bad channel token.' });
      }
      if (resourceState === 'sync') return json(200, { ok: true, hello: true });
      return json(200, await syncCalendar());
    }
    if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json(401, { error: 'Unauthorized.' });
    const body = (await req.json().catch(() => ({}))) as { action?: string; force?: boolean };
    if (body.action === 'renew-watch') return json(200, await renewWatch(Boolean(body.force)));
    return json(200, await syncCalendar());
  } catch (err) {
    console.error(err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
