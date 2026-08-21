/**
 * Seed the PTO family directory with example data.
 *
 * Usage:  pnpm seed
 *
 * Idempotent: deletes all existing families/parents/children/teachers first,
 * then recreates a fresh random sample. Safe to re-run.
 *
 * Requires INSTANT_ADMIN_TOKEN and VITE_INSTANT_APP_ID in .env.
 */
import 'dotenv/config';
import { init, id } from '@instantdb/admin';
import schema from '../src/instant.schema';

const appId = process.env.VITE_INSTANT_APP_ID;
const adminToken = process.env.INSTANT_ADMIN_TOKEN;

if (!appId) throw new Error('Missing VITE_INSTANT_APP_ID in .env');
if (!adminToken) throw new Error('Missing INSTANT_ADMIN_TOKEN in .env');

const db = init({ appId, adminToken, schema });

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

async function deleteAll(entity: 'families' | 'parents' | 'children' | 'teachers') {
  const data = await db.query({ [entity]: {} } as any);
  const rows: { id: string }[] = (data as any)[entity] ?? [];
  if (rows.length === 0) return 0;
  await db.transact(rows.map((r) => db.tx[entity]![r.id]!.delete()));
  return rows.length;
}

async function main() {
  console.log('Clearing existing directory data…');
  for (const entity of ['children', 'parents', 'families', 'teachers'] as const) {
    const n = await deleteAll(entity);
    console.log(`  deleted ${n} ${entity}`);
  }

  // --- Teachers: 3 per grade, K–5 -------------------------------------------
  const teacherNames = shuffle(
    TEACHER_LAST.flatMap((last) => TEACHER_FIRST.map((first) => ({ first, last }))),
  );
  const teachers: { id: string; grade: number }[] = [];
  let nameIdx = 0;
  for (let grade = 0; grade <= 5; grade++) {
    for (let k = 0; k < 3; k++) {
      const tid = id();
      const nm = teacherNames[nameIdx++]!;
      teachers.push({ id: tid, grade });
      await db.transact(
        db.tx.teachers![tid]!.update({
          firstName: nm.first,
          lastName: nm.last,
          grade,
        }),
      );
    }
  }
  console.log(`Created ${teachers.length} teachers (grades K–5).`);

  const teachersByGrade = (g: number) => teachers.filter((t) => t.grade === g);

  // --- Families --------------------------------------------------------------
  let parentCount = 0;
  let childCount = 0;

  for (let f = 0; f < FAMILY_COUNT; f++) {
    const familyId = id();
    const familyName = pick(LAST_NAMES);
    const txs: any[] = [];

    txs.push(db.tx.families![familyId]!.update({ name: familyName }));

    // The first 10 families have a second parent with a different last name
    // (parents don't always share a surname). Those families always get 2 parents.
    const differentSecondSurname = f < 10;

    // 1–2 parents, biased toward 2.
    const numParents = differentSecondSurname || chance(0.75) ? 2 : 1;
    const street = `${1000 + rand(8000)} ${pick(STREETS)}`;
    for (let p = 0; p < numParents; p++) {
      const pid = id();
      const first = pick(FIRST_NAMES);
      // Second parent of a mixed-surname family gets a different last name.
      const last =
        differentSecondSurname && p === 1 ? pickDifferent(LAST_NAMES, familyName) : familyName;
      const emailLast = last.toLowerCase().replace(/[^a-z]/g, '');
      const hasAddress = chance(0.7);
      txs.push(
        db.tx.parents![pid]!
          .update({
            firstName: first,
            lastName: last,
            email: `${first.toLowerCase()}.${emailLast}@example.com`,
            // Address/phones are optional — only sometimes present.
            ...(hasAddress
              ? { street, city: 'Lexington', state: 'MA', zip: '02421' }
              : {}),
            ...(chance(0.6) ? { homePhone: phone() } : {}),
            ...(chance(0.5) ? { mobilePhone: phone() } : {}),
            ...(chance(0.3) ? { workPhone: phone() } : {}),
          })
          .link({ family: familyId }),
      );
      parentCount++;
    }

    // 1–4 children.
    const numChildren = 1 + rand(4);
    for (let c = 0; c < numChildren; c++) {
      const cid = id();
      const currentGrade = rand(6); // 0–5
      const current = pick(teachersByGrade(currentGrade));

      // Past teachers: from grades below the current one, 0–3 of them.
      const lowerGradeTeachers = teachers.filter((t) => t.grade < currentGrade);
      const past = shuffle(lowerGradeTeachers).slice(0, Math.min(rand(4), lowerGradeTeachers.length));

      txs.push(
        db.tx.children![cid]!
          .update({
            firstName: pick(FIRST_NAMES),
            lastName: familyName,
            birthDate: birthDate(),
          })
          .link({
            family: familyId,
            currentTeacher: current.id,
            ...(past.length ? { pastTeachers: past.map((t) => t.id) } : {}),
          }),
      );
      childCount++;
    }

    await db.transact(txs);
  }

  console.log(
    `Seeded ${FAMILY_COUNT} families, ${parentCount} parents, ${childCount} children.`,
  );
  console.log('Done.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
