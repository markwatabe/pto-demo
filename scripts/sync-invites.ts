/**
 * Bring every volunteer's Google Calendar invites in line with the database
 * (the sync-invites edge function: one invite per person per day, matched by
 * person and day; Google resets the guest's RSVP when an invite's time changes).
 *
 * DRY RUN (prints the plan) unless --confirm. New invites always email the
 * guest; --notify also emails guests about time changes and cancellations.
 * Runs in batches until nothing is left.
 *
 *   pnpm sync:invites
 *   pnpm sync:invites --confirm --notify
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminEmail = process.env.ADMIN_EMAIL;
if (!url || !anon || !serviceKey || !adminEmail) throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / ADMIN_EMAIL in .env');
const CONFIRM = process.argv.includes('--confirm');
const NOTIFY = process.argv.includes('--notify');

type Result = { dryRun?: boolean; create?: number; update?: number; cancel?: number; created?: number; updated?: number; cancelled?: number; remaining?: number; error?: string };

/** A signed-in admin session for the function's auth check: a magic link minted with the service key (no email is sent). */
async function adminJwt(): Promise<string> {
  const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: adminEmail! });
  if (error) throw new Error(error.message);
  const client = createClient(url!, anon!, { auth: { persistSession: false } });
  const { data, error: e2 } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (e2 || !data.session) throw new Error(e2?.message ?? 'no session');
  return data.session.access_token;
}

let jwt = '';
async function call(body: Record<string, unknown>, retry = true): Promise<Result> {
  jwt ||= await adminJwt();
  const res = await fetch(`${url}/functions/v1/sync-invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon!, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Result;
  // A freshly minted session is sometimes refused once ("Admins only"); try again.
  if (res.status === 403 && retry) return call(body, false);
  if (!res.ok || out.error) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

async function main() {
  const plan = await call({});
  console.log(`Plan: create ${plan.create}, update ${plan.update}, cancel ${plan.cancel}`);
  if (!CONFIRM) return console.log('Dry run. Pass --confirm to change the calendar (--notify to email updates and cancellations too).');
  const total = { created: 0, updated: 0, cancelled: 0 };
  for (;;) {
    const r = await call({ confirm: true, limit: 40, notifyChanges: NOTIFY, notifyCancellations: NOTIFY });
    total.created += r.created ?? 0;
    total.updated += r.updated ?? 0;
    total.cancelled += r.cancelled ?? 0;
    console.log(`  created ${total.created}, updated ${total.updated}, cancelled ${total.cancelled}; ${r.remaining} left`);
    if (!r.remaining) break;
  }
}

main().catch((e) => { console.error('sync-invites failed:', e); process.exit(1); });
