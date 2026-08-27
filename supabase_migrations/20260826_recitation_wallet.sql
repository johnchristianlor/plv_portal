-- Recitation wallet
-- Secure, auditable chip awards and same-section student transfers.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.recitation_wallets (
  student_no text primary key,
  balance bigint not null default 0,
  pin_hash text,
  failed_pin_attempts integer not null default 0 check (failed_pin_attempts >= 0),
  pin_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recitation_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_type text not null check (transaction_type in ('award', 'deduction', 'transfer')),
  from_student_no text,
  to_student_no text not null,
  amount bigint not null check (amount > 0),
  section text not null,
  subject_code text,
  note text,
  created_by_profile_id text,
  created_at timestamptz not null default now(),
  constraint recitation_transfer_parties_check check (
    transaction_type <> 'transfer'
    or (from_student_no is not null and from_student_no <> to_student_no)
  ),
  constraint recitation_note_length_check check (char_length(coalesce(note, '')) <= 240)
);

create index if not exists recitation_transactions_from_created_idx
  on public.recitation_transactions (from_student_no, created_at desc);
create index if not exists recitation_transactions_to_created_idx
  on public.recitation_transactions (to_student_no, created_at desc);
create index if not exists recitation_transactions_section_created_idx
  on public.recitation_transactions (section, created_at desc);

alter table public.recitation_wallets enable row level security;
alter table public.recitation_transactions enable row level security;
revoke all on table public.recitation_wallets from anon, authenticated;
revoke all on table public.recitation_transactions from anon, authenticated;
grant all on table public.recitation_wallets to service_role;
grant all on table public.recitation_transactions to service_role;

create or replace function public.recitation_admin_is_valid(p_session_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.users u
    where lower(coalesce(u.role, '')) = 'admin'
      and lower(coalesce(u.status, 'active')) <> 'inactive'
      and (u.uid::text = auth.uid()::text or u.id::text = auth.uid()::text)
      and u."activeSessionToken" = p_session_token
      and nullif(p_session_token, '') is not null
  );
$$;

revoke all on function public.recitation_admin_is_valid(text) from public, anon, authenticated;

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

  if not found then
    return jsonb_build_object('success', false, 'code', 'invalid_session');
  end if;

  insert into public.recitation_wallets (student_no)
  values (v_student.student_no)
  on conflict (student_no) do nothing;

  select * into v_wallet
  from public.recitation_wallets
  where student_no = v_student.student_no;

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

create or replace function public.setup_recitation_pin(
  p_student_no text,
  p_session_token text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_valid boolean;
begin
  select exists (
    select 1 from public.users u
    where u."studentNo" = p_student_no
      and lower(coalesce(u.role, '')) = 'student'
      and lower(coalesce(u.status, 'active')) <> 'inactive'
      and u."activeSessionToken" = p_session_token
      and nullif(p_session_token, '') is not null
  ) into v_valid;

  if not v_valid then return jsonb_build_object('success', false, 'code', 'invalid_session'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_pin_format');
  end if;

  insert into public.recitation_wallets (student_no)
  values (p_student_no)
  on conflict (student_no) do nothing;

  update public.recitation_wallets
  set pin_hash = crypt(p_pin, gen_salt('bf', 10)),
      failed_pin_attempts = 0,
      pin_locked_until = null,
      updated_at = now()
  where student_no = p_student_no
    and pin_hash is null;

  if not found then return jsonb_build_object('success', false, 'code', 'pin_already_set'); end if;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.change_recitation_pin(
  p_student_no text,
  p_session_token text,
  p_current_pin text,
  p_new_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_wallet public.recitation_wallets%rowtype;
  v_valid boolean;
begin
  select exists (
    select 1 from public.users u
    where u."studentNo" = p_student_no
      and lower(coalesce(u.role, '')) = 'student'
      and lower(coalesce(u.status, 'active')) <> 'inactive'
      and u."activeSessionToken" = p_session_token
      and nullif(p_session_token, '') is not null
  ) into v_valid;

  if not v_valid then return jsonb_build_object('success', false, 'code', 'invalid_session'); end if;
  if coalesce(p_new_pin, '') !~ '^[0-9]{4}$' then
    return jsonb_build_object('success', false, 'code', 'invalid_pin_format');
  end if;

  select * into v_wallet from public.recitation_wallets
  where student_no = p_student_no for update;
  if not found or v_wallet.pin_hash is null then
    return jsonb_build_object('success', false, 'code', 'pin_not_set');
  end if;
  if v_wallet.pin_locked_until is not null and v_wallet.pin_locked_until > now() then
    return jsonb_build_object('success', false, 'code', 'pin_locked', 'lockedUntil', v_wallet.pin_locked_until);
  end if;

  if crypt(coalesce(p_current_pin, ''), v_wallet.pin_hash) <> v_wallet.pin_hash then
    update public.recitation_wallets
    set failed_pin_attempts = failed_pin_attempts + 1,
        pin_locked_until = case when failed_pin_attempts + 1 >= 5 then now() + interval '15 minutes' else null end,
        updated_at = now()
    where student_no = p_student_no;
    return jsonb_build_object('success', false, 'code', 'invalid_pin');
  end if;

  update public.recitation_wallets
  set pin_hash = crypt(p_new_pin, gen_salt('bf', 10)),
      failed_pin_attempts = 0,
      pin_locked_until = null,
      updated_at = now()
  where student_no = p_student_no;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.list_recitation_recipients(
  p_student_no text,
  p_session_token text,
  p_search text default ''
)
returns table(student_no text, full_name text, section text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_section text;
begin
  select u.section into v_section
  from public.users u
  where u."studentNo" = p_student_no
    and lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
    and u."activeSessionToken" = p_session_token
    and nullif(p_session_token, '') is not null
  limit 1;

  if not found or nullif(btrim(v_section), '') is null then return; end if;

  return query
  select u."studentNo"::text, u."fullName"::text, u.section::text
  from public.users u
  where u."studentNo" <> p_student_no
    and u.section = v_section
    and lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
    and (
      nullif(btrim(coalesce(p_search, '')), '') is null
      or u."fullName" ilike '%' || btrim(p_search) || '%'
      or u."studentNo" ilike '%' || btrim(p_search) || '%'
    )
  order by u."fullName"
  limit 50;
end;
$$;

create or replace function public.transfer_recitation(
  p_student_no text,
  p_session_token text,
  p_recipient_student_no text,
  p_amount bigint,
  p_pin text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sender record;
  v_recipient record;
  v_wallet public.recitation_wallets%rowtype;
begin
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    return jsonb_build_object('success', false, 'code', 'invalid_amount');
  end if;
  if char_length(coalesce(p_note, '')) > 240 then
    return jsonb_build_object('success', false, 'code', 'note_too_long');
  end if;

  select u."studentNo" as student_no, u.section into v_sender
  from public.users u
  where u."studentNo" = p_student_no
    and lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
    and u."activeSessionToken" = p_session_token
    and nullif(p_session_token, '') is not null
  limit 1;
  if not found then return jsonb_build_object('success', false, 'code', 'invalid_session'); end if;

  select u."studentNo" as student_no, u."fullName" as full_name, u.section into v_recipient
  from public.users u
  where u."studentNo" = p_recipient_student_no
    and lower(coalesce(u.role, '')) = 'student'
    and lower(coalesce(u.status, 'active')) <> 'inactive'
  limit 1;
  if not found or p_recipient_student_no = p_student_no then
    return jsonb_build_object('success', false, 'code', 'invalid_recipient');
  end if;
  if nullif(btrim(v_sender.section), '') is null or v_recipient.section is distinct from v_sender.section then
    return jsonb_build_object('success', false, 'code', 'different_section');
  end if;

  insert into public.recitation_wallets (student_no)
  values (p_student_no), (p_recipient_student_no)
  on conflict (student_no) do nothing;

  perform 1 from public.recitation_wallets
  where student_no in (p_student_no, p_recipient_student_no)
  order by student_no for update;

  select * into v_wallet from public.recitation_wallets where student_no = p_student_no;
  if v_wallet.pin_hash is null then return jsonb_build_object('success', false, 'code', 'pin_not_set'); end if;
  if v_wallet.pin_locked_until is not null and v_wallet.pin_locked_until > now() then
    return jsonb_build_object('success', false, 'code', 'pin_locked', 'lockedUntil', v_wallet.pin_locked_until);
  end if;

  if crypt(coalesce(p_pin, ''), v_wallet.pin_hash) <> v_wallet.pin_hash then
    update public.recitation_wallets
    set failed_pin_attempts = failed_pin_attempts + 1,
        pin_locked_until = case when failed_pin_attempts + 1 >= 5 then now() + interval '15 minutes' else null end,
        updated_at = now()
    where student_no = p_student_no;
    return jsonb_build_object('success', false, 'code', 'invalid_pin');
  end if;
  if v_wallet.balance < p_amount then return jsonb_build_object('success', false, 'code', 'insufficient_balance'); end if;

  update public.recitation_wallets
  set balance = balance - p_amount,
      failed_pin_attempts = 0,
      pin_locked_until = null,
      updated_at = now()
  where student_no = p_student_no;

  update public.recitation_wallets
  set balance = balance + p_amount, updated_at = now()
  where student_no = p_recipient_student_no;

  insert into public.recitation_transactions (
    transaction_type, from_student_no, to_student_no, amount, section, note
  ) values (
    'transfer', p_student_no, p_recipient_student_no, p_amount, v_sender.section,
    nullif(btrim(coalesce(p_note, '')), '')
  );

  return jsonb_build_object(
    'success', true,
    'balance', v_wallet.balance - p_amount,
    'recipientName', v_recipient.full_name
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

create or replace function public.admin_award_recitation(
  p_admin_session_token text,
  p_student_no text,
  p_amount bigint,
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
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then
    return jsonb_build_object('success', false, 'code', 'invalid_session');
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    return jsonb_build_object('success', false, 'code', 'invalid_amount');
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

  insert into public.recitation_wallets (student_no, balance)
  values (p_student_no, p_amount)
  on conflict (student_no) do update
  set balance = public.recitation_wallets.balance + excluded.balance,
      updated_at = now();

  insert into public.recitation_transactions (
    transaction_type, to_student_no, amount, section, subject_code, note, created_by_profile_id
  ) values (
    'award', p_student_no, p_amount, coalesce(v_student.section, 'Unassigned'), p_subject_code,
    nullif(btrim(coalesce(p_note, '')), ''), auth.uid()::text
  );

  return jsonb_build_object(
    'success', true,
    'studentName', v_student.full_name,
    'balance', (select balance from public.recitation_wallets where student_no = p_student_no)
  );
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
  p_limit integer default 100,
  p_section text default null,
  p_transaction_type text default null
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
  where (nullif(btrim(coalesce(p_section, '')), '') is null or t.section = p_section)
    and (nullif(btrim(coalesce(p_transaction_type, '')), '') is null or t.transaction_type = p_transaction_type)
  order by t.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 250);
end;
$$;

create or replace function public.admin_reset_recitation_pin(
  p_admin_session_token text,
  p_student_no text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.recitation_admin_is_valid(p_admin_session_token) then
    return jsonb_build_object('success', false, 'code', 'invalid_session');
  end if;
  update public.recitation_wallets
  set pin_hash = null, failed_pin_attempts = 0, pin_locked_until = null, updated_at = now()
  where student_no = p_student_no;
  return jsonb_build_object('success', true);
end;
$$;

revoke all on function public.get_recitation_wallet(text, text) from public;
revoke all on function public.setup_recitation_pin(text, text, text) from public;
revoke all on function public.change_recitation_pin(text, text, text, text) from public;
revoke all on function public.list_recitation_recipients(text, text, text) from public;
revoke all on function public.transfer_recitation(text, text, text, bigint, text, text) from public;
revoke all on function public.get_recitation_transactions(text, text, integer) from public;
revoke all on function public.admin_get_recitation_overview(text, text, text) from public;
revoke all on function public.admin_award_recitation(text, text, bigint, text, text) from public;
revoke all on function public.admin_adjust_recitation(text, text, bigint, text, text, text) from public;
revoke all on function public.admin_get_recitation_transactions(text, integer, text, text) from public;
revoke all on function public.admin_reset_recitation_pin(text, text) from public;

grant execute on function public.get_recitation_wallet(text, text) to anon, authenticated;
grant execute on function public.setup_recitation_pin(text, text, text) to anon, authenticated;
grant execute on function public.change_recitation_pin(text, text, text, text) to anon, authenticated;
grant execute on function public.list_recitation_recipients(text, text, text) to anon, authenticated;
grant execute on function public.transfer_recitation(text, text, text, bigint, text, text) to anon, authenticated;
grant execute on function public.get_recitation_transactions(text, text, integer) to anon, authenticated;
grant execute on function public.admin_get_recitation_overview(text, text, text) to authenticated;
grant execute on function public.admin_award_recitation(text, text, bigint, text, text) to authenticated;
grant execute on function public.admin_adjust_recitation(text, text, bigint, text, text, text) to authenticated;
grant execute on function public.admin_get_recitation_transactions(text, integer, text, text) to authenticated;
grant execute on function public.admin_reset_recitation_pin(text, text) to authenticated;
