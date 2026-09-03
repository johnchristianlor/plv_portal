-- Repair the production score schema used by Admin Activities.
-- Safe to run more than once. Supports both legacy text IDs and UUID IDs.
-- This does not weaken RLS or remove existing score values.

begin;

create extension if not exists pgcrypto;

-- Older PLV Supabase migrations documented ids as text, while newer tables may
-- use uuid. Pick a compatible generated-id default instead of assuming uuid.
do $$
declare
  v_id_type text;
begin
  select c.udt_name
  into v_id_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'scores'
    and c.column_name = 'id';

  if v_id_type = 'uuid' then
    execute 'alter table public.scores alter column id set default gen_random_uuid()';
  elsif v_id_type in ('text', 'varchar', 'bpchar') then
    execute 'alter table public.scores alter column id set default (gen_random_uuid()::text)';
  end if;
end;
$$;

alter table public.scores
  alter column score type numeric using score::numeric,
  alter column "createdAt" set default now();

update public.scores
set "createdAt" = now()
where "createdAt" is null;

alter table public.scores
  alter column "createdAt" set not null;

-- Keep the absence rule self-contained. Cast only for comparisons so it works
-- whether activities.id / scores.activityId are text or uuid.
create or replace function public.plv_reject_absent_activity_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.activities activity
    join public.attendance attendance
      on attendance.section = activity.section
     and attendance."subjectCode" = activity."subjectCode"
     and attendance.date::date = activity.date::date
     and attendance."studentNo" = new."studentNo"
    where activity.id::text = new."activityId"::text
      and (
        upper(trim(coalesce(attendance.status, ''))) = 'A'
        or upper(trim(coalesce(attendance.status, ''))) like 'ABSENT%'
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot record an activity score for a student marked absent on the activity date.';
  end if;
  return new;
end;
$$;

drop trigger if exists scores_reject_absent_activity on public.scores;
create trigger scores_reject_absent_activity
before insert or update on public.scores
for each row execute function public.plv_reject_absent_activity_score();

create or replace function public.plv_remove_scores_for_absent_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(trim(coalesce(new.status, ''))) = 'A'
     or upper(trim(coalesce(new.status, ''))) like 'ABSENT%'
  then
    delete from public.scores score
    using public.activities activity
    where score."activityId"::text = activity.id::text
      and score."studentNo" = new."studentNo"
      and activity.section = new.section
      and activity."subjectCode" = new."subjectCode"
      and activity.date::date = new.date::date;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_remove_same_day_activity_scores on public.attendance;
create trigger attendance_remove_same_day_activity_scores
after insert or update of status, date, section, "subjectCode", "studentNo" on public.attendance
for each row execute function public.plv_remove_scores_for_absent_attendance();

revoke all on function public.plv_reject_absent_activity_score() from public, anon, authenticated;
revoke all on function public.plv_remove_scores_for_absent_attendance() from public, anon, authenticated;

-- Atomic score writer. Activity ids are accepted as text because the original
-- Firebase-to-Supabase migration explicitly documented ids as text. Comparisons
-- cast the table ids to text, so this same writer also works when the live tables
-- use native uuid columns. Drop the older uuid overload to avoid PostgREST
-- ambiguity and the production text = uuid operator error.
drop function if exists public.plv_write_activity_score(text, uuid, text, numeric);
drop function if exists public.plv_write_activity_score(text, text, text, numeric);

create function public.plv_write_activity_score(
  p_action text,
  p_activity_id text,
  p_student_no text,
  p_score numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity public.activities%rowtype;
  v_score public.scores%rowtype;
begin
  if p_action not in ('save', 'delete')
     or p_student_no is null
     or btrim(p_student_no) = ''
  then
    raise exception using errcode = '22023', message = 'Invalid activity score request.';
  end if;

  select *
  into v_activity
  from public.activities
  where id::text = btrim(p_activity_id);

  if not found then
    raise exception using errcode = '23503', message = 'The activity no longer exists.';
  end if;

  if not exists (
    select 1
    from public.enrollments enrollment
    where enrollment."studentNo" = btrim(p_student_no)
      and enrollment.section = v_activity.section
      and enrollment."subjectCode" = v_activity."subjectCode"
  ) then
    raise exception using errcode = '23503', message = 'The student is not enrolled in this class.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(btrim(p_activity_id) || '|' || btrim(p_student_no), 0));

  if p_action = 'delete' then
    delete from public.scores
    where "activityId"::text = btrim(p_activity_id)
      and "studentNo" = btrim(p_student_no);
    return jsonb_build_object('deleted', true);
  end if;

  if p_score is null
     or p_score < 0
     or p_score > v_activity."perfectScore"::numeric
  then
    raise exception using errcode = '23514', message = 'The score is outside the activity range.';
  end if;

  if exists (
    select 1
    from public.attendance attendance
    where attendance."studentNo" = btrim(p_student_no)
      and attendance.section = v_activity.section
      and attendance."subjectCode" = v_activity."subjectCode"
      and attendance.date::date = v_activity.date::date
      and (
        upper(trim(coalesce(attendance.status, ''))) = 'A'
        or upper(trim(coalesce(attendance.status, ''))) like 'ABSENT%'
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot record an activity score for a student marked absent on the activity date.';
  end if;

  select *
  into v_score
  from public.scores
  where "activityId"::text = btrim(p_activity_id)
    and "studentNo" = btrim(p_student_no)
  order by "createdAt" asc nulls last, id::text asc
  limit 1;

  if found then
    update public.scores
    set score = p_score
    where id::text = v_score.id::text
    returning * into v_score;

    delete from public.scores
    where "activityId"::text = btrim(p_activity_id)
      and "studentNo" = btrim(p_student_no)
      and id::text <> v_score.id::text;
  else
    -- Use the actual activity id value from its row. This preserves its native
    -- type and remains compatible with scores.activityId on both text/uuid DBs.
    insert into public.scores ("activityId", "studentNo", score, "createdAt")
    values (v_activity.id, btrim(p_student_no), p_score, now())
    returning * into v_score;
  end if;

  return jsonb_build_object(
    'id', v_score.id,
    'activityId', v_score."activityId",
    'studentNo', v_score."studentNo",
    'score', v_score.score
  );
end;
$$;

revoke all on function public.plv_write_activity_score(text, text, text, numeric)
from public, anon, authenticated;
grant execute on function public.plv_write_activity_score(text, text, text, numeric)
to service_role;

notify pgrst, 'reload schema';

commit;

-- A successful run returns true. This is also safe to use as a quick check in
-- the Supabase SQL Editor after applying the migration.
select to_regprocedure('public.plv_write_activity_score(text,text,text,numeric)') is not null
  as activity_score_write_ready;
