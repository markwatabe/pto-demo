# InstantDB → Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace InstantDB with Supabase for both auth (email + 6-digit code) and the family-directory database, with zero InstantDB code remaining.

**Architecture:** React/Vite SPA talks directly to a hosted Supabase project — no app server. Postgres tables with FKs replace Instant entities/links; RLS (`SELECT` for `authenticated` only) replaces `instant.perms.ts`; the service-role key replaces `@instantdb/admin` in the seed script. snake_case columns are aliased back to camelCase in the supabase-js select string so render code is untouched.

**Tech Stack:** React 19, Vite 5, TypeScript, `@supabase/supabase-js` v2, pnpm, tsx (scripts).

**Spec:** `docs/superpowers/specs/2026-08-21-supabase-migration-design.md`

## Global Constraints

- No test framework exists in this repo; do not add one. Verification per task = `pnpm typecheck` (which runs `tsc --noEmit`), the two verification scripts, and manual browser checks where stated.
- SPA only — no backend server, no Supabase Edge Functions.
- Do not touch `@apygee/*` UI components or the Calendar/Forms/OurPto pages.
- Env var names exactly: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Table/column names exactly as in the schema SQL in Task 1 (snake_case); client-side identifiers stay camelCase via select aliases.
- Package manager is pnpm (`pnpm add`, `pnpm remove`); commit `pnpm-lock.yaml` changes with `package.json`.
- Every commit must leave `pnpm typecheck` passing. InstantDB deps are removed only in Task 6, after nothing imports them.

---

### Task 1: Supabase project, schema SQL, and environment

**⚠️ Requires the human partner:** creating the Supabase project and pasting SQL into its dashboard needs their account. Prepare the files, then hand them the checklist below and wait for confirmation before Task 2's verification steps.

**Files:**
- Create: `supabase/schema.sql`
- Modify: `.env.example` (full replacement)
- Modify (untracked, local only): `.env`

**Interfaces:**
- Produces: Postgres tables `families`, `teachers`, `parents`, `children`, `child_past_teachers` (columns below) with RLS `SELECT`-for-`authenticated` policies; env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` populated in `.env`.

- [ ] **Step 1: Write `supabase/schema.sql`**

```sql
-- PTO family directory schema. Apply once via the Supabase SQL editor.
-- Idempotent: drops and recreates the directory tables.

drop table if exists child_past_teachers;
drop table if exists children;
drop table if exists parents;
drop table if exists families;
drop table if exists teachers;

create table families (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
create index families_name_idx on families (name);

create table teachers (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  -- Grade as a number; Kindergarten is stored as 0, displayed as "K".
  grade smallint not null
);
create index teachers_last_name_idx on teachers (last_name);

create table parents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  -- Address + phones are optional in the directory.
  street text,
  city text,
  state text,
  zip text,
  home_phone text,
  work_phone text,
  mobile_phone text
);
create index parents_family_id_idx on parents (family_id);
create index parents_last_name_idx on parents (last_name);

create table children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  current_teacher_id uuid references teachers (id),
  first_name text not null,
  last_name text not null,
  birth_date date not null
);
create index children_family_id_idx on children (family_id);
create index children_last_name_idx on children (last_name);

create table child_past_teachers (
  child_id uuid not null references children (id) on delete cascade,
  teacher_id uuid not null references teachers (id) on delete cascade,
  primary key (child_id, teacher_id)
);

-- Directory is readable by signed-in users only. No client-side write
-- policies exist; the seed script writes with the service-role key, which
-- bypasses RLS.
alter table families enable row level security;
alter table teachers enable row level security;
alter table parents enable row level security;
alter table children enable row level security;
alter table child_past_teachers enable row level security;

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

Note: the unnamed FK on `children.current_teacher_id` gets Postgres's default constraint name `children_current_teacher_id_fkey`. Task 4's select string references that name — do not rename it.

- [ ] **Step 2: Replace `.env.example`**

```bash
# Supabase project URL and publishable (anon) key — safe to expose; they ship
# in the client bundle. From: Dashboard → Project Settings → API Keys.
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key

# Supabase secret (service-role) key — SECRET. Bypasses RLS. Used only by
# scripts/ (server-side). Never commit the real value.
SUPABASE_SERVICE_ROLE_KEY=your-secret-key-here
```

- [ ] **Step 3: Human checklist (hand this to the user, wait for done)**

1. Create a project at https://supabase.com/dashboard (any name, e.g. `pto-demo`; free tier).
2. SQL Editor → paste the full contents of `supabase/schema.sql` → Run.
3. Authentication → Emails → template **Magic Link**: replace `{{ .ConfirmationURL }}` with `Your code is {{ .Token }}` (subject e.g. "Your PTO sign-in code"). Do the same for the **Confirm signup** template (a first-time email address may receive this one instead).
4. Project Settings → API Keys: copy the project URL, publishable/anon key, and secret/service-role key into `.env` under the three names from Step 2.
5. Heads-up: the built-in mailer allows only a couple of emails per hour — enough to test sign-in, not more. (Custom SMTP is a later, out-of-scope step.)

- [ ] **Step 4: Verify the schema applied**

In the dashboard SQL editor, run:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

Expected: `child_past_teachers`, `children`, `families`, `parents`, `teachers`.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql .env.example
git commit -m "feat: add Supabase schema and env template for migration"
```

---

### Task 2: Supabase client and auth hook

**Files:**
- Create: `src/supabase.ts`
- Create: `src/auth.ts`
- Modify: `package.json` (dependency added via pnpm)

**Interfaces:**
- Consumes: env vars from Task 1.
- Produces: `supabase` (a `SupabaseClient` singleton) from `src/supabase.ts`; `useAuth(): { isLoading: boolean; user: User | null }` from `src/auth.ts` (`User` from `@supabase/supabase-js`). Tasks 3–4 import exactly these.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add @supabase/supabase-js
```

- [ ] **Step 2: Write `src/supabase.ts`**

```ts
import { createClient } from '@supabase/supabase-js';

// Supabase project URL + publishable key, supplied via .env (see .env.example).
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Define them in .env');
}

export const supabase = createClient(url, anonKey);
```

- [ ] **Step 3: Write `src/auth.ts`**

```ts
import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

type AuthState = { isLoading: boolean; user: User | null };

/**
 * Current auth session. Resolves the persisted session on mount, then stays
 * in sync via onAuthStateChange (sign-in, sign-out, token refresh).
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ isLoading: true, user: null });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setState({ isLoading: false, user: data.session?.user ?? null });
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ isLoading: false, user: session?.user ?? null });
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return state;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm typecheck`
Expected: exit 0 (nothing imports the new files yet; Instant code is still present and still compiles).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/supabase.ts src/auth.ts
git commit -m "feat: add Supabase client and useAuth hook"
```

---

### Task 3: Switch auth flow (Login, App, AppLayout)

**Files:**
- Modify: `src/pages/Login.tsx` (full replacement below)
- Modify: `src/App.tsx:1-30` (imports + auth gate)
- Modify: `src/components/AppLayout.tsx:1-12,21-22,49-56` (imports, hook, sign-out)

**Interfaces:**
- Consumes: `useAuth()` from `src/auth.ts`, `supabase` from `src/supabase.ts` (Task 2).
- Produces: nothing new — same routes and components.

- [ ] **Step 1: Replace `src/pages/Login.tsx` entirely**

```tsx
import { useState, type FormEvent } from 'react';
import {
  Body,
  Button,
  Caption,
  Card,
  PageShell,
  SectionTitle,
  Stack,
  TextField,
} from '@apygee/atoms';
import { supabase } from '../supabase';

type Step = 'email' | 'code';

export function LoginPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSendCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    setSubmitting(false);
    if (sendError) {
      setError(sendError.message || 'Could not send the code. Check the email and try again.');
      return;
    }
    setStep('code');
  }

  async function handleVerifyCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });
    setSubmitting(false);
    if (verifyError) {
      setError(verifyError.message || 'That code did not work. Request a new one and try again.');
    }
    // On success, useAuth() in <App> flips to a signed-in user and routes away.
  }

  return (
    <PageShell width="sm">
      <Stack gap="xl">
        <Stack gap="xs">
          <Caption>PTO Demo</Caption>
          <SectionTitle>Sign in</SectionTitle>
          <Body>Email-code authentication powered by Supabase.</Body>
        </Stack>

        <Card padding="lg" surface="raised">
          {step === 'email' ? (
            <form onSubmit={handleSendCode}>
              <Stack gap="md">
                <TextField
                  label="Email"
                  name="email"
                  placeholder="you@example.com"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  error={error ?? undefined}
                  required
                />
                <Button type="submit" fullWidth disabled={submitting || !email}>
                  {submitting ? 'Sending…' : 'Send code'}
                </Button>
              </Stack>
            </form>
          ) : (
            <form onSubmit={handleVerifyCode}>
              <Stack gap="md">
                <Body>{`We sent a 6-digit code to ${email}.`}</Body>
                <TextField
                  label="Code"
                  name="code"
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                  error={error ?? undefined}
                  required
                />
                <Button type="submit" fullWidth disabled={submitting || !code}>
                  {submitting ? 'Verifying…' : 'Verify and sign in'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  fullWidth
                  disabled={submitting}
                  onClick={() => {
                    setStep('email');
                    setCode('');
                    setError(null);
                  }}
                >
                  Use a different email
                </Button>
              </Stack>
            </form>
          )}
        </Card>
      </Stack>
    </PageShell>
  );
}
```

(The old `messageOf` helper is gone — supabase-js returns structured `{ error }` objects instead of throwing.)

- [ ] **Step 2: Update `src/App.tsx`**

Replace the import of `db` and the top of the component. Old:

```tsx
import { db } from './db';
// …
export function App() {
  const { isLoading, user, error } = db.useAuth();

  if (isLoading) {
    return (
      <PageShell width="sm">
        <Stack gap="md" align="center">
          <Spinner />
        </Stack>
      </PageShell>
    );
  }

  if (error) {
    return (
      <PageShell width="sm">
        <Stack gap="md">{`Auth error: ${error.message}`}</Stack>
      </PageShell>
    );
  }
```

New (the `error` branch is dropped — `useAuth` has no error state; `onAuthStateChange` only reports sessions):

```tsx
import { useAuth } from './auth';
// …
export function App() {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <PageShell width="sm">
        <Stack gap="md" align="center">
          <Spinner />
        </Stack>
      </PageShell>
    );
  }
```

Everything from `if (!user)` down is unchanged.

- [ ] **Step 3: Update `src/components/AppLayout.tsx`**

Replace `import { db } from '../db';` with:

```tsx
import { useAuth } from '../auth';
import { supabase } from '../supabase';
```

Replace `const { user } = db.useAuth();` with `const { user } = useAuth();`, and the sign-out button's `onClick={() => db.auth.signOut()}` with `onClick={() => supabase.auth.signOut()}`.

- [ ] **Step 4: Verify compile + manual sign-in**

Run: `pnpm typecheck` — expected exit 0.
Then `pnpm dev`, open the app: you land on `/login`, enter your real email, receive a 6-digit code (check spam), verify, and land on `/directory` (which still runs on Instant until Task 4 — an empty or still-working directory is fine here; only auth is under test). Click **Sign out** in the sidebar → back to `/login`. Reload while signed in → stays signed in (session persisted).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Login.tsx src/App.tsx src/components/AppLayout.tsx
git commit -m "feat: switch auth to Supabase email OTP"
```

---

### Task 4: Switch the Directory query

**Files:**
- Modify: `src/pages/Directory.tsx` (imports, query constant, data hook, types — render code untouched)

**Interfaces:**
- Consumes: `supabase` from `src/supabase.ts` (Task 2); tables + `children_current_teacher_id_fkey` constraint name from Task 1.
- Produces: nothing — page-internal.

- [ ] **Step 1: Replace the query plumbing in `src/pages/Directory.tsx`**

Replace `import { db } from '../db';` with:

```tsx
import { useEffect } from 'react';
import { supabase } from '../supabase';
```

(keep the existing `useMemo`, `useState` imports — merge into one `react` import: `import { useEffect, useMemo, useState } from 'react';`).

Replace the `DIRECTORY_QUERY` constant with a select string. Aliases map snake_case columns back to the camelCase names the render code already uses; the two `teachers` relationships must be disambiguated — the FK-constraint hint for the to-one current teacher, the join-table hint for the many-to-many past teachers:

```tsx
// One nested query: families with parents, children, and each child's
// current + past teachers. Postgres columns are snake_case; aliases map them
// back to the camelCase names the render code uses.
const DIRECTORY_SELECT = `
  id, name,
  parents (
    id, firstName:first_name, lastName:last_name, email,
    street, city, state, zip,
    homePhone:home_phone, workPhone:work_phone, mobilePhone:mobile_phone
  ),
  children (
    id, firstName:first_name, lastName:last_name, birthDate:birth_date,
    currentTeacher:teachers!children_current_teacher_id_fkey (
      id, firstName:first_name, lastName:last_name, grade
    ),
    pastTeachers:teachers!child_past_teachers (
      id, firstName:first_name, lastName:last_name, grade
    )
  )
`;
```

In the `Child` type, change `currentTeacher?: Teacher;` to `currentTeacher?: Teacher | null;` (a to-one join with no row comes back as `null`, not `undefined`; the render code's truthiness check already handles both).

Add this hook above `DirectoryPage` and swap it in for `db.useQuery`:

```tsx
type DirectoryResult = {
  isLoading: boolean;
  error: { message: string } | null;
  families: Family[];
};

function useDirectory(): DirectoryResult {
  const [result, setResult] = useState<DirectoryResult>({
    isLoading: true,
    error: null,
    families: [],
  });

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('families')
      .select(DIRECTORY_SELECT)
      .then(({ data, error }) => {
        if (cancelled) return;
        setResult({
          isLoading: false,
          error,
          families: (data ?? []) as unknown as Family[],
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}
```

In `DirectoryPage`, replace:

```tsx
const { isLoading, error, data } = db.useQuery(DIRECTORY_QUERY);

const families = (data?.families ?? []) as Family[];
```

with:

```tsx
const { isLoading, error, families } = useDirectory();
```

Nothing else in the file changes — columns, filtering, `ParentBlock`, `ChildBlock`, and the helpers stay as they are.

- [ ] **Step 2: Verify compile**

Run: `pnpm typecheck` — expected exit 0.

- [ ] **Step 3: Verify in the browser (empty state)**

`pnpm dev`, sign in, open `/directory`. Expected before seeding: no error alert, table shows the empty state ("No families match your search…"). An error alert here means the select string or RLS policy is wrong — stop and fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Directory.tsx
git commit -m "feat: switch directory query to Supabase nested select"
```

---

### Task 5: Rewrite the seed script + RLS verification script

**Files:**
- Modify: `scripts/seed.ts` (full replacement below)
- Create: `scripts/verify-rls.ts`
- Modify: `package.json` (add `verify:rls` script)

**Interfaces:**
- Consumes: tables from Task 1; `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from `.env`.
- Produces: seeded data (50 families, 18 teachers, parents, children, past-teacher links); `pnpm seed` and `pnpm verify:rls` commands.

- [ ] **Step 1: Replace `scripts/seed.ts` entirely**

The name pools, random helpers, and distribution rules are identical to the old script; only the persistence layer changes (bulk inserts with client-generated UUIDs instead of per-family `transact`).

```ts
/**
 * Seed the PTO family directory with example data.
 *
 * Usage:  pnpm seed
 *
 * Idempotent: deletes all existing families/parents/children/teachers first,
 * then recreates a fresh random sample. Safe to re-run.
 *
 * Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
 * The service-role key bypasses RLS — this script must never run client-side.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const FAMILY_COUNT = 50;

const LAST_NAMES = [
  'Donwin', 'Anderson', 'Patel', 'Nguyen', 'Garcia', 'Kim', 'O\'Brien', 'Rossi',
  'Schmidt', 'Lopez', 'Cohen', 'Murphy', 'Tanaka', 'Silva', 'Khan', 'Müller',
  'Johnson', 'Williams', 'Brown', 'Jones', 'Davis', 'Martinez', 'Hernandez',
  'Wilson', 'Moore', 'Taylor', 'Thomas', 'Jackson', 'White', 'Harris', 'Clark',
  'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'Wright', 'Scott', 'Torres',
  'Reyes', 'Chen', 'Park', 'Singh', 'Okafor', 'Abebe', 'Novak', 'Haddad',
  'Petrov', 'Andersson', 'Costa',
];

const FIRST_NAMES = [
  'Emily', 'Simon', 'Olivia', 'Liam', 'Noah', 'Ava', 'Sophia', 'Mason',
  'Isabella', 'Lucas', 'Mia', 'Ethan', 'Amelia', 'James', 'Harper', 'Benjamin',
  'Evelyn', 'Henry', 'Abigail', 'Alexander', 'Ella', 'Daniel', 'Scarlett',
  'Michael', 'Grace', 'Jack', 'Chloe', 'David', 'Zoe', 'Samuel', 'Nina',
  'Leo', 'Aria', 'Owen', 'Lily', 'Gabriel', 'Hannah', 'Julian', 'Layla', 'Aaron',
];

const STREETS = [
  'Liberty Ave', 'Maple St', 'Oak Ln', 'Washington Rd', 'Bedford St', 'Concord Ave',
  'Marrett Rd', 'Pleasant St', 'Hancock St', 'Forest St', 'Cedar Way', 'Birch Rd',
];

const TEACHER_LAST = [
  'Anderson', 'Bennett', 'Carter', 'Diaz', 'Evans', 'Foster', 'Green', 'Hughes',
  'Irwin', 'Jensen', 'Kelly', 'Lambert', 'Morgan', 'Nash', 'Owens', 'Price',
  'Quinn', 'Reed',
];
const TEACHER_FIRST = [
  'Bev', 'Carol', 'Dan', 'Ellen', 'Frank', 'Gina', 'Hank', 'Iris',
  'Joan', 'Karl', 'Lena', 'Marcus', 'Nora', 'Otto', 'Paula', 'Rex', 'Sue', 'Tom',
];

// --- random helpers (no external deps) ---------------------------------------
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(arr: T[]): T => arr[rand(arr.length)]!;
const chance = (p: number) => Math.random() < p;

// Pick a value from arr that is not equal to `exclude`.
function pickDifferent<T>(arr: T[], exclude: T): T {
  let choice = pick(arr);
  while (choice === exclude) choice = pick(arr);
  return choice;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function phone(): string {
  const part = () => String(100 + rand(900));
  return `(${part()}) ${part()}-${1000 + rand(9000)}`;
}

// Random ISO birth date for a child roughly age 4–12 (relative to mid-2026).
function birthDate(): string {
  const year = 2014 + rand(9); // 2014..2022
  const month = 1 + rand(12);
  const day = 1 + rand(28);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

// --- persistence helpers ------------------------------------------------------
async function clearTable(table: string, keyColumn: string) {
  const { error, count } = await db
    .from(table)
    .delete({ count: 'exact' })
    .not(keyColumn, 'is', null); // supabase-js requires a filter on delete
  if (error) throw new Error(`Failed to clear ${table}: ${error.message}`);
  return count ?? 0;
}

async function insertAll(table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`Failed to insert into ${table}: ${error.message}`);
  }
}

async function main() {
  console.log('Clearing existing directory data…');
  // Children/parents cascade from families, but clear explicitly so counts print.
  for (const [table, key] of [
    ['child_past_teachers', 'child_id'],
    ['children', 'id'],
    ['parents', 'id'],
    ['families', 'id'],
    ['teachers', 'id'],
  ] as const) {
    const n = await clearTable(table, key);
    console.log(`  deleted ${n} ${table}`);
  }

  // --- Teachers: 3 per grade, K–5 -------------------------------------------
  const teacherNames = shuffle(
    TEACHER_LAST.flatMap((last) => TEACHER_FIRST.map((first) => ({ first, last }))),
  );
  const teachers: { id: string; grade: number }[] = [];
  const teacherRows: Record<string, unknown>[] = [];
  let nameIdx = 0;
  for (let grade = 0; grade <= 5; grade++) {
    for (let k = 0; k < 3; k++) {
      const tid = randomUUID();
      const nm = teacherNames[nameIdx++]!;
      teachers.push({ id: tid, grade });
      teacherRows.push({ id: tid, first_name: nm.first, last_name: nm.last, grade });
    }
  }
  await insertAll('teachers', teacherRows);
  console.log(`Created ${teachers.length} teachers (grades K–5).`);

  const teachersByGrade = (g: number) => teachers.filter((t) => t.grade === g);

  // --- Families --------------------------------------------------------------
  const familyRows: Record<string, unknown>[] = [];
  const parentRows: Record<string, unknown>[] = [];
  const childRows: Record<string, unknown>[] = [];
  const pastTeacherRows: Record<string, unknown>[] = [];

  for (let f = 0; f < FAMILY_COUNT; f++) {
    const familyId = randomUUID();
    const familyName = pick(LAST_NAMES);
    familyRows.push({ id: familyId, name: familyName });

    // The first 10 families have a second parent with a different last name
    // (parents don't always share a surname). Those families always get 2 parents.
    const differentSecondSurname = f < 10;

    // 1–2 parents, biased toward 2.
    const numParents = differentSecondSurname || chance(0.75) ? 2 : 1;
    const street = `${1000 + rand(8000)} ${pick(STREETS)}`;
    for (let p = 0; p < numParents; p++) {
      const first = pick(FIRST_NAMES);
      // Second parent of a mixed-surname family gets a different last name.
      const last =
        differentSecondSurname && p === 1 ? pickDifferent(LAST_NAMES, familyName) : familyName;
      const emailLast = last.toLowerCase().replace(/[^a-z]/g, '');
      const hasAddress = chance(0.7);
      parentRows.push({
        id: randomUUID(),
        family_id: familyId,
        first_name: first,
        last_name: last,
        email: `${first.toLowerCase()}.${emailLast}@example.com`,
        // Address/phones are optional — only sometimes present.
        ...(hasAddress ? { street, city: 'Lexington', state: 'MA', zip: '02421' } : {}),
        ...(chance(0.6) ? { home_phone: phone() } : {}),
        ...(chance(0.5) ? { mobile_phone: phone() } : {}),
        ...(chance(0.3) ? { work_phone: phone() } : {}),
      });
    }

    // 1–4 children.
    const numChildren = 1 + rand(4);
    for (let c = 0; c < numChildren; c++) {
      const childId = randomUUID();
      const currentGrade = rand(6); // 0–5
      const current = pick(teachersByGrade(currentGrade));

      // Past teachers: from grades below the current one, 0–3 of them.
      const lowerGradeTeachers = teachers.filter((t) => t.grade < currentGrade);
      const past = shuffle(lowerGradeTeachers).slice(
        0,
        Math.min(rand(4), lowerGradeTeachers.length),
      );

      childRows.push({
        id: childId,
        family_id: familyId,
        current_teacher_id: current.id,
        first_name: pick(FIRST_NAMES),
        last_name: familyName,
        birth_date: birthDate(),
      });
      for (const t of past) {
        pastTeacherRows.push({ child_id: childId, teacher_id: t.id });
      }
    }
  }

  // Insert in FK order: families before parents/children, children before links.
  await insertAll('families', familyRows);
  await insertAll('parents', parentRows);
  await insertAll('children', childRows);
  await insertAll('child_past_teachers', pastTeacherRows);

  console.log(
    `Seeded ${familyRows.length} families, ${parentRows.length} parents, ${childRows.length} children.`,
  );
  console.log('Done.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Write `scripts/verify-rls.ts`**

This is the migration's automated check: the anon key (no session) must see zero rows; the service-role key must see the seeded data.

```ts
/**
 * Verify RLS: unauthenticated (anon key, no session) reads must return zero
 * rows; the service-role key must see the seeded data.
 *
 * Usage:  pnpm verify:rls   (run after pnpm seed)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env',
  );
}

const anonDb = createClient(url, anonKey, { auth: { persistSession: false } });
const adminDb = createClient(url, serviceKey, { auth: { persistSession: false } });

const TABLES = ['families', 'parents', 'children', 'teachers', 'child_past_teachers'];

async function countRows(client: ReturnType<typeof createClient>, table: string) {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`Count failed for ${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  let failed = false;

  for (const table of TABLES) {
    const anonCount = await countRows(anonDb, table);
    const adminCount = await countRows(adminDb, table);

    const anonOk = anonCount === 0;
    const adminOk = adminCount > 0;
    if (!anonOk || !adminOk) failed = true;

    console.log(
      `${anonOk && adminOk ? 'PASS' : 'FAIL'}  ${table}: anon sees ${anonCount} (want 0), ` +
        `service role sees ${adminCount} (want > 0)`,
    );
  }

  if (failed) {
    console.error('RLS verification FAILED.');
    process.exit(1);
  }
  console.log('RLS verification passed.');
}

main().catch((err) => {
  console.error('verify-rls failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the script to `package.json`**

In `"scripts"`, after `"seed"`:

```json
"verify:rls": "tsx scripts/verify-rls.ts"
```

- [ ] **Step 4: Run and verify**

```bash
pnpm typecheck   # expected: exit 0
pnpm seed        # expected: "Seeded 50 families, … parents, … children." then "Done."
pnpm seed        # run twice — idempotency: deletes then re-creates, same counts shape
pnpm verify:rls  # expected: PASS for all 5 tables, "RLS verification passed."
```

Then in the browser (`pnpm dev`, signed in): `/directory` shows 50 families with parents, children, ages, current teacher with grade (K for 0), and past teachers. Search filters by family, parent, and child names.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed.ts scripts/verify-rls.ts package.json
git commit -m "feat: rewrite seed script for Supabase, add RLS verification"
```

---

### Task 6: Remove InstantDB entirely

**Files:**
- Delete: `src/db.ts`, `src/instant.schema.ts`, `src/instant.perms.ts`
- Modify: `package.json` (deps removed via pnpm)

**Interfaces:**
- Consumes: Tasks 3–5 having removed every import of `../db`, `./db`, and `../src/instant.schema`.
- Produces: a repo with zero InstantDB references.

- [ ] **Step 1: Confirm nothing imports Instant anymore**

```bash
grep -rn "instantdb\|instant.schema\|instant.perms\|from './db'\|from '../db'" src scripts index.html vite.config.ts
```

Expected: no matches (if any appear, fix that file first — it was missed in Tasks 3–5).

- [ ] **Step 2: Delete files and dependencies**

```bash
git rm src/db.ts src/instant.schema.ts src/instant.perms.ts
pnpm remove @instantdb/react @instantdb/admin
```

- [ ] **Step 3: Full verification**

```bash
pnpm typecheck   # expected: exit 0
pnpm build       # expected: tsc + vite build succeed
pnpm verify:rls  # expected: still passes
```

Manual smoke test (`pnpm dev`): sign out → sign in with email code → directory renders 50 families → search works → sign out.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat: remove InstantDB dependencies and schema files"
```
