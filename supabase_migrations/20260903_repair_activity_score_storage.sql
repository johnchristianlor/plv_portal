-- Repair the production score schema used by Admin Activities.
-- Safe to run more than once. This does not change RLS or existing score values.

begin;

create extension if not exists pgcrypto;

alter table public.scores
  alter column id set default gen_random_uuid(),
  alter column score type numeric using score::numeric,
  alter column "createdAt" set default now();

update public.scores
set "createdAt" = now()
where "createdAt" is null;

alter table public.scores
  alter column "createdAt" set not null;

-- Keep the absence rule self-contained. The earlier trigger called a second
-- helper function; in installations where EXECUTE was revoked from that helper,
-- every score insert could fail before the row reached the table.
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
    where activity.id = new."activityId"
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
    where score."activityId" = activity.id
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

notify pgrst, 'reload schema';

commit;
