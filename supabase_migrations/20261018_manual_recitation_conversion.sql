-- Apply AFTER 20261018_exam_incentives_and_admin_audit.sql.
-- Replaces every automatic recitation conversion with explicit admin-only actions.
-- Safe to apply to a portal that already ran the October 18 base migration.
BEGIN;

-- Stop automatic conversion FIRST; previously converted entries are deliberately retained.
DROP TRIGGER IF EXISTS exam_auto_convert_award ON public.recitation_transactions;
DROP FUNCTION IF EXISTS public.exam_auto_convert_recitation_award();
UPDATE public.exam_incentive_rules SET auto_convert = false WHERE auto_convert;
ALTER TABLE public.exam_incentive_rules ALTER COLUMN auto_convert SET DEFAULT false;

-- Retain the old RPC signature for compatibility, but reject attempts to turn on automatic conversion.
CREATE OR REPLACE FUNCTION public.admin_set_exam_incentive_rule(
  p_admin_session_token text,p_activity_id text,p_rate integer,p_auto_convert boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_activity record; v_actor text;
BEGIN
  v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
  IF coalesce(p_auto_convert,false) THEN RETURN jsonb_build_object('success',false,'code','automatic_conversion_disabled'); END IF;
  IF p_rate IS NULL OR p_rate NOT BETWEEN 1 AND 1000 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_rate'); END IF;
  SELECT a.id::text AS id,a."subjectCode" AS subject_code,a.section INTO v_activity
    FROM public.activities a WHERE a.id::text=p_activity_id AND a.category='exam' LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','exam_not_found'); END IF;
  INSERT INTO public.exam_incentive_rules(activity_id,subject_code,section,recitation_rate,auto_convert,changed_by)
  VALUES (p_activity_id,v_activity.subject_code,v_activity.section,p_rate,false,v_actor)
  ON CONFLICT(activity_id) DO UPDATE SET recitation_rate=excluded.recitation_rate,
    auto_convert=false,subject_code=excluded.subject_code,section=excluded.section,
    changed_by=excluded.changed_by,updated_at=now();
  RETURN jsonb_build_object('success',true);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_exam_incentive_rule(text,text,integer,boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_set_exam_incentive_rule(text,text,integer,boolean) TO authenticated;

-- Bulk conversion uses exactly the same wallet row lock and grade cap as single-student
-- conversion. A second click cannot redeem the same chips twice.
CREATE OR REPLACE FUNCTION public.admin_convert_recitation_section(
  p_admin_session_token text,p_activity_id text,p_section text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE
  v_actor text; v_exam record; v_student record; v_result jsonb;
  v_converted integer:=0; v_skipped integer:=0; v_points bigint:=0;
  v_spent bigint:=0; v_checked integer:=0; v_details jsonb:='[]'::jsonb;
BEGIN
  v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
  IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
  SELECT a.id::text AS id,a.section,a."subjectCode" AS subject_code INTO v_exam
    FROM public.activities a WHERE a.id::text=p_activity_id AND a.category='exam' LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','exam_not_found'); END IF;
  IF p_section IS DISTINCT FROM v_exam.section THEN
    RETURN jsonb_build_object('success',false,'code','section_mismatch'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_incentive_rules r WHERE r.activity_id=p_activity_id) THEN
    RETURN jsonb_build_object('success',false,'code','rule_required'); END IF;
  FOR v_student IN
    SELECT DISTINCT e."studentNo" AS student_no FROM public.enrollments e
    WHERE e."subjectCode"=v_exam.subject_code AND e.section=v_exam.section
    ORDER BY e."studentNo"
  LOOP
    v_checked:=v_checked+1;
    v_result:=public.exam_redeem_wallet(p_activity_id,v_student.student_no,v_actor,
      'recitation_manual','Manual section conversion',NULL);
    IF coalesce((v_result->>'success')::boolean,false) THEN
      v_converted:=v_converted+1;
      v_points:=v_points+(v_result->>'points')::bigint;
      v_spent:=v_spent+(v_result->>'spent')::bigint;
    ELSE
      v_skipped:=v_skipped+1;
    END IF;
    v_details:=v_details||jsonb_build_array(jsonb_build_object(
      'student_no',v_student.student_no,'success',coalesce((v_result->>'success')::boolean,false),
      'points',coalesce((v_result->>'points')::integer,0),
      'spent',coalesce((v_result->>'spent')::integer,0),
      'code',v_result->>'code'));
  END LOOP;
  RETURN jsonb_build_object('success',true,'checked',v_checked,'converted',v_converted,
    'skipped',v_skipped,'points',v_points,'spent',v_spent,'details',v_details);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_convert_recitation_section(text,text,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.admin_convert_recitation_section(text,text,text) TO authenticated;

-- Full conversion totals, not restricted by the 500-event history display window.
CREATE OR REPLACE FUNCTION public.admin_get_recitation_conversion_totals(p_admin_session_token text)
RETURNS TABLE(activity_id text,student_no text,converted_points bigint,spent_chips bigint,last_converted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
BEGIN
  IF NOT public.recitation_admin_is_valid(p_admin_session_token) THEN RETURN; END IF;
  RETURN QUERY SELECT l.activity_id,l.student_no,sum(l.bonus_points)::bigint,
    sum(l.recitation_spent)::bigint,max(l.created_at)
  FROM public.exam_incentive_ledger l WHERE l.source IN ('recitation_manual','recitation_auto')
  GROUP BY l.activity_id,l.student_no;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_get_recitation_conversion_totals(text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_get_recitation_conversion_totals(text) TO authenticated;

-- Student-only, read-only summary scoped to the student's active portal session.
CREATE OR REPLACE FUNCTION public.student_get_exam_conversion_status(p_student_no text,p_session_token text)
RETURNS TABLE(activity_id text,exam_title text,subject_code text,section text,term text,
  recitation_rate integer,converted_points bigint,spent_chips bigint,last_converted_at timestamptz,
  wallet_balance bigint,raw_score numeric,exam_max numeric,total_bonus bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
BEGIN
  IF nullif(p_session_token,'') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u."studentNo"=p_student_no
      AND lower(coalesce(u.role,''))='student'
      AND lower(coalesce(u.status,'active'))<>'inactive'
      AND u."activeSessionToken"=p_session_token
  ) THEN RETURN; END IF;
  RETURN QUERY
  SELECT a.id::text,a.title::text,a."subjectCode"::text,a.section::text,a.term::text,
    r.recitation_rate,coalesce(conversion.converted_points,0)::bigint,
    coalesce(conversion.spent_chips,0)::bigint,conversion.last_converted_at,
    coalesce(w.balance,0)::bigint,s.score::numeric,a."perfectScore"::numeric,
    coalesce(bonus.total_bonus,0)::bigint
  FROM public.activities a
  JOIN public.exam_incentive_rules r ON r.activity_id=a.id::text
  LEFT JOIN public.recitation_wallets w ON w.student_no=p_student_no
  LEFT JOIN LATERAL (
    SELECT sum(l.bonus_points)::bigint AS converted_points,sum(l.recitation_spent)::bigint AS spent_chips,
      max(l.created_at) AS last_converted_at
    FROM public.exam_incentive_ledger l
    WHERE l.activity_id=a.id::text AND l.student_no=p_student_no
      AND l.source IN ('recitation_manual','recitation_auto')
  ) conversion ON true
  LEFT JOIN LATERAL (
    SELECT sum(l.bonus_points)::bigint AS total_bonus FROM public.exam_incentive_ledger l
    WHERE l.activity_id=a.id::text AND l.student_no=p_student_no
  ) bonus ON true
  LEFT JOIN LATERAL (
    SELECT ss.score FROM public.scores ss
    WHERE ss."activityId"::text=a.id::text AND ss."studentNo"=p_student_no
    ORDER BY ss.id DESC LIMIT 1
  ) s ON true
  WHERE a.category='exam' AND EXISTS (
    SELECT 1 FROM public.enrollments e WHERE e."studentNo"=p_student_no
      AND e."subjectCode"=a."subjectCode" AND e.section=a.section
  )
  ORDER BY a."subjectCode",a.section,a.title;
END;
$$;
REVOKE ALL ON FUNCTION public.student_get_exam_conversion_status(text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.student_get_exam_conversion_status(text,text) TO authenticated,anon;
COMMIT;
