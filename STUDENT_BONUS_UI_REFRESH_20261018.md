# PLV Student bonus UI refresh (18 October 2026)

## What changed
- **Student Scores**: Displays recitation and manual extra-credit approvals as compact, named bonus score cards. The original exam score remains unchanged and credits still count toward the combined earned total.
- **Student Recitation**: New rewards overview for available chips, earned bonus points, and configured exams, followed by simplified status cards and approved recitation bonus history.
- Removed verbose developer-facing explanations and repeated chip-wallet warnings from the student-facing UI.
- Fixed a page-load timing issue: the wallet balance now loads before conversion previews, including refresh and after a successful student transfer.
- Student recitation history is filtered to actual recitation conversions; manual plus points remain visible on Student Scores.

## Installation (update an existing portal)
Deploy the files under `public/` in the same relative paths. Hard-refresh both student pages after deployment.
This release changes frontend presentation and a wallet-loading sequence only. **No new SQL migration** is needed on top of the previous standalone recitation-incentive database setup.

## Tests and deployment notes
Run: `node --test tests/*.mjs`
The page layouts were visually checked at 1440px and 390px. Backend data calls were not exercised against a live Supabase project; confirm with a test student who has a wallet and at least one approved credit before deploying to all users.
