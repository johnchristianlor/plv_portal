-- PLV student avatar persistence and single-login security
-- Run this once in Supabase SQL Editor.

alter table public.users
  add column if not exists "avatarUrl" text,
  add column if not exists "activeSessionToken" text,
  add column if not exists "activeSessionAt" timestamptz,
  add column if not exists "isOnline" boolean default false,
  add column if not exists "lastSeenAt" timestamptz;

create or replace function public.login_student_secure(
  p_identifier text,
  p_password text,
  p_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
begin
  select * into v_user
  from public.users
  where role = 'student'
    and status is distinct from 'Inactive'
    and password = p_password
    and (
      lower(coalesce("studentNo", '')) = lower(p_identifier)
      or lower(coalesce(username, '')) = lower(p_identifier)
      or lower(coalesce(email, '')) = lower(p_identifier)
    )
  limit 1;

  if not found then
    return null;
  end if;

  update public.users
  set "activeSessionToken" = p_session_token,
      "activeSessionAt" = now(),
      "isOnline" = true,
      "lastSeenAt" = now()
  where id = v_user.id;

  select * into v_user from public.users where id = v_user.id;

  return jsonb_build_object(
    'id', v_user.id,
    'studentNo', v_user."studentNo",
    'username', v_user.username,
    'email', v_user.email,
    'role', v_user.role,
    'status', v_user.status,
    'fullName', v_user."fullName",
    'name', v_user.name,
    'courseYear', v_user."courseYear",
    'section', v_user.section,
    'isFirstLogin', coalesce(v_user."isFirstLogin", false),
    'avatarUrl', v_user."avatarUrl",
    'activeSessionToken', v_user."activeSessionToken"
  );
end;
$$;

create or replace function public.validate_student_session(
  p_student_no text,
  p_session_token text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where "studentNo" = p_student_no
      and role = 'student'
      and status is distinct from 'Inactive'
      and "activeSessionToken" = p_session_token
  );
$$;

create or replace function public.get_student_profile(
  p_student_no text,
  p_session_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
begin
  select * into v_user
  from public.users
  where "studentNo" = p_student_no
    and role = 'student'
    and (p_session_token = '' or "activeSessionToken" = p_session_token)
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'studentNo', v_user."studentNo",
    'email', v_user.email,
    'status', v_user.status,
    'fullName', v_user."fullName",
    'name', v_user.name,
    'courseYear', v_user."courseYear",
    'section', v_user.section,
    'avatarUrl', v_user."avatarUrl",
    'activeSessionToken', v_user."activeSessionToken"
  );
end;
$$;

create or replace function public.update_student_avatar(
  p_student_no text,
  p_session_token text,
  p_avatar_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avatar text;
begin
  update public.users
  set "avatarUrl" = p_avatar_url
  where "studentNo" = p_student_no
    and role = 'student'
    and "activeSessionToken" = p_session_token
  returning "avatarUrl" into v_avatar;

  if v_avatar is null then
    raise exception 'Invalid or expired student session.';
  end if;

  return jsonb_build_object('avatarUrl', v_avatar);
end;
$$;

grant execute on function public.login_student_secure(text,text,text) to anon, authenticated;
grant execute on function public.validate_student_session(text,text) to anon, authenticated;
grant execute on function public.get_student_profile(text,text) to anon, authenticated;
grant execute on function public.update_student_avatar(text,text,text) to anon, authenticated;



create or replace function public.start_admin_session(
  p_profile_id text,
  p_session_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
  set "activeSessionToken" = p_session_token,
      "activeSessionAt" = now(),
      "isOnline" = true,
      "lastSeenAt" = now()
  where id::text = p_profile_id
    and role = 'admin'
    and status is distinct from 'Inactive';

  return found;
end;
$$;

create or replace function public.validate_admin_session(
  p_profile_id text,
  p_session_token text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id::text = p_profile_id
      and role = 'admin'
      and status is distinct from 'Inactive'
      and "activeSessionToken" = p_session_token
  );
$$;

grant execute on function public.start_admin_session(text,text) to anon, authenticated;
grant execute on function public.validate_admin_session(text,text) to anon, authenticated;
