-- Turso assessment schema for PLV Grades Portal
-- Run this in Turso if you want to create the tables manually.

create table if not exists assessments (
  id text primary key,
  title text not null,
  instructions text,
  subject_code text,
  section text,
  status text not null default 'draft',
  duration_minutes integer not null default 30,
  opens_at text,
  closes_at text,
  settings_json text,
  created_by text,
  created_at text not null,
  updated_at text not null
);

create table if not exists assessment_questions (
  id text primary key,
  assessment_id text not null,
  type text not null,
  prompt text not null,
  points integer not null default 1,
  answer_key text,
  choices_json text,
  category text,
  difficulty text,
  explanation text,
  order_no integer not null default 1,
  created_at text not null,
  foreign key (assessment_id) references assessments(id) on delete cascade
);

create table if not exists assessment_attempts (
  id text primary key,
  assessment_id text not null,
  student_no text not null,
  student_name text,
  student_uid text,
  status text not null,
  answers_json text,
  score real not null default 0,
  total_points real not null default 0,
  violations integer not null default 0,
  started_at text not null,
  submitted_at text,
  deadline_at text,
  created_at text not null,
  foreign key (assessment_id) references assessments(id) on delete cascade
);

create table if not exists assessment_incidents (
  id text primary key,
  attempt_id text,
  assessment_id text,
  student_no text,
  type text not null,
  details text,
  created_at text not null
);

create index if not exists idx_assessments_status_section on assessments(status, section);
create index if not exists idx_questions_assessment_order on assessment_questions(assessment_id, order_no);
create index if not exists idx_attempts_student on assessment_attempts(student_no, assessment_id, status);
create index if not exists idx_attempts_assessment on assessment_attempts(assessment_id, started_at);
create index if not exists idx_incidents_attempt on assessment_incidents(attempt_id, created_at);
create index if not exists idx_incidents_assessment on assessment_incidents(assessment_id, created_at);
