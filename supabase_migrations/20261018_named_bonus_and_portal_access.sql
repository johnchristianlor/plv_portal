-- PLV Portal · Named extra credits and all-account access trail
-- Upgrade AFTER the October 18 base, manual conversion, and chip preservation migrations.
-- Back up and test in staging. No existing scores, recitation chips or history deleted.
BEGIN;

ALTER TABLE public.exam_incentive_ledger ADD COLUMN IF NOT EXISTS entry_title text;
UPDATE public.exam_incentive_ledger SET entry_title = CASE
 WHEN source='manual' THEN left(coalesce(nullif(btrim(reason),''),'Exam Incentive'),100)
 ELSE left(coalesce(nullif(btrim(reason),''),'Recitation Conversion'),100) END
WHERE entry_title IS NULL OR btrim(entry_title)='';
ALTER TABLE public.exam_incentive_ledger ALTER COLUMN entry_title SET NOT NULL;
ALTER TABLE public.exam_incentive_ledger ALTER COLUMN entry_title SET DEFAULT 'Exam Incentive';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='exam_incentive_title_length' AND conrelid='public.exam_incentive_ledger'::regclass) THEN
 ALTER TABLE public.exam_incentive_ledger ADD CONSTRAINT exam_incentive_title_length
 CHECK (char_length(btrim(entry_title)) BETWEEN 1 AND 100);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS incentive_named_export ON public.exam_incentive_ledger(activity_id,student_no,entry_title);

-- Award independent extra-credit records; never alter scores.score, scores.activityId,
-- the examination's perfectScore, or a student's recitation wallet.
CREATE OR REPLACE FUNCTION public.admin_grant_named_exam_bonus(
 p_admin_session_token text,p_activity_id text,p_student_no text,p_points integer,p_title text,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_actor text; v_activity record; v_title text;
BEGIN
 v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
 IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 IF p_points IS NULL OR p_points NOT BETWEEN 1 AND 1000 THEN RETURN jsonb_build_object('success',false,'code','invalid_points'); END IF;
 v_title:=nullif(btrim(p_title),'');
 IF v_title IS NULL OR char_length(v_title)>100 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 IF char_length(coalesce(p_reason,''))>240 THEN RETURN jsonb_build_object('success',false,'code','reason_too_long'); END IF;
 SELECT a."subjectCode" AS subject_code,a.section INTO v_activity
 FROM public.activities a WHERE a.id::text=p_activity_id AND a.category='exam' LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','exam_not_found'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.enrollments e WHERE e."studentNo"=p_student_no
    AND e."subjectCode"=v_activity.subject_code AND e.section=v_activity.section) THEN
    RETURN jsonb_build_object('success',false,'code','student_not_enrolled'); END IF;
 INSERT INTO public.exam_incentive_ledger(activity_id,student_no,bonus_points,source,entry_title,reason,created_by_profile_id)
 VALUES(p_activity_id,p_student_no,p_points,'manual',v_title,nullif(btrim(p_reason),''),v_actor);
 RETURN jsonb_build_object('success',true,'points',p_points,'title',v_title);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_grant_named_exam_bonus(text,text,text,integer,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_named_exam_bonus(text,text,text,integer,text,text) TO authenticated;

-- Manually convert complete chip groups into independent named awards.
-- This intentionally removes the OLD exam-headroom cap: incentive points are
-- outside the examination's maximum and may legitimately raise overall points
-- above the examination maximum, without changing the raw exam result.
CREATE OR REPLACE FUNCTION public.exam_redeem_wallet(
 p_activity_id text,p_student_no text,p_actor text,p_source text,
 p_reason text DEFAULT NULL,p_recitation_transaction_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_rate integer;v_balance bigint;v_points bigint;v_spend bigint;v_remaining bigint;v_title text;
BEGIN
 IF p_source IS DISTINCT FROM 'recitation_manual' THEN
  RETURN jsonb_build_object('success',false,'code','manual_only'); END IF;
 v_title:=coalesce(nullif(btrim(p_reason),''),'Recitation Conversion');
 IF char_length(v_title)>100 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 SELECT r.recitation_rate INTO v_rate FROM public.exam_incentive_rules r
 JOIN public.activities a ON a.id::text=r.activity_id AND a.category='exam'
 WHERE r.activity_id=p_activity_id LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','rule_required'); END IF;
 IF v_rate IS NULL OR v_rate<1 THEN RETURN jsonb_build_object('success',false,'code','invalid_rate'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.enrollments e JOIN public.activities a ON a.id::text=p_activity_id
  WHERE e."studentNo"=p_student_no AND e."subjectCode"=a."subjectCode" AND e.section=a.section)
  THEN RETURN jsonb_build_object('success',false,'code','student_not_enrolled'); END IF;
 INSERT INTO public.recitation_wallets(student_no,balance) VALUES(p_student_no,0)
 ON CONFLICT(student_no) DO NOTHING;
 SELECT w.balance INTO v_balance FROM public.recitation_wallets w WHERE w.student_no=p_student_no FOR UPDATE;
 IF v_balance IS NULL OR v_balance<0 THEN RETURN jsonb_build_object('success',false,'code','invalid_wallet_balance'); END IF;
 -- Entire transaction is atomic; wallet row lock prevents concurrent double redemption.
 v_points:=least(v_balance/v_rate,100000::bigint,2147483647::bigint/v_rate);
 IF v_points<1 THEN RETURN jsonb_build_object('success',false,'code','below_rate',
   'balance',v_balance,'retained',v_balance,'spent',0,'points',0,'needed',v_rate-v_balance); END IF;
 v_spend:=v_points*v_rate;
 UPDATE public.recitation_wallets SET balance=balance-v_spend,updated_at=now()
 WHERE student_no=p_student_no AND balance>=v_spend RETURNING balance INTO v_remaining;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','balance_changed','spent',0,'points',0); END IF;
 INSERT INTO public.exam_incentive_ledger(activity_id,student_no,bonus_points,source,recitation_spent,
   conversion_rate,recitation_transaction_id,entry_title,reason,created_by_profile_id)
 VALUES(p_activity_id,p_student_no,v_points::integer,'recitation_manual',v_spend::integer,v_rate,
   p_recitation_transaction_id,v_title,'Manually approved conversion',p_actor);
 RETURN jsonb_build_object('success',true,'points',v_points,'spent',v_spend,'rate',v_rate,
   'balance',v_remaining,'retained',v_remaining,'title',v_title);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_redeem_wallet(text,text,text,text,text,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.admin_convert_named_recitation(
 p_admin_session_token text,p_activity_id text,p_student_no text,p_title text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_actor text;
BEGIN
 v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
 IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 RETURN public.exam_redeem_wallet(p_activity_id,p_student_no,v_actor,'recitation_manual',p_title,null);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_convert_named_recitation(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_convert_named_recitation(text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_convert_named_recitation_section(
 p_admin_session_token text,p_activity_id text,p_section text,p_title text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_actor text;v_exam record;v_student record;v_result jsonb;
 v_converted integer:=0;v_skipped integer:=0;v_points bigint:=0;v_spent bigint:=0;v_checked integer:=0;
BEGIN
 v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
 IF v_actor IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 IF nullif(btrim(p_title),'') IS NULL OR char_length(btrim(p_title))>100
 THEN RETURN jsonb_build_object('success',false,'code','invalid_title'); END IF;
 SELECT a.section,a."subjectCode" AS subject_code INTO v_exam FROM public.activities a
 WHERE a.id::text=p_activity_id AND a.category='exam' LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','exam_not_found'); END IF;
 IF v_exam.section IS DISTINCT FROM p_section THEN RETURN jsonb_build_object('success',false,'code','section_mismatch'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.exam_incentive_rules r WHERE r.activity_id=p_activity_id)
 THEN RETURN jsonb_build_object('success',false,'code','rule_required'); END IF;
 FOR v_student IN SELECT DISTINCT e."studentNo" AS student_no FROM public.enrollments e
  WHERE e."subjectCode"=v_exam.subject_code AND e.section=v_exam.section ORDER BY e."studentNo"
 LOOP
  v_checked:=v_checked+1;
  v_result:=public.exam_redeem_wallet(p_activity_id,v_student.student_no,v_actor,'recitation_manual',p_title,null);
  IF coalesce((v_result->>'success')::boolean,false) THEN
   v_converted:=v_converted+1;v_points:=v_points+(v_result->>'points')::bigint;v_spent:=v_spent+(v_result->>'spent')::bigint;
  ELSE v_skipped:=v_skipped+1;END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'checked',v_checked,'converted',v_converted,'skipped',v_skipped,
  'points',v_points,'spent',v_spent,'title',p_title);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_convert_named_recitation_section(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_convert_named_recitation_section(text,text,text,text) TO authenticated;

-- Named bonus lines for scores, Excel and CSV, instead of altering the original exam.
CREATE OR REPLACE FUNCTION public.get_named_exam_incentive_entries(
 p_admin_session_token text DEFAULT NULL,p_student_no text DEFAULT NULL,p_student_session_token text DEFAULT NULL
) RETURNS TABLE(activity_id text,student_no text,entry_title text,source text,bonus_points bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_admin boolean;
BEGIN
 v_admin:=public.recitation_admin_is_valid(p_admin_session_token);
 IF NOT v_admin AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u."studentNo"=p_student_no
  AND lower(coalesce(u.role,''))='student' AND lower(coalesce(u.status,'active'))<>'inactive'
  AND nullif(p_student_session_token,'') IS NOT NULL AND u."activeSessionToken"=p_student_session_token)
 THEN RETURN; END IF;
 RETURN QUERY SELECT l.activity_id,l.student_no,l.entry_title,l.source,sum(l.bonus_points)::bigint
 FROM public.exam_incentive_ledger l WHERE v_admin OR l.student_no=p_student_no
 GROUP BY l.activity_id,l.student_no,l.entry_title,l.source ORDER BY l.activity_id,l.student_no,l.entry_title,l.source;
END;
$$;
REVOKE ALL ON FUNCTION public.get_named_exam_incentive_entries(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_named_exam_incentive_entries(text,text,text) TO authenticated,anon;

CREATE OR REPLACE FUNCTION public.admin_get_named_incentive_history(p_admin_session_token text,p_limit integer DEFAULT 200)
RETURNS TABLE(id uuid,activity_id text,exam_title text,student_no text,student_name text,entry_title text,
 source text,bonus_points integer,recitation_spent integer,conversion_rate integer,reason text,
 admin_name text,created_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
BEGIN
 IF NOT public.recitation_admin_is_valid(p_admin_session_token) THEN RETURN; END IF;
 RETURN QUERY SELECT l.id,l.activity_id,a.title::text,l.student_no,
 coalesce(s."fullName",l.student_no)::text,l.entry_title,l.source,l.bonus_points,l.recitation_spent,
 l.conversion_rate,l.reason,coalesce(u."fullName",l.created_by_profile_id,'System')::text,l.created_at
 FROM public.exam_incentive_ledger l
 LEFT JOIN public.activities a ON a.id::text=l.activity_id
 LEFT JOIN public.users s ON s."studentNo"=l.student_no AND lower(s.role)='student'
 LEFT JOIN public.users u ON (u.id::text=l.created_by_profile_id OR u.uid::text=l.created_by_profile_id) AND lower(u.role)='admin'
 ORDER BY l.created_at DESC,l.id DESC LIMIT least(greatest(coalesce(p_limit,200),1),500);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_get_named_incentive_history(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_named_incentive_history(text,integer) TO authenticated;

-- Student audit: immutable history, recorded only for the current validated session.
CREATE TABLE IF NOT EXISTS public.student_session_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_no text NOT NULL,actor_name text NOT NULL,
 actor_email text,action text NOT NULL CHECK(action IN ('login','logout')),
 session_fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS student_session_events_created ON public.student_session_events(created_at DESC);
CREATE INDEX IF NOT EXISTS student_session_events_student ON public.student_session_events(student_no,created_at DESC);
ALTER TABLE public.student_session_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_session_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.student_session_events TO service_role;

CREATE OR REPLACE FUNCTION public.student_log_portal_session_event(
 p_student_no text,p_session_token text,p_action text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE v_user record;
BEGIN
 IF p_action NOT IN ('login','logout') THEN RETURN jsonb_build_object('success',false,'code','invalid_action'); END IF;
 IF nullif(p_session_token,'') IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 SELECT u."studentNo" AS student_no,coalesce(nullif(u."fullName",''),u."studentNo") AS name,u.email
 INTO v_user FROM public.users u WHERE u."studentNo"=p_student_no
 AND lower(coalesce(u.role,''))='student' AND lower(coalesce(u.status,'active'))<>'inactive'
 AND u."activeSessionToken"=p_session_token LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','invalid_session'); END IF;
 INSERT INTO public.student_session_events(student_no,actor_name,actor_email,action,session_fingerprint)
 VALUES(v_user.student_no,v_user.name,v_user.email,p_action,encode(extensions.digest(p_session_token,'sha256'),'hex'));
 RETURN jsonb_build_object('success',true);
END;
$$;
REVOKE ALL ON FUNCTION public.student_log_portal_session_event(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_log_portal_session_event(text,text,text) TO authenticated,anon;

-- Filter in the database rather than filtering a truncated latest-50 result.
-- Inclusive Philippine local calendar dates, handled by PostgreSQL time zones.
CREATE OR REPLACE FUNCTION public.admin_get_portal_access_trail(
 p_admin_session_token text,p_date_from date DEFAULT NULL,p_date_to date DEFAULT NULL,
 p_role text DEFAULT NULL,p_action text DEFAULT NULL,p_search text DEFAULT NULL,
 p_limit integer DEFAULT 100,p_offset integer DEFAULT 0
) RETURNS TABLE(id uuid,actor_name text,actor_email text,actor_role text,action text,created_at timestamptz,total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,extensions AS $$
BEGIN
 IF public.exam_incentive_admin_id(p_admin_session_token) IS NULL THEN RETURN; END IF;
 IF p_role IS NOT NULL AND p_role NOT IN ('student','admin') THEN RETURN; END IF;
 IF p_action IS NOT NULL AND p_action NOT IN ('login','logout') THEN RETURN; END IF;
 RETURN QUERY WITH combined AS (
  SELECT a.id,a.actor_name,a.actor_email,'admin'::text AS actor_role,a.action,a.created_at FROM public.admin_session_events a
  UNION ALL SELECT s.id,s.actor_name,s.actor_email,'student'::text AS actor_role,s.action,s.created_at FROM public.student_session_events s
 ),filtered AS (
  SELECT c.* FROM combined c WHERE
   (p_date_from IS NULL OR c.created_at >= (p_date_from::timestamp AT TIME ZONE 'Asia/Manila'))
   AND (p_date_to IS NULL OR c.created_at < ((p_date_to+1)::timestamp AT TIME ZONE 'Asia/Manila'))
   AND (p_role IS NULL OR c.actor_role=p_role)
   AND (p_action IS NULL OR c.action=p_action)
   AND (nullif(btrim(p_search),'') IS NULL OR c.actor_name ILIKE '%'||btrim(p_search)||'%'
      OR c.actor_email ILIKE '%'||btrim(p_search)||'%')
 ) SELECT f.id,f.actor_name,f.actor_email,f.actor_role,f.action,f.created_at,count(*) OVER ()::bigint
   FROM filtered f ORDER BY f.created_at DESC,f.id DESC
   LIMIT least(greatest(coalesce(p_limit,100),1),200) OFFSET greatest(coalesce(p_offset,0),0);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_get_portal_access_trail(text,date,date,text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_portal_access_trail(text,date,date,text,text,text,integer,integer) TO authenticated;

-- Strictly manual only: no triggers react to recitation awards.
DROP TRIGGER IF EXISTS exam_auto_convert_award ON public.recitation_transactions;
DROP FUNCTION IF EXISTS public.exam_auto_convert_recitation_award();
UPDATE public.exam_incentive_rules SET auto_convert=false WHERE auto_convert;
COMMIT;
