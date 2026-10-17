-- PLV Portal: each approved conversion creates a NEW, independent extra-credit entry.
-- Apply after 20261018_named_bonus_and_portal_access.sql (and preceding migrations).
-- Old scores and incentive history are retained; chips are still spent manually only.
BEGIN;

ALTER TABLE public.exam_incentive_ledger ADD COLUMN IF NOT EXISTS entry_group_id uuid;
CREATE INDEX IF NOT EXISTS exam_incentive_ledger_group ON public.exam_incentive_ledger(entry_group_id,student_no);
CREATE SEQUENCE IF NOT EXISTS public.recitation_bonus_name_seq;
REVOKE ALL ON SEQUENCE public.recitation_bonus_name_seq FROM PUBLIC,anon,authenticated;

-- Internal, permission-restricted helper: all students in ONE section conversion receive
-- the same entry group ID (one class-wide item, with a separate value per student).
CREATE OR REPLACE FUNCTION public.exam_redeem_wallet_standalone(
 p_activity_id text,p_student_no text,p_actor text,p_title text,p_entry_group_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_rate integer;v_balance bigint;v_points bigint;v_spend bigint;v_remaining bigint;
BEGIN
 IF p_entry_group_id IS NULL OR nullif(btrim(p_title),'') IS NULL OR char_length(btrim(p_title))>100
 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 SELECT r.recitation_rate INTO v_rate FROM public.exam_incentive_rules r
 JOIN public.activities a ON a.id::text=r.activity_id AND a.category='exam'
 WHERE r.activity_id=p_activity_id LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','rule_required'); END IF;
 IF v_rate IS NULL OR v_rate NOT BETWEEN 1 AND 1000
 THEN RETURN jsonb_build_object('success',false,'code','invalid_rate'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.enrollments e JOIN public.activities a ON a.id::text=p_activity_id
    WHERE e."studentNo"=p_student_no AND e."subjectCode"=a."subjectCode" AND e.section=a.section)
 THEN RETURN jsonb_build_object('success',false,'code','student_not_enrolled'); END IF;
 INSERT INTO public.recitation_wallets(student_no,balance) VALUES(p_student_no,0)
 ON CONFLICT(student_no) DO NOTHING;
 SELECT w.balance INTO v_balance FROM public.recitation_wallets w
 WHERE w.student_no=p_student_no FOR UPDATE;
 IF v_balance IS NULL OR v_balance<0
 THEN RETURN jsonb_build_object('success',false,'code','invalid_wallet_balance'); END IF;
 v_points:=least(v_balance/v_rate,100000::bigint,2147483647::bigint/v_rate);
 IF v_points<1 THEN RETURN jsonb_build_object('success',false,'code','below_rate',
   'points',0,'spent',0,'balance',v_balance,'retained',v_balance,'needed',v_rate-v_balance); END IF;
 v_spend:=v_points*v_rate;
 UPDATE public.recitation_wallets SET balance=balance-v_spend,updated_at=now()
 WHERE student_no=p_student_no AND balance>=v_spend RETURNING balance INTO v_remaining;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','balance_changed','spent',0,'points',0); END IF;
 INSERT INTO public.exam_incentive_ledger(activity_id,student_no,bonus_points,source,recitation_spent,
   conversion_rate,entry_title,entry_group_id,reason,created_by_profile_id)
 VALUES(p_activity_id,p_student_no,v_points::integer,'recitation_manual',v_spend::integer,
   v_rate,btrim(p_title),p_entry_group_id,'Approved standalone recitation extra credit',p_actor);
 RETURN jsonb_build_object('success',true,'title',btrim(p_title),'entry_id',p_entry_group_id,
   'points',v_points,'spent',v_spend,'rate',v_rate,'balance',v_remaining,'retained',v_remaining);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_redeem_wallet_standalone(text,text,text,text,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.admin_convert_named_recitation(
 p_admin_session_token text,p_activity_id text,p_student_no text,p_title text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_actor text;v_title text;v_entry_group_id uuid;
BEGIN
 v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
 IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 IF char_length(btrim(coalesce(p_title,'')))>100 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 -- No entered title? Automatically name the new score item. Never create/overwrite an exam.
 v_title:=coalesce(nullif(btrim(p_title),''),
   'Recitation Bonus #'||lpad(nextval('public.recitation_bonus_name_seq')::text,4,'0'));
 v_entry_group_id:=gen_random_uuid();
 RETURN public.exam_redeem_wallet_standalone(p_activity_id,p_student_no,v_actor,v_title,v_entry_group_id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_convert_named_recitation(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_convert_named_recitation(text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_convert_named_recitation_section(
 p_admin_session_token text,p_activity_id text,p_section text,p_title text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_actor text;v_exam record;v_student record;v_result jsonb;
 v_title text;v_entry_group_id uuid:=gen_random_uuid();
 v_converted integer:=0;v_skipped integer:=0;v_points bigint:=0;v_spent bigint:=0;v_checked integer:=0;
BEGIN
 v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
 IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 IF char_length(btrim(coalesce(p_title,'')))>100 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 SELECT a.section,a."subjectCode" AS subject_code INTO v_exam FROM public.activities a
 WHERE a.id::text=p_activity_id AND a.category='exam' LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','exam_not_found'); END IF;
 IF v_exam.section IS DISTINCT FROM p_section THEN RETURN jsonb_build_object('success',false,'code','section_mismatch'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.exam_incentive_rules r WHERE r.activity_id=p_activity_id)
 THEN RETURN jsonb_build_object('success',false,'code','rule_required'); END IF;
 v_title:=coalesce(nullif(btrim(p_title),''),
   'Recitation Bonus #'||lpad(nextval('public.recitation_bonus_name_seq')::text,4,'0'));
 FOR v_student IN SELECT DISTINCT e."studentNo" AS student_no FROM public.enrollments e
 WHERE e."subjectCode"=v_exam.subject_code AND e.section=v_exam.section ORDER BY e."studentNo"
 LOOP
  v_checked:=v_checked+1;
  v_result:=public.exam_redeem_wallet_standalone(p_activity_id,v_student.student_no,v_actor,v_title,v_entry_group_id);
  IF coalesce((v_result->>'success')::boolean,false) THEN
   v_converted:=v_converted+1;v_points:=v_points+(v_result->>'points')::bigint;
   v_spent:=v_spent+(v_result->>'spent')::bigint;
  ELSE v_skipped:=v_skipped+1;END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'checked',v_checked,'converted',v_converted,'skipped',v_skipped,
  'points',v_points,'spent',v_spent,'title',v_title,'entry_id',v_entry_group_id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_convert_named_recitation_section(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_convert_named_recitation_section(text,text,text,text) TO authenticated;

-- One manually awarded bonus is its own independent item, too.
CREATE OR REPLACE FUNCTION public.admin_grant_named_exam_bonus(
 p_admin_session_token text,p_activity_id text,p_student_no text,p_points integer,p_title text,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_actor text;v_activity record;v_title text;v_group_id uuid:=gen_random_uuid();
BEGIN
 v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
 IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 IF p_points IS NULL OR p_points NOT BETWEEN 1 AND 1000
 THEN RETURN jsonb_build_object('success',false,'code','invalid_points'); END IF;
 v_title:=nullif(btrim(p_title),'');
 IF v_title IS NULL OR char_length(v_title)>100 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 IF char_length(coalesce(p_reason,''))>240 THEN RETURN jsonb_build_object('success',false,'code','reason_too_long'); END IF;
 SELECT a."subjectCode" AS subject_code,a.section INTO v_activity FROM public.activities a
 WHERE a.id::text=p_activity_id AND a.category='exam' LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','exam_not_found'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.enrollments e WHERE e."studentNo"=p_student_no
 AND e."subjectCode"=v_activity.subject_code AND e.section=v_activity.section)
 THEN RETURN jsonb_build_object('success',false,'code','student_not_enrolled'); END IF;
 INSERT INTO public.exam_incentive_ledger(activity_id,student_no,bonus_points,source,
   entry_title,entry_group_id,reason,created_by_profile_id)
 VALUES(p_activity_id,p_student_no,p_points,'manual',v_title,v_group_id,nullif(btrim(p_reason),''),v_actor);
 RETURN jsonb_build_object('success',true,'points',p_points,'title',v_title,'entry_id',v_group_id);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_grant_named_exam_bonus(text,text,text,integer,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_named_exam_bonus(text,text,text,integer,text,text) TO authenticated;

-- Standalone score items (virtual extra-credit activities, not actual exam activities).
-- The exam ID is a classification anchor for subject/section/term ONLY and never appears
-- as the bonus's own score or maximum. Each conversion approval gets its own group ID.
CREATE OR REPLACE FUNCTION public.get_standalone_exam_incentive_entries(
 p_admin_session_token text DEFAULT NULL,p_student_no text DEFAULT NULL,p_student_session_token text DEFAULT NULL
) RETURNS TABLE(entry_id uuid,activity_id text,student_no text,entry_title text,source text,
 bonus_points bigint,subject_code text,section text,term text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_admin boolean;
BEGIN
 v_admin:=public.recitation_admin_is_valid(p_admin_session_token);
 IF NOT v_admin AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u."studentNo"=p_student_no
 AND lower(coalesce(u.role,''))='student' AND lower(coalesce(u.status,'active'))<>'inactive'
 AND nullif(p_student_session_token,'') IS NOT NULL AND u."activeSessionToken"=p_student_session_token)
 THEN RETURN; END IF;
 RETURN QUERY SELECT coalesce(l.entry_group_id,l.id),l.activity_id,l.student_no,l.entry_title,l.source,
  sum(l.bonus_points)::bigint,a."subjectCode"::text,a.section::text,a.term::text
 FROM public.exam_incentive_ledger l JOIN public.activities a ON a.id::text=l.activity_id
 WHERE v_admin OR l.student_no=p_student_no
 GROUP BY coalesce(l.entry_group_id,l.id),l.activity_id,l.student_no,l.entry_title,l.source,
   a."subjectCode",a.section,a.term
 ORDER BY a."subjectCode",a.section,a.term,l.entry_title,coalesce(l.entry_group_id,l.id),l.student_no;
END;
$$;
REVOKE ALL ON FUNCTION public.get_standalone_exam_incentive_entries(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_standalone_exam_incentive_entries(text,text,text) TO authenticated,anon;

-- Old automatic trigger remains disabled. No code changes scores.score/perfectScore.
DROP TRIGGER IF EXISTS exam_auto_convert_award ON public.recitation_transactions;
DROP FUNCTION IF EXISTS public.exam_auto_convert_recitation_award();
UPDATE public.exam_incentive_rules SET auto_convert=false WHERE auto_convert;
COMMIT;
