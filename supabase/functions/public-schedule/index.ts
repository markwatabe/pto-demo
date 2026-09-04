// Public (no-login) read of the upcoming Green Team schedule for the
// /fiske-schedule view: only days that actually have shifts. Returns
// volunteer NAMES only; the caller's email is used server-side to flag their
// own shifts and is never echoed back, and nobody else's email ever leaves
// the server.
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

// School-local "today" (dates in the DB are school-local calendar dates).
function todayInNewYork(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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

    const shiftsRes = await db
      .from('green_team_shifts')
      .select('date, slot, volunteers:volunteers!shift_volunteers ( name, email )')
      .gte('date', from)
      .lte('date', year.ends_on)
      .order('date');
    if (shiftsRes.error) {
      return json(500, { error: shiftsRes.error.message });
    }

    type ShiftRow = { date: string; slot: string; volunteers: { name: string; email: string }[] };
    type Day = {
      date: string;
      shifts: { slot: string; people: { name: string; me: boolean }[] }[];
    };
    const days = new Map<string, Day>();
    const dayFor = (date: string) => {
      let d = days.get(date);
      if (!d) {
        d = { date, shifts: [] };
        days.set(date, d);
      }
      return d;
    };

    for (const shift of (shiftsRes.data ?? []) as unknown as ShiftRow[]) {
      dayFor(shift.date).shifts.push({
        slot: shift.slot,
        people: shift.volunteers
          .map((v) => ({ name: v.name, me: v.email.toLowerCase() === me }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const d of sorted) d.shifts.sort((a, b) => a.slot.localeCompare(b.slot));

    return json(200, { days: sorted });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
