# Cross-platform portal contract

The website and Flutter application use the same production data sources.

## Shared services

- Supabase Auth: administrator and student sessions.
- Supabase PostgreSQL: `users`, `sections`, `subjects`, `class_schedules`,
  `enrollments`, `activities`, `scores`, `attendance`, `settings`, `deadlines`,
  `announcements`, and `sharedFiles`.
- Cloudflare Pages Functions: authenticated Backblaze avatar and shared-file
  upload/download operations.
- Backblaze B2: private file objects. Clients store only the B2 object reference.

The browser reads its public Supabase configuration from
`public/supabase-adapter.js`. Flutter reads the equivalent values from
`lib/core/config/portal_config.dart` and supports production overrides through
`--dart-define`.

## Student feature mapping

| Feature | Website | Flutter | Source |
| --- | --- | --- | --- |
| Login/profile | `index.html`, dashboard/settings | Login, Home, Profile | Supabase Auth + `users` |
| Scores | `student-scores.html` | Scores tab | `activities`, `scores`, `enrollments` |
| Grades | `student-grades.html` | Grades tab | `enrollments`, `subjects`, activity scores |
| Attendance | `student-attendance.html` | Attendance tab | `attendance` |
| Schedule | Dashboard | Home schedule view | `class_schedules`, `enrollments` |
| Announcements/deadlines | Dashboard notifications | Home/Announcements | `announcements`, `deadlines` |
| Avatar | Dashboard/settings | Home/Profile | Cloudflare avatar API + B2 |

## Administrator feature mapping

Website administration remains the full management workspace. The mobile
administrator view provides the workflows suited to a phone: overview,
student lookup/editing, QR lookup, activity scoring, attendance marking, and
activity management. Changes made by either client are written to the same
Supabase rows and are visible to the other client after refresh.

## Required production values

Website Cloudflare environment:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (secret, Functions only)
- `B2_KEY_ID` (secret)
- `B2_APPLICATION_KEY` (secret)
- `B2_BUCKET_ID`

Flutter release build:

```powershell
flutter build apk --release `
  --dart-define=SUPABASE_URL=YOUR_SUPABASE_URL `
  --dart-define=SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY `
  --dart-define=PORTAL_API_BASE=https://YOUR_PORTAL_DOMAIN
```

Never provide the Supabase service-role key or Backblaze credentials to the
Flutter build.

## Verification

Website:

```powershell
node --test tests/portal-connectivity-smoke.mjs
```

Flutter:

```powershell
flutter analyze
flutter test
```
