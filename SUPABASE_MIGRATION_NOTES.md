# Supabase Migration Notes

The static portal now uses `public/supabase-adapter.js` instead of the old backend client SDK imports.

## Supabase tables expected

Create/migrate these tables in Supabase with the same field names used by the app:

- `users`
- `subjects`
- `sections`
- `class_schedules`
- `enrollments`
- `activities`
- `scores`
- `attendance`
- `settings`
- `deadlines`
- `announcements`
- `sharedFiles`

Each table should include a text `id` column. Rows that used old document IDs should keep that value in `id`.

Recommended extra unique/index columns:

- `users.studentNo`
- `users.uid` for Supabase Auth admin users, if used
- `subjects.subjectCode`
- `sections.sectionName`

## Auth behavior

Admin login now uses Supabase Auth through `supabase.auth.signInWithPassword()`. The logged-in admin must also have a matching row in `users`, where `id` or `uid` equals the Supabase Auth user id and `role = 'admin'`.

Student login still uses the existing portal flow by checking `users.studentNo` or `users.email` plus the stored `password` column. This matches the old portal behavior, but storing plain passwords is not recommended for production.

## Row Level Security

If Row Level Security is enabled, add policies that allow the anonymous publishable key to perform the reads/writes this static portal needs, or move writes behind server-side functions.