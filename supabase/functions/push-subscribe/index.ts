// Stores / removes Web Push subscriptions for the public /fiske-schedule
// reminders. Public (no login) by design: a subscription only works on the
// device that created it, and rows are keyed by the endpoint the browser
// itself minted, so the worst an abuser can do is subscribe themselves.
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

type Body = {
  action?: 'subscribe' | 'unsubscribe';
  email?: string;
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action ?? 'subscribe';
    const endpoint = body.subscription?.endpoint;
    if (!endpoint || !endpoint.startsWith('https://')) {
      return json(400, { error: 'A push subscription with an endpoint is required.' });
    }

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (action === 'unsubscribe') {
      await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
      return json(200, { ok: true });
    }

    const email = (body.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return json(400, { error: 'A valid email is required.' });
    if (!body.subscription?.keys?.p256dh || !body.subscription.keys.auth) {
      return json(400, { error: 'The subscription is missing its encryption keys.' });
    }

    const { error } = await db
      .from('push_subscriptions')
      .upsert({ email, endpoint, subscription: body.subscription }, { onConflict: 'endpoint' });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
