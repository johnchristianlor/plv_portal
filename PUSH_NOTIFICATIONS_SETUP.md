# Phone Notification Setup

The mobile app now supports real operating-system push notifications through OneSignal. Supabase remains the portal database. OneSignal receives only its anonymous device subscription ID; student names, student numbers, sections, grades, and Supabase user IDs are not placed in the OneSignal message payload.

## 1. Create the OneSignal app

1. In OneSignal, create a Flutter app.
2. Add the Android platform using package name `com.example.plv_portal_app`.
3. In Firebase Console, create or select the Android Firebase project used only for push transport.
4. Upload the FCM V1 service-account credentials to OneSignal. Do not add that service-account JSON to this repository.
5. Copy the OneSignal **App ID** and **App API Key**. The App API Key is private.

Supabase is still the database. Firebase Cloud Messaging is only the Android operating-system delivery transport required by push providers.

## 2. Apply the Supabase migration

Run `supabase_migrations/20260720_push_subscriptions.sql` in the Supabase SQL Editor. The table is server-only and denies access to `anon` and `authenticated` roles.

## 3. Add Cloudflare configuration

In Cloudflare Pages > PLV Portal > Settings > Variables and secrets, add these to Production and Preview:

| Name | Type | Value |
| --- | --- | --- |
| `ONESIGNAL_APP_ID` | Secret or text | OneSignal App ID |
| `ONESIGNAL_APP_API_KEY` | Secret | OneSignal App API Key |
| `PUSH_WEBHOOK_SECRET` | Secret | A new random value of at least 32 characters |

Keep the existing `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` values. Never put the OneSignal App API Key, webhook secret, or Supabase service-role key in Flutter, HTML, JavaScript, screenshots, or Git.

Redeploy Cloudflare Pages, then confirm `https://plv-portal.pages.dev/api/push/config` returns `configured: true`. This endpoint exposes only the public OneSignal App ID.

## 4. Create Supabase database webhooks

Open Supabase > Database > Webhooks and create HTTP `POST` webhooks to:

`https://plv-portal.pages.dev/api/push/database-event`

Add these headers to every webhook:

* `Content-Type: application/json`
* `Authorization: Bearer YOUR_PUSH_WEBHOOK_SECRET`

Create these events:

| Table | Events |
| --- | --- |
| `announcements` | Insert |
| `scores` | Insert, Update |
| `attendance` | Insert, Update |
| `enrollments` | Update |

Enter the real webhook secret only in the Supabase and Cloudflare dashboards. Do not save it in SQL or source files.

## 5. Run and test Android

1. In `C:\CODE\plv_portal`, run `flutter pub get`.
2. Run `flutter run` and sign in with a Supabase Auth student account.
3. Allow notifications when Android asks.
4. In Profile > Notification preferences, leave the desired categories enabled.
5. Insert a test announcement from the admin website, then background or close the app.
6. The phone should receive a PLV Portal system notification. Tapping it opens the app; the private details remain inside the signed-in portal.

If a student signed in through the legacy password RPC rather than Supabase Auth, the device will not be registered. Native push intentionally requires a valid Supabase Auth session.

## iOS status

The Flutter code is cross-platform, but production iOS push still requires an Apple Developer account, APNs credentials in OneSignal, and OneSignal's iOS Notification Service Extension configured in Xcode. Those Apple signing steps cannot be completed on Windows alone.
