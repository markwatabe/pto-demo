// Lets a roster volunteer claim an open shift slot from the public
// /fiske-schedule view (no login — identified by their roster email).
// Server-side checks: real school day, today or later, on the roster,
// shift not full, not already on it.
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

function todayInNewYork(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// 1=Mon .. 7=Sun for a YYYY-MM-DD taken as a plain calendar date.
function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return day === 0 ? 7 : day;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      date?: string;
      slot?: string;
    };
    const email = (body.email ?? '').trim().toLowerCase();
    const date = body.date ?? '';
    const slot = body.slot ?? '';
    if (!email.includes('@')) return json(400, { error: 'A valid email is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'Invalid date.' });
    if (slot !== 'early' && slot !== 'late') return json(400, { error: 'Invalid slot.' });
    if (date < todayInNewYork()) return json(400, { error: 'That shift is in the past.' });

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [{ data: year }, { data: closure }, { data: volunteer }] = await Promise.all([
      db.from('school_year').select('starts_on, ends_on').maybeSingle(),
      db.from('school_closures').select('date').eq('date', date).maybeSingle(),
      db.from('volunteers').select('id').eq('email', email).maybeSingle(),
    ]);
    if (!year || date < year.starts_on || date > year.ends_on || closure || weekdayOf(date) > 4) {
      return json(400, { error: 'That date is not a school day.' });
    }
    if (!volunteer) {
      return json(403, {
        error: 'This email is not on the volunteer roster — check with the coordinator.',
      });
    }

    // Find or create the shift row (tolerate a concurrent create).
    let { data: shift } = await db
      .from('green_team_shifts')
      .select('id')
      .eq('date', date)
      .eq('slot', slot)
      .maybeSingle();
    if (!shift) {
      const { data: created } = await db
        .from('green_team_shifts')
        .insert({ date, slot })
        .select('id')
        .maybeSingle();
      shift =
        created ??
        (
          await db
            .from('green_team_shifts')
            .select('id')
            .eq('date', date)
            .eq('slot', slot)
            .maybeSingle()
        ).data;
    }
    if (!shift) return json(500, { error: 'Could not create the shift.' });

    const { data: assigned, error: countError } = await db
      .from('shift_volunteers')
      .select('volunteer_id')
      .eq('shift_id', shift.id);
    if (countError) return json(500, { error: countError.message });
    if (assigned!.some((a) => a.volunteer_id === volunteer.id)) {
      return json(409, { error: "You're already on this shift." });
    }
    if (assigned!.length >= 2) {
      return json(409, { error: 'This shift was just filled by someone else.' });
    }

    const { error: insertError } = await db
      .from('shift_volunteers')
      .insert({ shift_id: shift.id, volunteer_id: volunteer.id });
    if (insertError) return json(500, { error: insertError.message });

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
