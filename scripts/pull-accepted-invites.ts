/**
 * Snapshot every ACCEPTED Green Team invite from today onward into a CSV.
 * Read-only: lists events on the Green Team calendar, reads the roster —
 * never writes to the calendar, the database or anyone's inbox.
 *
 *   pnpm pull:accepted                  # -> accepted-invites.csv (git-ignored, real PII)
 *   pnpm pull:accepted --out other.csv
 *
 * RSVPs come straight from the calendar attendee (the source of truth the
 * webhook mirrors into shift_volunteers.accepted). Needs-action, tentative
 * and declined invites are skipped.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { GREEN_TEAM_CALENDAR_ID, GREEN_TEAM_USER, googleAccessToken, googleFetch, SCOPES } from './lib/google';
import { weekdayOf } from '../src/schedule';

const INVITE_MARKER = 'pto-demo-invite';
const arg = (n: string) => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
const OUT = arg('--out') ?? 'accepted-invites.csv';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

type GoogleEvent = {
  id: string;
  status?: string;
  start?: { dateTime?: string };
  attendees?: { email?: string; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};
type Volunteer = { id: string; name: string; email: string; grades: string | null; veteran: boolean; frequency: string };

const WEEKDAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const csvCell = (v: string | number | boolean) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const token = await googleAccessToken(GREEN_TEAM_USER, SCOPES.calendar);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GREEN_TEAM_CALENDAR_ID)}/events`;
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: `managedBy=${INVITE_MARKER}`,
      maxResults: '2500',
      showDeleted: 'false',
      timeMin: `${today}T00:00:00-04:00`,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await googleFetch<{ items?: GoogleEvent[]; nextPageToken?: string }>(token, `${base}?${params}`);
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const [volsRes, availRes] = await Promise.all([
    db.from('volunteers').select('id, name, email, grades, veteran, frequency'),
    db.from('availability').select('volunteer_id, weekday, slot'),
  ]);
  if (volsRes.error) throw new Error(volsRes.error.message);
  if (availRes.error) throw new Error(availRes.error.message);
  const byId = new Map(((volsRes.data ?? []) as Volunteer[]).map((v) => [v.id, v]));
  // "volunteerId|weekday" -> slots they said they can do that weekday.
  const available = new Map<string, string[]>();
  for (const a of (availRes.data ?? []) as { volunteer_id: string; weekday: number; slot: string }[]) {
    const k = `${a.volunteer_id}|${a.weekday}`;
    available.set(k, [...(available.get(k) ?? []), a.slot].sort());
  }

  const tally: Record<string, number> = {};
  const rows: { date: string; kind: string; v: Volunteer; eventId: string }[] = [];
  for (const ev of events) {
    const ext = ev.extendedProperties?.private;
    if (!ext || ev.status === 'cancelled') continue;
    const [volunteerId, date, kind] = (ext.ptoKey ?? '').split('|');
    if (!volunteerId || !date || !kind || date < today) continue;
    const email = (ext.email ?? '').toLowerCase();
    const status = ev.attendees?.find((a) => (a.email ?? '').toLowerCase() === email)?.responseStatus ?? 'none';
    tally[status] = (tally[status] ?? 0) + 1;
    if (status !== 'accepted') continue;
    const v = byId.get(volunteerId);
    if (!v) {
      console.warn(`  skipped accepted invite for ${email} on ${date}: not on the roster any more`);
      continue;
    }
    rows.push({ date, kind, v, eventId: ev.id });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.v.name.localeCompare(b.v.name));

  const header = ['date', 'weekday', 'current_shift', 'name', 'email', 'grades', 'has_3rd_grader', 'veteran', 'frequency', 'available_that_weekday', 'event_id'];
  const lines = [header.join(',')];
  for (const { date, kind, v, eventId } of rows) {
    lines.push(
      [date, WEEKDAY[weekdayOf(date)]!, kind, v.name.trim(), v.email, v.grades ?? '', /\b3rd\b/i.test(v.grades ?? '') ? 'yes' : 'no', v.veteran ? 'yes' : 'no', v.frequency, (available.get(`${v.id}|${weekdayOf(date)}`) ?? []).join('+'), eventId]
        .map(csvCell)
        .join(','),
    );
  }
  writeFileSync(OUT, lines.join('\n') + '\n');

  const people = new Set(rows.map((r) => r.v.id));
  console.log(`Invites from ${today} on: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`Wrote ${rows.length} accepted invite(s) for ${people.size} volunteer(s) across ${new Set(rows.map((r) => r.date)).size} day(s) -> ${OUT}`);
}

main().catch((e) => { console.error('pull-accepted-invites failed:', e); process.exit(1); });
