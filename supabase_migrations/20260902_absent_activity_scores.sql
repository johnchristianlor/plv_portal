-- Keep activity scores consistent with same-day class attendance.
-- An absent student has no stored score for activities in the same section,
-- subject, and date. The activity still remains visible to the student as Absent.

create or replace function public.plv_is_absent_status(value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select upper(trim(coalesce(value, ''))) = 'A'
      or upper(trim(coalesce(value, ''))) like 'ABSENT%';
$$;

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
      and public.plv_is_absent_status(attendance.status)
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
  if public.plv_is_absent_status(new.status) then
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

revoke all on function public.plv_is_absent_status(text) from public, anon, authenticated;
revoke all on function public.plv_reject_absent_activity_score() from public, anon, authenticated;
revoke all on function public.plv_remove_scores_for_absent_attendance() from public, anon, authenticated;
