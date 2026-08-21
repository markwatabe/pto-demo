# Admin Approval for New Sign-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New sign-ups land in a waiting room until a PTO admin approves them; admins approve sign-ups and grant/revoke admin from a new `/admin` page, enforced by RLS.

**Architecture:** A `profiles` table (auto-filled by a trigger on `auth.users` insert, status `pending` → `approved`) and an `admins` table gate everything: `security definer` helpers `is_admin()`/`is_approved()` drive RLS on all tables, so pending users are locked out at the database. The client gains a `useAccess()` hook, a waiting-room page, and an admin page; approval is a plain client-side UPDATE by an admin — no server code. The seed script bootstraps the first admin from `ADMIN_EMAIL`.

**Tech Stack:** Supabase (Postgres + RLS + auth admin API), React 19, `@supabase/supabase-js` v2, `@apygee/atoms`, pnpm, tsx.

**Spec:** `docs/superpowers/specs/2026-08-21-admin-approval-design.md`

## Global Constraints

- Pure SPA: no Edge Functions, no server code; the only privileged actor is the seed script's service-role client.
- Table/column names exactly as in Task 1's SQL: `profiles(id, email, status, requested_at, approved_at, approved_by)`, `admins(user_id, email, granted_at, granted_by)`; status values exactly `'pending'` / `'approved'`.
- Helper function names exactly `public.is_admin()`, `public.is_approved()`; trigger name `on_auth_user_created`.
- Fail closed: a signed-in user whose profile is missing or unreadable is treated as `pending`, never `approved`.
- New env var name exactly: `ADMIN_EMAIL` (required by `pnpm seed`).
- Every commit must leave `pnpm typecheck` passing. No test framework exists; do not add one — gates are typecheck plus the scripts.
- Live-project verifications (sign-up flow, approve flow, RLS behavior) are deferred to the consolidated runbook that already covers the migration branch — the Supabase project is not yet configured. Each task's gate is typecheck + code fidelity.
- Do not touch `@apygee/*` packages, `Login.tsx`, `Directory.tsx`, `src/auth.ts`, or `src/supabase.ts`.
- Branch: `admin-approval` (already created, based on `supabase-migration`).

---

### Task 1: Schema — profiles, admins, trigger, helpers, RLS rewrite

**Files:**
- Modify: `supabase/schema.sql` (four edits, shown in full below)
- Modify: `.env.example` (append one block)

**Interfaces:**
- Consumes: existing schema.sql from the migration (five directory tables, five `"authenticated can read"` policies).
- Produces: tables `profiles` / `admins`, functions `public.is_admin()` / `public.is_approved()`, trigger `on_auth_user_created`; five directory-table policies renamed `"approved can read"` using `public.is_approved()`. Tasks 2, 4, and 6 rely on these exact names.

- [ ] **Step 1: Update the header comment and drop section of `supabase/schema.sql`**

Replace the two header comment lines at the top of the file:

```sql
-- PTO family directory schema. Apply once via the Supabase SQL editor.
-- Idempotent: drops and recreates the directory tables.
```

with:

```sql
-- PTO family directory schema. Apply once via the Supabase SQL editor.
-- Idempotent: drops and recreates all tables. NOTE: re-running wipes
-- approval state (profiles/admins) as well as directory data; run
-- `pnpm seed` afterwards to re-bootstrap the first admin.
```

Replace the drop block:

```sql
drop table if exists child_past_teachers;
drop table if exists children;
drop table if exists parents;
drop table if exists families;
drop table if exists teachers;
```

with (trigger first, then dependent function order, then tables):

```sql
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.is_approved();
drop function if exists public.is_admin();
drop table if exists admins;
drop table if exists profiles;
drop table if exists child_past_teachers;
drop table if exists children;
drop table if exists parents;
drop table if exists families;
drop table if exists teachers;
```

- [ ] **Step 2: Add the new tables, helpers, and trigger**

Insert this block immediately after the `create table child_past_teachers (...)` statement and before the RLS section:

```sql
-- Approval workflow: every auth user gets a profiles row (via trigger),
-- pending until an admin approves. admins rows mark who can approve.
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users (id)
);

create table admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users (id)
);

-- Helpers for RLS policies. security definer lets policies call them
-- without recursing through profiles/admins' own policies.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

create or replace function public.is_approved()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'approved')
      or public.is_admin();
$$;

-- Every new auth user gets a pending profile row at sign-up time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 3: Rewrite the RLS section**

Replace the comment above the `alter table ... enable row level security` block:

```sql
-- Directory is readable by signed-in users only. No client-side write
-- policies exist; the seed script writes with the service-role key, which
-- bypasses RLS.
```

with:

```sql
-- Directory is readable by APPROVED users only (pending users are locked
-- out at the database). Approving and granting/revoking admin are the only
-- client-side writes, restricted to admins; the seed script writes with the
-- service-role key, which bypasses RLS.
```

Add to the enable-RLS block, after the existing five lines:

```sql
alter table profiles enable row level security;
alter table admins enable row level security;
```

Replace the five existing policies:

```sql
create policy "authenticated can read" on families
  for select to authenticated using (true);
create policy "authenticated can read" on teachers
  for select to authenticated using (true);
create policy "authenticated can read" on parents
  for select to authenticated using (true);
create policy "authenticated can read" on children
  for select to authenticated using (true);
create policy "authenticated can read" on child_past_teachers
  for select to authenticated using (true);
```

with:

```sql
create policy "approved can read" on families
  for select to authenticated using (public.is_approved());
create policy "approved can read" on teachers
  for select to authenticated using (public.is_approved());
create policy "approved can read" on parents
  for select to authenticated using (public.is_approved());
create policy "approved can read" on children
  for select to authenticated using (public.is_approved());
create policy "approved can read" on child_past_teachers
  for select to authenticated using (public.is_approved());

create policy "own or admin can read" on profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "admin can update" on profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "own or admin can read" on admins
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "admin can grant" on admins
  for insert to authenticated with check (public.is_admin());
create policy "admin can revoke others" on admins
  for delete to authenticated using (public.is_admin() and user_id <> auth.uid());
```

- [ ] **Step 4: Append to `.env.example`**

```bash

# First-admin bootstrap: pnpm seed creates/approves this account and makes
# it an admin. Use the email you sign in with.
ADMIN_EMAIL=you@example.com
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck` — expected exit 0 (SQL/env changes don't affect TS; confirms no accidental breakage).

```bash
git add supabase/schema.sql .env.example
git commit -m "feat: add approval schema — profiles, admins, trigger, RLS"
```

---

### Task 2: `useAccess()` hook

**Files:**
- Create: `src/access.ts`

**Interfaces:**
- Consumes: `useAuth()` from `src/auth.ts` (`{ isLoading, user }`), `supabase` from `src/supabase.ts`; `profiles`/`admins` tables from Task 1.
- Produces: `useAccess(): Access` where `Access = { isLoading: boolean; user: User | null; status: 'pending' | 'approved' | null; isAdmin: boolean; refresh: () => void }`. Tasks 3 and 5 import exactly this.

- [ ] **Step 1: Write `src/access.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useAuth } from './auth';

export type AccessStatus = 'pending' | 'approved' | null;

type AccessState = {
  isLoading: boolean;
  status: AccessStatus;
  isAdmin: boolean;
};

export type Access = AccessState & {
  user: User | null;
  refresh: () => void;
};

/**
 * Auth session plus approval status. Signed-out users have status null.
 * A signed-in user with no readable profile row is treated as pending —
 * access fails closed. refresh() re-checks (used by the waiting room).
 */
export function useAccess(): Access {
  const { isLoading: authLoading, user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<AccessState>({
    isLoading: true,
    status: null,
    isAdmin: false,
  });
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setState({ isLoading: false, status: null, isAdmin: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true }));
    Promise.all([
      supabase.from('profiles').select('status').eq('id', userId).maybeSingle(),
      supabase.from('admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ]).then(([profile, admin]) => {
      if (cancelled) return;
      const isAdmin = !admin.error && Boolean(admin.data);
      const approved = !profile.error && profile.data?.status === 'approved';
      setState({
        isLoading: false,
        status: approved || isAdmin ? 'approved' : 'pending',
        isAdmin,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, userId, generation]);

  return {
    ...state,
    user,
    isLoading: authLoading || state.isLoading,
    refresh,
  };
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm typecheck` — expected exit 0 (nothing imports the hook yet).

- [ ] **Step 3: Commit**

```bash
git add src/access.ts
git commit -m "feat: add useAccess hook for approval status"
```

---

### Task 3: Waiting-room page

**Files:**
- Create: `src/pages/Waiting.tsx`

**Interfaces:**
- Consumes: `supabase` from `src/supabase.ts`; `@apygee/atoms`.
- Produces: `WaitingPage({ onCheckAgain }: { onCheckAgain: () => void })`. Task 5 imports exactly this.

- [ ] **Step 1: Write `src/pages/Waiting.tsx`**

```tsx
import { Body, Button, Caption, Card, PageShell, SectionTitle, Stack } from '@apygee/atoms';
import { supabase } from '../supabase';

export function WaitingPage({ onCheckAgain }: { onCheckAgain: () => void }) {
  return (
    <PageShell width="sm">
      <Stack gap="xl">
        <Stack gap="xs">
          <Caption>PTO Demo</Caption>
          <SectionTitle>Waiting for approval</SectionTitle>
          <Body>
            Your account is waiting for PTO admin approval. You will get access to the
            directory once an admin approves your sign-up.
          </Body>
        </Stack>

        <Card padding="lg" surface="raised">
          <Stack gap="md">
            <Button fullWidth onClick={onCheckAgain}>
              Check again
            </Button>
            <Button variant="ghost" fullWidth onClick={() => supabase.auth.signOut()}>
              Sign out
            </Button>
          </Stack>
        </Card>
      </Stack>
    </PageShell>
  );
}
```

(While the re-check runs, `useAccess().isLoading` flips true and App shows its global spinner, so the page needs no busy state of its own.)

- [ ] **Step 2: Verify compile**

Run: `pnpm typecheck` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Waiting.tsx
git commit -m "feat: add waiting-room page for pending sign-ups"
```

---

### Task 4: Admin page

**Files:**
- Create: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `supabase` from `src/supabase.ts`, `useAuth()` from `src/auth.ts`; `profiles`/`admins` tables and RLS from Task 1.
- Produces: `AdminPage()` (no props). Task 5 imports exactly this.

- [ ] **Step 1: Write `src/pages/Admin.tsx`**

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Body,
  Button,
  Caption,
  Card,
  Divider,
  Inline,
  PageHeader,
  PageShell,
  SectionTitle,
  Spinner,
  Stack,
  Strong,
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';
import { useAuth } from '../auth';

type ProfileRow = {
  id: string;
  email: string;
  status: string;
  requested_at: string;
};

type AdminRow = {
  user_id: string;
  email: string;
  granted_at: string;
};

export function AdminPage() {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [grantEmail, setGrantEmail] = useState('');
  const [granting, setGranting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const [profilesRes, adminsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, email, status, requested_at')
        .order('requested_at', { ascending: true }),
      supabase
        .from('admins')
        .select('user_id, email, granted_at')
        .order('granted_at', { ascending: true }),
    ]);
    if (profilesRes.error || adminsRes.error) {
      setError((profilesRes.error ?? adminsRes.error)!.message);
    } else {
      setProfiles((profilesRes.data ?? []) as ProfileRow[]);
      setAdmins((adminsRes.data ?? []) as AdminRow[]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(profile: ProfileRow) {
    setBusyId(profile.id);
    setError(null);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: user?.id ?? null,
      })
      .eq('id', profile.id);
    setBusyId(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await load();
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    const email = grantEmail.trim().toLowerCase();
    if (!email) return;
    setGranting(true);
    setError(null);
    const { data: profile, error: lookupError } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();
    if (lookupError) {
      setGranting(false);
      setError(lookupError.message);
      return;
    }
    if (!profile) {
      setGranting(false);
      setError('No account with that email has signed in yet.');
      return;
    }
    const { error: insertError } = await supabase
      .from('admins')
      .insert({ user_id: profile.id, email: profile.email, granted_by: user?.id ?? null });
    setGranting(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setGrantEmail('');
    await load();
  }

  async function revoke(admin: AdminRow) {
    setBusyId(admin.user_id);
    setError(null);
    const { error: deleteError } = await supabase
      .from('admins')
      .delete()
      .eq('user_id', admin.user_id);
    setBusyId(null);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await load();
  }

  const pending = profiles.filter((p) => p.status === 'pending');
  const members = profiles.filter((p) => p.status === 'approved');

  return (
    <PageShell width="lg">
      <Stack gap="xl">
        <PageHeader
          eyebrow="PTO"
          title="Admin"
          description="Approve new sign-ups and manage admins."
        />

        {error ? <Alert tone="danger" title="Something went wrong" description={error} /> : null}

        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : (
          <>
            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Pending sign-ups</SectionTitle>
                {pending.length === 0 ? (
                  <Body>No one is waiting for approval.</Body>
                ) : (
                  <Stack gap="md">
                    {pending.map((profile) => (
                      <Inline key={profile.id} gap="md" align="center" wrap>
                        <Stack gap="xs">
                          <Strong>{profile.email}</Strong>
                          <Caption>
                            {`Requested ${new Date(profile.requested_at).toLocaleDateString()}`}
                          </Caption>
                        </Stack>
                        <Button onClick={() => approve(profile)} disabled={busyId === profile.id}>
                          {busyId === profile.id ? 'Approving…' : 'Approve'}
                        </Button>
                      </Inline>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Members</SectionTitle>
                {members.length === 0 ? (
                  <Body>No approved members yet.</Body>
                ) : (
                  <Stack gap="sm">
                    {members.map((profile) => (
                      <Body key={profile.id}>{profile.email}</Body>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Card>

            <Card padding="lg" surface="raised">
              <Stack gap="md">
                <SectionTitle>Admins</SectionTitle>
                <Stack gap="sm">
                  {admins.map((admin) => (
                    <Inline key={admin.user_id} gap="md" align="center" wrap>
                      <Body>{admin.email}</Body>
                      {admin.user_id === user?.id ? (
                        <Caption>you</Caption>
                      ) : (
                        <Button
                          variant="secondary"
                          onClick={() => revoke(admin)}
                          disabled={busyId === admin.user_id}
                        >
                          {busyId === admin.user_id ? 'Revoking…' : 'Revoke'}
                        </Button>
                      )}
                    </Inline>
                  ))}
                </Stack>

                <Divider />

                <form onSubmit={grant}>
                  <Stack gap="md">
                    <TextField
                      label="Grant admin by email"
                      name="grantEmail"
                      placeholder="parent@example.com"
                      inputMode="email"
                      value={grantEmail}
                      onChange={(e) => setGrantEmail(e.currentTarget.value)}
                    />
                    <Button type="submit" disabled={granting || !grantEmail.trim()}>
                      {granting ? 'Granting…' : 'Grant admin'}
                    </Button>
                  </Stack>
                </form>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </PageShell>
  );
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm typecheck` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "feat: add admin page — approvals and admin management"
```

---

### Task 5: Wire routing — App and AppLayout

**Files:**
- Modify: `src/App.tsx` (full replacement below)
- Modify: `src/components/AppLayout.tsx` (three edits below)

**Interfaces:**
- Consumes: `useAccess()` from `src/access.ts` (Task 2), `WaitingPage` (Task 3), `AdminPage` (Task 4).
- Produces: `AppLayout({ isAdmin }: { isAdmin: boolean })` — prop added.

- [ ] **Step 1: Replace `src/App.tsx` entirely**

```tsx
import { Navigate, Route, Routes } from 'react-router';
import { PageShell, Spinner, Stack } from '@apygee/atoms';
import { useAccess } from './access';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/Login';
import { DirectoryPage } from './pages/Directory';
import { CalendarPage } from './pages/Calendar';
import { FormsPage } from './pages/Forms';
import { OurPtoPage } from './pages/OurPto';
import { AdminPage } from './pages/Admin';
import { WaitingPage } from './pages/Waiting';

export function App() {
  const { isLoading, user, status, isAdmin, refresh } = useAccess();

  if (isLoading) {
    return (
      <PageShell width="sm">
        <Stack gap="md" align="center">
          <Spinner />
        </Stack>
      </PageShell>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (status !== 'approved') {
    return <WaitingPage onCheckAgain={refresh} />;
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/directory" replace />} />
      <Route element={<AppLayout isAdmin={isAdmin} />}>
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/our-pto" element={<OurPtoPage />} />
        <Route
          path="/admin"
          element={isAdmin ? <AdminPage /> : <Navigate to="/directory" replace />}
        />
        <Route path="/" element={<Navigate to="/directory" replace />} />
        <Route path="*" element={<Navigate to="/directory" replace />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 2: Update `src/components/AppLayout.tsx`**

Change the component signature from:

```tsx
export function AppLayout() {
```

to:

```tsx
export function AppLayout({ isAdmin }: { isAdmin: boolean }) {
```

In the nav block, after the `NAV_ITEMS.map(...)` expression and inside the same `<Stack gap="sm">`, add:

```tsx
              {isAdmin ? (
                <NavLink to="/admin" end>
                  Admin
                </NavLink>
              ) : null}
```

Everything else (including its `useAuth()` usage for the signed-in email) stays unchanged.

- [ ] **Step 3: Verify compile**

Run: `pnpm typecheck` — expected exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/AppLayout.tsx
git commit -m "feat: gate app behind approval, add admin route and nav"
```

---

### Task 6: Seed bootstrap + verify-rls extension

**Files:**
- Modify: `scripts/seed.ts` (three edits below)
- Modify: `scripts/verify-rls.ts` (one edit below)

**Interfaces:**
- Consumes: `profiles`/`admins` tables (Task 1); `ADMIN_EMAIL` env var (documented in Task 1's `.env.example` edit).
- Produces: `pnpm seed` bootstraps the first admin; `pnpm verify:rls` covers 7 tables.

- [ ] **Step 1: Edit `scripts/seed.ts` — require ADMIN_EMAIL**

Update the header comment's requirements line from:

```ts
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
```

to:

```ts
 * Requires VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ADMIN_EMAIL
 * in .env. Bootstraps ADMIN_EMAIL as an approved admin (profiles/admins
 * are never wiped — they hold real users, not demo data).
```

After the existing `serviceKey` guard lines, add:

```ts
const adminEmail = process.env.ADMIN_EMAIL;
if (!adminEmail) throw new Error('Missing ADMIN_EMAIL in .env');
```

- [ ] **Step 2: Edit `scripts/seed.ts` — bootstrap function + call**

Add this function directly above `async function main() {`:

```ts
// Find-or-create the first admin's confirmed auth user, then mark them
// approved and admin. Idempotent via upsert.
async function bootstrapAdmin(email: string) {
  const { data: list, error: listError } = await db.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listError) throw new Error(`Failed to list users: ${listError.message}`);

  let adminUser = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!adminUser) {
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createError) throw new Error(`Failed to create admin user: ${createError.message}`);
    adminUser = created.user ?? undefined;
  }
  if (!adminUser) throw new Error('Admin user lookup/creation returned no user');

  const { error: profileError } = await db.from('profiles').upsert({
    id: adminUser.id,
    email,
    status: 'approved',
    approved_at: new Date().toISOString(),
  });
  if (profileError) throw new Error(`Failed to upsert admin profile: ${profileError.message}`);

  const { error: adminError } = await db
    .from('admins')
    .upsert({ user_id: adminUser.id, email });
  if (adminError) throw new Error(`Failed to upsert admin role: ${adminError.message}`);

  console.log(`Admin bootstrapped: ${email}`);
}
```

Then add this as the first line inside `main()`, before the `console.log('Clearing existing directory data…');` line:

```ts
  await bootstrapAdmin(adminEmail);
```

Do NOT add `profiles` or `admins` to the clearing loop — the clear list stays exactly the five directory tables.

- [ ] **Step 3: Edit `scripts/verify-rls.ts` — cover the new tables**

Replace:

```ts
const TABLES = ['families', 'parents', 'children', 'teachers', 'child_past_teachers'];
```

with:

```ts
const TABLES = [
  'families',
  'parents',
  'children',
  'teachers',
  'child_past_teachers',
  'profiles',
  'admins',
];
```

(The existing assertions hold: anon sees 0 for all seven; the service role sees ≥ 1 in `profiles`/`admins` because the seed bootstraps the admin.)

- [ ] **Step 4: Verify compile**

Run: `pnpm typecheck` — expected exit 0. (`scripts/` sits outside tsconfig's include, so also spot-check by reading your diff that every referenced symbol exists — `db`, `adminEmail` — and that no `@instantdb` reference crept in.)

- [ ] **Step 5: Commit**

```bash
git add scripts/seed.ts scripts/verify-rls.ts
git commit -m "feat: bootstrap first admin in seed, verify RLS on approval tables"
```
