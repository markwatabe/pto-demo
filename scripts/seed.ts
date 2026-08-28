/**
 * Seed the PTO family directory with example data.
 *
 * Usage:  pnpm seed
 *
 * Idempotent: deletes all existing families/parents/children/teachers first,
 * then recreates a fresh random sample. Safe to re-run.
 *
 * Requires VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ADMIN_EMAIL
 * in .env. Bootstraps ADMIN_EMAIL as an approved admin (profiles/admins
 * are never wiped — they hold real users, not demo data).
 * The service-role key bypasses RLS — this script must never run client-side.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error('Missing VITE_SUPABASE_URL in .env');
if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env');

const adminEmail = process.env.ADMIN_EMAIL;
if (!adminEmail) throw new Error('Missing ADMIN_EMAIL in .env');

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const FAMILY_COUNT = 80;

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

// Find-or-create the first admin's confirmed auth user, then mark them
// approved and admin. Idempotent via upsert.
async function bootstrapAdmin(email: string) {
  email = email.trim().toLowerCase();
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

async function main() {
  await bootstrapAdmin(adminEmail);
  console.log('Clearing existing directory data…');
  // Children/parents cascade from families, but clear explicitly so counts print.
  for (const [table, key] of [
    ['shift_volunteers', 'shift_id'],
    ['green_team_shifts', 'id'],
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

  // --- Green Team volunteer pool ---------------------------------------------
  // ~25% of parents volunteer; top up randomly to guarantee a workable pool.
  for (const p of parentRows) p.green_team_volunteer = chance(0.25);
  let pool = parentRows.filter((p) => p.green_team_volunteer);
  if (pool.length < 20) {
    const extras = shuffle(parentRows.filter((p) => !p.green_team_volunteer)).slice(
      0,
      20 - pool.length,
    );
    for (const p of extras) p.green_team_volunteer = true;
    pool = parentRows.filter((p) => p.green_team_volunteer);
  }

  // --- Green Team shifts: two per weekday, ~12 weeks around today -------------
  // Dates ignore the real school calendar — this is demo data.
  const shiftRows: Record<string, unknown>[] = [];
  const shiftVolunteerRows: Record<string, unknown>[] = [];
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  for (let offset = -28; offset <= 56; offset++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // school days only

    const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    // ~25% of days one volunteer covers both slots.
    const sharedVolunteerId = chance(0.25) ? (pick(pool).id as string) : null;

    for (const slot of ['11:30', '12:30'] as const) {
      const shiftId = randomUUID();
      shiftRows.push({ id: shiftId, date, slot });

      const count = chance(0.8) ? 2 : 1;
      const volunteerIds = new Set<string>();
      if (sharedVolunteerId) volunteerIds.add(sharedVolunteerId);
      while (volunteerIds.size < count) volunteerIds.add(pick(pool).id as string);
      for (const parentId of volunteerIds) {
        shiftVolunteerRows.push({ shift_id: shiftId, parent_id: parentId });
      }
    }
  }

  // Insert in FK order: families before parents/children, children before links,
  // parents before shift links.
  await insertAll('families', familyRows);
  await insertAll('parents', parentRows);
  await insertAll('children', childRows);
  await insertAll('child_past_teachers', pastTeacherRows);
  await insertAll('green_team_shifts', shiftRows);
  await insertAll('shift_volunteers', shiftVolunteerRows);

  console.log(
    `Seeded ${familyRows.length} families, ${parentRows.length} parents, ${childRows.length} children.`,
  );
  console.log(
    `Seeded ${shiftRows.length} green team shifts (${shiftVolunteerRows.length} volunteer slots, pool of ${pool.length}).`,
  );
  console.log('Done.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
