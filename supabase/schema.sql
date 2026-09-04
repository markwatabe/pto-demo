-- Green Team scheduling + family directory schema. Apply via the Supabase SQL editor.
-- Idempotent: drops and recreates all tables. NOTE: re-running wipes
-- approval state (profiles/admins) as well as directory data; run
-- `pnpm seed` afterwards to re-bootstrap the first admin.

drop trigger if exists on_auth_user_created on auth.users;
drop table if exists push_subscriptions;
drop table if exists shift_volunteers;
drop table if exists green_team_shifts;
drop table if exists availability;
drop table if exists volunteers;
drop table if exists school_closures;
drop table if exists school_year;
drop table if exists admins;
drop table if exists profiles;
drop table if exists child_past_teachers;
drop table if exists children;
drop table if exists parents;
drop table if exists families;
drop table if exists teachers;
drop function if exists public.handle_new_user();
drop function if exists public.is_approved();
drop function if exists public.is_admin();

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

-- Green Team lunch shifts: early (11:05-12:15) and late (12:20-13:30) per
-- school day, covered by roster volunteers. Clock times live in
-- src/schedule.ts (SLOT_TIMES). Admins create/remove shifts client-side.
create table green_team_shifts (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  slot text not null check (slot in ('early', 'late')),
  unique (date, slot)
);
create index green_team_shifts_date_idx on green_team_shifts (date);

-- Volunteer roster: imported from the sign-up form (volunteers.csv) and
-- edited in-app. Linked to signed-in users by email match only.
create table volunteers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  veteran boolean not null default false,
  grades text,
  frequency text not null default 'monthly' check (frequency in ('monthly', 'biweekly', 'custom')),
  frequency_note text,
  cori text not null default 'unsure' check (cori in ('yes', 'no', 'unsure')),
  backfill boolean not null default false,
  notes text
);

-- Recurring weekly availability: weekday 1=Mon .. 4=Thu (lunch shifts run
-- Monday-Thursday only); slot values match green_team_shifts.slot.
create table availability (
  volunteer_id uuid not null references volunteers (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 4),
  slot text not null check (slot in ('early', 'late')),
  primary key (volunteer_id, weekday, slot)
);

-- Single-row school-year window; school days are Mon-Thu inside it minus closures.
create table school_year (
  id boolean primary key default true check (id),
  starts_on date not null,
  ends_on date not null
);

create table school_closures (
  date date primary key,
  reason text
);

create table shift_volunteers (
  shift_id uuid not null references green_team_shifts (id) on delete cascade,
  volunteer_id uuid not null references volunteers (id) on delete cascade,
  -- Attendance: 'scheduled' until an admin marks a past shift.
  status text not null default 'scheduled' check (status in ('scheduled', 'attended', 'missed')),
  primary key (shift_id, volunteer_id)
);

-- Web Push subscriptions for the public /fiske-schedule reminders. Written
-- and read ONLY by Edge Functions (service role); RLS enabled with no
-- policies so clients can never touch it.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_email_idx on push_subscriptions (email);
alter table push_subscriptions enable row level security;

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

-- Directory is readable by APPROVED users only (pending users are locked
-- out at the database). Approving and granting/revoking admin are the only
-- client-side writes, restricted to admins; the seed script writes with the
-- service-role key, which bypasses RLS.
alter table families enable row level security;
alter table teachers enable row level security;
alter table parents enable row level security;
alter table children enable row level security;
alter table child_past_teachers enable row level security;
alter table profiles enable row level security;
alter table admins enable row level security;
alter table green_team_shifts enable row level security;
alter table shift_volunteers enable row level security;
alter table volunteers enable row level security;
alter table availability enable row level security;
alter table school_year enable row level security;
alter table school_closures enable row level security;

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
create policy "approved can read" on green_team_shifts
  for select to authenticated using (public.is_approved());
create policy "approved can read" on shift_volunteers
  for select to authenticated using (public.is_approved());

create policy "approved can read" on volunteers
  for select to authenticated using (public.is_approved());
create policy "approved can read" on availability
  for select to authenticated using (public.is_approved());
create policy "approved can read" on school_year
  for select to authenticated using (public.is_approved());
create policy "approved can read" on school_closures
  for select to authenticated using (public.is_approved());

-- Self-service: a signed-in user manages their own roster row and
-- availability, matched by email. Admins manage everyone.
create policy "admin or self can insert" on volunteers
  for insert to authenticated
  with check (public.is_admin()
    or (public.is_approved() and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))));
create policy "admin or self can update" on volunteers
  for update to authenticated
  using (public.is_admin()
    or (public.is_approved() and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))))
  with check (public.is_admin()
    or (public.is_approved() and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))));
create policy "admin can delete" on volunteers
  for delete to authenticated using (public.is_admin());

create policy "admin or owner can insert" on availability
  for insert to authenticated
  with check (public.is_admin() or exists (
    select 1 from volunteers v
    where v.id = volunteer_id
      and lower(v.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));
create policy "admin or owner can delete" on availability
  for delete to authenticated
  using (public.is_admin() or exists (
    select 1 from volunteers v
    where v.id = volunteer_id
      and lower(v.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));

create policy "admin can set" on school_year
  for insert to authenticated with check (public.is_admin());
create policy "admin can update" on school_year
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin can add" on school_closures
  for insert to authenticated with check (public.is_admin());
create policy "admin can remove" on school_closures
  for delete to authenticated using (public.is_admin());

-- The schedule generator and roster editor run client-side as an admin.
create policy "admin can add" on green_team_shifts
  for insert to authenticated with check (public.is_admin());
create policy "admin can remove" on green_team_shifts
  for delete to authenticated using (public.is_admin());
create policy "admin can assign" on shift_volunteers
  for insert to authenticated with check (public.is_admin());
create policy "admin can unassign" on shift_volunteers
  for delete to authenticated using (public.is_admin());
create policy "admin can mark attendance" on shift_volunteers
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

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
