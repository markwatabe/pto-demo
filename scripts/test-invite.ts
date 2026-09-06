/**
 * Test route for the shift-invite feature. Schedules ONE test volunteer for
 * three shifts next week (Mon–Thu after the coming weekend): one early, one
 * late, and one full day ("both shifts"), then creates a Google Calendar
 * event on the Green Team calendar for each, with the volunteer as a guest
 * so Google emails them an invitation from greenteam@fiskeschoolpto.org.
 *
 *   pnpm test:invite                 # schedule + invite (idempotent)
 *   pnpm test:invite -- --cleanup    # remove the assignments, cancel the
 *                                    # events (guest gets cancellations),
 *                                    # delete the test volunteer
 *
 * Event title: "{name}: Fiske Green Team ({early|late|both shifts})".
 * Invite events carry managedBy=pto-demo-invite so the group-event sync
 * (sync-google-calendar, managedBy=pto-demo) leaves them alone.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { isoDate, isSchoolDay, SLOT_TIMES, toLocalDate, type Slot } from '../src/schedule';
import { googleAccessToken, googleFetch, GREEN_TEAM_CALENDAR_ID, GREEN_TEAM_USER, SCOPES } from './lib/google';

const TEST_NAME = process.env.TEST_INVITE_NAME ?? 'Mark Watabe';
const TEST_EMAIL = (process.env.TEST_INVITE_EMAIL ?? 'mark@gopagu.com').toLowerCase();
const TZ = 'America/New_York';
const MANAGED = 'pto-demo-invite';
const SCHEDULE_URL = 'https://pto-demo.onrender.com/fiske-schedule';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

type Kind = 'early' | 'late' | 'both shifts';
const KINDS: Kind[] = ['early', 'late', 'both shifts'];
const slotsFor = (kind: Kind): Slot[] => (kind === 'both shifts' ? ['early', 'late'] : [kind]);

// Mon–Thu of next week: the week (Sun–Sat) after the one containing today.
function nextWeekSchoolDays(closures: ReadonlySet<string>): string[] {
  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: TZ }) + 'T12:00');
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 8 - today.getDay());
  return [0, 1, 2, 3]
    .map((i) => isoDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)))
    .filter((d) => isSchoolDay(d, closures));
}

type Event = {
  ptoKey: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
};

function eventFor(name: string, date: string, kind: Kind, volunteerId: string): Event {
  const slots = slotsFor(kind);
  return {
    ptoKey: `${volunteerId}|${date}|${kind}`,
    summary: `${name}: Fiske Green Team (${kind})`,
    description: `Your Green Team lunch shift at Fiske.\n\nCan't make it? Open ${SCHEDULE_URL} and tap "Can't make it" on this shift, or reply to this invitation.`,
    start: { dateTime: `${date}T${SLOT_TIMES[slots[0]!].start}:00`, timeZone: TZ },
    end: { dateTime: `${date}T${SLOT_TIMES[slots[slots.length - 1]!].end}:00`, timeZone: TZ },
  };
}

type GoogleEvent = { id: string; extendedProperties?: { private?: Record<string, string> } };

async function main() {
  const cleanup = process.argv.includes('--cleanup');
  const token = await googleAccessToken(GREEN_TEAM_USER, SCOPES.calendar);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GREEN_TEAM_CALENDAR_ID)}/events`;

  // Existing invite events for this volunteer (by managed marker).
  const listed = await googleFetch<{ items?: GoogleEvent[] }>(
    token,
    `${base}?${new URLSearchParams({ privateExtendedProperty: `managedBy=${MANAGED}`, maxResults: '250' })}`,
  );
  const existingEvents = new Map(
    (listed.items ?? [])
      .filter((e) => e.extendedProperties?.private?.email === TEST_EMAIL)
      .map((e) => [e.extendedProperties!.private!.ptoKey!, e]),
  );

  const { data: existingVol } = await db
    .from('volunteers')
    .select('id, name')
    .eq('email', TEST_EMAIL)
    .maybeSingle();

  if (cleanup) {
    for (const [key, ev] of existingEvents) {
      await googleFetch(token, `${base}/${ev.id}?sendUpdates=all`, { method: 'DELETE' });
      console.log(`  cancelled event ${key}`);
    }
    if (existingVol) {
      const { error } = await db.from('volunteers').delete().eq('id', existingVol.id);
      if (error) throw new Error(error.message);
      console.log(`  removed ${TEST_EMAIL} and their assignments`);
    }
    console.log('Cleanup done.');
    return;
  }

  // 1. The test volunteer (veteran so they may hold a shift alone).
  const { data: vol, error: upsertError } = await db
    .from('volunteers')
    .upsert(
      {
        email: TEST_EMAIL,
        name: TEST_NAME,
        veteran: true,
        frequency: 'custom',
        frequency_note: 'test account',
        notes: 'TEST ACCOUNT for the invite feature — remove with `pnpm test:invite -- --cleanup`.',
      },
      { onConflict: 'email' },
    )
    .select('id, name')
    .single();
  if (upsertError || !vol) throw new Error(upsertError?.message ?? 'volunteer upsert failed');

  // 2. Next week's school days, and who is already on each shift.
  const { data: closureRows } = await db.from('school_closures').select('date');
  const days = nextWeekSchoolDays(new Set((closureRows ?? []).map((c) => c.date)));
  if (days.length < 3) throw new Error(`Next week only has ${days.length} school days.`);
  const { data: shiftRows, error: shiftsError } = await db
    .from('green_team_shifts')
    .select('id, date, slot, assignments:shift_volunteers ( volunteer_id )')
    .in('date', days);
  if (shiftsError) throw new Error(shiftsError.message);
  type ShiftRow = { id: string; date: string; slot: Slot; assignments: { volunteer_id: string }[] };
  const shifts = new Map((shiftRows as ShiftRow[]).map((s) => [`${s.date}|${s.slot}`, s]));
  const headcount = (date: string, slot: Slot) =>
    (shifts.get(`${date}|${slot}`)?.assignments ?? []).filter((a) => a.volunteer_id !== vol.id).length;

  // Give each kind the least-crowded remaining day (a third person on a
  // full shift is tolerated — this is a test).
  const plan = new Map<Kind, string>();
  const free = new Set(days);
  for (const kind of KINDS) {
    const day = [...free].sort(
      (a, b) =>
        slotsFor(kind).reduce((n, s) => n + headcount(a, s), 0) -
        slotsFor(kind).reduce((n, s) => n + headcount(b, s), 0),
    )[0]!;
    free.delete(day);
    plan.set(kind, day);
  }

  // 3. Assignments (find-or-create shift rows; ignore duplicates).
  for (const [kind, date] of plan) {
    for (const slot of slotsFor(kind)) {
      let shift = shifts.get(`${date}|${slot}`);
      if (!shift) {
        const { data: created, error } = await db
          .from('green_team_shifts')
          .insert({ date, slot })
          .select('id, date, slot')
          .single();
        if (error || !created) throw new Error(error?.message ?? 'shift insert failed');
        shift = { ...created, assignments: [] } as ShiftRow;
      }
      const { error } = await db
        .from('shift_volunteers')
        .upsert({ shift_id: shift.id, volunteer_id: vol.id }, { onConflict: 'shift_id,volunteer_id' });
      if (error) throw new Error(error.message);
    }
    console.log(`  scheduled ${date} ${kind} (${headcount(date, slotsFor(kind)[0]!)} other${headcount(date, slotsFor(kind)[0]!) === 1 ? '' : 's'} on it)`);
  }

  // 4. Calendar events with the volunteer as guest → Google sends the invite.
  for (const [kind, date] of plan) {
    const ev = eventFor(vol.name, date, kind, vol.id);
    const body = {
      summary: ev.summary,
      description: ev.description,
      start: ev.start,
      end: ev.end,
      attendees: [{ email: TEST_EMAIL, displayName: vol.name }],
      guestsCanInviteOthers: false,
      extendedProperties: { private: { managedBy: MANAGED, ptoKey: ev.ptoKey, email: TEST_EMAIL } },
    };
    const existing = existingEvents.get(ev.ptoKey);
    if (existing) {
      await googleFetch(token, `${base}/${existing.id}?sendUpdates=all`, { method: 'PATCH', body: JSON.stringify(body) });
      console.log(`  updated invite: ${ev.summary} — ${date}`);
    } else {
      await googleFetch(token, `${base}?sendUpdates=all`, { method: 'POST', body: JSON.stringify(body) });
      console.log(`  sent invite:    ${ev.summary} — ${date}`);
    }
  }
  console.log(`Done — ${TEST_NAME} <${TEST_EMAIL}> should have 3 invitations from ${GREEN_TEAM_USER}.`);
}

main().catch((err) => {
  console.error('test-invite failed:', err);
  process.exit(1);
});
