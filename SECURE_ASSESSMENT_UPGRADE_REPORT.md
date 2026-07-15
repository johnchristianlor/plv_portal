# PLV Portal Layered Secure Assessment Upgrade

## 1. Architecture summary

The assessment system remains an extension of the existing PLV Portal rather than a replacement.

- **Frontend:** static HTML, CSS, and vanilla JavaScript under `public/`.
- **Hosting and trusted API:** Cloudflare Pages and Cloudflare Pages Functions.
- **Authentication and profile/session validation:** Supabase.
- **Assessment source of truth:** Turso/libSQL through `functions/api/assessments/[[path]].js`.
- **File storage:** Backblaze B2 remains unchanged.
- **Administrator workflow:** stays inside the existing same-tab assessment page.
- **Student exam:** remains a dedicated `student-exam.html` view.

The upgrade adds four real security modes—Standard, Monitored, Strict, and Secure Browser Ready—using one normalized assessment security configuration stored in `assessments.settings_json`. Legacy `fullscreen`, `maxViolations`, and `autoSubmitOnViolation` fields continue to load and save.

New attempts use server-owned exam sessions. The server validates identity, section assignment, availability, attempt eligibility, session ownership, official deadline, question selection, scoring, warning policy, and finalization. The browser receives only the assigned runtime questions and public security settings.

## 2. Modified files

- `functions/api/assessments/[[path]].js`
- `public/admin-assessments.html`
- `public/admin-assessments-module.js`
- `public/student-assessments-module.js`
- `public/student-exam.html`
- `public/student-exam-module.js`
- `public/_headers`
- `turso_assessments_schema.sql`
- `SECURE_ASSESSMENT_INTEGRATION.md`

## 3. New files

- `public/exam-incident-codes.js`
- `public/exam-security-config.js`
- `public/exam-security-manager.js`
- `public/exam-offline-store.js`
- `public/exam-session-client.js`
- `public/exam-secure-browser-verifier.js`
- `tests/assessment-security-smoke.mjs`
- `tests/validate-assessment-security.mjs`
- `ASSESSMENT_SECURITY_TEST_MATRIX.md`
- `SECURE_ASSESSMENT_UPGRADE_REPORT.md`

The following architecture files were inspected and intentionally preserved without migration to another backend:

- `public/supabase-adapter.js`
- `public/student-session.js`
- `supabase_assessments_secure.sql`
- `wrangler.toml`

## 4. Turso migration and schema

### Production migration strategy

`ensureSchema()` in `functions/api/assessments/[[path]].js` is the repeatable production migration path. It:

1. Creates missing tables.
2. reads `PRAGMA table_info(...)`;
3. adds only missing columns with guarded `ALTER TABLE`;
4. backfills attempt numbers;
5. resolves pre-existing duplicate incident event IDs;
6. creates the required indexes and uniqueness constraints.

This is necessary because SQLite/libSQL does not consistently support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. The schema below is complete for a new database. Existing deployments should deploy the updated Pages Function first so its guarded migration can safely upgrade the current database without deleting data.

```sql
-- PLV Portal assessment schema (Turso/libSQL)
-- New installations can run this file directly.
-- Existing installations are upgraded safely and repeatedly by ensureSchema()
-- in functions/api/assessments/[[path]].js, which checks PRAGMA table_info
-- before issuing each ALTER TABLE statement.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    instructions TEXT,
    subject_code TEXT,
    section TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    opens_at TEXT,
    closes_at TEXT,
    settings_json TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_questions (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 1,
    answer_key TEXT,
    choices_json TEXT,
    category TEXT,
    difficulty TEXT,
    explanation TEXT,
    order_no INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assessment_attempts (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    student_no TEXT NOT NULL,
    student_name TEXT,
    student_uid TEXT,
    status TEXT NOT NULL,
    answers_json TEXT,
    score REAL NOT NULL DEFAULT 0,
    total_points REAL NOT NULL DEFAULT 0,
    violations INTEGER NOT NULL DEFAULT 0,
    attempt_no INTEGER,
    warning_count REAL NOT NULL DEFAULT 0,
    security_score REAL NOT NULL DEFAULT 0,
    submission_reason TEXT,
    active_session_id TEXT,
    last_heartbeat_at TEXT,
    last_saved_at TEXT,
    expired_at TEXT,
    finalized_at TEXT,
    security_status TEXT NOT NULL DEFAULT 'normal',
    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_notes TEXT,
    save_version INTEGER NOT NULL DEFAULT 0,
    last_question_index INTEGER NOT NULL DEFAULT 0,
    flagged_json TEXT,
    started_at TEXT NOT NULL,
    submitted_at TEXT,
    deadline_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assessment_sessions (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    assessment_id TEXT NOT NULL,
    student_no TEXT NOT NULL,
    client_session_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    tab_instance_id TEXT,
    device_id TEXT,
    device_type TEXT,
    browser_name TEXT,
    operating_system TEXT,
    user_agent_summary TEXT,
    ip_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    ended_at TEXT,
    termination_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES assessment_attempts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assessment_incidents (
    id TEXT PRIMARY KEY,
    attempt_id TEXT,
    assessment_id TEXT,
    student_no TEXT,
    type TEXT NOT NULL,
    details TEXT,
    client_event_id TEXT,
    session_id TEXT,
    event_group TEXT,
    severity TEXT NOT NULL DEFAULT 'low',
    warning_weight REAL NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT,
    first_detected_at TEXT,
    last_detected_at TEXT,
    duration_seconds REAL NOT NULL DEFAULT 0,
    action_taken TEXT,
    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_admin_audit (
    id TEXT PRIMARY KEY,
    assessment_id TEXT,
    attempt_id TEXT,
    incident_id TEXT,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assessments_status_section ON assessments(status, section);
CREATE INDEX IF NOT EXISTS idx_questions_assessment_order ON assessment_questions(assessment_id, order_no);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON assessment_attempts(student_no, assessment_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_assessment ON assessment_attempts(assessment_id, started_at);
CREATE INDEX IF NOT EXISTS idx_attempts_review ON assessment_attempts(review_status, security_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempt_number
    ON assessment_attempts(assessment_id, student_no, attempt_no)
    WHERE attempt_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_attempt ON assessment_sessions(attempt_id, status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON assessment_sessions(student_no, assessment_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_token_hash ON assessment_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_incidents_attempt ON assessment_incidents(attempt_id, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_assessment ON assessment_incidents(assessment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_student ON assessment_incidents(student_no, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_session ON assessment_incidents(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_review ON assessment_incidents(review_status, severity, created_at);
DROP INDEX IF EXISTS uq_incident_client_event;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_client_event_attempt
    ON assessment_incidents(attempt_id, client_event_id)
    WHERE client_event_id IS NOT NULL AND client_event_id <> '';
CREATE INDEX IF NOT EXISTS idx_admin_audit_attempt ON assessment_admin_audit(attempt_id, created_at);

-- Existing production tables are intentionally not altered here because
-- SQLite/libSQL does not support ADD COLUMN IF NOT EXISTS consistently.
-- Deploying the Pages Function runs the guarded migration logic automatically.
```

## 5. Cloudflare environment variables

Use Cloudflare Pages secrets or local `.dev.vars`. Never commit real values.

### Existing required assessment variables

```text
TURSO_DATABASE_URL=https://<database-name>-<organization>.turso.io
TURSO_AUTH_TOKEN=<server-only-turso-token>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<supabase-publishable-key>
```

### Recommended privacy variable

```text
ASSESSMENT_PRIVACY_SALT=<random-server-only-value>
```

This is used only to create a short privacy-conscious hash of server connection metadata. Raw IP addresses are not stored by the assessment code.

### Optional existing Supabase backend variable

```text
SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
```

This is optional for the current profile lookup implementation. It must remain a Cloudflare server secret and must never appear in `public/`.

### Optional secure-browser integration variables

```text
SECURE_BROWSER_VERIFIER_URL=https://<approved-verification-service>/verify
SECURE_BROWSER_VERIFIER_SECRET=<server-only-verification-secret>
SECURE_BROWSER_PUBLIC_INSTRUCTIONS=<public setup instructions>
SECURE_BROWSER_PUBLIC_LAUNCH_URL=https://<approved-public-launch-or-configuration-url>
```

When these are absent, Secure Browser Ready preflight reports **Unavailable** and blocks the exam if verification is required. It does not pretend that verification succeeded.

Backblaze variables remain unchanged and are not used by the assessment security modules.

## 6. Header changes

`public/_headers` keeps HSTS, `X-Content-Type-Options`, referrer policy, frame protection, CSP, and no-store behavior.

The global Permissions Policy denies camera, microphone, and display capture. A narrow route override for `/student-exam.html` allows only same-origin access when an administrator has explicitly enabled an optional media-state check:

```text
/student-exam.html
  Cache-Control: no-store, no-cache, must-revalidate, max-age=0
  Pragma: no-cache
  Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()
```

The secure exam module and each new exam-security module also use no-store caching.

No secure-browser verification endpoint or private credential is added to frontend JavaScript.

## 7. Local testing

1. Keep the project structure intact and open its root folder.
2. Create `.dev.vars` with placeholder names shown above and your actual development values.
3. Run the automated validation:

```bash
node tests/validate-assessment-security.mjs
node tests/assessment-security-smoke.mjs
```

4. Start Cloudflare Pages locally:

```bash
npx wrangler pages dev public
```

5. Sign in with a test administrator and create one assessment for each security mode.
6. Use separate test student accounts and sections.
7. Complete the browser-specific checks listed in `ASSESSMENT_SECURITY_TEST_MATRIX.md`.
8. Verify that answer keys do not appear in the Network panel responses from `/student/list`, `/student/preflight`, `/student/start`, or `/student/restore`.
9. Verify that a direct request for an assessment assigned to another section returns `403`.
10. Verify that the official deadline returned by the server does not change when the device clock changes.

## 8. After-deployment testing

Deploy to a staging Cloudflare Pages project before production.

1. Confirm Turso migration completed by opening an assessment route and checking that the new session and audit tables exist.
2. Test Supabase access-token refresh with a long-running staging assessment.
3. Test Android Chrome and iPhone Safari behavior for application switching, background suspension, keyboard opening, orientation changes, reconnection, and page restoration.
4. Test desktop Chrome, Edge, Firefox, and Safari for fullscreen support and event differences.
5. Confirm route-specific camera, microphone, and display-capture permissions.
6. Confirm audit pagination, filters, timeline, false-positive review, recovery approval, invalidation, reopening, and CSV export.
7. Confirm Cloudflare logs contain useful server diagnostics but student responses remain generic.
8. Confirm no production assessment is published until the assigned section, schedule, maximum attempts, warning policy, and recovery policy have been reviewed.

## 9. Enabling the security modes

### Standard

Select **Standard** in Assessment Details → Security and Monitoring.

Default behavior:

- server-controlled availability and deadline;
- one attempt;
- server-assigned question and choice order;
- autosaving and restore;
- server-side scoring;
- duplicate session prevention;
- no aggressive focus or fullscreen monitoring by default.

### Monitored

Select **Monitored**.

This adds configurable browser-event monitoring for tab changes, focus, fullscreen changes, clipboard actions, context menu, drag/drop, printing, restricted shortcuts, browser navigation, connection changes, and duplicate sessions. Events use cooldowns and weighted policies rather than treating every browser event equally.

### Strict

Select **Strict**.

This requires fullscreen when supported, adds a configurable pause/final-warning flow, and can disable backtracking or use one question per page. Automatic submission is controlled by server-side warning policy and is not triggered by a single default low-severity event.

Camera, microphone, and screen-sharing checks remain off until individually enabled.

### Secure Browser Ready

Select **Secure Browser Ready** only when an approved provider is available.

Configure the public provider name and public configuration ID in the assessment. Configure the private verification endpoint and secret only in Cloudflare environment variables. The student must receive a successful server verification result before starting.

Without a real provider bridge and backend verifier, the mode remains an integration-ready blocked state. User-agent text alone is never accepted as verification.

## 10. Implemented features

- Standard, Monitored, Strict, and Secure Browser Ready modes.
- Legacy settings compatibility.
- Server section-assignment enforcement.
- Active-account and published/open/closed validation.
- Default one-attempt enforcement and configurable maximum attempts.
- Unique attempt-number constraint.
- Active-attempt resume and stable runtime questions.
- Official server deadline capped by the assessment closing time.
- Deadline enforcement on start, autosave, heartbeat, incident, submit, list, and explicit finalization.
- Latest server-saved answers used for time-expired finalization.
- Fresh Supabase session retrieval and one 401 refresh retry.
- Canonical incident codes with aliases for existing records.
- Event policy controls for enabled state, severity, warning weight, pause, fullscreen restoration, auto-submit eligibility, cooldown, and tolerated count.
- Focus/visibility grouping and cooldown-based false-positive reduction.
- Per-event client IDs and server idempotency.
- Bounded offline incident batch synchronization.
- Save-version ordering and idempotent autosave.
- IndexedDB storage for pending answers, question position, flags, and incidents.
- Heartbeats and scoped server session tokens whose hashes are stored in Turso.
- Duplicate tab/device rejection and stale-session recovery.
- Optional media availability and track-state checks without recording or uploading media.
- Server-controlled warning/pause/automatic-submission decisions.
- Sanitized student security settings and answer-key exclusion.
- Administrator filters, pagination, summary, timeline, incident review, false-positive marking, recovery approval, attempt invalidation/reopening, and audit export.
- Same-tab administrator workflow.
- Timer, channel, listener, media, and IndexedDB cleanup.

## 11. Integration-ready placeholders

The secure-browser provider boundary is implemented, but real verification requires an approved provider:

- `SecureBrowserVerifier`
- `NoSecureBrowserVerifier`
- approved provider bridge using `globalThis.PLV_SECURE_BROWSER_BRIDGE`
- server verifier using `SECURE_BROWSER_VERIFIER_URL` and `SECURE_BROWSER_VERIFIER_SECRET`

No fake Safe Exam Browser validation is present. No private Browser Exam Key, Config Key, signing key, or verification secret is stored in assessment settings returned to students.

The optional media checks detect availability and whether a required track stops. They do not record, upload, analyze, or retain camera, microphone, or screen content.

## 12. Browser limitations that remain

A normal website cannot guarantee that cheating is impossible. It cannot reliably detect:

- a second physical phone;
- paper notes;
- another person outside the camera view;
- all screenshots or operating-system capture tools;
- all AI usage;
- virtual machines;
- hidden hardware;
- DevTools in every browser;
- operating-system-level application activity;
- every mobile application switch;
- browser suspension when the operating system stops JavaScript entirely.

A Print Screen key event indicates only that a shortcut was pressed, not that an image was captured.

Fullscreen, Page Visibility, focus, clipboard, media, and screen-sharing APIs vary by browser and operating system. iPhone and Android browsers cannot be locked down like a managed secure-browser application. Missing heartbeats are detected when a later request or recovery occurs; no background scheduler is claimed.

Security events are audit signals. They should be reviewed with context and must not be treated as automatic proof of misconduct.

## 13. Security weaknesses corrected

- Direct API start requests now validate the student’s section.
- Submitted attempts and maximum-attempt limits are enforced by the server.
- Active sessions are checked during preflight and start.
- Duplicate sessions use server-side event policy and can trigger configured actions.
- Deadlines are enforced by Turso server time and capped at the assessment close time.
- Student-supplied score, deadline, warning count, ownership, and privileged submission reason are ignored.
- Long exams retrieve fresh Supabase sessions and retry once after token expiration.
- Answer keys and private security settings are not returned to students.
- Incident names are canonical across frontend, backend, and audit UI.
- Related focus and visibility events are grouped.
- Offline incidents are replayed with original IDs and bounded batches.
- Duplicate autosave versions cannot overwrite newer saved answers.
- Administrative security decisions create audit records instead of deleting incidents.
- Existing databases receive guarded column and index migration.

## 14. Security confirmations

- No Supabase service-role key was added to frontend code.
- No Turso URL token or Turso auth token was added to frontend code.
- No Backblaze key was added to frontend code.
- No secure-browser verification secret was added to frontend code.
- Turso remains the active assessment database.
- Cloudflare Pages Functions remain the trusted assessment backend.
- Supabase remains responsible for authentication, roles, profiles, and student-session validation.
- The active assessment system was not migrated to Supabase assessment tables.
- Existing assessment creation, duplication, sections, question-bank picking, shuffle settings, Smart Paste, Question Review Manager, notifications, grades, and student records were preserved.

## 15. Validation results

Completed locally:

- JavaScript syntax check for every `.js` and `.mjs` file: passed.
- HTML duplicate-ID check for admin assessments, student assessments, and secure exam: passed.
- Frontend/backend canonical incident-code comparison: 30 codes matched.
- Four security modes found in frontend and backend.
- Turso schema executed successfully in SQLite/libSQL-compatible validation: six tables created.
- Frontend secret scan for Turso, service-role, Backblaze, and secure-browser secret variables: passed.
- Assessment API smoke test using a local Turso/Supabase emulator: **19 checks passed**.
- ZIP integrity validation: run when the final package is created.

Not executed against live production infrastructure:

- real Cloudflare Pages deployment;
- real production Turso data;
- real Supabase token expiry timing;
- physical Android/iPhone browser matrix;
- real camera/microphone/screen-share permission matrix;
- real approved secure-browser provider verification.

Those deployment and browser tests remain necessary before enabling Strict or Secure Browser Ready mode for a high-stakes assessment.
