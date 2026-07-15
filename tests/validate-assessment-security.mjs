import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = relative => readFileSync(join(root, relative), 'utf8');
const requiredFiles = [
  'public/exam-incident-codes.js',
  'public/exam-security-config.js',
  'public/exam-security-manager.js',
  'public/exam-offline-store.js',
  'public/exam-session-client.js',
  'public/exam-secure-browser-verifier.js',
  'public/student-exam-module.js',
  'functions/api/assessments/[[path]].js',
  'turso_assessments_schema.sql'
];
requiredFiles.forEach(file => assert.ok(existsSync(join(root, file)), `Missing ${file}`));

const backend = read('functions/api/assessments/[[path]].js');
const incidentModule = read('public/exam-incident-codes.js');
const studentExam = read('public/student-exam-module.js');
const adminModule = read('public/admin-assessments-module.js');
const securityConfig = read('public/exam-security-config.js');
const schema = read('turso_assessments_schema.sql');
const headers = read('public/_headers');

const frontendCodes = [...incidentModule.matchAll(/^\s*'([a-z0-9_]+)'\s*,?\s*$/gm)].map(match => match[1]);
const backendSetMatch = backend.match(/const INCIDENT_CODES = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(backendSetMatch, 'Backend incident set not found.');
const backendCodes = [...backendSetMatch[1].matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1]);
assert.deepEqual([...new Set(frontendCodes)].sort(), [...new Set(backendCodes)].sort(), 'Frontend and backend incident codes differ.');

for (const mode of ['standard', 'monitored', 'strict', 'secure_browser_ready']) {
  assert.match(securityConfig, new RegExp(`\\b${mode}\\s*:`), `Missing frontend security mode ${mode}`);
  assert.match(backend, new RegExp(`\\b${mode}\\s*:`), `Missing backend security mode ${mode}`);
}

for (const route of [
  '/student/preflight', '/student/start', '/student/autosave', '/student/heartbeat',
  '/student/session-status', '/student/restore', '/student/incidents-batch', '/student/finalize-expired',
  '/admin/attempt-detail', '/admin/attempt-timeline', '/admin/review-incident', '/admin/review-attempt',
  '/admin/export-audit'
]) assert.ok(backend.includes(`path === '${route}'`), `Missing route ${route}`);

assert.ok(!studentExam.includes('answer_key'), 'Student exam frontend references answer_key.');
assert.ok(!adminModule.includes('window.open('), 'Admin assessment module still opens a new browser tab.');
assert.match(backend, /This assessment is not assigned to your section\./);
assert.match(backend, /MAX_ATTEMPTS_REACHED/);
assert.match(backend, /SAVE_VERSION_CONFLICT/);
assert.match(backend, /Math\.min\(durationDeadlineMs, closesAtMs\)/);
assert.match(backend, /finalizeAttempt\(env, attempt, 'student_submitted'/);
assert.match(studentExam, /student\/incidents-batch/);
assert.match(studentExam, /runRequiredDeviceChecks/);
assert.match(headers, /\/student-exam\.html[\s\S]*Permissions-Policy: camera=\(\), microphone=\(\), display-capture=\(\)/);

for (const fragment of [
  'CREATE TABLE IF NOT EXISTS assessment_sessions',
  'CREATE TABLE IF NOT EXISTS assessment_admin_audit',
  'attempt_no INTEGER',
  'client_event_id TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_attempt_number',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_client_event_attempt'
]) assert.ok(schema.includes(fragment), `Schema is missing: ${fragment}`);

const forbiddenSecretNames = /(SUPABASE_SERVICE_ROLE_KEY|TURSO_AUTH_TOKEN|LIBSQL_AUTH_TOKEN|B2_APPLICATION_KEY|SECURE_BROWSER_VERIFIER_SECRET)/;
function scanPublicFiles(dir) {
  const matches = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) matches.push(...scanPublicFiles(full));
    else if (/\.(html|js|css|json)$/i.test(entry) && forbiddenSecretNames.test(readFileSync(full, 'utf8'))) matches.push(full);
  }
  return matches;
}
const publicSecretMatches = scanPublicFiles(join(root, 'public'));
assert.equal(publicSecretMatches.length, 0, `Private environment variable name found in frontend code:\n${publicSecretMatches.join('\n')}`);

const temp = mkdtempSync(join(tmpdir(), 'plv-schema-'));
const db = join(temp, 'schema.sqlite');
const pythonBin = process.env.PYTHON || 'python';
const schemaCheck = spawnSync(pythonBin, ['-c', `import sqlite3,sys,pathlib\nconn=sqlite3.connect(sys.argv[1])\nconn.executescript(pathlib.Path(sys.argv[2]).read_text())\nprint(','.join(r[0] for r in conn.execute("select name from sqlite_master where type='table' order by name")))\nconn.close()`, db, join(root, 'turso_assessments_schema.sql')], { encoding: 'utf8' });
rmSync(temp, { recursive: true, force: true });
assert.equal(schemaCheck.status, 0, schemaCheck.stderr || 'Schema execution failed.');
assert.match(schemaCheck.stdout, /assessment_sessions/);

console.log(JSON.stringify({
  ok: true,
  incident_codes: backendCodes.length,
  security_modes: 4,
  required_files: requiredFiles.length,
  schema_tables: schemaCheck.stdout.trim().split(',').length
}, null, 2));




