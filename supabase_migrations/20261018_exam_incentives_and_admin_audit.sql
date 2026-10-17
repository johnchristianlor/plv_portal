-- 18 October 2026: exam incentives, recitation redemption, and admin access audit.
-- Run AFTER the recitation wallet + admin single-session migrations.
-- All writes use authenticated SECURITY DEFINER RPCs. Never put a service key in the browser.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.exam_incentive_rules (
  activity_id text primary key,
  subject_code text not null,
  section text not null,
  recitation_rate integer not null default 3 check (recitation_rate between 1 and 1000),
  auto_convert boolean not null default false,
  changed_by text,
  updated_at timestamptz not null default now()
);
create unique index if not exists exam_incentive_single_auto_target
  on public.exam_incentive_rules (subject_code, section) where auto_convert;

create table if not exists public.exam_incentive_ledger (
  id uuid primary key default gen_random_uuid(),
  activity_id text not null,
  student_no text not null,
  bonus_points integer not null check (bonus_points between 1 and 100000),
  source text not null check (source in ('manual','recitation_manual','recitation_auto')),
  recitation_spent integer not null default 0 check (recitation_spent >= 0),
  conversion_rate integer check (conversion_rate is null or conversion_rate between 1 and 1000),
  recitation_transaction_id uuid,
  reason text check (char_length(coalesce(reason,'')) <= 240),
  created_by_profile_id text,
  created_at timestamptz not null default now(),
  constraint incentive_redemption_snapshot check (
    (source = 'manual' and recitation_spent = 0 and conversion_rate is null)
    or (source <> 'manual' and conversion_rate is not null and recitation_spent = bonus_points * conversion_rate)
  )
);
create index if not exists exam_incentive_student_activity on public.exam_incentive_ledger (student_no, activity_id);
create index if not exists exam_incentive_recent on public.exam_incentive_ledger (created_at desc);

create table if not exists public.admin_session_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id text not null,
  actor_auth_uid text not null,
  actor_name text not null,
  actor_email text,
  action text not null check (action in ('login','logout')),
  session_fingerprint text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_session_events_recent on public.admin_session_events (created_at desc);

alter table public.exam_incentive_rules enable row level security;
alter table public.exam_incentive_ledger enable row level security;
alter table public.admin_session_events enable row level security;
revoke all on public.exam_incentive_rules, public.exam_incentive_ledger, public.admin_session_events from anon, authenticated;
grant all on public.exam_incentive_rules, public.exam_incentive_ledger, public.admin_session_events to service_role;

-- Profile ID is looked up server-side; never trust the actor name sent by a browser.
create or replace function public.exam_incentive_admin_id(p_token text) returns text
language sql stable security definer set search_path=public,extensions as $$
  select u.id::text from public.users u
  where public.recitation_admin_is_valid(p_token)
    and lower(coalesce(u.role,'')) = 'admin'
    and (u.uid::text = auth.uid()::text or u.id::text = auth.uid()::text)
    and u."activeSessionToken" = p_token
  limit 1;
$$;
revoke all on function public.exam_incentive_admin_id(text) from public, anon, authenticated;

create or replace function public.admin_log_session_event(p_admin_session_token text, p_action text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_admin record;
begin
  if p_action not in ('login','logout') then return jsonb_build_object('success',false,'code','invalid_action'); end if;
  if not public.recitation_admin_is_valid(p_admin_session_token) then
    return jsonb_build_object('success',false,'code','invalid_session');
  end if;
  select u.id::text as id, coalesce(nullif(u."fullName",''),u.email,'Administrator') as name, u.email
    into v_admin from public.users u
    where lower(coalesce(u.role,''))='admin'
    and (u.uid::text=auth.uid()::text or u.id::text=auth.uid()::text)
    and u."activeSessionToken"=p_admin_session_token limit 1;
  if not found then return jsonb_build_object('success',false,'code','invalid_session'); end if;
  insert into public.admin_session_events (actor_profile_id,actor_auth_uid,actor_name,actor_email,action,session_fingerprint)
  values (v_admin.id,auth.uid()::text,v_admin.name,v_admin.email,p_action,
          encode(extensions.digest(p_admin_session_token,'sha256'),'hex'));
  return jsonb_build_object('success',true);
end;
$$;
revoke all on function public.admin_log_session_event(text,text) from public;
grant execute on function public.admin_log_session_event(text,text) to authenticated;

create or replace function public.admin_get_session_history(p_admin_session_token text, p_limit integer default 50)
returns table (id uuid,actor_name text,actor_email text,action text,created_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then return; end if;
  return query select e.id,e.actor_name,e.actor_email,e.action,e.created_at
    from public.admin_session_events e order by e.created_at desc,e.id desc
    limit least(greatest(coalesce(p_limit,50),1),200);
end;
$$;
revoke all on function public.admin_get_session_history(text,integer) from public;
grant execute on function public.admin_get_session_history(text,integer) to authenticated;

-- Used by every score/report view. Students may only request their own totals
-- with their active student session; admins must supply the active admin token.
create or replace function public.get_exam_incentive_totals(
  p_admin_session_token text default null,
  p_student_no text default null,
  p_student_session_token text default null
) returns table (activity_id text,student_no text,bonus_points bigint)
language plpgsql stable security definer set search_path=public,extensions as $$
declare v_admin boolean;
begin
  v_admin := public.recitation_admin_is_valid(p_admin_session_token);
  if not v_admin and not exists (
    select 1 from public.users u where u."studentNo" = p_student_no
    and lower(coalesce(u.role,''))='student'
    and lower(coalesce(u.status,'active')) <> 'inactive'
    and u."activeSessionToken"=p_student_session_token
    and nullif(p_student_session_token,'') is not null
  ) then return; end if;
  return query select l.activity_id,l.student_no,sum(l.bonus_points)::bigint
    from public.exam_incentive_ledger l
    where v_admin or l.student_no=p_student_no
    group by l.activity_id,l.student_no
    order by l.activity_id,l.student_no;
end;
$$;
revoke all on function public.get_exam_incentive_totals(text,text,text) from public;
grant execute on function public.get_exam_incentive_totals(text,text,text) to authenticated,anon;

create or replace function public.admin_get_exam_incentive_rules(p_admin_session_token text)
returns table(activity_id text,recitation_rate integer,auto_convert boolean,updated_at timestamptz)
language plpgsql stable security definer set search_path=public,extensions as $$
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then return; end if;
  return query select r.activity_id,r.recitation_rate,r.auto_convert,r.updated_at
  from public.exam_incentive_rules r order by r.updated_at desc;
end;
$$;
revoke all on function public.admin_get_exam_incentive_rules(text) from public;
grant execute on function public.admin_get_exam_incentive_rules(text) to authenticated;

create or replace function public.admin_set_exam_incentive_rule(
  p_admin_session_token text,p_activity_id text,p_rate integer,p_auto_convert boolean
) returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_activity record; v_actor text;
begin
  v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
  if v_actor is null then return jsonb_build_object('success',false,'code','invalid_session'); end if;
  if p_rate is null or p_rate not between 1 and 1000 then
    return jsonb_build_object('success',false,'code','invalid_rate'); end if;
  select a.id::text as id,a."subjectCode" as subject_code,a.section
    into v_activity from public.activities a where a.id::text=p_activity_id and a.category='exam' limit 1;
  if not found then return jsonb_build_object('success',false,'code','exam_not_found'); end if;
  -- Serialize configuration changes, so only one automatic destination exists per class.
  perform pg_advisory_xact_lock(hashtextextended(v_activity.subject_code||':'||v_activity.section,0));
  if coalesce(p_auto_convert,false) then
    return jsonb_build_object('success',false,'code','automatic_conversion_disabled');
  end if;
  insert into public.exam_incentive_rules(activity_id,subject_code,section,recitation_rate,auto_convert,changed_by)
  values(p_activity_id,v_activity.subject_code,v_activity.section,p_rate,false,v_actor)
  on conflict(activity_id) do update set recitation_rate=excluded.recitation_rate,
    auto_convert=false,subject_code=excluded.subject_code,
    section=excluded.section,changed_by=excluded.changed_by,updated_at=now();
  return jsonb_build_object('success',true);
end;
$$;
revoke all on function public.admin_set_exam_incentive_rule(text,text,integer,boolean) from public;
grant execute on function public.admin_set_exam_incentive_rule(text,text,integer,boolean) to authenticated;

create or replace function public.admin_grant_exam_incentive(
  p_admin_session_token text,p_activity_id text,p_student_no text,p_points integer,p_reason text default null
) returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_activity record; v_actor text; v_raw numeric; v_previous bigint; v_available numeric;
begin
  v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
  if v_actor is null then return jsonb_build_object('success',false,'code','invalid_session'); end if;
  if p_points is null or p_points not between 1 and 1000 then
    return jsonb_build_object('success',false,'code','invalid_points'); end if;
  if char_length(coalesce(p_reason,''))>240 then return jsonb_build_object('success',false,'code','reason_too_long'); end if;
  select a.id::text as id,a."subjectCode" as subject_code,a.section, a."perfectScore" as maximum
    into v_activity from public.activities a where a.id::text=p_activity_id and a.category='exam' limit 1;
  if not found then return jsonb_build_object('success',false,'code','exam_not_found'); end if;
  if not exists(select 1 from public.enrollments e where e."studentNo"=p_student_no
    and e."subjectCode"=v_activity.subject_code and e.section=v_activity.section) then
    return jsonb_build_object('success',false,'code','student_not_enrolled'); end if;
  perform pg_advisory_xact_lock(hashtextextended('exam_bonus:'||p_activity_id||':'||p_student_no,0));
  select s.score::numeric into v_raw from public.scores s
    where s."activityId"::text=p_activity_id and s."studentNo"=p_student_no limit 1;
  select coalesce(sum(l.bonus_points),0) into v_previous from public.exam_incentive_ledger l
    where l.activity_id=p_activity_id and l.student_no=p_student_no;
  v_available:=greatest(0,v_activity.maximum::numeric-coalesce(v_raw,0)-v_previous);
  if p_points>v_available then
    return jsonb_build_object('success',false,'code','bonus_exceeds_max','available',v_available);
  end if;
  insert into public.exam_incentive_ledger (activity_id,student_no,bonus_points,source,reason,created_by_profile_id)
  values (p_activity_id,p_student_no,p_points,'manual',nullif(btrim(coalesce(p_reason,'')),''),v_actor);
  return jsonb_build_object('success',true,'points',p_points);
end;
$$;
revoke all on function public.admin_grant_exam_incentive(text,text,text,integer,text) from public;
grant execute on function public.admin_grant_exam_incentive(text,text,text,integer,text) to authenticated;

-- Atomic conversion. Wallet row locking prevents concurrent redemptions from double-spending.
create or replace function public.exam_redeem_wallet(
  p_activity_id text,p_student_no text,p_actor text,p_source text,p_reason text default null,
  p_recitation_transaction_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_rule record; v_balance bigint; v_points integer; v_spend integer; v_raw numeric;
begin
  select r.recitation_rate,a."perfectScore" as maximum
  into v_rule from public.exam_incentive_rules r
  join public.activities a on a.id::text=r.activity_id and a.category='exam'
  where r.activity_id=p_activity_id limit 1;
  if not found then return jsonb_build_object('success',false,'code','rule_required'); end if;
  if not exists (select 1 from public.enrollments e join public.activities a
    on a.id::text=p_activity_id where e."studentNo"=p_student_no and e.section=a.section
    and e."subjectCode"=a."subjectCode") then
    return jsonb_build_object('success',false,'code','student_not_enrolled'); end if;
  insert into public.recitation_wallets(student_no,balance) values (p_student_no,0)
    on conflict(student_no) do nothing;
  select w.balance into v_balance from public.recitation_wallets w
    where w.student_no=p_student_no for update;
  perform pg_advisory_xact_lock(hashtextextended('exam_bonus:'||p_activity_id||':'||p_student_no,0));
  select s.score::numeric into v_raw from public.scores s
    where s."activityId"::text=p_activity_id and s."studentNo"=p_student_no limit 1;
  -- Do not deduct wallet points that can no longer increase this exam result.
  select least(greatest(floor(v_rule.maximum::numeric - coalesce(v_raw,0) - coalesce(sum(l.bonus_points),0)),0),
               greatest(floor(v_balance::numeric/v_rule.recitation_rate),0))::integer
    into v_points from public.exam_incentive_ledger l
    where l.activity_id=p_activity_id and l.student_no=p_student_no;
  if v_points<1 then return jsonb_build_object('success',false,'code','insufficient_or_full','balance',v_balance); end if;
  v_spend:=v_points*v_rule.recitation_rate;
  update public.recitation_wallets set balance=balance-v_spend,updated_at=now()
    where student_no=p_student_no;
  insert into public.exam_incentive_ledger(activity_id,student_no,bonus_points,source,recitation_spent,
    conversion_rate,recitation_transaction_id,reason,created_by_profile_id)
  values (p_activity_id,p_student_no,v_points,p_source,v_spend,v_rule.recitation_rate,
    p_recitation_transaction_id,p_reason,p_actor);
  return jsonb_build_object('success',true,'points',v_points,'spent',v_spend,'rate',v_rule.recitation_rate,'balance',v_balance-v_spend);
end;
$$;
revoke all on function public.exam_redeem_wallet(text,text,text,text,text,uuid) from public,anon,authenticated;

create or replace function public.admin_convert_recitation_to_exam(
  p_admin_session_token text,p_activity_id text,p_student_no text
) returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_actor text;
begin
  v_actor:=public.exam_incentive_admin_id(p_admin_session_token);
  if v_actor is null then return jsonb_build_object('success',false,'code','invalid_session'); end if;
  return public.exam_redeem_wallet(p_activity_id,p_student_no,v_actor,'recitation_manual','Admin conversion of available recitation chips',null);
end;
$$;
revoke all on function public.admin_convert_recitation_to_exam(text,text,text) from public;
grant execute on function public.admin_convert_recitation_to_exam(text,text,text) to authenticated;

-- Manual-only mode: no recitation insert trigger is installed.
-- Recitation awards NEVER invoke exam_redeem_wallet.
drop trigger if exists exam_auto_convert_award on public.recitation_transactions;
drop function if exists public.exam_auto_convert_recitation_award();

create or replace function public.admin_get_exam_incentive_history(p_admin_session_token text,p_limit integer default 200)
returns table (id uuid,activity_id text,exam_title text,student_no text,student_name text,
  source text,bonus_points integer,recitation_spent integer,conversion_rate integer,
  reason text,admin_name text,created_at timestamptz)
language plpgsql stable security definer set search_path=public,extensions as $$
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then return; end if;
  return query select l.id,l.activity_id,a.title::text,l.student_no,
    coalesce(s."fullName",l.student_no)::text,l.source,l.bonus_points,l.recitation_spent,
    l.conversion_rate,l.reason,coalesce(u."fullName",l.created_by_profile_id,'System')::text,l.created_at
  from public.exam_incentive_ledger l
  left join public.activities a on a.id::text=l.activity_id
  left join public.users s on s."studentNo"=l.student_no and lower(s.role)='student'
  left join public.users u on (u.id::text=l.created_by_profile_id or u.uid::text=l.created_by_profile_id) and lower(u.role)='admin'
  order by l.created_at desc,l.id desc limit least(greatest(coalesce(p_limit,200),1),500);
end;
$$;
revoke all on function public.admin_get_exam_incentive_history(text,integer) from public;
grant execute on function public.admin_get_exam_incentive_history(text,integer) to authenticated;

commit;
