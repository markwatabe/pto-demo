// Nightly Web Push reminders: tells every subscribed volunteer about their
// shift tomorrow. Triggered by pg_cron (x-cron-secret header), not by users.
// Implements RFC 8291 (aes128gcm message encryption) and RFC 8292 (VAPID)
// directly on WebCrypto.
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Mirrors SLOT_TIMES / labels in src/schedule.ts.
const SLOT_TEXT: Record<string, string> = {
  early: 'Early shift 11:05–12:15',
  late: 'Late shift 12:20–1:30',
};

function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64uEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

// RFC 8291: encrypt `payload` for one subscription; returns the POST body.
async function encryptPayload(
  payload: Uint8Array,
  p256dh: string,
  auth: string,
): Promise<Uint8Array> {
  const uaPub = b64uDecode(p256dh); // 65-byte uncompressed point
  const authSecret = b64uDecode(auth); // 16 bytes

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256),
  );

  const enc = new TextEncoder();
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPub, asPub);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(payload, new Uint8Array([2])); // 0x02 = last record
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
  );

  // Header: salt(16) | record size(4) | keyid len(1) | as_pub(65) | ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// RFC 8292: "vapid t=<jwt>, k=<public key>" for the endpoint's origin.
async function vapidAuth(endpoint: string): Promise<string> {
  const jwk = JSON.parse(Deno.env.get('VAPID_PRIVATE_JWK')!);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const enc = new TextEncoder();
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:greenteam@fiskeschoolpto.org',
      }),
    ),
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(`${header}.${claims}`),
  );
  return `vapid t=${header}.${claims}.${b64uEncode(sig)}, k=${Deno.env.get('VAPID_PUBLIC_KEY')}`;
}

// Sends one push; returns 'ok', 'gone' (subscription dead), or 'error'.
async function sendPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: { title: string; body: string },
): Promise<'ok' | 'gone' | 'error'> {
  try {
    const body = await encryptPayload(
      new TextEncoder().encode(JSON.stringify(payload)),
      sub.keys.p256dh,
      sub.keys.auth,
    );
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuth(sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
      },
      body,
    });
    await res.body?.cancel();
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone';
    console.error(`push failed (${res.status}) for ${new URL(sub.endpoint).origin}`);
    return 'error';
  } catch (err) {
    console.error('push error:', err instanceof Error ? err.message : String(err));
    return 'error';
  }
}

// Tomorrow's date in school-local time.
function tomorrowInNewYork(): string {
  const now = new Date(Date.now() + 24 * 3600 * 1000);
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return json(403, { error: 'Forbidden.' });
  }
  try {
    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const date = tomorrowInNewYork();
    const { data: shifts, error: shiftsError } = await db
      .from('green_team_shifts')
      .select('slot, volunteers:volunteers!shift_volunteers ( email )')
      .eq('date', date);
    if (shiftsError) return json(500, { error: shiftsError.message });

    // email -> that volunteer's slots tomorrow
    const slotsByEmail = new Map<string, string[]>();
    type ShiftRow = { slot: string; volunteers: { email: string }[] };
    for (const shift of (shifts ?? []) as unknown as ShiftRow[]) {
      for (const v of shift.volunteers) {
        const email = v.email.toLowerCase();
        const list = slotsByEmail.get(email) ?? [];
        list.push(shift.slot);
        slotsByEmail.set(email, list);
      }
    }
    if (slotsByEmail.size === 0) return json(200, { date, sent: 0, reason: 'no shifts tomorrow' });

    const { data: subs, error: subsError } = await db
      .from('push_subscriptions')
      .select('email, endpoint, subscription')
      .in('email', [...slotsByEmail.keys()]);
    if (subsError) return json(500, { error: subsError.message });

    let sent = 0;
    let removed = 0;
    let failed = 0;
    for (const row of subs ?? []) {
      const slots = slotsByEmail.get(row.email)!;
      const text = slots
        .sort()
        .map((s) => SLOT_TEXT[s] ?? s)
        .join(' and ');
      const result = await sendPush(
        row.subscription as { endpoint: string; keys: { p256dh: string; auth: string } },
        { title: 'Green Team tomorrow', body: `You're on the ${text}. Thank you!` },
      );
      if (result === 'ok') sent++;
      else if (result === 'gone') {
        await db.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
        removed++;
      } else failed++;
    }

    return json(200, { date, volunteers: slotsByEmail.size, sent, removed, failed });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
