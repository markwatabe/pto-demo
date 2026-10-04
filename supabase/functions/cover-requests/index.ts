// Finds volunteers who could cover open Green Team shifts and emails the
// COORDINATOR the list. Volunteers are never emailed by this function — the
// coordinator asked for no cover-request emails and no links (2026-09-14;
// the one-click claim links rendered as raw text in browsers).
//   {action:"shift", date, slot, exclude?}  one shift, right now (urgent)
//   {action:"weekly"}                       Sunday-night gap check: every gap in
//                                           the next 14 days with possible covers
// Gated by x-cron-secret = CRON_SECRET (called by pg_cron and calendar-webhook).
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const DIGEST_DAYS = 14;

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
// Shifts: First/Second/Third since 2026-10-05; early/late rows stay as history.
const SLOT_TIMES: Record<string, { start: string; end: string }> = {
  first: { start: '11:05', end: '12:00' },
  second: { start: '12:05', end: '13:00' },
  third: { start: '13:20', end: '13:45' },
  early: { start: '11:10', end: '12:20' },
  late: { start: '12:20', end: '13:45' },
};
const SLOT_LABEL: Record<string, string> = {
  first: 'First shift (11:05–12:00)',
  second: 'Second shift (12:05–1:00)',
  third: 'Third shift (1:20–1:45)',
  early: 'Morning (11:10–12:20)',
  late: 'Afternoon (12:20–1:45)',
};

/** RFC 2047-encode a Subject with non-ASCII (the em-dash in dates) so mail clients don't show mojibake. */
const mimeSubject = (s: string): string =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;

/** Plain-text email from the Green Team mailbox. */
async function sendMail(args: { to: string; subject: string; text: string; replyTo?: string }): Promise<void> {
  const token = await googleAccessToken(MAIL_FROM, 'https://www.googleapis.com/auth/gmail.send');
  const raw = [
    `From: Fiske Green Team <${MAIL_FROM}>`,
    `To: ${args.to}`,
    args.replyTo ? `Reply-To: ${args.replyTo}` : '',
    `Subject: ${mimeSubject(args.subject)}`,
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
const KIND_DETAIL: Record<InviteKind, string> = {
  early: 'morning lunch 11:10–12:20 (grades K, 2, 4, 5)',
  late: 'afternoon lunch 12:20–1:45 (grades K, 1, 3)',
  'both shifts': 'full shift 11:10–1:45 (all grades)',
};

function inviteEventBody(v: { id: string; name: string; email: string }, date: string, kind: InviteKind) {
  const slots = slotsForKind(kind);
  return {
    summary: `${v.name}: Fiske Green Team (${kind})`,
    colorId: KIND_COLOR[kind],
    description: [
      `Your Green Team lunch shift at Fiske — ${KIND_DETAIL[kind]}.`,
      '',
      'Please ACCEPT this invitation once you know you can make it, and DECLINE as soon as you know you cannot — declining takes you off the shift right away so we can find cover.',
    ].join('\n'),
    start: { dateTime: `${date}T${SLOT_TIMES[slots[0]!]!.start}:00`, timeZone: TZ },
    end: { dateTime: `${date}T${SLOT_TIMES[slots[slots.length - 1]!]!.end}:00`, timeZone: TZ },
    attendees: [{ email: v.email, displayName: v.name }],
    guestsCanInviteOthers: false,
    extendedProperties: { private: { managedBy: INVITE_MARKER, ptoKey: `${v.id}|${date}|${kind}`, email: v.email } },
  };
}
// ---- end helpers ----

type Volunteer = { id: string; name: string; email: string; veteran: boolean; backfill: boolean; grades: string | null };
// Which half of the sign-up availability a shift draws on, and who may take it by grade.
const HALF_OF: Record<string, string> = { first: 'early', second: 'late', third: 'late', early: 'early', late: 'late' };
const gradeOk = (v: Volunteer, slot: string) =>
  slot === 'third' ? /\b3rd\b/i.test(v.grades ?? '') : slot === 'first' ? /\b(4th|5th)\b/i.test(v.grades ?? '') : true;
type Blackout = { volunteer_id: string; starts_on: string; ends_on: string; weekday: number | null };
type Shift = { id: string; date: string; slot: string; people: { id: string; veteran: boolean }[] };

async function loadRoster() {
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const [vRes, aRes, bRes] = await Promise.all([
    client.from('volunteers').select('id, name, email, veteran, backfill, grades'),
    client.from('availability').select('volunteer_id, weekday, slot'),
    client.from('volunteer_blackouts').select('volunteer_id, starts_on, ends_on, weekday'),
  ]);
  if (vRes.error || aRes.error || bRes.error) throw new Error((vRes.error ?? aRes.error ?? bRes.error)!.message);
  const cells = new Set((aRes.data ?? []).map((a) => `${a.volunteer_id}|${a.weekday}|${a.slot}`));
  return { volunteers: (vRes.data ?? []) as Volunteer[], cells, blackouts: (bRes.data ?? []) as Blackout[] };
}

async function loadShifts(from: string, to: string): Promise<Shift[]> {
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await client
    .from('green_team_shifts')
    .select('id, date, slot, assignments:shift_volunteers ( volunteer:volunteers ( id, veteran ) )')
    .gte('date', from)
    .lte('date', to)
    .order('date');
  if (error) throw new Error(error.message);
  type Row = { id: string; date: string; slot: string; assignments: { volunteer: { id: string; veteran: boolean } | null }[] };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    date: r.date,
    slot: r.slot,
    people: r.assignments.map((a) => a.volunteer).filter(Boolean) as { id: string; veteran: boolean }[],
  }));
}

/** Who may take this shift: available for the cell, not away, not already on it, and paired with a veteran if new. */
function candidates(shift: Shift, volunteers: Volunteer[], cells: Set<string>, blackouts: Blackout[], exclude?: string): Volunteer[] {
  const hasVeteran = shift.people.some((p) => p.veteran);
  return volunteers.filter(
    (v) =>
      v.email !== exclude &&
      cells.has(`${v.id}|${weekdayOf(shift.date)}|${HALF_OF[shift.slot] ?? shift.slot}`) &&
      gradeOk(v, shift.slot) &&
      !blackouts.some(
        (b) =>
          b.volunteer_id === v.id &&
          shift.date >= b.starts_on &&
          shift.date <= b.ends_on &&
          (b.weekday == null || b.weekday === weekdayOf(shift.date)),
      ) &&
      !shift.people.some((p) => p.id === v.id) &&
      (v.veteran || hasVeteran),
  );
}

async function coverOneShift(date: string, slot: string, exclude?: string) {
  const { volunteers, cells, blackouts } = await loadRoster();
  const shift = (await loadShifts(date, date)).find((s) => s.slot === slot);
  if (!shift) return { sent: 0, reason: 'no such shift' };
  if (shift.people.length >= 2) return { sent: 0, reason: 'shift is full' };
  const who = candidates(shift, volunteers, cells, blackouts, exclude);
  const status = shift.people.length === 0 ? 'nobody is on it' : `only ${shift.people.length} person is on it`;
  await sendMail({
    to: COORDINATOR,
    subject: `Cover needed: ${shortDate(date)} — ${SLOT_LABEL[slot]} (${who.length} possible)`,
    text: [
      `${shortDate(date)} — ${SLOT_LABEL[slot]}: ${status}.`,
      '',
      who.length ? 'Volunteers whose availability fits (not away, not already on it):' : 'Nobody on the roster fits this slot.',
      ...who.map((v) => `• ${v.name} <${v.email}>${v.backfill ? ' (backfill)' : ''}${v.veteran ? '' : ' (new)'}`),
      '',
      'No one has been contacted — reach out to whoever you like.',
      `Schedule: ${SITE}/admin/schedule`,
    ].join('\n'),
  });
  return { sent: 0, candidates: who.length, status, notified: COORDINATOR };
}

async function weeklyDigest() {
  const { volunteers, cells, blackouts } = await loadRoster();
  const today = todayInNewYork();
  const from = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(today + 'T12:00:00Z') + DIGEST_DAYS * 86400000).toISOString().slice(0, 10);
  const shifts = await loadShifts(from, to);
  const needsCover = shifts.filter((s) => s.people.length === 0 || !s.people.some((p) => p.veteran));
  const couldUseSecond = shifts.filter((s) => s.people.length === 1 && s.people.some((p) => p.veteran));

  const summary = (list: Shift[]) =>
    list.length
      ? list.flatMap((s) => {
          const who = candidates(s, volunteers, cells, blackouts);
          return [
            `• ${shortDate(s.date)} — ${SLOT_LABEL[s.slot]} (${s.people.length} on it)`,
            `    could cover: ${who.length ? who.map((v) => v.name).join(', ') : 'nobody fits'}`,
          ];
        })
      : ['• none'];
  await sendMail({
    to: COORDINATOR,
    subject: `Green Team gap check: ${needsCover.length} need cover, ${couldUseSecond.length} could use a second (${from} → ${to})`,
    text: [
      `Sunday check for ${from} through ${to}. No volunteers were emailed.`,
      '',
      'NEEDS COVER:',
      ...summary(needsCover),
      '',
      'COULD USE A SECOND:',
      ...summary(couldUseSecond),
      '',
      `Schedule: ${SITE}/admin/schedule`,
    ].join('\n'),
  });
  return { from, to, needsCover: needsCover.length, couldUseSecond: couldUseSecond.length, volunteerEmails: 0 };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json(401, { error: 'Unauthorized.' });
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; date?: string; slot?: string; exclude?: string };
    if (body.action === 'shift') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '') || !SLOT_LABEL[body.slot ?? '']) {
        return json(400, { error: 'date and slot required.' });
      }
      return json(200, await coverOneShift(body.date!, body.slot!, body.exclude?.toLowerCase()));
    }
    if (body.action === 'weekly') return json(200, await weeklyDigest());
    return json(400, { error: 'action must be "shift" or "weekly".' });
  } catch (err) {
    console.error(err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
