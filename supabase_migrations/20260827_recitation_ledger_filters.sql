-- Server-side filters for the administrator Recitation ledger.

drop function if exists public.admin_get_recitation_transactions(text, integer);

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

revoke all on function public.admin_get_recitation_transactions(text, integer, text, text) from public;
grant execute on function public.admin_get_recitation_transactions(text, integer, text, text) to authenticated;
