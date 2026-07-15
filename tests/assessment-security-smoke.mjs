import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiPath = join(projectRoot, 'functions', 'api', 'assessments', '[[path]].js');
const { onRequest } = await import(pathToFileURL(apiPath).href + `?test=${Date.now()}`);

const tempDir = mkdtempSync(join(tmpdir(), 'plv-assessment-smoke-'));
const dbPath = join(tempDir, 'assessment.sqlite');
const PYTHON_BRIDGE = String.raw`
import json, sqlite3, sys
path = sys.argv[1]
conn = sqlite3.connect(path)
conn.execute('PRAGMA foreign_keys = ON')

def decode(arg):
    kind = arg.get('type')
    if kind == 'null': return None
    if kind == 'integer': return int(arg.get('value', 0))
    if kind == 'float': return float(arg.get('value', 0))
    return str(arg.get('value', ''))

def encode(value):
    if value is None: return {'type': 'null'}
    if isinstance(value, bool): return {'type': 'integer', 'value': '1' if value else '0'}
    if isinstance(value, int): return {'type': 'integer', 'value': str(value)}
    if isinstance(value, float): return {'type': 'float', 'value': value}
    return {'type': 'text', 'value': str(value)}

for line in sys.stdin:
    if not line.strip():
        continue
    payload = json.loads(line)
    results = []
    for item in payload.get('requests', []):
        stmt = item.get('stmt', {})
        sql = stmt.get('sql', '')
        args = [decode(value) for value in stmt.get('args', [])]
        try:
            cur = conn.execute(sql, args)
            cols = [{'name': column[0]} for column in (cur.description or [])]
            data = [[encode(value) for value in row] for row in (cur.fetchall() if cur.description else [])]
            results.append({'type': 'ok', 'response': {'type': 'execute', 'result': {
                'cols': cols, 'rows': data, 'affected_row_count': max(cur.rowcount, 0), 'last_insert_rowid': None
            }}})
        except Exception as exc:
            results.append({'type': 'error', 'error': {'message': str(exc)}})
    conn.commit()
    print(json.dumps({'results': results}), flush=True)
conn.close()
`;

const pythonBin = process.env.PYTHON || 'python';
const dbProcess = spawn(pythonBin, ['-u', '-c', PYTHON_BRIDGE, dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const dbLines = createInterface({ input: dbProcess.stdout });
const dbPending = [];
let dbError = '';
dbProcess.stderr.on('data', chunk => { dbError += chunk.toString(); });
dbLines.on('line', line => {
  const pending = dbPending.shift();
  if (!pending) return;
  try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
});
dbProcess.on('exit', code => {
  while (dbPending.length) dbPending.shift().reject(new Error(dbError || `SQLite bridge exited with code ${code}.`));
});
function dbPipeline(body) {
  return new Promise((resolve, reject) => {
    dbPending.push({ resolve, reject });
    dbProcess.stdin.write(JSON.stringify(body) + '\n');
  });
}

const profiles = {
  'admin-token': { id: 'admin-1', uid: 'admin-1', email: 'admin@plv.test', role: 'admin', status: 'active', name: 'Test Admin' },
  'student-a-token': { id: 'student-a', uid: 'student-a', email: 'a@plv.test', role: 'student', status: 'active', studentNo: 'ST-A', studentName: 'Student A', section: 'SEC-A' },
  'student-b-token': { id: 'student-b', uid: 'student-b', email: 'b@plv.test', role: 'student', status: 'active', studentNo: 'ST-B', studentName: 'Student B', section: 'SEC-B' },
  'student-c-token': { id: 'student-c', uid: 'student-c', email: 'c@plv.test', role: 'student', status: 'active', studentNo: 'ST-C', studentName: 'Student C', section: 'SEC-A' }
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'mock.turso.local') {
    return new Response(JSON.stringify(await dbPipeline(JSON.parse(options.body || '{}'))), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
  if (url.hostname === 'mock.supabase.local') {
    const auth = String(options.headers?.authorization || options.headers?.Authorization || '');
    const token = auth.replace(/^Bearer\s+/i, '');
    const profile = profiles[token];
    if (url.pathname === '/auth/v1/user') {
      return profile
        ? Response.json({ id: profile.uid, email: profile.email })
        : Response.json({ message: 'invalid token' }, { status: 401 });
    }
    if (url.pathname === '/rest/v1/users') return Response.json(profile ? [profile] : []);
    return Response.json({ message: 'not found' }, { status: 404 });
  }
  throw new Error(`Unexpected fetch during smoke test: ${url}`);
};

const env = {
  TURSO_DATABASE_URL: 'https://mock.turso.local',
  TURSO_AUTH_TOKEN: 'test-turso-token',
  SUPABASE_URL: 'https://mock.supabase.local',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only',
  ASSESSMENT_PRIVACY_SALT: 'test-salt'
};

async function call(path, { token = 'student-a-token', method = 'GET', body, query } = {}) {
  const url = new URL(`https://portal.test/api/assessments/${path}`);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const request = new Request(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await onRequest({ request, env, params: { path: path.split('/') } });
  const data = await response.json();
  return { status: response.status, data, headers: response.headers };
}

async function directSql(sql, args = []) {
  const response = await globalThis.fetch('https://mock.turso.local/v2/pipeline', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(value => {
      if (value === null || value === undefined) return { type: 'null' };
      if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
      if (typeof value === 'number') return { type: 'float', value };
      return { type: 'text', value: String(value) };
    }) } }] })
  });
  return response.json();
}

function assessmentPayload(id, mode, overrides = {}) {
  const closesAt = overrides.closes_at || new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    assessment: {
      id,
      title: `${mode} Assessment`,
      instructions: 'Smoke test assessment',
      subject_code: 'TEST101',
      section: overrides.section || 'SEC-A',
      status: 'published',
      duration_minutes: overrides.duration_minutes || 30,
      opens_at: new Date(Date.now() - 60_000).toISOString(),
      closes_at: closesAt,
      settings: {
        builderSections: [{ id: 'sec1', title: 'Section I', pickCount: 0, shuffleQuestions: true, shuffleChoices: true }],
        security: {
          mode,
          maxAttempts: 1,
          warningLimit: 5,
          finalWarningThreshold: 4,
          ...(overrides.security || {})
        }
      }
    },
    questions: [{
      id: `${id}-q1`, type: 'multiple_choice', prompt: 'What does a loop do?', points: 2,
      choices: ['Declare variables', 'Repeat statements', 'Import packages', 'Create classes'],
      answer_key: 'Repeat statements', category: 'sec1', order_no: 1
    }]
  };
}

const checks = [];
function passed(name) { checks.push(name); }

try {
  const strictClosesAt = new Date(Date.now() + 90_000).toISOString();
  let result = await call('admin/save', { token: 'admin-token', method: 'POST', body: assessmentPayload('asm-strict', 'strict', { closes_at: strictClosesAt }) });
  assert.equal(result.status, 200); passed('admin saves Strict assessment and settings');

  result = await call('student/start', { token: 'student-b-token', method: 'POST', body: { assessment_id: 'asm-strict', accept_rules: true, client_session_id: 'wrong', tab_instance_id: 'wrong-tab', device_id: 'wrong-device' } });
  assert.equal(result.status, 403); passed('server rejects direct start for another section');

  result = await call('student/preflight', { method: 'POST', body: { assessment_id: 'asm-strict', client_session_id: 'client-a', device: { device_id: 'device-a', device_type: 'desktop' } } });
  assert.equal(result.status, 200);
  assert.equal(result.data.eligible, true);
  assert.equal(result.data.assessment.settings.security.mode, 'strict');
  assert.equal('builderSections' in result.data.assessment.settings, false); passed('preflight returns only public settings and eligibility');

  result = await call('student/start', { method: 'POST', body: { assessment_id: 'asm-strict', accept_rules: true, client_session_id: 'client-a', tab_instance_id: 'tab-a', device_id: 'device-a', device: { device_id: 'device-a', device_type: 'desktop', browser_name: 'Test Browser', operating_system: 'Test OS' } } });
  assert.equal(result.status, 200);
  const strictStart = result.data;
  assert.equal(strictStart.questions.length, 1);
  assert.equal('answer_key' in strictStart.questions[0], false);
  assert.ok(Date.parse(strictStart.attempt.deadline_at) <= Date.parse(strictClosesAt) + 5);
  passed('Strict attempt starts with server deadline capped by assessment close and no answer key');

  result = await call('student/preflight', { method: 'POST', body: { assessment_id: 'asm-strict', client_session_id: 'other-client', device: { device_id: 'other-device' } } });
  assert.equal(result.status, 200);
  assert.equal(result.data.eligible, false);
  assert.equal(result.data.statuses.find(item => item.key === 'active_session')?.status, 'failed');
  passed('preflight detects conflicting active session');

  result = await call('student/start', { method: 'POST', body: { assessment_id: 'asm-strict', accept_rules: true, client_session_id: 'client-b', tab_instance_id: 'tab-b', device_id: 'device-b', device: { device_id: 'device-b', device_type: 'desktop' } } });
  assert.equal(result.status, 409);
  assert.ok(['DUPLICATE_DEVICE_SESSION', 'EXAM_ALREADY_ACTIVE'].includes(result.data.code));
  passed('duplicate tab or device session is rejected and recorded by policy');

  result = await call('student/start', { method: 'POST', body: {
    assessment_id: 'asm-strict', accept_rules: true, client_session_id: 'client-a', tab_instance_id: 'tab-a', device_id: 'device-a',
    session_id: strictStart.session.id, session_token: strictStart.session.token, device: { device_id: 'device-a', device_type: 'desktop' }
  } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.questions.map(q => q.id), strictStart.questions.map(q => q.id));
  passed('refresh recovery keeps the stable server-assigned question set');

  const sessionBase = { attempt_id: strictStart.attempt.id, session_id: strictStart.session.id, session_token: strictStart.session.token, client_session_id: 'client-a' };
  result = await call('student/autosave', { method: 'POST', body: { ...sessionBase, answers: { [strictStart.questions[0].id]: 'Repeat statements' }, question_index: 0, save_version: 3 } });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'SAVE_VERSION_CONFLICT');
  result = await call('student/autosave', { method: 'POST', body: { ...sessionBase, answers: { [strictStart.questions[0].id]: 'Repeat statements' }, question_index: 0, save_version: 1 } });
  assert.equal(result.status, 200);
  result = await call('student/autosave', { method: 'POST', body: { ...sessionBase, answers: { [strictStart.questions[0].id]: 'Wrong overwrite' }, question_index: 0, save_version: 1 } });
  assert.equal(result.data.duplicate, true); passed('autosave versions are ordered and idempotent');

  const incident = { ...sessionBase, type: 'tab_switch', client_event_id: 'evt-tab-1', event_group: 'focus_transition', details: 'Test tab switch', first_detected_at: new Date().toISOString(), last_detected_at: new Date().toISOString(), duration_seconds: 2 };
  result = await call('student/incident', { method: 'POST', body: incident });
  assert.equal(result.status, 200);
  const afterFirstIncident = result.data.warning_count;
  result = await call('student/incident', { method: 'POST', body: incident });
  assert.equal(result.status, 200);
  assert.equal(result.data.duplicate, true);
  assert.equal(result.data.warning_count, afterFirstIncident); passed('client event IDs prevent duplicate incident warnings');

  result = await call('student/incidents-batch', { method: 'POST', body: { ...sessionBase, events: [
    { type: 'network_disconnected', client_event_id: 'evt-offline-1', details: 'Connection interrupted', duration_seconds: 2 },
    { type: 'network_reconnected', client_event_id: 'evt-online-1', details: 'Connection restored' }
  ] } });
  assert.equal(result.status, 200);
  assert.equal(result.data.results.length, 2);
  assert.equal(result.data.submitted, false);
  passed('pending incidents batch and low-severity connection events do not unfairly auto-submit');

  await directSql(`update assessment_attempts set deadline_at=? where id=?`, [new Date(Date.now() - 5_000).toISOString(), strictStart.attempt.id]);
  result = await call('student/finalize-expired', { method: 'POST', body: sessionBase });
  assert.equal(result.status, 200);
  assert.equal(result.data.finalized, true);
  assert.equal(result.data.submission_reason, 'time_expired');
  assert.equal(Number(result.data.score), 2); passed('server finalizes expired attempts using latest saved answers');

  result = await call('student/start', { method: 'POST', body: { assessment_id: 'asm-strict', accept_rules: true, client_session_id: 'new-client', tab_instance_id: 'new-tab', device_id: 'new-device' } });
  assert.equal(result.status, 403);
  assert.equal(result.data.code, 'MAX_ATTEMPTS_REACHED'); passed('submitted attempt cannot be restarted beyond maxAttempts');

  result = await call('student/autosave', { token: 'student-c-token', method: 'POST', body: { ...sessionBase, answers: {}, save_version: 2 } });
  assert.ok([403, 404].includes(result.status)); passed('another student cannot access or modify an attempt');

  result = await call('admin/incidents', { token: 'admin-token', query: { assessment_id: 'asm-strict', limit: 50 } });
  assert.equal(result.status, 200);
  assert.ok(result.data.incidents.length >= 2);
  const reviewIncident = result.data.incidents.find(item => item.client_event_id === 'evt-tab-1');
  assert.ok(reviewIncident);
  result = await call('admin/review-incident', { token: 'admin-token', method: 'POST', body: { incident_id: reviewIncident.id, review_status: 'false_positive', review_notes: 'Smoke-test review' } });
  assert.equal(result.status, 200);
  result = await call('admin/attempt-timeline', { token: 'admin-token', query: { attempt_id: strictStart.attempt.id } });
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.data.events)); passed('administrator can review incidents and load an attempt timeline');

  result = await call('admin/save', { token: 'admin-token', method: 'POST', body: assessmentPayload('asm-standard', 'standard') });
  assert.equal(result.status, 200);
  result = await call('student/start', { method: 'POST', body: { assessment_id: 'asm-standard', accept_rules: true, client_session_id: 'std-client', tab_instance_id: 'std-tab', device_id: 'std-device' } });
  assert.equal(result.status, 200);
  const standardStart = result.data;
  result = await call('student/submit', { method: 'POST', body: {
    attempt_id: standardStart.attempt.id, session_id: standardStart.session.id, session_token: standardStart.session.token,
    client_session_id: 'std-client', answers: { [standardStart.questions[0].id]: 'Repeat statements' },
    submission_reason: 'administrator_invalidated', score: 9999, total_points: 9999,
    warning_count: 0, deadline_at: new Date(Date.now() + 86400000).toISOString(), student_no: 'ST-C'
  } });
  assert.equal(result.status, 200);
  assert.equal(result.data.submission_reason, 'student_submitted'); passed('student cannot forge privileged submission reasons or scoring state');

  result = await call('admin/save', { token: 'admin-token', method: 'POST', body: assessmentPayload('asm-monitored', 'monitored') });
  assert.equal(result.status, 200);
  result = await call('student/start', { token: 'student-c-token', method: 'POST', body: { assessment_id: 'asm-monitored', accept_rules: true, client_session_id: 'mon-client', tab_instance_id: 'mon-tab', device_id: 'mon-device' } });
  assert.equal(result.status, 200);
  assert.equal(result.data.assessment.settings.security.mode, 'monitored'); passed('Monitored assessment starts with monitoring configuration');

  result = await call('admin/save', { token: 'admin-token', method: 'POST', body: assessmentPayload('asm-autosubmit', 'strict', { security: { warningLimit: 1, finalWarningThreshold: 1, pauseAfterWarningCount: 0, autoSubmitAfterFinalViolation: true, adminReviewInsteadOfAutoSubmit: false } }) });
  assert.equal(result.status, 200);
  result = await call('student/start', { token: 'student-c-token', method: 'POST', body: { assessment_id: 'asm-autosubmit', accept_rules: true, client_session_id: 'auto-client', tab_instance_id: 'auto-tab', device_id: 'auto-device' } });
  assert.equal(result.status, 200);
  const autoStart = result.data;
  result = await call('student/incident', { token: 'student-c-token', method: 'POST', body: {
    attempt_id: autoStart.attempt.id, session_id: autoStart.session.id, session_token: autoStart.session.token,
    client_session_id: 'auto-client', type: 'tab_switch', client_event_id: 'evt-auto-submit', details: 'Threshold test'
  } });
  assert.equal(result.status, 200);
  assert.equal(result.data.submitted, true);
  assert.equal(result.data.auto_submit, true);
  passed('server-side policy automatically submits at the configured warning threshold');

  result = await call('admin/save', { token: 'admin-token', method: 'POST', body: assessmentPayload('asm-secure-browser', 'secure_browser_ready') });
  assert.equal(result.status, 200);
  result = await call('student/preflight', { token: 'student-b-token', method: 'POST', body: { assessment_id: 'asm-secure-browser' } });
  // Student B is the wrong section, so first prove assignment enforcement remains first.
  assert.equal(result.status, 403);
  result = await call('student/preflight', { token: 'student-c-token', method: 'POST', body: { assessment_id: 'asm-secure-browser' } });
  assert.equal(result.status, 200);
  assert.equal(result.data.eligible, false);
  assert.equal(result.data.secure_browser.status, 'unavailable');
  result = await call('student/start', { token: 'student-c-token', method: 'POST', body: { assessment_id: 'asm-secure-browser', accept_rules: true } });
  assert.equal(result.status, 403);
  assert.equal(result.data.code, 'SECURE_BROWSER_REQUIRED'); passed('secure-browser-required exam blocks start when verification is unavailable');

  const legacy = assessmentPayload('asm-legacy', 'standard');
  legacy.assessment.settings = { ...legacy.assessment.settings, security: undefined, fullscreen: true, maxViolations: 3, autoSubmitOnViolation: true };
  result = await call('admin/save', { token: 'admin-token', method: 'POST', body: legacy });
  assert.equal(result.status, 200);
  result = await call('student/list', { token: 'student-c-token' });
  const legacyPublic = result.data.assessments.find(item => item.id === 'asm-legacy');
  assert.equal(legacyPublic.settings.security.mode, 'monitored');
  assert.equal(legacyPublic.settings.security.requireFullscreen, true);
  assert.equal(legacyPublic.settings.security.warningLimit, 3); passed('legacy fullscreen/maxViolations/autoSubmit settings remain compatible');

  console.log(JSON.stringify({ ok: true, checks: checks.length, passed: checks }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  dbProcess.stdin.end();
  dbProcess.kill();
  rmSync(tempDir, { recursive: true, force: true });
}


