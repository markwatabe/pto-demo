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
