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
- `recitation_wallets` (created by the Recitation migration)
- `recitation_transactions` (created by the Recitation migration)

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

## Recitation wallet

Apply `supabase_migrations/20260826_recitation_wallet.sql` before opening the new Admin or Student Recitation pages. It creates the wallet and immutable transaction ledger, enables Row Level Security, blocks direct browser access to both tables, and exposes only session-validated database functions.

Student PINs are stored only as bcrypt hashes. Student transfers are atomic, limited to active classmates in the same section, and protected by a five-attempt lockout. Instructor awards require an authenticated admin session and a subject in which the student is enrolled.
