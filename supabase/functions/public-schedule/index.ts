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

    const [shiftsRes, closuresRes] = await Promise.all([
      db
        .from('green_team_shifts')
        .select('date, slot, volunteers:volunteers!shift_volunteers ( name, email )')
        .gte('date', from)
        .lte('date', year.ends_on),
      db.from('school_closures').select('date'),
    ]);
    if (shiftsRes.error || closuresRes.error) {
      return json(500, { error: (shiftsRes.error ?? closuresRes.error)!.message });
    }

    type ShiftRow = { date: string; slot: string; volunteers: { name: string; email: string }[] };
    type Person = { name: string; me: boolean };
    const peopleByKey = new Map<string, Person[]>();
    for (const shift of (shiftsRes.data ?? []) as unknown as ShiftRow[]) {
      peopleByKey.set(
        `${shift.date}|${shift.slot}`,
        shift.volunteers
          .map((v) => ({ name: v.name, me: v.email.toLowerCase() === me }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }

    const closures = new Set(
      ((closuresRes.data ?? []) as { date: string }[]).map((c) => c.date),
    );

    // Every school day (Mon-Thu, not a closure) gets both slots, empty or not.
    const days: { date: string; shifts: { slot: string; people: Person[] }[] }[] = [];
    for (let date = from; date <= year.ends_on; date = nextDay(date)) {
      if (weekdayOf(date) > 4 || closures.has(date)) continue;
      days.push({
        date,
        shifts: SLOTS.map((slot) => ({
          slot,
          people: peopleByKey.get(`${date}|${slot}`) ?? [],
        })),
      });
    }

    return json(200, { days });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
