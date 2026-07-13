# Supabase Auth Migration

1. Back up Supabase.
2. Apply `migrations/supabase/0001_auth_profiles_rls.sql` except the final password drop line.
3. Run `scripts/migrate-supabase-auth.mjs` locally with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in your shell. Do not paste keys into the file.
4. Verify every student has an Auth user and a `profiles` row.
5. Set administrators with Auth `app_metadata.role = admin`.
6. Update login to call `/api/auth/student-login` for student-number login.
7. Confirm no frontend code reads or compares `users.password`.
8. Drop `users.password`.
9. Revoke old RPC functions: `login_student_secure`, `login_student`, and `update_student_password`.

Login errors must stay generic to avoid account enumeration.
