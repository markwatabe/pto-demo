# Volunteers, CORI, Admins, and Green Team Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add volunteer flags and admin-only CORI status to the family directory, introduce admins with a management page, and render seeded Green Team lunch shifts (11:30–12:30, 12:30–1:30 every weekday) on the calendar page.

**Architecture:** InstantDB schema gains two booleans on `parents` plus three entities — `coriRecords` (admin-only via entity-level permission rules, since Instant has no field-level rules), `adminRoles` (linked to `$users`; existence of a link = admin), and `greenTeamShifts` (linked to volunteer parents). First-ever permission rules lock all writes to admins. UI: badges + admin-only CORI captions in the directory, a guarded `/admin` page for managing admins/volunteers/CORI, and the `@apygee/calendar` `Calendar` component on the calendar page fed by seeded shifts.

**Tech Stack:** React 19, InstantDB (`@instantdb/react` client, `@instantdb/admin` for seed), `@apygee/atoms` / `@apygee/data-table` / `@apygee/calendar` workspace packages, Vite, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-27-volunteers-cori-admins-design.md`

## Global Constraints

- No test framework exists in this repo; per the spec, verification is `pnpm typecheck` plus manual checks. Every task must end with a passing `pnpm typecheck`.
- Kindergarten grade is stored as `0`, displayed as `"K"` (existing convention).
- Shift slots are exactly the strings `"11:30"` and `"12:30"`; every shift is one hour.
- CORI data must never be readable by non-admins — enforced by `coriRecords` permission rules, not UI.
- Seed leaves `adminRoles` and `$users` untouched so admin grants survive reseeding.
- Admin bootstrap email env var: `SEED_ADMIN_EMAIL`, default `m.watabe@gmail.com`.
- Pushing schema/perms uses `npx instant-cli@latest push schema` / `push perms` from the repo root. If the CLI cannot infer the app, add `--app <value of VITE_INSTANT_APP_ID from .env>`. These commands require the developer to be logged in to instant-cli; if a push fails with an auth error, stop and ask the user to run `npx instant-cli@latest login`.
- Commit messages follow existing style (imperative, no scope prefix required) and end with the Claude co-author trailer.

---

### Task 0: Commit the untracked baseline app

The repo currently has only the two spec commits; all app source is untracked. Later tasks commit specific files, so the baseline must land first.

**Files:**
- Modify: none (git only)

- [ ] **Step 1: Commit everything currently untracked**

```bash
cd /Users/markwatabe/code/pto-demo
git add -A
git commit -m "Add baseline PTO demo app

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Verify clean tree**

Run: `git status --short`
Expected: no output (clean tree).

---

### Task 1: Add `@apygee/calendar` and `@apygee/types` workspace dependencies

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

**Interfaces:**
- Produces: `import { Calendar } from '@apygee/calendar'` and `import type { CalendarEvent } from '@apygee/types'` resolve for Task 8.

- [ ] **Step 1: Add the packages to `pnpm-workspace.yaml`**

The `packages:` list currently ends with `- '../components/packages/data-table'`. Add two lines so it reads:

```yaml
packages:
  - '.'
  # Consume the @apygee component library from the sibling monorepo as
  # workspace packages. Their dist/ output is already built.
  - '../components/packages/atoms'
  - '../components/packages/core'
  - '../components/packages/types'
  - '../components/packages/data-table'
  - '../components/packages/calendar'
```

(`types` is already listed; only `calendar` is new there. Keep the `allowBuilds` block unchanged.)

- [ ] **Step 2: Add dependencies to `package.json`**

In `dependencies`, alongside the other `@apygee/*` entries, add:

```json
    "@apygee/calendar": "workspace:*",
    "@apygee/types": "workspace:*",
```

- [ ] **Step 3: Install and typecheck**

```bash
pnpm install
pnpm typecheck
```

Expected: install succeeds resolving both as workspace links; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "Add @apygee/calendar and @apygee/types workspace deps

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema — volunteer flags, coriRecords, adminRoles, greenTeamShifts

**Files:**
- Modify: `src/instant.schema.ts`

**Interfaces:**
- Produces (used by every later task):
  - `parents` fields `greenTeamVolunteer?: boolean`, `classroomVolunteer?: boolean`
  - entity `coriRecords { onFile: boolean; expiresOn?: string }`, link label `cori` on parents / `parent` on coriRecords
  - entity `adminRoles { email: string; grantedAt: string }`, link label `user` on adminRoles / `adminRole` on `$users`
  - entity `greenTeamShifts { date: string; slot: string }`, link label `volunteers` on shifts / `shifts` on parents

- [ ] **Step 1: Add the fields and entities**

In `src/instant.schema.ts`, replace the `parents` entity definition with:

```ts
    parents: i.entity({
      firstName: i.string(),
      lastName: i.string().indexed(),
      email: i.string(), // required
      // Address + phones are optional in the directory.
      street: i.string().optional(),
      city: i.string().optional(),
      state: i.string().optional(),
      zip: i.string().optional(),
      homePhone: i.string().optional(),
      workPhone: i.string().optional(),
      mobilePhone: i.string().optional(),
      // Volunteer roles, visible to all signed-in users.
      greenTeamVolunteer: i.boolean().optional(),
      classroomVolunteer: i.boolean().optional(),
    }),
```

After the `teachers` entity, add three entities:

```ts
    // CORI (background check) status. Lives in its own entity because Instant
    // permissions are per-entity: only admins may view coriRecords.
    coriRecords: i.entity({
      onFile: i.boolean(),
      // ISO date; absent means no known expiration.
      expiresOn: i.string().optional(),
    }),
    // A user is an admin iff an adminRoles record links to their $users record.
    adminRoles: i.entity({
      email: i.string().unique().indexed(),
      grantedAt: i.string(),
    }),
    // Green Team lunch shifts: two per school day, "11:30" and "12:30",
    // each one hour long.
    greenTeamShifts: i.entity({
      date: i.string().indexed(), // ISO date, e.g. "2026-07-27"
      slot: i.string(), // "11:30" | "12:30"
    }),
```

- [ ] **Step 2: Add the links**

In the `links` section, after `childPastTeachers`, add:

```ts
    // Each parent has at most one CORI record; it dies with the parent.
    parentCori: {
      forward: { on: "parents", has: "one", label: "cori" },
      reverse: { on: "coriRecords", has: "one", label: "parent", onDelete: "cascade" },
    },
    // Admin grant, keyed to the authed $users record. Deleting the user
    // removes the grant.
    adminRoleUser: {
      forward: { on: "adminRoles", has: "one", label: "user", onDelete: "cascade" },
      reverse: { on: "$users", has: "one", label: "adminRole" },
    },
    // Up to 2 volunteers per shift in practice (seed enforces; schema doesn't).
    shiftVolunteers: {
      forward: { on: "greenTeamShifts", has: "many", label: "volunteers" },
      reverse: { on: "parents", has: "many", label: "shifts" },
    },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 4: Push the schema to InstantDB**

```bash
npx instant-cli@latest push schema
```

Expected: CLI lists the new attrs/links (parents.greenTeamVolunteer, parents.classroomVolunteer, coriRecords, adminRoles, greenTeamShifts, and the three links) and completes. If it cannot find the app id, re-run with `--app <VITE_INSTANT_APP_ID>`. If it fails on auth, stop and ask the user to run `npx instant-cli@latest login`.

- [ ] **Step 5: Commit**

```bash
git add src/instant.schema.ts
git commit -m "Add volunteer flags, coriRecords, adminRoles, greenTeamShifts to schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Permission rules — admin-gated writes, admin-only CORI

**Files:**
- Modify: `src/instant.perms.ts`

**Interfaces:**
- Produces: database-enforced behavior every UI task relies on — non-admin queries for `coriRecords`/`adminRoles` return empty; only admins can write.

- [ ] **Step 1: Replace `src/instant.perms.ts` with the full rule set**

```ts
// Docs: https://www.instantdb.com/docs/permissions

import type { InstantRules } from "@instantdb/react";

// A user is an admin iff an adminRoles record links to their $users record.
// auth.ref returns a list; non-empty means the link exists.
const IS_ADMIN = "auth.id != null && auth.ref('$user.adminRole.id') != []";
const IS_SIGNED_IN = "auth.id != null";

// Directory entities: any signed-in user may read, only admins may write.
const directoryEntity = {
  allow: {
    view: IS_SIGNED_IN,
    create: "isAdmin",
    update: "isAdmin",
    delete: "isAdmin",
  },
  bind: ["isAdmin", IS_ADMIN],
} as const;

const rules = {
  families: directoryEntity,
  parents: directoryEntity,
  children: directoryEntity,
  teachers: directoryEntity,
  greenTeamShifts: directoryEntity,

  // CORI status is admin-only, including view. Non-admins querying the
  // parents.cori link silently get nothing back.
  coriRecords: {
    allow: {
      view: "isAdmin",
      create: "isAdmin",
      update: "isAdmin",
      delete: "isAdmin",
    },
    bind: ["isAdmin", IS_ADMIN],
  },

  // Grant/revoke only — no in-place edits. A non-admin's "am I an admin?"
  // query correctly returns empty.
  adminRoles: {
    allow: {
      view: "isAdmin",
      create: "isAdmin",
      update: "false",
      delete: "isAdmin",
    },
    bind: ["isAdmin", IS_ADMIN],
  },

  // Users can see themselves; admins can look up users by email to grant
  // admin. Instant already restricts $users writes; make it explicit.
  $users: {
    allow: {
      view: "auth.id == data.id || isAdmin",
      create: "false",
      update: "false",
      delete: "false",
    },
    bind: ["isAdmin", IS_ADMIN],
  },
} satisfies InstantRules;

export default rules;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes. (If `bind` tuple types complain, the Instant-documented shape is `bind: ["name", "expr"]` — flat array of name/expression pairs; keep that shape and adjust the `as const` if needed.)

- [ ] **Step 3: Push the perms to InstantDB**

```bash
npx instant-cli@latest push perms
```

Expected: CLI shows the new rules and completes.

- [ ] **Step 4: Commit**

```bash
git add src/instant.perms.ts
git commit -m "Lock writes to admins and make coriRecords admin-only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Seed — volunteer flags, CORI records, Green Team shifts, admin bootstrap

**Files:**
- Modify: `scripts/seed.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: schema from Task 2 (entity/link names exactly as defined there).
- Produces: seeded data every UI task renders; `SEED_ADMIN_EMAIL` bootstrap admin.

- [ ] **Step 1: Extend `deleteAll` and the clearing loop**

In `scripts/seed.ts`, change the `deleteAll` signature and the loop in `main()`:

```ts
async function deleteAll(
  entity: 'families' | 'parents' | 'children' | 'teachers' | 'coriRecords' | 'greenTeamShifts',
) {
```

```ts
  console.log('Clearing existing directory data…');
  // adminRoles and $users are deliberately NOT cleared: admin grants survive reseeding.
  for (const entity of [
    'greenTeamShifts',
    'coriRecords',
    'children',
    'parents',
    'families',
    'teachers',
  ] as const) {
    const n = await deleteAll(entity);
    console.log(`  deleted ${n} ${entity}`);
  }
```

(`greenTeamShifts` and `coriRecords` go first so links to parents are gone before parents are deleted.)

- [ ] **Step 2: Track created parents**

Above the family loop (next to `let parentCount = 0;`), add:

```ts
  const allParents: { id: string; firstName: string; lastName: string }[] = [];
```

Inside the parent-creation loop, right after `parentCount++;`, add:

```ts
      allParents.push({ id: pid, firstName: first, lastName: last });
```

- [ ] **Step 3: Add date helpers**

Next to the existing `birthDate()` helper, add:

```ts
// ISO date (YYYY-MM-DD) for a Date, local time.
function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A date `days` from today (negative = past), as ISO.
function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}
```

- [ ] **Step 4: Assign volunteer flags after the family loop**

After the family loop (after its closing `}`, before the final `console.log`), add:

```ts
  // --- Volunteer flags --------------------------------------------------------
  // At least 20 green-team parents so the shift schedule has a workable pool.
  const greenCount = Math.max(20, Math.round(allParents.length * 0.25));
  const greenTeam = shuffle(allParents).slice(0, greenCount);
  const classroom = allParents.filter(() => chance(0.35));
  await db.transact([
    ...greenTeam.map((p) => db.tx.parents![p.id]!.update({ greenTeamVolunteer: true })),
    ...classroom.map((p) => db.tx.parents![p.id]!.update({ classroomVolunteer: true })),
  ]);
  console.log(`Flagged ${greenTeam.length} green team, ${classroom.length} classroom volunteers.`);
```

- [ ] **Step 5: Seed CORI records**

Immediately after the volunteer-flags block, add:

```ts
  // --- CORI records (admin-only in the app) -----------------------------------
  const coriTxs = [];
  for (const p of allParents) {
    if (!chance(0.4)) continue;
    const r = Math.random();
    // 70% valid (expires up to ~2 years out), 20% expired, 10% no date.
    const expiresOn =
      r < 0.7 ? daysFromToday(30 + rand(700)) : r < 0.9 ? daysFromToday(-(30 + rand(400))) : undefined;
    coriTxs.push(
      db.tx.coriRecords![id()]!
        .update({ onFile: true, ...(expiresOn ? { expiresOn } : {}) })
        .link({ parent: p.id }),
    );
  }
  await db.transact(coriTxs);
  console.log(`Created ${coriTxs.length} CORI records.`);
```

- [ ] **Step 6: Seed Green Team shifts**

Immediately after the CORI block, add:

```ts
  // --- Green Team lunch shifts ------------------------------------------------
  // Two 1-hour shifts per weekday ("11:30" and "12:30"), from 4 weeks back to
  // 8 weeks ahead. Demo data: ignores the real school calendar.
  const SLOTS = ['11:30', '12:30'] as const;
  const shiftTxs: any[] = [];
  let shiftCount = 0;
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 28);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 56);
  for (; cursor <= endDate; cursor.setDate(cursor.getDate() + 1)) {
    const dow = cursor.getDay();
    if (dow === 0 || dow === 6) continue; // weekends
    const date = isoDate(cursor);
    // ~25% of days, one volunteer covers both slots.
    const doubleShifter = chance(0.25) ? pick(greenTeam) : null;
    for (const slot of SLOTS) {
      const volunteers = new Set<string>();
      if (doubleShifter) volunteers.add(doubleShifter.id);
      const target = chance(0.8) ? 2 : 1; // ~20% of shifts have a single volunteer
      while (volunteers.size < target) volunteers.add(pick(greenTeam).id);
      shiftTxs.push(
        db.tx.greenTeamShifts![id()]!
          .update({ date, slot })
          .link({ volunteers: [...volunteers] }),
      );
      shiftCount++;
    }
  }
  // Transact in chunks to keep payloads small.
  for (let iChunk = 0; iChunk < shiftTxs.length; iChunk += 40) {
    await db.transact(shiftTxs.slice(iChunk, iChunk + 40));
  }
  console.log(`Created ${shiftCount} green team shifts.`);
```

- [ ] **Step 7: Bootstrap the first admin**

Immediately after the shifts block (still inside `main()`, before the final `console.log('Done.')`), add:

```ts
  // --- Admin bootstrap --------------------------------------------------------
  // Ensures there is always a way into the admin UI. createToken creates the
  // $users record if that email has never signed in.
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'm.watabe@gmail.com').toLowerCase();
  await db.auth.createToken(adminEmail);
  const adminUser = await db.auth.getUser({ email: adminEmail });
  const existing = await db.query({ adminRoles: { $: { where: { email: adminEmail } } } });
  if ((existing.adminRoles ?? []).length === 0) {
    await db.transact(
      db.tx.adminRoles![id()]!
        .update({ email: adminEmail, grantedAt: new Date().toISOString() })
        .link({ user: adminUser.id }),
    );
    console.log(`Granted admin to ${adminEmail}.`);
  } else {
    console.log(`${adminEmail} is already an admin.`);
  }
```

- [ ] **Step 8: Document `SEED_ADMIN_EMAIL` in `.env.example`**

Append to `.env.example`:

```bash

# Email granted admin by scripts/seed.ts (created in $users if needed).
SEED_ADMIN_EMAIL=m.watabe@gmail.com
```

- [ ] **Step 9: Typecheck and run the seed**

```bash
pnpm typecheck
pnpm seed
```

Expected output includes: deleted counts for all six entities, `Flagged N green team` (N ≥ 20), `Created N CORI records` (~35), `Created ~120 green team shifts`, and either `Granted admin to …` or `… is already an admin`, then `Done.`

- [ ] **Step 10: Commit**

```bash
git add scripts/seed.ts .env.example
git commit -m "Seed volunteer flags, CORI records, green team shifts, and bootstrap admin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `useIsAdmin` hook, Admin route scaffold, nav item

**Files:**
- Create: `src/hooks/useIsAdmin.ts`
- Create: `src/pages/Admin.tsx` (guarded placeholder; filled in by Tasks 6–7)
- Modify: `src/App.tsx`
- Modify: `src/components/AppLayout.tsx`

**Interfaces:**
- Produces: `useIsAdmin(): { isAdmin: boolean; isLoading: boolean }` — consumed by AppLayout and Admin page. `AdminPage` component exported from `src/pages/Admin.tsx`, routed at `/admin`.

- [ ] **Step 1: Create `src/hooks/useIsAdmin.ts`**

```ts
import { db } from '../db';

/**
 * Whether the signed-in user is an admin (an adminRoles record links to them).
 * Non-admins get an empty result from this query thanks to the adminRoles
 * view rule, so `isAdmin` is false for them without any special-casing.
 */
export function useIsAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const { user } = db.useAuth();
  const { isLoading, data } = db.useQuery(
    user ? { adminRoles: { $: { where: { 'user.id': user.id } } } } : null,
  );
  return { isAdmin: (data?.adminRoles?.length ?? 0) > 0, isLoading };
}
```

- [ ] **Step 2: Create `src/pages/Admin.tsx` as a guarded placeholder**

```tsx
import { Navigate } from 'react-router';
import { PageHeader, PageShell, Spinner, Stack } from '@apygee/atoms';
import { useIsAdmin } from '../hooks/useIsAdmin';

export function AdminPage() {
  const { isAdmin, isLoading } = useIsAdmin();

  if (isLoading) {
    return (
      <PageShell width="xl">
        <Stack gap="md" align="center">
          <Spinner />
        </Stack>
      </PageShell>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/directory" replace />;
  }

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="PTO"
          title="Admin"
          description="Manage admins, volunteer roles, and CORI status."
        />
      </Stack>
    </PageShell>
  );
}
```

- [ ] **Step 3: Route it in `src/App.tsx`**

Add the import:

```tsx
import { AdminPage } from './pages/Admin';
```

Add the route inside the `<Route element={<AppLayout />}>` block, after the `/our-pto` route:

```tsx
        <Route path="/admin" element={<AdminPage />} />
```

- [ ] **Step 4: Show the nav item only to admins in `src/components/AppLayout.tsx`**

Add the import:

```tsx
import { useIsAdmin } from '../hooks/useIsAdmin';
```

In `AppLayout`, after `const { user } = db.useAuth();`, add:

```tsx
  const { isAdmin } = useIsAdmin();
  const navItems = isAdmin ? [...NAV_ITEMS, { to: '/admin', label: 'Admin' }] : [...NAV_ITEMS];
```

Change the nav render loop to use `navItems`:

```tsx
              {navItems.map((item) => (
                <NavLink key={item.to} to={item.to} end>
                  {item.label}
                </NavLink>
              ))}
```

- [ ] **Step 5: Typecheck and manually verify**

```bash
pnpm typecheck
pnpm dev
```

Expected: typecheck passes. In the browser, signed in as the bootstrap admin (`SEED_ADMIN_EMAIL`), the sidebar shows "Admin" and `/admin` renders the header. In a private window signed in as any other email, no "Admin" nav item and `/admin` redirects to `/directory`.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useIsAdmin.ts src/pages/Admin.tsx src/App.tsx src/components/AppLayout.tsx
git commit -m "Add useIsAdmin hook and guarded /admin route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Admin page — Admins section (grant/revoke)

**Files:**
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `useIsAdmin` (Task 5), `adminRoles`/`$users` perms (Task 3).
- Produces: complete admins management UI; `messageOf` helper reused by Task 7.

- [ ] **Step 1: Replace `src/pages/Admin.tsx` with the version including the Admins card**

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import {
  Alert,
  Body,
  Button,
  Caption,
  Card,
  Inline,
  PageHeader,
  PageShell,
  SectionTitle,
  Spinner,
  Stack,
  Strong,
  TextField,
} from '@apygee/atoms';
import { id } from '@instantdb/react';
import { db } from '../db';
import { useIsAdmin } from '../hooks/useIsAdmin';

const ADMINS_QUERY = { adminRoles: { user: {} } } as const;

type AdminRole = {
  id: string;
  email: string;
  grantedAt: string;
  user?: { id: string; email?: string };
};

export function AdminPage() {
  const { isAdmin, isLoading } = useIsAdmin();

  if (isLoading) {
    return (
      <PageShell width="xl">
        <Stack gap="md" align="center">
          <Spinner />
        </Stack>
      </PageShell>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/directory" replace />;
  }

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="PTO"
          title="Admin"
          description="Manage admins, volunteer roles, and CORI status."
        />
        <AdminsCard />
      </Stack>
    </PageShell>
  );
}

function AdminsCard() {
  const { user } = db.useAuth();
  const { isLoading, error, data } = db.useQuery(ADMINS_QUERY);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantError, setGrantError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  // Two-click revoke: first click arms, second click executes.
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

  const admins = ((data?.adminRoles ?? []) as AdminRole[])
    .slice()
    .sort((a, b) => a.email.localeCompare(b.email));

  async function handleGrant(event: FormEvent) {
    event.preventDefault();
    setGrantError(null);
    const email = grantEmail.trim().toLowerCase();
    if (admins.some((a) => a.email === email)) {
      setGrantError('That person is already an admin.');
      return;
    }
    setGranting(true);
    try {
      const res = await db.queryOnce({ $users: { $: { where: { email } } } });
      const target = res.data.$users?.[0];
      if (!target) {
        setGrantError("That person hasn't signed in yet — ask them to sign in once first.");
        return;
      }
      await db.transact(
        db.tx.adminRoles[id()]!
          .update({ email, grantedAt: new Date().toISOString() })
          .link({ user: target.id }),
      );
      setGrantEmail('');
    } catch (err) {
      setGrantError(messageOf(err) ?? 'Could not grant admin.');
    } finally {
      setGranting(false);
    }
  }

  function handleRevoke(role: AdminRole) {
    if (confirmingRevokeId !== role.id) {
      setConfirmingRevokeId(role.id);
      return;
    }
    setConfirmingRevokeId(null);
    db.transact(db.tx.adminRoles[role.id]!.delete());
  }

  return (
    <Card padding="lg" surface="raised">
      <Stack gap="lg">
        <SectionTitle>Admins</SectionTitle>

        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert tone="danger" title="Could not load admins" description={error.message} />
        ) : (
          <Stack gap="md">
            {admins.map((role) => (
              <Inline key={role.id} gap="md" align="center" wrap>
                <Stack gap="xs">
                  <Strong>{role.email}</Strong>
                  <Caption>{`Granted ${new Date(role.grantedAt).toLocaleDateString()}${
                    role.email === user?.email ? ' · you' : ''
                  }`}</Caption>
                </Stack>
                <Button
                  variant={confirmingRevokeId === role.id ? 'danger' : 'secondary'}
                  onClick={() => handleRevoke(role)}
                >
                  {confirmingRevokeId === role.id ? 'Confirm revoke' : 'Revoke'}
                </Button>
              </Inline>
            ))}
            {admins.length === 0 ? <Body>No admins yet.</Body> : null}
          </Stack>
        )}

        <form onSubmit={handleGrant}>
          <Stack gap="md">
            <TextField
              label="Grant admin by email"
              name="grant-email"
              placeholder="parent@example.com"
              inputMode="email"
              value={grantEmail}
              onChange={(e) => setGrantEmail(e.currentTarget.value)}
              error={grantError ?? undefined}
              description="They must have signed in at least once."
            />
            <Inline gap="md">
              <Button type="submit" disabled={granting || !grantEmail.trim()}>
                {granting ? 'Granting…' : 'Grant admin'}
              </Button>
            </Inline>
          </Stack>
        </form>
      </Stack>
    </Card>
  );
}

function messageOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const body = (err as { body?: { message?: string } }).body;
    if (body?.message) return body.message;
    const message = (err as { message?: string }).message;
    if (message) return message;
  }
  return undefined;
}
```

Note: if `db.tx.adminRoles[id()]!` upsets the typechecker over the non-null assertion placement, the existing seed script uses `db.tx.adminRoles![id()]!` — mirror whichever form typechecks; the client SDK's `db.tx` proxy accepts both at runtime. If the Button `variant="danger"` doesn't exist in atoms, use `variant="secondary"` for both states (check `ButtonProps` in `@apygee/types` — use only variants it declares).

- [ ] **Step 2: Typecheck and manually verify**

```bash
pnpm typecheck
pnpm dev
```

Expected: as the bootstrap admin, `/admin` lists that account under Admins. Granting a nonsense email shows the "hasn't signed in yet" error. Granting the email of a second account that HAS signed in adds it to the list live; Revoke → Confirm revoke removes it.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "Add admins management (grant/revoke) to admin page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Admin page — Volunteers & CORI section

**Files:**
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: schema link labels `cori`/`parent` (Task 2), `messageOf` (Task 6).
- Produces: admin editing for `greenTeamVolunteer`, `classroomVolunteer`, and `coriRecords`.

- [ ] **Step 1: Add the Volunteers & CORI card to `src/pages/Admin.tsx`**

Add imports (merge into the existing import statements):

```tsx
import { useMemo } from 'react';
import { Checkbox, Switch } from '@apygee/atoms';
import { DataTable, type DataTableColumnDef } from '@apygee/data-table';
```

Add types and query near `ADMINS_QUERY`:

```tsx
const PARENTS_QUERY = {
  parents: { family: {}, cori: {} },
} as const;

type Cori = { id: string; onFile: boolean; expiresOn?: string };
type ParentRow = {
  id: string;
  firstName: string;
  lastName: string;
  greenTeamVolunteer?: boolean;
  classroomVolunteer?: boolean;
  family?: { id: string; name: string };
  cori?: Cori;
};
```

Render `<VolunteersCard />` in `AdminPage` right after `<AdminsCard />`:

```tsx
        <AdminsCard />
        <VolunteersCard />
```

Add the component:

```tsx
const PARENT_COLUMNS: DataTableColumnDef<ParentRow>[] = [
  {
    id: 'name',
    header: 'Parent',
    accessorFn: (p) => `${p.lastName}, ${p.firstName}`,
    size: 220,
    cell: ({ row }) => (
      <Strong>{`${row.original.lastName}, ${row.original.firstName}`}</Strong>
    ),
  },
  {
    id: 'family',
    header: 'Family',
    accessorFn: (p) => p.family?.name ?? '',
    size: 140,
  },
  {
    id: 'greenTeam',
    header: 'Green Team',
    enableSorting: false,
    size: 140,
    cell: ({ row }) => (
      <Switch
        aria-label={`Green team volunteer: ${row.original.firstName} ${row.original.lastName}`}
        checked={Boolean(row.original.greenTeamVolunteer)}
        onCheckedChange={(checked) =>
          db.transact(db.tx.parents[row.original.id]!.update({ greenTeamVolunteer: checked }))
        }
      />
    ),
  },
  {
    id: 'classroom',
    header: 'Classroom',
    enableSorting: false,
    size: 140,
    cell: ({ row }) => (
      <Switch
        aria-label={`Classroom volunteer: ${row.original.firstName} ${row.original.lastName}`}
        checked={Boolean(row.original.classroomVolunteer)}
        onCheckedChange={(checked) =>
          db.transact(db.tx.parents[row.original.id]!.update({ classroomVolunteer: checked }))
        }
      />
    ),
  },
  {
    id: 'cori',
    header: 'CORI',
    enableSorting: false,
    size: 260,
    cell: ({ row }) => <CoriCell parent={row.original} />,
  },
];

function VolunteersCard() {
  const { isLoading, error, data } = db.useQuery(PARENTS_QUERY);
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const parents = ((data?.parents ?? []) as ParentRow[])
      .slice()
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
    const q = filter.trim().toLowerCase();
    if (!q) return parents;
    return parents.filter((p) =>
      `${p.firstName} ${p.lastName} ${p.family?.name ?? ''}`.toLowerCase().includes(q),
    );
  }, [data, filter]);

  return (
    <Card padding="lg" surface="raised">
      <Stack gap="lg">
        <SectionTitle>Volunteers &amp; CORI</SectionTitle>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert tone="danger" title="Could not load parents" description={error.message} />
        ) : (
          <DataTable<ParentRow>
            data={rows}
            columns={PARENT_COLUMNS}
            ariaLabel="Volunteers and CORI status"
            getRowId={(p) => p.id}
            density="comfortable"
            filterValue={filter}
            onFilterValueChange={setFilter}
            filterPlaceholder="Search parents…"
            rowCountLabel={(visible) => `${visible} ${visible === 1 ? 'parent' : 'parents'}`}
            emptyState="No parents match your search."
          />
        )}
      </Stack>
    </Card>
  );
}

function CoriCell({ parent }: { parent: ParentRow }) {
  const cori = parent.cori;
  return (
    <Inline gap="md" align="center" wrap>
      <Checkbox
        label="On file"
        checked={Boolean(cori)}
        onCheckedChange={(checked) => {
          if (checked && !cori) {
            db.transact(
              db.tx.coriRecords[id()]!.update({ onFile: true }).link({ parent: parent.id }),
            );
          } else if (!checked && cori) {
            db.transact(db.tx.coriRecords[cori.id]!.delete());
          }
        }}
      />
      {cori ? (
        <TextField
          aria-label={`CORI expiration for ${parent.firstName} ${parent.lastName}`}
          placeholder="YYYY-MM-DD"
          size="sm"
          defaultValue={cori.expiresOn ?? ''}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v === (cori.expiresOn ?? '')) return;
            if (v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return; // ignore invalid input
            db.transact(db.tx.coriRecords[cori.id]!.update({ expiresOn: v === '' ? null : v }));
          }}
        />
      ) : null}
    </Inline>
  );
}
```

Note: `update({ expiresOn: null })` is Instant's documented way to clear an optional attr. If the typed transaction API rejects `null` for the optional string, cast the update payload: `.update({ expiresOn: (v === '' ? null : v) as string })`.

- [ ] **Step 2: Typecheck and manually verify**

```bash
pnpm typecheck
pnpm dev
```

Expected: `/admin` shows the parents table. Toggling Green Team / Classroom persists (reload survives, and the Directory page badges — after Task 8 — follow). Checking "On file" creates a CORI record; a date field appears; entering `2028-01-15` and blurring persists it; unchecking deletes the record.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "Add volunteers and CORI editing to admin page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Directory — volunteer badges and admin-only CORI caption

**Files:**
- Modify: `src/pages/Directory.tsx`

**Interfaces:**
- Consumes: schema fields/links from Task 2; perms from Task 3 (CORI stripped for non-admins).

- [ ] **Step 1: Update the query, types, and `ParentBlock`**

In `src/pages/Directory.tsx`:

Add `Badge` to the `@apygee/atoms` import list.

Update the query to fetch CORI (perms strip it for non-admins — no special-casing needed):

```tsx
const DIRECTORY_QUERY = {
  families: {
    parents: { cori: {} },
    children: {
      currentTeacher: {},
      pastTeachers: {},
    },
  },
} as const;
```

Extend the `Parent` type:

```tsx
type Cori = { id: string; onFile: boolean; expiresOn?: string };
type Parent = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  homePhone?: string;
  workPhone?: string;
  mobilePhone?: string;
  greenTeamVolunteer?: boolean;
  classroomVolunteer?: boolean;
  cori?: Cori;
};
```

Replace `ParentBlock` with:

```tsx
function ParentBlock({ parent }: { parent: Parent }) {
  const address = [parent.street, joinCityStateZip(parent)].filter(Boolean).join(', ');
  const phones = [
    parent.homePhone ? `H: ${parent.homePhone}` : null,
    parent.workPhone ? `W: ${parent.workPhone}` : null,
    parent.mobilePhone ? `M: ${parent.mobilePhone}` : null,
  ].filter(Boolean);
  const cori = coriLabel(parent.cori);

  return (
    <Stack gap="xs">
      <Inline gap="sm" align="center" wrap>
        <Strong>{`${parent.lastName}, ${parent.firstName}`}</Strong>
        {parent.greenTeamVolunteer ? <Badge tone="success">Green Team</Badge> : null}
        {parent.classroomVolunteer ? <Badge tone="primary">Classroom</Badge> : null}
      </Inline>
      <Body>{parent.email}</Body>
      {address ? <Caption>{address}</Caption> : null}
      {phones.length > 0 ? <Caption>{phones.join('  ·  ')}</Caption> : null}
      {cori ? <Caption>{cori}</Caption> : null}
    </Stack>
  );
}

// Only admins ever receive cori data (entity-level permission rule), so this
// renders nothing for everyone else.
function coriLabel(cori?: Cori): string | null {
  if (!cori?.onFile) return null;
  if (!cori.expiresOn) return 'CORI on file';
  const expires = new Date(`${cori.expiresOn}T00:00:00`);
  if (expires < new Date()) return 'CORI expired';
  const label = expires.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return `CORI on file · expires ${label}`;
}
```

- [ ] **Step 2: Typecheck and manually verify**

```bash
pnpm typecheck
pnpm dev
```

Expected: as admin — badges on flagged parents, CORI captions ("CORI on file · expires Mar 2028" / "CORI expired" / "CORI on file") on roughly 40% of parents. As non-admin (private window) — badges still visible, zero CORI captions, and the websocket/network payload for the directory query contains no `coriRecords` data (check devtools → Network → WS frames).

- [ ] **Step 3: Commit**

```bash
git add src/pages/Directory.tsx
git commit -m "Show volunteer badges and admin-only CORI status in directory

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Calendar page — render Green Team shifts

**Files:**
- Modify: `src/pages/Calendar.tsx`

**Interfaces:**
- Consumes: `@apygee/calendar` `Calendar` (Task 1), `greenTeamShifts` data (Tasks 2/4).

- [ ] **Step 1: Replace `src/pages/Calendar.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { Alert, PageHeader, PageShell, Spinner, Stack } from '@apygee/atoms';
import { Calendar } from '@apygee/calendar';
import type { CalendarEvent } from '@apygee/types';
import { db } from '../db';

const SHIFTS_QUERY = { greenTeamShifts: { volunteers: {} } } as const;

type ShiftVolunteer = { id: string; firstName: string; lastName: string };
type Shift = { id: string; date: string; slot: string; volunteers?: ShiftVolunteer[] };

const SLOT_LABEL: Record<string, string> = {
  '11:30': '11:30–12:30',
  '12:30': '12:30–1:30',
};

export function CalendarPage() {
  const [viewStart, setViewStart] = useState<Date>(() => startOfWeek(new Date()));
  const { isLoading, error, data } = db.useQuery(SHIFTS_QUERY);

  const events = useMemo(
    () => ((data?.greenTeamShifts ?? []) as Shift[]).map(shiftToEvent),
    [data],
  );

  return (
    <PageShell width="xl">
      <Stack gap="xl">
        <PageHeader
          eyebrow="Planning"
          title="My calendar"
          description="Green Team lunch shifts: 11:30–12:30 and 12:30–1:30 every school day."
        />
        {isLoading ? (
          <Stack gap="md" align="center">
            <Spinner />
          </Stack>
        ) : error ? (
          <Alert tone="danger" title="Could not load shifts" description={error.message} />
        ) : (
          <Calendar
            events={events}
            viewStart={viewStart}
            onViewStartChange={setViewStart}
            defaultZoom="3"
            getEventTone={() => 'success'}
            ariaLabel="Green Team shift calendar"
          />
        )}
      </Stack>
    </PageShell>
  );
}

function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function shiftToEvent(shift: Shift): CalendarEvent {
  const [hours = 0, minutes = 0] = shift.slot.split(':').map(Number);
  const startsAt = new Date(`${shift.date}T00:00:00`);
  startsAt.setHours(hours, minutes);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  const names = (shift.volunteers ?? []).map((v) => `${v.firstName} ${v.lastName}`);
  return {
    id: shift.id,
    title: names.length > 0 ? `Green Team: ${names.join(', ')}` : 'Green Team: open shift',
    description: `Green Team lunch shift ${SLOT_LABEL[shift.slot] ?? shift.slot}${
      names.length > 0 ? ` — ${names.join(' and ')}` : ''
    }`,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}
```

- [ ] **Step 2: Typecheck and manually verify**

```bash
pnpm typecheck
pnpm dev
```

Expected: `/calendar` shows a week view starting the current week. Each weekday has two adjacent one-hour green-toned events at 11:30 and 12:30 titled with volunteer names (one or two names; sometimes the same name on both slots of a day). Navigating back ~4 weeks and forward ~8 weeks still shows shifts; beyond the window, none.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Calendar.tsx
git commit -m "Render green team shifts on the calendar page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Final verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: both pass.

- [ ] **Step 2: Manual checks against the spec's testing section**

With `pnpm dev` running:

1. **Non-admin** (any email other than the bootstrap admin, private window): directory shows volunteer badges but no CORI captions; the directory websocket payload contains no `coriRecords`; no "Admin" nav item; `/admin` redirects to `/directory`; `/calendar` shows shifts.
2. **Admin** (bootstrap email): directory shows CORI captions; `/admin` lists admins, grants/revokes work, volunteer toggles and CORI editing persist across reload.
3. Reseed idempotency: `pnpm seed` again — completes, prints `… is already an admin`, and the app still works (admin grant survived).

- [ ] **Step 3: Report results**

Report any failures with exact output rather than fixing ad hoc; unexpected failures go through superpowers:systematic-debugging.
