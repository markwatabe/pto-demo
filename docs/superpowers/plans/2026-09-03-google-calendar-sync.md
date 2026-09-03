# Google Calendar Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only "Sync Google Calendar" button pushes the school year's shifts and closures into a PTO-owned Google Calendar via a Supabase Edge Function, idempotently.

**Architecture:** The project's first server-side code: a Deno Edge Function that (1) admin-gates the caller via their Supabase JWT, (2) reads the schedule with the service role, (3) mints a Google access token from service-account credentials held in function secrets, and (4) diff-syncs events keyed by a private extended property — create/patch/delete only events it manages. The Schedule page gains one card with one button.

**Tech Stack:** Supabase Edge Functions (Deno, `Deno.serve`, WebCrypto RS256), Google Calendar REST API v3, `@supabase/supabase-js` v2 (both in-function via `npm:` specifier and in the SPA), React 19 / `@apygee/atoms`.

**Spec:** `docs/superpowers/specs/2026-09-03-google-calendar-sync-design.md`

## Global Constraints

- Function name/path exactly: `supabase/functions/sync-google-calendar/index.ts`; invoked as `sync-google-calendar`.
- Secrets read via `Deno.env`: `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `GOOGLE_CALENDAR_ID` (plus platform-provided `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Secrets never appear in git or the SPA.
- Managed-event marker exactly: `extendedProperties.private = { managedBy: 'pto-demo', ptoKey }`; `ptoKey` = shift id, or `closure-<date>`. Only events carrying the marker are ever created/patched/deleted.
- Event shapes exactly: shifts → timed events, timeZone `America/New_York`, `11:30`→`12:30` / `12:30`→`13:30`, summary `` `Green Team: ${names || 'unfilled'} (${Early|Late})` `` with names sorted via `localeCompare`, joined `', '`; closures → all-day, summary `` `No school · ${reason}` `` or `No school`.
- Sync window = `[school_year.starts_on, school_year.ends_on]` for desired events; the existing-events listing has NO time bounds (managed marker only).
- Responses: JSON with CORS headers; success `{ created, updated, deleted, total }`; failures 4xx/5xx `{ error }` (401 not signed in, 403 not admin, 400 school year unset, 500 config/Google errors).
- Google API calls are sequential (deterministic, rate-limit-friendly; ~240 calls ≈ well within the function's 150s wall clock).
- The Deno file sits outside tsconfig — its static gate is `deno check` when a `deno` binary exists locally, otherwise a careful line-by-line self-review; `pnpm typecheck`/`pnpm build` must stay green for the SPA change.
- Work directly on `main` (standing consent); every commit green before push; deployment of the function is the controller's post-task step (Supabase MCP), as is the live sync test after the user configures Google + secrets.

---

### Task 1: Edge Function `sync-google-calendar`

**Files:**
- Create: `supabase/functions/sync-google-calendar/index.ts`

**Interfaces:**
- Consumes: existing tables `admins(user_id)`, `school_year(starts_on, ends_on)`, `green_team_shifts(id, date, slot)` with `volunteers:volunteers!shift_volunteers(name)`, `school_closures(date, reason)`.
- Produces: HTTP function returning `{ created: number, updated: number, deleted: number, total: number }` on 200. Task 2 invokes it by name and reads those fields plus `{ error }` on failure.

- [ ] **Step 1: Write `supabase/functions/sync-google-calendar/index.ts`**

```ts
// Pushes the school year's Green Team shifts and closures into the PTO's
// shared Google Calendar. Admin-only; idempotent diff sync — only events
// carrying our managed marker are ever created, patched, or deleted.
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

const TZ = 'America/New_York';
const MANAGED = 'pto-demo';
const SLOT_END: Record<string, string> = { '11:30': '12:30', '12:30': '13:30' };
const SLOT_LABEL: Record<string, string> = { '11:30': 'Early', '12:30': 'Late' };

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

async function googleAccessToken(saEmail: string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: saEmail,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

type DesiredEvent = {
  ptoKey: string;
  summary: string;
  start: Record<string, string>;
  end: Record<string, string>;
};

type GoogleEvent = {
  id: string;
  summary?: string;
  start?: Record<string, string>;
  end?: Record<string, string>;
  extendedProperties?: { private?: Record<string, string> };
};

// All-day events end on the FOLLOWING day in the Calendar API.
function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, (d ?? 1) + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Google echoes dateTime in the event's zone with an offset
// ("2026-09-08T11:30:00-04:00"); our naive local string is its prefix.
function matches(g: GoogleEvent, d: DesiredEvent): boolean {
  if ((g.summary ?? '') !== d.summary) return false;
  if (d.start.date) return g.start?.date === d.start.date && g.end?.date === d.end.date;
  return (
    Boolean(g.start?.dateTime?.startsWith(d.start.dateTime!)) &&
    Boolean(g.end?.dateTime?.startsWith(d.end.dateTime!))
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const saEmail = Deno.env.get('GOOGLE_SA_EMAIL');
    const saKey = Deno.env.get('GOOGLE_SA_PRIVATE_KEY');
    const calendarId = Deno.env.get('GOOGLE_CALENDAR_ID');
    if (!saEmail || !saKey || !calendarId) {
      return json(500, {
        error:
          'Missing GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY / GOOGLE_CALENDAR_ID function secrets.',
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Admin gate: resolve the caller from their JWT, then check admins.
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json(401, { error: 'Not signed in.' });

    const db = createClient(supabaseUrl, serviceKey);
    const { data: adminRow } = await db
      .from('admins')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (!adminRow) return json(403, { error: 'Admins only.' });

    // Load the schedule.
    const { data: year } = await db.from('school_year').select('starts_on, ends_on').maybeSingle();
    if (!year) return json(400, { error: 'Set the school year before syncing.' });

    const [shiftsRes, closuresRes] = await Promise.all([
      db
        .from('green_team_shifts')
        .select('id, date, slot, volunteers:volunteers!shift_volunteers ( name )')
        .gte('date', year.starts_on)
        .lte('date', year.ends_on),
      db.from('school_closures').select('date, reason'),
    ]);
    if (shiftsRes.error || closuresRes.error) {
      return json(500, { error: (shiftsRes.error ?? closuresRes.error)!.message });
    }

    const desired = new Map<string, DesiredEvent>();
    type ShiftRow = { id: string; date: string; slot: string; volunteers: { name: string }[] };
    for (const shift of (shiftsRes.data ?? []) as unknown as ShiftRow[]) {
      const names = shift.volunteers
        .map((v) => v.name)
        .sort((a, b) => a.localeCompare(b))
        .join(', ');
      desired.set(shift.id, {
        ptoKey: shift.id,
        summary: `Green Team: ${names || 'unfilled'} (${SLOT_LABEL[shift.slot]})`,
        start: { dateTime: `${shift.date}T${shift.slot}:00`, timeZone: TZ },
        end: { dateTime: `${shift.date}T${SLOT_END[shift.slot]}:00`, timeZone: TZ },
      });
    }
    for (const c of (closuresRes.data ?? []) as { date: string; reason: string | null }[]) {
      if (c.date < year.starts_on || c.date > year.ends_on) continue;
      desired.set(`closure-${c.date}`, {
        ptoKey: `closure-${c.date}`,
        summary: c.reason ? `No school · ${c.reason}` : 'No school',
        start: { date: c.date },
        end: { date: nextDay(c.date) },
      });
    }

    // Google: token, then list ALL events we manage (no time bounds, so a
    // shrunk school year still gets its stale events cleaned up).
    const token = await googleAccessToken(saEmail, saKey);
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const gHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const existing = new Map<string, GoogleEvent>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        privateExtendedProperty: `managedBy=${MANAGED}`,
        maxResults: '2500',
        showDeleted: 'false',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`${base}?${params}`, { headers: gHeaders });
      if (!res.ok) throw new Error(`Google list failed (${res.status}): ${await res.text()}`);
      const page = await res.json();
      for (const ev of (page.items ?? []) as GoogleEvent[]) {
        const key = ev.extendedProperties?.private?.ptoKey;
        if (key) existing.set(key, ev);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const eventBody = (d: DesiredEvent) => ({
      summary: d.summary,
      start: d.start,
      end: d.end,
      extendedProperties: { private: { managedBy: MANAGED, ptoKey: d.ptoKey } },
    });

    let created = 0;
    let updated = 0;
    let deleted = 0;
    for (const [key, d] of desired) {
      const g = existing.get(key);
      if (!g) {
        const res = await fetch(base, {
          method: 'POST',
          headers: gHeaders,
          body: JSON.stringify(eventBody(d)),
        });
        if (!res.ok) throw new Error(`Google create failed (${res.status}): ${await res.text()}`);
        created++;
      } else if (!matches(g, d)) {
        const res = await fetch(`${base}/${g.id}`, {
          method: 'PATCH',
          headers: gHeaders,
          body: JSON.stringify(eventBody(d)),
        });
        if (!res.ok) throw new Error(`Google update failed (${res.status}): ${await res.text()}`);
        updated++;
      }
    }
    for (const [key, g] of existing) {
      if (desired.has(key)) continue;
      const res = await fetch(`${base}/${g.id}`, { method: 'DELETE', headers: gHeaders });
      if (!res.ok && res.status !== 410) {
        throw new Error(`Google delete failed (${res.status}): ${await res.text()}`);
      }
      deleted++;
    }

    return json(200, { created, updated, deleted, total: desired.size });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 2: Static check**

Run: `deno check supabase/functions/sync-google-calendar/index.ts` if `command -v deno` succeeds — expected: no errors. If Deno isn't installed locally, perform a careful line-by-line self-review against this brief instead and say so in your report. Also run `pnpm typecheck` — expected exit 0 (the file is outside tsconfig; this confirms no accidental SPA breakage).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/sync-google-calendar/index.ts
git commit -m "feat: edge function syncs schedule to shared Google Calendar"
```

---

### Task 2: Sync button on the Schedule page

**Files:**
- Modify: `src/pages/Schedule.tsx` (one state hook, one handler, one card)

**Interfaces:**
- Consumes: the deployed function name `sync-google-calendar` and its response `{ created, updated, deleted, total }` / `{ error }`; the page's existing `supabase`, `error`/`notice` Alert pattern.
- Produces: nothing new.

- [ ] **Step 1: Add state**

After the line `const [summary, setSummary] = useState<DraftPlan['summary'] | null>(null);` add:

```tsx
  const [syncing, setSyncing] = useState(false);
```

- [ ] **Step 2: Add the handler**

Immediately after the closing brace of the `generate()` function, add:

```tsx
  async function syncGoogleCalendar() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    const { data, error: fnError } = await supabase.functions.invoke('sync-google-calendar');
    setSyncing(false);
    if (fnError) {
      // FunctionsHttpError carries the response; surface the function's message.
      let message = fnError.message;
      try {
        const ctx = (fnError as { context?: Response }).context;
        if (ctx) message = (await ctx.json()).error ?? message;
      } catch {
        // keep the generic message
      }
      setError(message);
      return;
    }
    setNotice(
      `Google Calendar synced: ${data.created} created, ${data.updated} updated, ${data.deleted} removed.`,
    );
  }
```

- [ ] **Step 3: Add the card**

Insert this card immediately BEFORE the `<Card padding="lg" surface="raised">` whose content begins with `<SectionTitle>Adjust a day</SectionTitle>` (i.e. between the Generate card and the Adjust-a-day card):

```tsx
            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Google Calendar</SectionTitle>
                <Caption>
                  Pushes the school year's shifts and no-school days to the PTO's shared Google
                  Calendar. Only events managed by this app are touched.
                </Caption>
                <Button onClick={syncGoogleCalendar} disabled={syncing}>
                  {syncing ? 'Syncing…' : 'Sync Google Calendar'}
                </Button>
              </Stack>
            </Card>
```

- [ ] **Step 4: Verify compile and build**

Run: `pnpm typecheck` — expected exit 0.
Run: `pnpm build` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Schedule.tsx
git commit -m "feat: sync-to-google-calendar button on the schedule page"
```
