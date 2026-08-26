-- Administrator Recitation adjustments
-- Allows authorized admins to add or reduce chips, including below zero.
-- Student-to-student transfers still require a sufficient positive balance.

alter table public.recitation_wallets
  drop constraint if exists recitation_wallets_balance_check;

alter table public.recitation_transactions
  drop constraint if exists recitation_transactions_transaction_type_check;

alter table public.recitation_transactions
  add constraint recitation_transactions_transaction_type_check
  check (transaction_type in ('award', 'deduction', 'transfer'));

create or replace function public.get_recitation_wallet(
  p_student_no text,
  p_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_student record;
  v_wallet public.recitation_wallets%rowtype;
begin
  select u."studentNo" as student_no, u."fullName" as full_name, u.section
    into v_student
  from public.users u
  where u."studentNo" = p_student_no
    and lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
    and u."activeSessionToken" = p_session_token
    and nullif(p_session_token, '') is not null
  limit 1;

  if not found then return jsonb_build_object('success', false, 'code', 'invalid_session'); end if;

  insert into public.recitation_wallets (student_no)
  values (v_student.student_no)
  on conflict (student_no) do nothing;

  select * into v_wallet from public.recitation_wallets where student_no = v_student.student_no;

  return jsonb_build_object(
    'success', true,
    'studentNo', v_student.student_no,
    'fullName', v_student.full_name,
    'section', v_student.section,
    'balance', v_wallet.balance,
    'pinSet', v_wallet.pin_hash is not null,
    'pinLockedUntil', v_wallet.pin_locked_until,
    'totalEarned', coalesce((
      select sum(t.amount) from public.recitation_transactions t
      where t.to_student_no = v_student.student_no
        and t.transaction_type <> 'deduction'
    ), 0),
    'totalShared', coalesce((
      select sum(t.amount) from public.recitation_transactions t
      where t.from_student_no = v_student.student_no
        and t.transaction_type = 'transfer'
    ), 0)
  );
end;
$$;

create or replace function public.get_recitation_transactions(
  p_student_no text,
  p_session_token text,
  p_limit integer default 50
)
returns table(
  id uuid,
  transaction_type text,
  direction text,
  amount bigint,
  counterparty_name text,
  subject_code text,
  note text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1 from public.users u
    where u."studentNo" = p_student_no
      and lower(coalesce(u.role, '')) = 'student'
      and lower(coalesce(u.status, 'active')) <> 'inactive'
      and u."activeSessionToken" = p_session_token
      and nullif(p_session_token, '') is not null
  ) then return; end if;

  return query
  select t.id,
         t.transaction_type,
         case when t.transaction_type = 'award' then 'earned'
              when t.transaction_type = 'deduction' then 'deducted'
              when t.from_student_no = p_student_no then 'sent' else 'received' end,
         t.amount,
         case when t.transaction_type = 'award' then 'Instructor award'
              when t.transaction_type = 'deduction' then 'Instructor adjustment'
              when t.from_student_no = p_student_no then coalesce(receiver."fullName", t.to_student_no)
              else coalesce(sender."fullName", t.from_student_no) end,
         t.subject_code,
         t.note,
         t.created_at
  from public.recitation_transactions t
  left join public.users sender on sender."studentNo" = t.from_student_no
  left join public.users receiver on receiver."studentNo" = t.to_student_no
  where t.from_student_no = p_student_no or t.to_student_no = p_student_no
  order by t.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

create or replace function public.admin_get_recitation_overview(
  p_admin_session_token text,
  p_section text default null,
  p_search text default null
)
returns table(
  student_no text,
  full_name text,
  section text,
  balance bigint,
  pin_set boolean,
  total_earned bigint,
  total_shared bigint
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then return; end if;

  return query
  select u."studentNo"::text,
         u."fullName"::text,
         u.section::text,
         coalesce(w.balance, 0)::bigint,
         (w.pin_hash is not null),
         coalesce((select sum(t.amount) from public.recitation_transactions t where t.to_student_no = u."studentNo" and t.transaction_type <> 'deduction'), 0)::bigint,
         coalesce((select sum(t.amount) from public.recitation_transactions t where t.from_student_no = u."studentNo" and t.transaction_type = 'transfer'), 0)::bigint
  from public.users u
  left join public.recitation_wallets w on w.student_no = u."studentNo"
  where lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
    and (nullif(btrim(coalesce(p_section, '')), '') is null or u.section = p_section)
    and (
      nullif(btrim(coalesce(p_search, '')), '') is null
      or u."fullName" ilike '%' || btrim(p_search) || '%'
      or u."studentNo" ilike '%' || btrim(p_search) || '%'
    )
  order by u.section, u."fullName";
end;
$$;

create or replace function public.admin_adjust_recitation(
  p_admin_session_token text,
  p_student_no text,
  p_amount bigint,
  p_adjustment_type text,
  p_subject_code text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_student record;
  v_transaction_type text;
  v_delta bigint;
  v_balance bigint;
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then
    return jsonb_build_object('success', false, 'code', 'invalid_session');
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    return jsonb_build_object('success', false, 'code', 'invalid_amount');
  end if;
  if lower(coalesce(p_adjustment_type, '')) not in ('add', 'reduce') then
    return jsonb_build_object('success', false, 'code', 'invalid_adjustment_type');
  end if;
  if nullif(btrim(coalesce(p_subject_code, '')), '') is null then
    return jsonb_build_object('success', false, 'code', 'subject_required');
  end if;
  if char_length(coalesce(p_note, '')) > 240 then
    return jsonb_build_object('success', false, 'code', 'note_too_long');
  end if;

  select u."studentNo" as student_no, u."fullName" as full_name, u.section into v_student
  from public.users u
  where u."studentNo" = p_student_no
    and lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
  limit 1;
  if not found then return jsonb_build_object('success', false, 'code', 'student_not_found'); end if;

  if not exists (
    select 1 from public.enrollments e
    where e."studentNo" = p_student_no and e."subjectCode" = p_subject_code
  ) then return jsonb_build_object('success', false, 'code', 'subject_not_enrolled'); end if;

  v_transaction_type := case when lower(p_adjustment_type) = 'reduce' then 'deduction' else 'award' end;
  v_delta := case when v_transaction_type = 'deduction' then -p_amount else p_amount end;

  insert into public.recitation_wallets (student_no, balance)
  values (p_student_no, v_delta)
  on conflict (student_no) do update
  set balance = public.recitation_wallets.balance + excluded.balance,
      updated_at = now()
  returning balance into v_balance;

  insert into public.recitation_transactions (
    transaction_type, to_student_no, amount, section, subject_code, note, created_by_profile_id
  ) values (
    v_transaction_type, p_student_no, p_amount, coalesce(v_student.section, 'Unassigned'), p_subject_code,
    nullif(btrim(coalesce(p_note, '')), ''), auth.uid()::text
  );

  return jsonb_build_object(
    'success', true,
    'adjustmentType', lower(p_adjustment_type),
    'studentName', v_student.full_name,
    'balance', v_balance
  );
end;
$$;

create or replace function public.admin_get_recitation_transactions(
  p_admin_session_token text,
  p_limit integer default 100
)
returns table(
  id uuid,
  transaction_type text,
  from_name text,
  to_name text,
  amount bigint,
  section text,
  subject_code text,
  note text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then return; end if;
  return query
  select t.id, t.transaction_type,
         coalesce(sender."fullName", case when t.transaction_type in ('award', 'deduction') then 'Instructor' else t.from_student_no end),
         coalesce(receiver."fullName", t.to_student_no),
         t.amount, t.section, t.subject_code, t.note, t.created_at
  from public.recitation_transactions t
  left join public.users sender on sender."studentNo" = t.from_student_no
  left join public.users receiver on receiver."studentNo" = t.to_student_no
  order by t.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 250);
end;
$$;

revoke all on function public.admin_adjust_recitation(text, text, bigint, text, text, text) from public;
grant execute on function public.admin_adjust_recitation(text, text, bigint, text, text, text) to authenticated;
