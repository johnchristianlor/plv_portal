# Safe Exam Browser Setup for PLV Portal

This portal now supports a Safe Exam Browser verification path for assessments that require stronger exam control.

Important limitation: normal mobile browsers cannot reliably detect every screenshot, floating app, Smart Panel, split-screen, or second-app action. The portal records browser events that the phone exposes, but Android system overlays and screenshots are often not exposed to webpages. Use Safe Exam Browser or a managed/kiosk device when the exam needs stronger control.

## Supported secure-browser path

Safe Exam Browser officially provides downloads for Windows, macOS, and iOS/iPadOS. Android/Infinix phones do not have the same official SEB lockdown path, so use one of these options for high-stakes mobile exams:

- Use school-managed Windows/macOS computers with Safe Exam Browser.
- Use iPads/iPhones with Safe Exam Browser for iOS.
- For Android phones, use a dedicated Android kiosk/exam browser or managed-device policy from your school IT provider.
- For bring-your-own Android devices, keep the portal in Monitored or Strict mode and treat incidents as review signals, not proof.

## Cloudflare secrets

Keep all verifier secrets in Cloudflare Pages encrypted secrets. Do not put them in HTML or browser JavaScript.

Required when secure-browser verification is enabled:

- `SECURE_BROWSER_VERIFIER_URL` = your server-side verifier endpoint
- `SECURE_BROWSER_VERIFIER_SECRET` = shared secret used only between Cloudflare and the verifier
- `SECURE_BROWSER_PUBLIC_INSTRUCTIONS` = optional student instructions URL
- `SECURE_BROWSER_PUBLIC_LAUNCH_URL` = optional SEB launch/config URL

Your existing secrets are still required:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `B2_KEY_ID`
- `B2_APPLICATION_KEY`
- `B2_BUCKET_ID`

## Safe Exam Browser configuration

1. Install Safe Exam Browser Config Tool on a teacher/admin computer.
2. Set the start URL to your PLV exam page, for example:
   - `https://YOUR_DOMAIN/student-exam.html`
3. Allow only the PLV Portal domain and any required Supabase/CDN domains.
4. Disable new windows, external applications, and unrestricted navigation according to your school policy.
5. Enable Browser Exam Key / Config Key transmission to the server. In SEB configuration this is the setting that sends browser and config keys in HTTP headers.
6. Save the `.seb` configuration file.
7. Distribute the `.seb` file only through your official school channel.
8. In PLV Portal admin assessment settings, check **Require Safe Exam Browser** before publishing the test.

## Verification model

The browser sends SEB proof to Cloudflare Pages Functions. Cloudflare then calls your private verifier using `SECURE_BROWSER_VERIFIER_URL` and `SECURE_BROWSER_VERIFIER_SECRET`.

The verifier should check at least:

- The request came from Cloudflare using the shared secret.
- The SEB Config Key / Browser Exam Key matches the approved exam configuration.
- The exam URL matches the configured PLV Portal URL.
- The assessment ID is valid for that configuration.

Never verify based only on the browser user-agent string.

## Recommended exam modes

- **Monitored**: best default for regular quizzes and bring-your-own devices.
- **Strict**: use for higher-stakes exams in normal browsers. Requires fullscreen and stronger warning rules.
- **Require Safe Exam Browser**: use for controlled Windows, macOS, or iPad/iPhone devices after the verifier is configured.

## What this cannot guarantee

No browser-based exam system is perfectly cheat-proof. Safe Exam Browser and monitoring reduce common cheating paths, but they should be paired with clear school rules, assessment design, time limits, randomized questions, and administrator review.
