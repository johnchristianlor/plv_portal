# Security Notes

The assessment module uses Supabase Auth access tokens verified in Cloudflare Functions against Supabase JWKS. Roles are read only from trusted Auth app metadata. Browser localStorage is not trusted for role or identity.

Secrets must only be stored as encrypted Cloudflare secrets. Do not put service-role, Turso, Backblaze, Cloudflare, or database secrets in frontend files, screenshots, logs, or Git history.

Current known legacy risk: several older portal pages still read `loggedInUser` from localStorage and directly query Supabase. The new assessment module does not use that trust model, but the remaining legacy pages should be refactored to the same server-verified pattern.

Run:

- `npm run test:syntax`
- `npm run scan:secrets`
- `git grep -n password`
- `git log -p --all -S service_role -- .`

If any real secret was committed, rotate it immediately in Supabase, Turso, Backblaze, and Cloudflare.
