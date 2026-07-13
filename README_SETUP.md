# PLV Portal Setup

This project is a static PLV portal hosted on Cloudflare Pages with Pages Functions, Supabase Auth/PostgreSQL, Turso/libSQL for detailed assessments, and private Backblaze B2 file storage.

## Install

1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` for local development and fill values locally only.
4. Never commit `.dev.vars`, `.env`, service-role keys, Turso tokens, Backblaze keys, or Cloudflare tokens.

## Cloudflare secrets

Add these as encrypted Cloudflare Pages secrets:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `B2_KEY_ID`
- `B2_APPLICATION_KEY`
- `B2_BUCKET_ID`
- `B2_BUCKET_NAME`

## Turso

Create a Turso database, then run `migrations/turso/0001_assessments.sql` with the Turso CLI or dashboard SQL runner.

## Supabase

Apply `migrations/supabase/0001_auth_profiles_rls.sql` after reviewing existing table names. Set user roles in Auth `app_metadata.role` to `admin` or `student` using the server route or Supabase admin tools.

## Run locally

Use Cloudflare Pages local development so Functions are available:

`npx wrangler pages dev public`

## Deploy

Commit changes and push to GitHub. Cloudflare Pages will build from `public` and deploy Functions from `functions`.
