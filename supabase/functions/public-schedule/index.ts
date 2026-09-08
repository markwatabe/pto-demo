// Public (no-login) read of the upcoming Green Team schedule for the
// /fiske-schedule view: EVERY school day from today, both slots, empty or
// not, so open slots can be claimed. Returns volunteer NAMES only; the
// caller's email is used server-side to flag their own shifts and is never
// echoed back, and nobody else's email ever leaves the server.
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

const SLOTS = ['early', 'late'] as const;

// School-local "today" (dates in the DB are school-local calendar dates).
function todayInNewYork(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// 1=Mon .. 7=Sun for a YYYY-MM-DD taken as a plain calendar date.
function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return day === 0 ? 7 : day;
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + 1));
  return dt.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const { email } = (await req.json().catch(() => ({}))) as { email?: string };
    const me = (email ?? '').trim().toLowerCase();

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: year } = await db.from('school_year').select('starts_on, ends_on').maybeSingle();
    if (!year) return json(200, { days: [] });

    const today = todayInNewYork();
    const from = today > year.starts_on ? today : year.starts_on;
    if (from > year.ends_on) return json(200, { days: [] });

    const [shiftsRes, closuresRes, declinesRes] = await Promise.all([
      db
        .from('green_team_shifts')
        .select(
          'date, slot, assignments:shift_volunteers ( accepted, volunteer:volunteers ( name, email ) )',
        )
        .gte('date', from)
        .lte('date', year.ends_on),
      db.from('school_closures').select('date'),
      db
        .from('shift_declines')
        .select('date, slot, volunteer_name, volunteer_email')
        .gte('date', from)
        .lte('date', year.ends_on),
    ]);
    if (shiftsRes.error || closuresRes.error || declinesRes.error) {
      return json(500, {
        error: (shiftsRes.error ?? closuresRes.error ?? declinesRes.error)!.message,
      });
    }

    type ShiftRow = {
      date: string;
      slot: string;
      assignments: { accepted: boolean; volunteer: { name: string; email: string } | null }[];
    };
    type Person = { name: string; me: boolean; accepted: boolean };
    const peopleByKey = new Map<string, Person[]>();
    const assignedEmailsByKey = new Map<string, Set<string>>();
    for (const shift of (shiftsRes.data ?? []) as unknown as ShiftRow[]) {
      const key = `${shift.date}|${shift.slot}`;
      const rows = shift.assignments.filter((a) => a.volunteer);
      peopleByKey.set(
        key,
        rows
          .map((a) => ({
            name: a.volunteer!.name,
            me: a.volunteer!.email.toLowerCase() === me,
            accepted: a.accepted,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      assignedEmailsByKey.set(key, new Set(rows.map((a) => a.volunteer!.email.toLowerCase())));
    }

    // People who declined a slot and are no longer on it (a later re-claim
    // of the same slot hides the old decline).
    const declinedByKey = new Map<string, string[]>();
    type DeclineRow = { date: string; slot: string; volunteer_name: string; volunteer_email: string };
    for (const d of (declinesRes.data ?? []) as DeclineRow[]) {
      const key = `${d.date}|${d.slot}`;
      if (assignedEmailsByKey.get(key)?.has(d.volunteer_email.toLowerCase())) continue;
      const list = declinedByKey.get(key) ?? [];
      if (!list.includes(d.volunteer_name)) list.push(d.volunteer_name);
      declinedByKey.set(key, list);
    }

    const closures = new Set(
      ((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date),
    );

    // Every school day (Mon-Thu, not a closure) gets both slots, empty or not.
    const days: {
      date: string;
      shifts: { slot: string; people: Person[]; declined: string[] }[];
    }[] = [];
    for (let date = from; date <= year.ends_on; date = nextDay(date)) {
      if (weekdayOf(date) > 4 || closures.has(date)) continue;
      days.push({
        date,
        shifts: SLOTS.map((slot) => ({
          slot,
          people: peopleByKey.get(`${date}|${slot}`) ?? [],
          declined: declinedByKey.get(`${date}|${slot}`) ?? [],
        })),
      });
    }

    return json(200, { days });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
