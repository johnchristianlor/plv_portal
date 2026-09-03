# Activity Score Storage Fix

This project includes a compatibility repair for the Admin Activities score-saving error.

## What was fixed

- The secure score writer now supports both legacy **text IDs** and newer **UUID IDs**.
- The Cloudflare score API now falls back to a safe service-role table write when an older/incompatible RPC is installed, including the PostgreSQL `text = uuid` failure.
- Legacy non-UUID activity IDs are accepted when they match the portal's safe record-ID format.
- Score IDs receive a database default appropriate for either text or UUID schemas.
- Decimal scores, autosave, duplicate protection, enrollment checks, and same-day absence rules remain enforced.

## Required deployment step

The website code cannot change an already-hosted Supabase schema by itself. In your Supabase project:

1. Open **SQL Editor**.
2. Open `RUN_THIS_IN_SUPABASE_ACTIVITY_SCORE_FIX.sql` from this project.
3. Paste the whole SQL file and click **Run**.
4. The final result should show `activity_score_write_ready = true`.
5. Redeploy this corrected project so the updated `functions/api/admin/activity-score.js` is live.

## Cloudflare Pages server variables

Keep `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, plus **one** server-side Supabase secret:

- `SUPABASE_SECRET_KEY` for a modern `sb_secret_...` key, or
- `SUPABASE_SERVICE_ROLE_KEY` for a legacy service-role JWT.

Never place the server secret in `public/` or browser JavaScript.

## Verification

After deployment, open `/api/admin/activity-score` on the deployed portal. A repaired RPC should report a JSON response with `ready: true`. Then open Admin Activities and save a score.

If the RPC has not been repaired yet, the updated POST endpoint can still use its secure server-side fallback for compatible older score tables; applying the SQL repair is still recommended because it restores the atomic database writer.
