-- Apply after moving users to Supabase Auth. Review table names against your existing schema before running in production.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  student_no text unique,
  email text,
  full_name text,
  role text not null check (role in ('admin','student')),
  section text,
  status text not null default 'active',
  must_change_password boolean not null default false,
  avatar_object text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assessment_score_summaries (
  id text primary key,
  student_id uuid not null references auth.users(id) on delete cascade,
  assessment_id text not null,
  title text not null,
  subject_code text,
  score numeric,
  total_points numeric,
  percentage numeric,
  status text,
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.assessment_score_summaries enable row level security;

drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select to authenticated using (id = auth.uid());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles for all to authenticated using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists assessment_summaries_student_read on public.assessment_score_summaries;
create policy assessment_summaries_student_read on public.assessment_score_summaries for select to authenticated using (student_id = auth.uid());

drop policy if exists assessment_summaries_admin_all on public.assessment_score_summaries;
create policy assessment_summaries_admin_all on public.assessment_score_summaries for all to authenticated using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

revoke all on function public.login_student_secure(text,text,text) from anon, authenticated;
drop function if exists public.login_student_secure(text,text,text);
drop function if exists public.login_student(text,text);
drop function if exists public.update_student_password(text,text,text);

-- Run after profiles are verified and all pages use Supabase Auth:
-- alter table public.users drop column if exists password;
