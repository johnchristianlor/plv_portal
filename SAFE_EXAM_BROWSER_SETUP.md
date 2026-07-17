# Safe Exam Browser Setup for PLV Portal

PLV Portal supports two practical assessment paths:

- **Monitored / Strict** works in ordinary browsers and records events the browser exposes, including tab hiding, focus loss, fullscreen exit, clipboard actions, printing, navigation, network loss, duplicate tabs, and duplicate sessions.
- **Require Safe Exam Browser** only starts after the Cloudflare Function validates the approved SEB Config Key for the exact assessment URL.

The portal does not request camera, microphone, or screen-sharing access.

## Platform support

Official Safe Exam Browser supports Windows, macOS, and iOS/iPadOS. It does not currently provide the equivalent official Android exam client. For Android, use Monitored or Strict mode for ordinary quizzes, or a school-managed Android kiosk solution for high-stakes exams.

A normal webpage cannot reliably detect Android screenshots, Smart Panel, split-screen, floating apps, or a second device. Do not treat the absence of an incident as proof that none occurred.

## Create the SEB configuration

1. Install the official Safe Exam Browser Config Tool on an administrator computer.
2. Set the Start URL to `https://YOUR_DOMAIN/student-assessments.html`.
3. Save the configuration for **starting an exam**, not for configuring a client permanently.
4. Set a strong quit password. iOS Assessment Mode requires a quit password to activate its protected mode.
5. Enable **Use Browser & Config Keys** so SEB provides the Config Key through its HTTP header or JavaScript API.
6. Disable unrelated applications, unrestricted navigation, printing, screenshots, clipboard access, downloads, and new windows according to school policy.
7. Allow the PLV Portal domain and the Supabase endpoints required for login. Test the final allowlist before an actual exam.
8. Save the final encrypted `.seb` file.
9. Copy the final 64-character **Config Key** only after saving. Changing and re-saving the SEB configuration changes this key.
10. Host the encrypted `.seb` file at a stable HTTPS address or use an approved `seb://` / `sebs://` launch link.

## Cloudflare configuration

Add these under **Cloudflare Pages > Settings > Variables and secrets > Production**:

- `SEB_CONFIG_KEY` as **Secret**: the 64-character Config Key copied from the final SEB configuration.
- `SEB_LAUNCH_URL` as **Text**: the stable HTTPS, `seb://`, or `sebs://` link that opens the approved `.seb` configuration.
- `SEB_STUDENT_INSTRUCTIONS` as **Text**: optional short instructions shown before launch.

For key rotation, `SEB_CONFIG_KEYS` may be stored as a Secret containing comma-separated current and previous Config Keys. Remove the previous key after the transition period. When both names exist, `SEB_CONFIG_KEYS` takes precedence.

Do not put the Config Key, quit password, admin password, service-role key, Turso token, or Backblaze key in HTML or browser JavaScript.

Redeploy after changing the Cloudflare values. Then open an assessment in Admin, enable **Require Safe Exam Browser**, save it, and test with a non-production student account.

## Student flow

1. The student selects a protected assessment.
2. PLV Portal shows **Open in Safe Exam Browser**.
3. The approved SEB configuration opens the portal. The student may need to sign in again because SEB uses its own browser session.
4. The student selects the assessment inside SEB.
5. The Cloudflare Function validates the Config Key for that exact assessment URL before it creates or resumes an attempt.
6. During the attempt, the existing server timer, autosave, heartbeat, one-session rule, and incident logging remain active.

## Android policy

Do not enable **Require Safe Exam Browser** for a class that must use Android phones. Official SEB cannot open that assessment on Android. Use Monitored or Strict mode instead, keep one active session, randomize questions, use short time windows, and review anomalies as signals rather than automatic proof of cheating.

## Security limits

SEB and browser monitoring reduce common cheating opportunities but do not make an exam perfectly cheat-proof. Pair technical controls with good question design, randomization, clear rules, reasonable time limits, and instructor review.
