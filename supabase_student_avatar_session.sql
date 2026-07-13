-- Deprecated: this file previously created insecure student password-login RPCs.
-- Do not reintroduce functions that compare passwords in public tables.
-- Use Supabase Auth plus /api/auth/student-login for student-number login.

revoke all on function public.login_student_secure(text,text,text) from anon, authenticated;
drop function if exists public.login_student_secure(text,text,text);
drop function if exists public.login_student(text,text);
drop function if exists public.update_student_password(text,text,text);

-- Avatar/profile changes should be handled through Auth-protected Cloudflare Functions
-- or RLS policies tied to auth.uid(), never through client-supplied role or password values.
