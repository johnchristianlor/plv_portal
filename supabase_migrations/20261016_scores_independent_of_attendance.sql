-- Apply AFTER the 20260903 score storage migration in the Supabase SQL Editor.
-- Attendance and scores are independent records: A/E must never delete or block scores.
-- Safe to rerun. No attendance history is changed; previously deleted grades cannot be recovered here.
begin;

drop trigger if exists scores_reject_absent_activity on public.scores;
drop trigger if exists attendance_remove_same_day_activity_scores on public.attendance;

create or replace function public.plv_write_activity_score(
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

  -- Attendance A/E does not block saving a legitimate late/completion score.

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
