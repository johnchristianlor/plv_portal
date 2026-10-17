-- PLV Portal: chip conservation and explicit manual conversion safety upgrade.
-- Prerequisites (run in this order):
-- 1) 20261018_exam_incentives_and_admin_audit.sql
-- 2) 20261018_manual_recitation_conversion.sql
-- Then run THIS FILE. Re-running is safe; existing ledger entries are not modified.
-- No live database is accessed when shipping this migration.
BEGIN;

-- Extra defence: new recitation rewards must never start an exam conversion.
DROP TRIGGER IF EXISTS exam_auto_convert_award ON public.recitation_transactions;
DROP FUNCTION IF EXISTS public.exam_auto_convert_recitation_award();
UPDATE public.exam_incentive_rules SET auto_convert = false WHERE auto_convert;
ALTER TABLE public.exam_incentive_rules ALTER COLUMN auto_convert SET DEFAULT false;

-- Important invariants:
-- * Only a human-triggered administrator RPC may call this function.
-- * Insufficient (< rate) / zero chips / a full exam -> no wallet debit, no ledger row.
-- * Exactly one whole group (balance=rate) -> one point, exactly rate chips spent.
-- * Remainder is kept (e.g. balance=8, rate=3 -> 2 points / 6 spent / 2 left).
-- * A per-student wallet row lock serializes redemptions, and the bonus advisory lock
--   serializes incentives for the same student/exam.
-- * The wallet debit and bonus-ledger credit form one PostgreSQL transaction;
--   SQL errors roll both actions back.
CREATE OR REPLACE FUNCTION public.exam_redeem_wallet(
  p_activity_id text, p_student_no text, p_actor text, p_source text,
  p_reason text DEFAULT NULL, p_recitation_transaction_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,extensions AS $$
DECLARE
  v_rate integer;
  v_max numeric;
  v_raw numeric := 0;
  v_existing bigint := 0;
  v_balance bigint := 0;
  v_capacity bigint := 0;
  v_convertible bigint := 0;
  v_points bigint := 0;
  v_spend bigint := 0;
  v_remaining bigint := 0;
BEGIN
  -- The retired automatic route is invalid even if a caller attempts it.
  IF p_source IS DISTINCT FROM 'recitation_manual' THEN
    RETURN jsonb_build_object('success',false,'code','manual_only');
  END IF;
  SELECT r.recitation_rate, a."perfectScore"::numeric INTO v_rate,v_max
    FROM public.exam_incentive_rules r
    JOIN public.activities a ON a.id::text=r.activity_id AND a.category='exam'
    WHERE r.activity_id=p_activity_id LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','rule_required'); END IF;
  IF v_rate IS NULL OR v_rate<1 OR v_max IS NULL OR v_max<=0 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_exam_rule');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.enrollments e JOIN public.activities a ON a.id::text=p_activity_id
    WHERE e."studentNo"=p_student_no AND e."subjectCode"=a."subjectCode" AND e.section=a.section
  ) THEN RETURN jsonb_build_object('success',false,'code','student_not_enrolled'); END IF;

  INSERT INTO public.recitation_wallets(student_no,balance)
    VALUES(p_student_no,0) ON CONFLICT(student_no) DO NOTHING;
  SELECT w.balance INTO v_balance FROM public.recitation_wallets w
    WHERE w.student_no=p_student_no FOR UPDATE;
  IF v_balance IS NULL OR v_balance<0 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_wallet_balance');
  END IF;
  -- Lock bonus ledger calculations for the selected exam/student.
  PERFORM pg_advisory_xact_lock(hashtextextended('exam_bonus:'||p_activity_id||':'||p_student_no,0));
  SELECT coalesce(s.score::numeric,0) INTO v_raw
    FROM public.scores s WHERE s."activityId"::text=p_activity_id
      AND s."studentNo"=p_student_no ORDER BY s.id DESC LIMIT 1;
  v_raw := coalesce(v_raw,0);
  SELECT coalesce(sum(l.bonus_points),0)::bigint INTO v_existing
    FROM public.exam_incentive_ledger l
    WHERE l.activity_id=p_activity_id AND l.student_no=p_student_no;

  v_capacity := greatest(0,floor(v_max - v_raw - v_existing))::bigint;
  v_convertible := v_balance / v_rate; -- INT division: only COMPLETE groups.
  IF v_capacity=0 THEN
    RETURN jsonb_build_object('success',false,'code','exam_full',
      'balance',v_balance,'retained',v_balance,'spent',0,'points',0);
  END IF;
  IF v_convertible=0 THEN
    RETURN jsonb_build_object('success',false,'code','below_rate',
      'balance',v_balance,'retained',v_balance,'spent',0,'points',0,'needed',v_rate-v_balance);
  END IF;

  -- Ledger permits at most 100000 points per transaction. Never debit chips
  -- outside the amount that will be credited on this same transaction.
  v_points := least(v_convertible,v_capacity,100000::bigint);
  v_spend := v_points * v_rate;
  UPDATE public.recitation_wallets SET balance=balance-v_spend,updated_at=now()
    WHERE student_no=p_student_no AND balance>=v_spend
    RETURNING balance INTO v_remaining;
  IF NOT FOUND THEN
    -- Defensive failure if another implementation unexpectedly changed wallet state.
    RETURN jsonb_build_object('success',false,'code','balance_changed','spent',0,'points',0);
  END IF;
  INSERT INTO public.exam_incentive_ledger(
    activity_id,student_no,bonus_points,source,recitation_spent,
    conversion_rate,recitation_transaction_id,reason,created_by_profile_id
  ) VALUES (
    p_activity_id,p_student_no,v_points::integer,'recitation_manual',v_spend::integer,
    v_rate,p_recitation_transaction_id,p_reason,p_actor
  );
  RETURN jsonb_build_object('success',true,'points',v_points,'spent',v_spend,
    'rate',v_rate,'balance',v_remaining,'retained',v_remaining);
END;
$$;

REVOKE ALL ON FUNCTION public.exam_redeem_wallet(text,text,text,text,text,uuid)
  FROM PUBLIC,anon,authenticated;
-- Existing admin_convert_recitation_to_exam and admin_convert_recitation_section
-- are SECURITY DEFINER functions that validate administrator sessions and
-- call this helper internally. Do not grant clients direct execution.
COMMIT;
