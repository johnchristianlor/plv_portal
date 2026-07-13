-- PLV secure assessment tables for Supabase
-- Run this in Supabase SQL Editor before using the assessment pages.

create extension if not exists pgcrypto;

create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  instructions text default '',
  subject_code text not null,
  section text not null,
  status text not null default 'draft' check (status in ('draft','published','closed')),
  duration_minutes integer not null default 30 check (duration_minutes between 1 and 240),
  opens_at timestamptz,
  closes_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assessment_questions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  prompt text not null,
  type text not null check (type in ('multiple_choice','true_false','short_answer','essay')),
  points numeric(8,2) not null default 1 check (points > 0),
  order_no integer not null default 1
);

create table if not exists public.assessment_choices (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.assessment_questions(id) on delete cascade,
  choice_text text not null,
  order_no integer not null default 1
);

create table if not exists public.assessment_answer_keys (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null unique references public.assessment_questions(id) on delete cascade,
  answer_key text not null
);

create table if not exists public.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  student_uid text,
  student_no text not null,
  student_name text,
  status text not null default 'submitted' check (status in ('in_progress','submitted','graded')),
  answers_json jsonb not null default '{}'::jsonb,
  score numeric(8,2),
  total_points numeric(8,2),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  graded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (assessment_id, student_no)
);

create index if not exists idx_assessments_section_status on public.assessments(section,status);
create index if not exists idx_assessment_questions_assessment on public.assessment_questions(assessment_id,order_no);
create index if not exists idx_assessment_choices_question on public.assessment_choices(question_id,order_no);
create index if not exists idx_assessment_attempts_student on public.assessment_attempts(student_no,assessment_id);

create or replace function public.plv_current_role()
returns text language sql stable as $$
  select coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'role', ''),
    (select role from public.users where uid = auth.uid()::text or email = auth.jwt() ->> 'email' limit 1),
    'anon'
  );
$$;

create or replace function public.plv_current_student_no()
returns text language sql stable as $$
  select coalesce(
    (select "studentNo" from public.users where uid = auth.uid()::text or email = auth.jwt() ->> 'email' limit 1),
    auth.jwt() -> 'user_metadata' ->> 'studentNo',
    auth.jwt() -> 'user_metadata' ->> 'student_no'
  );
$$;

create or replace function public.plv_current_section()
returns text language sql stable as $$
  select coalesce(
    (select section from public.users where uid = auth.uid()::text or email = auth.jwt() ->> 'email' limit 1),
    auth.jwt() -> 'user_metadata' ->> 'section'
  );
$$;

alter table public.assessments enable row level security;
alter table public.assessment_questions enable row level security;
alter table public.assessment_choices enable row level security;
alter table public.assessment_answer_keys enable row level security;
alter table public.assessment_attempts enable row level security;

drop policy if exists assessments_admin_all on public.assessments;
drop policy if exists assessments_student_read_assigned on public.assessments;
create policy assessments_admin_all on public.assessments for all using (public.plv_current_role() = 'admin') with check (public.plv_current_role() = 'admin');
create policy assessments_student_read_assigned on public.assessments for select using (status in ('published','closed') and (section = 'ALL' or section = public.plv_current_section()));

drop policy if exists questions_admin_all on public.assessment_questions;
drop policy if exists questions_student_read_assigned on public.assessment_questions;
create policy questions_admin_all on public.assessment_questions for all using (public.plv_current_role() = 'admin') with check (public.plv_current_role() = 'admin');
create policy questions_student_read_assigned on public.assessment_questions for select using (exists (select 1 from public.assessments a where a.id = assessment_id and a.status in ('published','closed') and (a.section = 'ALL' or a.section = public.plv_current_section())));

drop policy if exists choices_admin_all on public.assessment_choices;
drop policy if exists choices_student_read_assigned on public.assessment_choices;
create policy choices_admin_all on public.assessment_choices for all using (public.plv_current_role() = 'admin') with check (public.plv_current_role() = 'admin');
create policy choices_student_read_assigned on public.assessment_choices for select using (exists (select 1 from public.assessment_questions q join public.assessments a on a.id = q.assessment_id where q.id = question_id and a.status in ('published','closed') and (a.section = 'ALL' or a.section = public.plv_current_section())));

drop policy if exists answer_keys_admin_only on public.assessment_answer_keys;
create policy answer_keys_admin_only on public.assessment_answer_keys for all using (public.plv_current_role() = 'admin') with check (public.plv_current_role() = 'admin');

drop policy if exists attempts_admin_all on public.assessment_attempts;
drop policy if exists attempts_student_own on public.assessment_attempts;
create policy attempts_admin_all on public.assessment_attempts for all using (public.plv_current_role() = 'admin') with check (public.plv_current_role() = 'admin');
create policy attempts_student_own on public.assessment_attempts for all using (student_no = public.plv_current_student_no()) with check (student_no = public.plv_current_student_no());

revoke all on public.assessment_answer_keys from anon;
grant select, insert, update, delete on public.assessments, public.assessment_questions, public.assessment_choices, public.assessment_attempts to authenticated;
grant select, insert, update, delete on public.assessment_answer_keys to authenticated;
