# Deployment

1. Add Cloudflare Pages secrets listed in README_SETUP.md.
2. Run Turso migration `migrations/turso/0001_assessments.sql`.
3. Run Supabase migration `migrations/supabase/0001_auth_profiles_rls.sql`.
4. Run `npm install` so Cloudflare can bundle `@libsql/client`.
5. Push to GitHub.
6. In Cloudflare Pages, verify Functions are detected under `functions/api`.
7. Test admin and student assessment flows on the Pages preview before production.
