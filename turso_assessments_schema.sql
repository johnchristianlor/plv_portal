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

CREATE TABLE IF NOT EXISTS assessment_schema_meta (
    schema_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
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

INSERT INTO assessment_schema_meta(schema_key, version, updated_at)
VALUES ('assessment', 4, CURRENT_TIMESTAMP)
ON CONFLICT(schema_key) DO UPDATE SET
    version = excluded.version,
    updated_at = excluded.updated_at;

-- Existing production tables are intentionally not altered here because
-- SQLite/libSQL does not support ADD COLUMN IF NOT EXISTS consistently.
-- Deploying the Pages Function runs the guarded migration logic automatically.
