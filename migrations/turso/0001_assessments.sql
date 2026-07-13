-- PLV assessment schema for Turso/libSQL
pragma foreign_keys = on;

create table if not exists assessments (
  id text primary key,
  title text not null,
  description text,
  instructions text,
  subject_id text,
  subject_code text,
  type text not null check (type in ('quiz','examination','practice','diagnostic')),
  total_points real not null default 0,
  passing_score real default 0,
  passing_percent real default 0,
  status text not null default 'draft' check (status in ('draft','scheduled','active','paused','closed','archived')),
  open_at text,
  close_at text,
  duration_minutes integer not null default 60,
  per_question_seconds integer default 0,
  attempt_limit integer not null default 1,
  grace_minutes integer default 0,
  late_policy text default 'auto_submit',
  shuffle_questions integer not null default 0,
  shuffle_choices integer not null default 0,
  random_draw_count integer not null default 0,
  allow_backtracking integer not null default 1,
  one_question_per_page integer not null default 0,
  require_answer_before_next integer not null default 0,
  review_policy text not null default 'after_release',
  incident_policy text not null default 'warn',
  incident_limit integer not null default 3,
  created_by text not null,
  created_at text not null,
  updated_at text not null,
  current_version_id text
);

create table if not exists assessment_versions (
  id text primary key,
  assessment_id text not null references assessments(id) on delete cascade,
  version_no integer not null,
  status text not null default 'draft',
  snapshot_json text not null,
  created_by text not null,
  created_at text not null,
  unique(assessment_id, version_no)
);

create table if not exists assessment_assignments (
  id text primary key,
  assessment_id text not null references assessments(id) on delete cascade,
  version_id text not null references assessment_versions(id),
  section_id text,
  student_id text,
  assigned_by text not null,
  assigned_at text not null,
  unique(assessment_id, coalesce(section_id,''), coalesce(student_id,''))
);

create table if not exists question_categories (id text primary key, name text not null unique, created_at text not null);
create table if not exists questions (
  id text primary key,
  version_id text not null references assessment_versions(id) on delete cascade,
  type text not null check (type in ('single','multiple','true_false','short','essay')),
  prompt text not null,
  points real not null default 1,
  explanation text,
  category text,
  difficulty text,
  required integer not null default 1,
  case_sensitive integer not null default 0,
  accepted_answers_json text,
  media_object text,
  created_at text not null
);
create table if not exists question_choices (id text primary key, question_id text not null references questions(id) on delete cascade, choice_text text not null, is_correct integer not null default 0, order_index integer not null default 0);
create table if not exists assessment_question_map (id text primary key, assessment_id text not null references assessments(id) on delete cascade, version_id text not null references assessment_versions(id), question_id text not null references questions(id), order_index integer not null, points real not null default 1);

create table if not exists attempts (
  id text primary key,
  assessment_id text not null references assessments(id),
  version_id text not null references assessment_versions(id),
  student_id text not null,
  status text not null default 'in_progress',
  started_at text not null,
  server_deadline_at text not null,
  submitted_at text,
  last_heartbeat_at text,
  score real,
  total_points real,
  percentage real,
  locked_reason text,
  created_at text not null,
  updated_at text not null
);
create table if not exists attempt_question_map (id text primary key, attempt_id text not null references attempts(id) on delete cascade, question_id text not null references questions(id), order_index integer not null, choice_order_json text not null default '[]');
create table if not exists student_answers (id text primary key, attempt_id text not null references attempts(id) on delete cascade, question_id text not null references questions(id), student_id text not null, answer_json text, marked_for_review integer default 0, is_correct integer, awarded_points real, manual_feedback text, idempotency_key text, updated_at text not null, unique(attempt_id, question_id));
create table if not exists manual_grades (id text primary key, answer_id text not null references student_answers(id) on delete cascade, graded_by text not null, points real not null, feedback text, graded_at text not null);
create table if not exists assessment_incidents (id text primary key, attempt_id text not null references attempts(id) on delete cascade, student_id text not null, incident_type text not null, question_id text, incident_count integer not null, details_json text, created_at text not null);
create table if not exists assessment_audit_logs (id text primary key, actor_id text not null, actor_role text not null, action text not null, entity_type text not null, entity_id text, details_json text, created_at text not null);
create table if not exists score_sync_outbox (id text primary key, attempt_id text not null, assessment_id text not null, student_id text not null, payload_json text not null, status text not null default 'pending', retries integer not null default 0, last_error text, created_at text not null, processed_at text);

create index if not exists idx_assessments_status_dates on assessments(status, open_at, close_at);
create index if not exists idx_assessments_subject on assessments(subject_id, subject_code);
create index if not exists idx_assignments_section on assessment_assignments(section_id);
create index if not exists idx_assignments_student on assessment_assignments(student_id);
create index if not exists idx_questions_version on questions(version_id);
create index if not exists idx_attempts_student on attempts(student_id, status);
create index if not exists idx_attempts_assessment on attempts(assessment_id, status);
create index if not exists idx_attempts_submitted on attempts(submitted_at);
create index if not exists idx_answers_attempt on student_answers(attempt_id);
create index if not exists idx_incidents_attempt_type on assessment_incidents(attempt_id, incident_type);
create index if not exists idx_incidents_student on assessment_incidents(student_id);
create index if not exists idx_outbox_status on score_sync_outbox(status, created_at);
