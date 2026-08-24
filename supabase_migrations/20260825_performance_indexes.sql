-- Query-backed indexes for the PLV portal.
-- This migration intentionally changes no grants, policies, or RLS settings.
-- Run once in the Supabase SQL Editor during a low-traffic window.

-- Admin dashboard student count and other role-filtered account lists.
create index if not exists users_role_idx
  on public.users (role);

-- Five-minute online count: role + online are fixed by the query, then lastSeenAt is ranged.
create index if not exists users_online_students_last_seen_idx
  on public.users ("lastSeenAt" desc)
  where role = 'student' and "isOnline" = true;

-- Case-insensitive login_student_secure identifier branches. The partial predicate mirrors
-- the RPC's student/active-account filter so password/session columns are not indexed.
create index if not exists users_student_no_lower_active_idx
  on public.users (lower(coalesce("studentNo", '')))
  where role = 'student' and status is distinct from 'Inactive';

create index if not exists users_username_lower_active_idx
  on public.users (lower(coalesce(username, '')))
  where role = 'student' and status is distinct from 'Inactive';

create index if not exists users_email_lower_active_idx
  on public.users (lower(coalesce(email, '')))
  where role = 'student' and status is distinct from 'Inactive';

-- Own-enrollment reads and student/subject duplicate checks share this leading prefix.
create index if not exists enrollments_student_subject_idx
  on public.enrollments ("studentNo", "subjectCode");

-- Admin rosters, grade batches, schedules, and attendance enrollment validation.
create index if not exists enrollments_section_subject_idx
  on public.enrollments (section, "subjectCode");

-- Common activity list plus the full duplicate check
-- (subjectCode, section, term, category, title) with one non-redundant index.
create index if not exists activities_subject_section_term_category_title_idx
  on public.activities ("subjectCode", section, term, category, title);

-- Student score pages filter by studentNo; class calculations and cascaded deletes use activityId.
create index if not exists scores_student_no_idx
  on public.scores ("studentNo");

create index if not exists scores_activity_student_idx
  on public.scores ("activityId", "studentNo");

-- Student attendance history is read by student and sorted by date in the UI.
create index if not exists attendance_student_date_idx
  on public.attendance ("studentNo", date desc);

-- Roster/date loads and QR duplicate checks use this complete equality prefix.
create index if not exists attendance_section_subject_date_student_idx
  on public.attendance (section, "subjectCode", date, "studentNo");

-- Schedule upsert/lookups always address one subject/section pair.
create index if not exists class_schedules_subject_section_idx
  on public.class_schedules ("subjectCode", section);

-- Bounded dashboard/notification feeds request newest rows first.
create index if not exists deadlines_created_at_desc_idx
  on public.deadlines ("createdAt" desc);

create index if not exists announcements_created_at_desc_idx
  on public.announcements ("createdAt" desc);

-- Student file reads filter one recipient or the broadcast recipient and order newest first.
create index if not exists shared_files_recipient_uploaded_at_idx
  on public."sharedFiles" ("recipientStudentNo", "uploadedAt" desc);
