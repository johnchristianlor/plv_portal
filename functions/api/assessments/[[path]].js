const JSON_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
};

const INCIDENT_ALIASES = Object.freeze({
    tab_hidden: 'tab_switch', visibility_hidden: 'tab_switch', window_blur: 'window_focus_lost',
    app_switch: 'tab_switch', smart_panel: 'window_focus_lost', floating_window: 'window_focus_lost', split_screen: 'window_focus_lost',
    duplicate_tab: 'duplicate_exam_tab', duplicate_window: 'duplicate_exam_tab',
    copy: 'copy_attempt', cut: 'cut_attempt', paste: 'paste_attempt', context_menu: 'context_menu_attempt',
    offline: 'network_disconnected', network_offline: 'network_disconnected', online: 'network_reconnected',
    network_online: 'network_reconnected', unload: 'page_exit', screenshot_key: 'screenshot_shortcut',
    print: 'print_attempt', anomaly_limit: 'anomaly_limit_reached'
});

const INCIDENT_CODES = new Set([
    'tab_switch', 'window_focus_lost', 'fullscreen_exit', 'duplicate_exam_tab',
    'duplicate_device_session', 'session_replaced', 'copy_attempt', 'cut_attempt', 'paste_attempt',
    'context_menu_attempt', 'drop_attempt', 'print_attempt', 'screenshot_shortcut', 'restricted_shortcut',
    'back_navigation', 'refresh_attempt', 'network_disconnected', 'network_reconnected', 'heartbeat_timeout',
    'camera_unavailable', 'camera_stopped', 'microphone_unavailable', 'microphone_stopped',
    'screen_share_unavailable', 'screen_share_stopped', 'secure_browser_failed', 'page_exit',
    'session_recovered', 'time_expired', 'anomaly_limit_reached'
]);

const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
let schemaReadyPromise = null;
const ASSESSMENT_SCHEMA_VERSION = 4;

const BASE_MONITORING = Object.freeze({
    tabSwitch: false, windowFocus: false, fullscreenExit: false, clipboard: false,
    contextMenu: false, dragDrop: false, print: false, restrictedShortcut: false,
    browserNavigation: false, connection: true, duplicateSession: true,
    cameraState: false, microphoneState: false, screenSharing: false,
    secureBrowserVerification: false
});

const DEFAULT_EVENT_POLICIES = Object.freeze({
    tab_switch: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 4000, maxToleratedCount: 6 },
    window_focus_lost: { enabled: true, severity: 'low', countsWarning: true, warningWeight: 0.5, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 4000, maxToleratedCount: 8 },
    fullscreen_exit: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: true, mayAutoSubmit: true, cooldownMs: 3500, maxToleratedCount: 3 },
    duplicate_exam_tab: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 10000, maxToleratedCount: 2 },
    duplicate_device_session: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    session_replaced: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    copy_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
    cut_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
    paste_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
    context_menu_attempt: { enabled: true, severity: 'low', countsWarning: true, warningWeight: 0.5, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 1800, maxToleratedCount: 8 },
    drop_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
    print_attempt: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 5000, maxToleratedCount: 2 },
    screenshot_shortcut: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 2500, maxToleratedCount: 5 },
    restricted_shortcut: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
    back_navigation: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 3000, maxToleratedCount: 4 },
    refresh_attempt: { enabled: true, severity: 'low', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 10 },
    network_disconnected: { enabled: true, severity: 'low', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 20 },
    network_reconnected: { enabled: true, severity: 'info', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 1000, maxToleratedCount: 50 },
    heartbeat_timeout: { enabled: true, severity: 'medium', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 30000, maxToleratedCount: 10 },
    camera_unavailable: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    camera_stopped: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    microphone_unavailable: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    microphone_stopped: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    screen_share_unavailable: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    screen_share_stopped: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 4, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
    secure_browser_failed: { enabled: true, severity: 'critical', countsWarning: false, warningWeight: 0, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 60000, maxToleratedCount: 1 },
    page_exit: { enabled: true, severity: 'medium', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 10 },
    session_recovered: { enabled: true, severity: 'info', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 20 },
    time_expired: { enabled: true, severity: 'info', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 60000, maxToleratedCount: 1 },
    anomaly_limit_reached: { enabled: true, severity: 'critical', countsWarning: false, warningWeight: 0, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 60000, maxToleratedCount: 1 }
});

const MODE_DEFAULTS = Object.freeze({
    standard: {
        mode: 'standard', requireFullscreen: false, maxAttempts: 1, allowBacktracking: true,
        oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
        allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 60, maxSimultaneousSessions: 1,
        warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 0,
        autoSubmitAfterFinalViolation: false, autoSubmitHighRiskOnly: true,
        adminReviewInsteadOfAutoSubmit: true, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
        monitoring: { ...BASE_MONITORING },
        media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
        requireSecureBrowser: false, secureBrowserProvider: 'none', secureBrowserConfigId: '',
        secureBrowserVerificationEnabled: false
    },
    monitored: {
        mode: 'monitored', requireFullscreen: false, maxAttempts: 1, allowBacktracking: true,
        oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
        allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 60, maxSimultaneousSessions: 1,
        warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 0,
        autoSubmitAfterFinalViolation: false, autoSubmitHighRiskOnly: true,
        adminReviewInsteadOfAutoSubmit: true, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
        monitoring: { ...BASE_MONITORING, tabSwitch: true, windowFocus: true, fullscreenExit: true, clipboard: true, contextMenu: true, dragDrop: true, print: true, restrictedShortcut: true, browserNavigation: true },
        media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
        requireSecureBrowser: false, secureBrowserProvider: 'none', secureBrowserConfigId: '',
        secureBrowserVerificationEnabled: false
    },
    strict: {
        mode: 'strict', requireFullscreen: true, maxAttempts: 1, allowBacktracking: true,
        oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
        allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 45, maxSimultaneousSessions: 1,
        warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 3,
        autoSubmitAfterFinalViolation: true, autoSubmitHighRiskOnly: false,
        adminReviewInsteadOfAutoSubmit: false, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
        monitoring: { ...BASE_MONITORING, tabSwitch: true, windowFocus: true, fullscreenExit: true, clipboard: true, contextMenu: true, dragDrop: true, print: true, restrictedShortcut: true, browserNavigation: true },
        media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
        requireSecureBrowser: false, secureBrowserProvider: 'none', secureBrowserConfigId: '',
        secureBrowserVerificationEnabled: false
    },
    secure_browser_ready: {
        mode: 'secure_browser_ready', requireFullscreen: true, maxAttempts: 1, allowBacktracking: true,
        oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
        allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 45, maxSimultaneousSessions: 1,
        warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 3,
        autoSubmitAfterFinalViolation: true, autoSubmitHighRiskOnly: false,
        adminReviewInsteadOfAutoSubmit: false, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
        monitoring: { ...BASE_MONITORING, tabSwitch: true, windowFocus: true, fullscreenExit: true, clipboard: true, contextMenu: true, dragDrop: true, print: true, restrictedShortcut: true, browserNavigation: true, secureBrowserVerification: true },
        media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
        requireSecureBrowser: true, secureBrowserProvider: 'safe_exam_browser', secureBrowserConfigId: '',
        secureBrowserVerificationEnabled: true
    }
});

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}
function envValue(env, ...names) {
    for (const name of names) if (env[name]) return env[name];
    return '';
}
function safeHttpsUrl(value) {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:' ? url.toString() : ''; }
    catch { return ''; }
}
function bearer(request) {
    const auth = request.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}
function dbEndpoint(env) {
    const raw = envValue(env, 'TURSO_DATABASE_URL', 'LIBSQL_URL').trim();
    if (!raw) throw new Error('Turso database URL is missing.');
    let base = raw.replace(/\/$/, '');
    if (base.startsWith('libsql://')) base = 'https://' + base.slice('libsql://'.length);
    if (base.startsWith('http://')) base = 'https://' + base.slice('http://'.length);
    return base + '/v2/pipeline';
}
function supabaseUrl(env) { return envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, ''); }
function supabaseAnonKey(env) { return envValue(env, 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'); }
function arg(value) {
    if (value === null || value === undefined) return { type: 'null' };
    if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
    if (typeof value === 'number') return { type: 'float', value };
    return { type: 'text', value: String(value) };
}
async function turso(env, statements) {
    const token = envValue(env, 'TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN');
    if (!token) throw new Error('Turso auth token is missing.');
    const requests = statements.map(item => ({ type: 'execute', stmt: { sql: item.sql, args: (item.args || []).map(arg) } }));
    const response = await fetch(dbEndpoint(env), {
        method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer ' + token }, body: JSON.stringify({ requests })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Turso request failed.');
    return (body.results || []).map(result => {
        if (result.type === 'error') throw new Error('Turso statement failed.');
        const exec = result.response?.result || result.result;
        return exec || { cols: [], rows: [], affected_row_count: 0 };
    });
}
function rows(result) {
    const cols = (result.cols || []).map(col => col.name || col);
    return (result.rows || []).map(row => {
        const out = {};
        row.forEach((cell, index) => { out[cols[index]] = cell && Object.prototype.hasOwnProperty.call(cell, 'value') ? cell.value : null; });
        return out;
    });
}
function id(prefix = 'id') {
    const uuid = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return prefix + '_' + uuid.replace(/-/g, '');
}
function clampText(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function bool(value, fallback) { return typeof value === 'boolean' ? value : fallback; }
function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}
function nowIso() { return new Date().toISOString(); }
function canonicalIncidentCode(value) {
    const key = clampText(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
    return INCIDENT_ALIASES[key] || key;
}
async function sha256(value) {
    const data = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomToken(bytes = 32) {
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getSupabaseUser(env, token) {
    const url = supabaseUrl(env), anonKey = supabaseAnonKey(env);
    if (!url || !anonKey || !token) return null;
    const response = await fetch(url + '/auth/v1/user', { headers: { apikey: anonKey, authorization: 'Bearer ' + token } });
    return response.ok ? response.json() : null;
}
async function findProfile(env, accessToken, authUser, role) {
    const url = supabaseUrl(env), anonKey = supabaseAnonKey(env), serviceKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anonKey) return null;
    const apiKey = serviceKey || anonKey, dbBearer = serviceKey || accessToken;
    const checks = [['uid', authUser.id], ['id', authUser.id], ['email', authUser.email]].filter(([, value]) => !!value);
    if (!checks.length) return null;
    const requestUrl = new URL(url + '/rest/v1/users');
    requestUrl.searchParams.set('select', 'id,uid,email,studentNo,username,role,status,fullName,name,section');
    requestUrl.searchParams.set('role', 'eq.' + role);
    requestUrl.searchParams.set('or', '(' + checks.map(([field, value]) => `${field}.eq.${value}`).join(',') + ')');
    requestUrl.searchParams.set('limit', '1');
    const response = await fetch(requestUrl.toString(), { headers: { apikey: apiKey, authorization: 'Bearer ' + dbBearer } });
    if (!response.ok) return null;
    const data = await response.json();
    return (data || [])[0] || null;
}
async function supabaseRpc(env, name, payload, accessToken = '') {
    const url = supabaseUrl(env), anonKey = supabaseAnonKey(env);
    if (!url || !anonKey) throw new Error('Supabase connection is missing.');
    const serviceKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const response = await fetch(url + '/rest/v1/rpc/' + name, {
        method: 'POST', headers: { ...JSON_HEADERS, apikey: serviceKey || anonKey, authorization: 'Bearer ' + (serviceKey || accessToken || anonKey) }, body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error('Supabase validation failed.');
    return data;
}
async function validateStudentSession(env, studentNo, sessionToken) {
    if (!studentNo || !sessionToken) return false;
    try { return await supabaseRpc(env, 'validate_student_session', { p_student_no: studentNo, p_session_token: sessionToken }) === true; } catch { return false; }
}
async function getStudentProfile(env, studentNo, sessionToken) {
    if (!studentNo || !sessionToken) return null;
    try {
        const data = await supabaseRpc(env, 'get_student_profile', { p_student_no: studentNo, p_session_token: sessionToken });
        return data && typeof data === 'object' ? data : null;
    } catch { return null; }
}
async function requireRole(request, env, role) {
    const token = bearer(request);
    if (!token) return { error: json({ error: 'Please login again.' }, 401) };
    const authUser = await getSupabaseUser(env, token);
    if (!authUser?.id) return { error: json({ error: 'Please login again.' }, 401) };
    const profile = await findProfile(env, token, authUser, role);
    if (!profile) return { error: json({ error: 'Access denied.' }, 403) };
    if (String(profile.status || '').toLowerCase() === 'inactive') return { error: json({ error: 'Account is inactive.' }, 403) };
    return { token, authUser, profile };
}
async function requireStudent(request, env) {
    const token = bearer(request);
    if (token) return requireRole(request, env, 'student');
    const studentNo = clampText(request.headers.get('x-student-no') || request.headers.get('x-studentno') || '', 80);
    const sessionToken = clampText(request.headers.get('x-student-session') || request.headers.get('x-session-token') || '', 240);
    if (!studentNo || !sessionToken) return { error: json({ error: 'Please login again.' }, 401) };
    if (!await validateStudentSession(env, studentNo, sessionToken)) return { error: json({ error: 'Please login again.' }, 401) };
    const profile = await getStudentProfile(env, studentNo, sessionToken);
    if (!profile) return { error: json({ error: 'Access denied.' }, 403) };
    if (String(profile.status || '').toLowerCase() === 'inactive') return { error: json({ error: 'Account is inactive.' }, 403) };
    return { token: sessionToken, authUser: { id: studentNo }, profile };
}

async function ensureColumns(env, table, definitions) {
    const [info] = await turso(env, [{ sql: `pragma table_info(${table})` }]);
    const existing = new Set(rows(info).map(row => String(row.name)));
    for (const [name, definition] of Object.entries(definitions)) {
        if (existing.has(name)) continue;
        try { await turso(env, [{ sql: `alter table ${table} add column ${name} ${definition}` }]); } catch { /* Safe repeatable migration. */ }
    }
}

async function backfillAttemptNumbers(env) {
    const [result] = await turso(env, [{ sql: `select id,assessment_id,student_no,attempt_no,started_at,created_at from assessment_attempts order by assessment_id,student_no,coalesce(started_at,created_at),id` }]);
    const groups = new Map();
    for (const attempt of rows(result)) {
        const key = `${attempt.assessment_id}::${attempt.student_no}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(attempt);
    }
    const updates = [];
    for (const attempts of groups.values()) {
        const used = new Set();
        for (const attempt of attempts) {
            let number = Number(attempt.attempt_no || 0);
            if (number < 1 || used.has(number)) {
                number = 1;
                while (used.has(number)) number += 1;
                updates.push({ sql: `update assessment_attempts set attempt_no=? where id=?`, args: [number, attempt.id] });
            }
            used.add(number);
        }
    }
    for (let index = 0; index < updates.length; index += 100) await turso(env, updates.slice(index, index + 100));
}
async function deduplicateIncidentEventIds(env) {
    const [duplicates] = await turso(env, [{ sql: `select attempt_id,client_event_id,count(*) as count from assessment_incidents where client_event_id is not null and client_event_id<>'' group by attempt_id,client_event_id having count(*)>1` }]);
    for (const duplicate of rows(duplicates)) {
        const [itemsResult] = await turso(env, [{ sql: `select id from assessment_incidents where attempt_id is ? and client_event_id=? order by created_at,id`, args: [duplicate.attempt_id ?? null, duplicate.client_event_id] }]);
        const items = rows(itemsResult);
        const updates = items.slice(1).map(item => ({ sql: `update assessment_incidents set client_event_id=? where id=?`, args: [`${duplicate.client_event_id}:${item.id}`, item.id] }));
        if (updates.length) await turso(env, updates);
    }
}
async function ensureIndexes(env, statements) {
    try { await turso(env, statements); }
    catch (error) {
        for (const statement of statements) {
            try { await turso(env, [statement]); } catch (indexError) { console.error('Assessment index migration failed:', statement.sql, indexError?.message || indexError); }
        }
    }
}
async function ensureSchema(env) {
    await turso(env, [
        { sql: `create table if not exists assessments (id text primary key, title text not null, instructions text, subject_code text, section text, status text not null default 'draft', duration_minutes integer not null default 30, opens_at text, closes_at text, settings_json text, created_by text, created_at text not null, updated_at text not null)` },
        { sql: `create table if not exists assessment_questions (id text primary key, assessment_id text not null, type text not null, prompt text not null, points integer not null default 1, answer_key text, choices_json text, category text, difficulty text, explanation text, order_no integer not null default 1, created_at text not null, foreign key (assessment_id) references assessments(id) on delete cascade)` },
        { sql: `create table if not exists assessment_attempts (id text primary key, assessment_id text not null, student_no text not null, student_name text, student_uid text, status text not null, answers_json text, score real not null default 0, total_points real not null default 0, violations integer not null default 0, started_at text not null, submitted_at text, deadline_at text, created_at text not null, foreign key (assessment_id) references assessments(id) on delete cascade)` },
        { sql: `create table if not exists assessment_incidents (id text primary key, attempt_id text, assessment_id text, student_no text, type text not null, details text, created_at text not null)` },
        { sql: `create table if not exists assessment_sessions (id text primary key, attempt_id text not null, assessment_id text not null, student_no text not null, client_session_id text not null, session_token_hash text not null, tab_instance_id text, device_id text, device_type text, browser_name text, operating_system text, user_agent_summary text, ip_hash text, status text not null default 'active', started_at text not null, last_heartbeat_at text not null, ended_at text, termination_reason text, created_at text not null, foreign key (attempt_id) references assessment_attempts(id) on delete cascade)` },
        { sql: `create table if not exists assessment_admin_audit (id text primary key, assessment_id text, attempt_id text, incident_id text, admin_id text not null, action text not null, details text, created_at text not null)` }
    ]);
    await ensureColumns(env, 'assessment_attempts', {
        attempt_no: 'integer', warning_count: 'real not null default 0', security_score: 'real not null default 0',
        submission_reason: 'text', active_session_id: 'text', last_heartbeat_at: 'text', last_saved_at: 'text',
        expired_at: 'text', finalized_at: 'text', security_status: "text not null default 'normal'",
        review_status: "text not null default 'unreviewed'", reviewed_by: 'text', reviewed_at: 'text', review_notes: 'text',
        save_version: 'integer not null default 0', last_question_index: 'integer not null default 0', flagged_json: 'text'
    });
    await ensureColumns(env, 'assessment_incidents', {
        client_event_id: 'text', session_id: 'text', event_group: 'text', severity: "text not null default 'low'",
        warning_weight: 'real not null default 0', event_count: 'integer not null default 1', metadata_json: 'text',
        first_detected_at: 'text', last_detected_at: 'text', duration_seconds: 'real not null default 0', action_taken: 'text',
        review_status: "text not null default 'unreviewed'", reviewed_by: 'text', reviewed_at: 'text', review_notes: 'text'
    });
    await backfillAttemptNumbers(env);
    await deduplicateIncidentEventIds(env);
    await ensureIndexes(env, [
        { sql: `create index if not exists idx_assessments_status_section on assessments(status, section)` },
        { sql: `create index if not exists idx_questions_assessment_order on assessment_questions(assessment_id, order_no)` },
        { sql: `create index if not exists idx_attempts_student on assessment_attempts(student_no, assessment_id, status)` },
        { sql: `create index if not exists idx_attempts_assessment on assessment_attempts(assessment_id, started_at)` },
        { sql: `create index if not exists idx_attempts_review on assessment_attempts(review_status, security_status)` },
        { sql: `create unique index if not exists uq_attempt_number on assessment_attempts(assessment_id, student_no, attempt_no) where attempt_no is not null` },
        { sql: `create index if not exists idx_sessions_attempt on assessment_sessions(attempt_id, status, last_heartbeat_at)` },
        { sql: `create index if not exists idx_sessions_student on assessment_sessions(student_no, assessment_id, status)` },
        { sql: `create unique index if not exists uq_session_token_hash on assessment_sessions(session_token_hash)` },
        { sql: `create index if not exists idx_incidents_attempt on assessment_incidents(attempt_id, created_at)` },
        { sql: `create index if not exists idx_incidents_assessment on assessment_incidents(assessment_id, created_at)` },
        { sql: `create index if not exists idx_incidents_student on assessment_incidents(student_no, created_at)` },
        { sql: `create index if not exists idx_incidents_session on assessment_incidents(session_id, created_at)` },
        { sql: `create index if not exists idx_incidents_review on assessment_incidents(review_status, severity, created_at)` },
        { sql: `drop index if exists uq_incident_client_event` },
        { sql: `create unique index if not exists uq_incident_client_event_attempt on assessment_incidents(attempt_id, client_event_id) where client_event_id is not null and client_event_id <> ''` },
        { sql: `create index if not exists idx_admin_audit_attempt on assessment_admin_audit(attempt_id, created_at)` }
    ]);
}

async function ensureSchemaOnce(env) {
    if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
            const [versionResult] = await turso(env, [{ sql: `pragma user_version` }]);
            const currentVersion = Number(rows(versionResult)[0]?.user_version || 0);
            if (currentVersion >= ASSESSMENT_SCHEMA_VERSION) return;
            await ensureSchema(env);
            await turso(env, [{ sql: `pragma user_version = ${ASSESSMENT_SCHEMA_VERSION}` }]);
        })().catch(error => { schemaReadyPromise = null; throw error; });
    }
    return schemaReadyPromise;
}
async function readBody(request) { return request.json().catch(() => ({})); }
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeSecurityConfig(settings = {}) {
    const raw = settings?.security && typeof settings.security === 'object' ? settings.security : settings;
    const requestedMode = clampText(raw.mode || raw.securityMode, 40).toLowerCase();
    const legacy = raw.fullscreen !== undefined || raw.maxViolations !== undefined || raw.autoSubmitOnViolation !== undefined;
    const mode = MODE_DEFAULTS[requestedMode] ? requestedMode : (legacy ? 'monitored' : 'standard');
    const defaults = deepClone(MODE_DEFAULTS[mode]);
    const policies = deepClone(DEFAULT_EVENT_POLICIES);
    const customPolicies = raw.eventPolicies && typeof raw.eventPolicies === 'object' ? raw.eventPolicies : {};
    for (const code of INCIDENT_CODES) {
        if (!customPolicies[code]) continue;
        const merged = { ...policies[code], ...customPolicies[code] };
        merged.severity = SEVERITIES.has(merged.severity) ? merged.severity : policies[code].severity;
        merged.warningWeight = clampNumber(merged.warningWeight, policies[code].warningWeight, 0, 20);
        merged.cooldownMs = Math.floor(clampNumber(merged.cooldownMs, policies[code].cooldownMs, 0, 300000));
        merged.maxToleratedCount = Math.floor(clampNumber(merged.maxToleratedCount, policies[code].maxToleratedCount, 0, 1000));
        policies[code] = merged;
    }
    const warningLimit = clampNumber(raw.warningLimit ?? raw.maxViolations ?? raw.maxViol, defaults.warningLimit, 1, 100);
    const config = {
        ...defaults, ...raw, mode,
        requireFullscreen: bool(raw.requireFullscreen ?? raw.fullscreen, defaults.requireFullscreen),
        maxAttempts: Math.floor(clampNumber(raw.maxAttempts, defaults.maxAttempts, 1, 20)),
        allowBacktracking: bool(raw.allowBacktracking, defaults.allowBacktracking),
        oneQuestionPerPage: bool(raw.oneQuestionPerPage, defaults.oneQuestionPerPage),
        showNavigator: bool(raw.showNavigator, defaults.showNavigator),
        allowResumeAfterRefresh: bool(raw.allowResumeAfterRefresh, defaults.allowResumeAfterRefresh),
        allowResumeAfterConnectionLoss: bool(raw.allowResumeAfterConnectionLoss, defaults.allowResumeAfterConnectionLoss),
        connectionGraceSeconds: Math.floor(clampNumber(raw.connectionGraceSeconds, defaults.connectionGraceSeconds, 5, 600)),
        maxSimultaneousSessions: Math.floor(clampNumber(raw.maxSimultaneousSessions, defaults.maxSimultaneousSessions, 1, 5)),
        warningLimit,
        finalWarningThreshold: clampNumber(raw.finalWarningThreshold, Math.min(defaults.finalWarningThreshold, warningLimit), 0, warningLimit),
        pauseAfterWarningCount: clampNumber(raw.pauseAfterWarningCount, defaults.pauseAfterWarningCount, 0, warningLimit),
        autoSubmitAfterFinalViolation: bool(raw.autoSubmitAfterFinalViolation ?? raw.autoSubmitOnViolation, defaults.autoSubmitAfterFinalViolation),
        autoSubmitHighRiskOnly: bool(raw.autoSubmitHighRiskOnly, defaults.autoSubmitHighRiskOnly),
        adminReviewInsteadOfAutoSubmit: bool(raw.adminReviewInsteadOfAutoSubmit, defaults.adminReviewInsteadOfAutoSubmit),
        resetWarningOnApprovedResume: bool(raw.resetWarningOnApprovedResume, defaults.resetWarningOnApprovedResume),
        warningCalculation: ['weighted', 'count'].includes(raw.warningCalculation) ? raw.warningCalculation : defaults.warningCalculation,
        monitoring: { ...defaults.monitoring, ...(raw.monitoring || {}) },
        media: { ...defaults.media, ...(raw.media || {}) },
        requireSecureBrowser: bool(raw.requireSecureBrowser, defaults.requireSecureBrowser),
        secureBrowserProvider: clampText(raw.secureBrowserProvider || defaults.secureBrowserProvider || 'none', 80),
        secureBrowserConfigId: clampText(raw.secureBrowserConfigId, 120),
        secureBrowserVerificationEnabled: bool(raw.secureBrowserVerificationEnabled, defaults.secureBrowserVerificationEnabled),
        eventPolicies: policies
    };
    config.fullscreen = config.requireFullscreen;
    config.maxViolations = config.warningLimit;
    config.autoSubmitOnViolation = config.autoSubmitAfterFinalViolation;
    return config;
}
function publicSecurityConfig(settings, env) {
    const c = normalizeSecurityConfig(settings);
    return {
        mode: c.mode, requireFullscreen: c.requireFullscreen, maxAttempts: c.maxAttempts,
        allowBacktracking: c.allowBacktracking, oneQuestionPerPage: c.oneQuestionPerPage,
        showNavigator: c.showNavigator, allowResumeAfterRefresh: c.allowResumeAfterRefresh,
        allowResumeAfterConnectionLoss: c.allowResumeAfterConnectionLoss,
        connectionGraceSeconds: c.connectionGraceSeconds, maxSimultaneousSessions: c.maxSimultaneousSessions,
        warningLimit: c.warningLimit, finalWarningThreshold: c.finalWarningThreshold,
        pauseAfterWarningCount: c.pauseAfterWarningCount, autoSubmitAfterFinalViolation: c.autoSubmitAfterFinalViolation,
        autoSubmitHighRiskOnly: c.autoSubmitHighRiskOnly, adminReviewInsteadOfAutoSubmit: c.adminReviewInsteadOfAutoSubmit,
        resetWarningOnApprovedResume: c.resetWarningOnApprovedResume, warningCalculation: c.warningCalculation, monitoring: { ...c.monitoring }, media: { ...c.media },
        requireSecureBrowser: c.requireSecureBrowser, secureBrowserProvider: c.secureBrowserProvider,
        secureBrowserVerificationEnabled: c.secureBrowserVerificationEnabled,
        secureBrowserInstructions: clampText(envValue(env, 'SECURE_BROWSER_PUBLIC_INSTRUCTIONS'), 2000),
        secureBrowserLaunchUrl: safeHttpsUrl(envValue(env, 'SECURE_BROWSER_PUBLIC_LAUNCH_URL')).slice(0, 500),
        fullscreen: c.requireFullscreen, maxViolations: c.warningLimit, autoSubmitOnViolation: c.autoSubmitAfterFinalViolation,
        eventPolicies: Object.fromEntries(Object.entries(c.eventPolicies).map(([code, policy]) => [code, {
            enabled: policy.enabled !== false, severity: policy.severity, countsWarning: !!policy.countsWarning,
            warningWeight: Number(policy.warningWeight || 0), pausesExam: !!policy.pausesExam,
            requireFullscreenRestore: !!policy.requireFullscreenRestore, cooldownMs: Number(policy.cooldownMs || 0)
        }]))
    };
}
function assessmentFromRow(row) {
    return { ...row, duration_minutes: Number(row.duration_minutes || 30), question_count: Number(row.question_count || 0), attempt_count: Number(row.attempt_count || 0), violation_count: Number(row.violation_count || 0), settings: parseJson(row.settings_json, {}) };
}
function studentAssessmentFromRow(row, env) {
    const assessment = assessmentFromRow(row);
    const security = publicSecurityConfig(assessment.settings, env);
    return { id: assessment.id, title: assessment.title, instructions: assessment.instructions, subject_code: assessment.subject_code, section: assessment.section, status: assessment.status, duration_minutes: assessment.duration_minutes, opens_at: assessment.opens_at, closes_at: assessment.closes_at, created_at: assessment.created_at, updated_at: assessment.updated_at, settings: { security, ...security } };
}
function questionFromRow(row, includeKey = false) {
    const question = { id: row.id, assessment_id: row.assessment_id, type: row.type, prompt: row.prompt, points: Number(row.points || 1), choices: parseJson(row.choices_json, []), category: row.category || '', difficulty: row.difficulty || '', explanation: row.explanation || '', order_no: Number(row.order_no || 1) };
    if (includeKey) question.answer_key = row.answer_key || '';
    return question;
}
function shuffleList(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    for (let index = list.length - 1; index > 0; index -= 1) { const swap = Math.floor(Math.random() * (index + 1)); [list[index], list[swap]] = [list[swap], list[index]]; }
    return list;
}
function uniqueId(base, used, prefix = 'sec') {
    let candidate = clampText(base, 80) || id(prefix);
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    let suffix = 2; while (used.has(`${candidate}_${suffix}`)) suffix += 1;
    candidate = `${candidate}_${suffix}`; used.add(candidate); return candidate;
}
function normalizeBuilderSections(settings, bankQuestions = []) {
    const source = Array.isArray(settings?.builderSections) ? settings.builderSections : [];
    const inferred = [];
    if (!source.length) for (const question of bankQuestions) {
        const category = clampText(question.sectionId || question.category, 80);
        if (category && !inferred.some(item => item.id === category)) inferred.push({ id: category, title: category });
    }
    const input = source.length ? source : inferred, used = new Set();
    const sections = input.map((section, index) => ({ id: uniqueId(section?.id, used), title: clampText(section?.title || `Section ${index + 1}`, 120) || `Section ${index + 1}`, pickCount: Math.max(0, Math.floor(Number(section?.pickCount || 0))), shuffleQuestions: !!section?.shuffleQuestions, shuffleChoices: !!section?.shuffleChoices, collapsed: !!section?.collapsed }));
    if (!sections.length) sections.push({ id: 'default_section', title: 'Section 1', pickCount: 0, shuffleQuestions: false, shuffleChoices: false, collapsed: false });
    return sections;
}
function normalizeChoices(question, type) {
    if (type === 'true_false') return ['True', 'False'];
    if (type !== 'multiple_choice') return [];
    const clean = [], seen = new Set();
    for (const value of Array.isArray(question.choices) ? question.choices : []) {
        const choice = clampText(value, 500), key = choice.toLowerCase();
        if (!choice || seen.has(key)) continue;
        seen.add(key); clean.push(choice); if (clean.length >= 40) break;
    }
    return clean;
}
function normalizeQuestions(rawQuestions, sections) {
    const sectionIds = new Set(sections.map(section => section.id)), first = sections[0].id;
    return rawQuestions.slice(0, 1000).map((question, index) => {
        const type = ['multiple_choice', 'true_false', 'short_answer', 'essay'].includes(question?.type) ? question.type : 'multiple_choice';
        const choices = normalizeChoices(question || {}, type);
        let answerKey = type === 'essay' ? '' : clampText(question?.answer_key, 1000);
        if (type === 'true_false') answerKey = /^false$/i.test(answerKey) ? 'False' : 'True';
        const section = clampText(question?.sectionId || question?.category, 80);
        return { id: clampText(question?.id, 80) || id('q'), type, prompt: clampText(question?.prompt, 6000), points: Math.max(1, Math.min(1000, Number(question?.points || 1))), answer_key: answerKey, choices, category: sectionIds.has(section) ? section : first, difficulty: clampText(question?.difficulty, 50), explanation: clampText(question?.explanation, 2000), order_no: Number.isFinite(Number(question?.order_no)) ? Number(question.order_no) : index + 1, source_index: index };
    }).filter(question => question.prompt);
}
function validatePublishedQuestions(questions) {
    for (const [index, question] of questions.entries()) {
        if (question.type === 'multiple_choice' && (question.choices.length < 2 || !question.answer_key || !question.choices.includes(question.answer_key))) return `Question ${index + 1} needs valid choices and a correct answer.`;
        if (question.type === 'true_false' && !['True', 'False'].includes(question.answer_key)) return `Question ${index + 1} needs a True or False answer.`;
    }
    return '';
}
function clampSectionPickCounts(sections, questions) {
    const counts = new Map(sections.map(section => [section.id, 0]));
    questions.forEach(question => counts.set(question.category, (counts.get(question.category) || 0) + 1));
    return sections.map(section => ({ ...section, pickCount: section.pickCount > 0 && section.pickCount < (counts.get(section.id) || 0) ? section.pickCount : 0 }));
}
function buildRuntimeQuestions(assessment, bankQuestions) {
    const settings = parseJson(assessment.settings_json, assessment.settings || {});
    const sections = normalizeBuilderSections(settings, bankQuestions), grouped = new Map(sections.map(section => [section.id, []])), fallback = sections[0].id;
    bankQuestions.forEach(question => { const key = grouped.has(String(question.category || '')) ? String(question.category) : fallback; grouped.get(key).push(question); });
    const runtime = [];
    sections.forEach((section, sectionIndex) => {
        const ordered = (grouped.get(section.id) || []).slice().sort((a, b) => Number(a.order_no || 0) - Number(b.order_no || 0));
        let selected = ordered;
        if (section.pickCount > 0 && section.pickCount < ordered.length) {
            const picked = new Set(shuffleList(ordered).slice(0, section.pickCount).map(question => question.id));
            selected = ordered.filter(question => picked.has(question.id));
        }
        if (section.shuffleQuestions) selected = shuffleList(selected);
        selected.forEach((question, index) => runtime.push({ ...question, choices: section.shuffleChoices ? shuffleList(question.choices || []) : (question.choices || []).slice(), section_id: section.id, section_title: section.title, section_order: sectionIndex + 1, section_question_no: index + 1 }));
    });
    return runtime;
}
function safeRuntimeQuestion(question) { const { answer_key, explanation, ...safe } = question; return safe; }
function sanitizeDraftAnswers(runtimeQuestions, rawAnswers) {
    const source = rawAnswers && typeof rawAnswers === 'object' ? rawAnswers : {}, allowed = new Set((runtimeQuestions || []).map(question => String(question.id))), clean = {};
    for (const [questionId, value] of Object.entries(source)) if (allowed.has(String(questionId))) clean[String(questionId)] = String(value ?? '').slice(0, 12000);
    return clean;
}
function grade(questions, answers) {
    let score = 0, total = 0, manualCount = 0; const detail = {};
    for (const question of questions) {
        const points = Number(question.points || 1); total += points;
        const expected = String(question.answer_key || '').trim(), actual = String(answers[question.id] || '').trim();
        const manual = question.type === 'essay' || !expected; if (manual) manualCount += 1;
        const correct = !manual && expected.toLowerCase() === actual.toLowerCase();
        const earned = correct ? points : 0; score += earned;
        detail[question.id] = { answer: actual, points: earned, manual };
    }
    return { score, total, detail, manualCount };
}
function studentIdentity(profile) {
    return {
        studentNo: String(profile.studentNo || profile.student_no || profile.username || '').trim(),
        studentName: String(profile.studentName || profile.fullName || profile.name || profile.email || 'Student').trim(),
        uid: String(profile.uid || profile.id || ''), section: String(profile.section || '').trim(),
        status: String(profile.status || 'active').toLowerCase()
    };
}
function sectionAssigned(assessmentSection, studentSection) {
    const assigned = String(assessmentSection || '').trim().toUpperCase(), student = String(studentSection || '').trim().toUpperCase();
    return assigned === 'ALL' || (!!assigned && assigned === student);
}
function attemptAccessError(attempt, identity) {
    if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    if (!sectionAssigned(attempt.assessment_section, identity.section)) return json({ error: 'This assessment is not assigned to your section.' }, 403);
    return null;
}
async function getAssessmentAndQuestions(env, assessmentId) {
    const [assessmentResult, questionResult] = await turso(env, [
        { sql: `select * from assessments where id = ? limit 1`, args: [assessmentId] },
        { sql: `select * from assessment_questions where assessment_id = ? order by order_no`, args: [assessmentId] }
    ]);
    return { assessment: rows(assessmentResult)[0] || null, questions: rows(questionResult).map(row => questionFromRow(row, true)) };
}
async function loadRuntimeQuestions(env, attempt) {
    const meta = parseJson(attempt.answers_json, {});
    if (Array.isArray(meta.runtimeQuestions) && meta.runtimeQuestions.length) return meta.runtimeQuestions;
    const { assessment, questions } = await getAssessmentAndQuestions(env, attempt.assessment_id);
    return assessment ? buildRuntimeQuestions(assessment, questions) : questions;
}
async function finalizeAttempt(env, attempt, reason = 'manual_submit', providedAnswers = null, sessionId = '') {
    if (!attempt || attempt.status === 'submitted' || attempt.status === 'invalidated') {
        return { alreadySubmitted: true, score: Number(attempt?.score || 0), total: Number(attempt?.total_points || 0), submittedAt: attempt?.submitted_at, reason: attempt?.submission_reason || reason };
    }
    const runtime = await loadRuntimeQuestions(env, attempt), meta = parseJson(attempt.answers_json, {});
    const answers = sanitizeDraftAnswers(runtime, providedAnswers || meta.draftAnswers || meta.raw || {}), result = grade(runtime, answers), now = nowIso();
    const nextMeta = { ...meta, runtimeQuestions: runtime, draftAnswers: answers, raw: answers, graded: result.detail, runtimeQuestionIds: runtime.map(q => q.id), completedSessionId: sessionId || attempt.active_session_id || '', completedAt: now, submissionReason: reason, manualGradingRequired: result.manualCount > 0 };
    await turso(env, [
        { sql: `update assessment_attempts set status = 'submitted', answers_json = ?, score = ?, total_points = ?, submitted_at = ?, finalized_at = ?, expired_at = case when ? = 'time_expired' then ? else expired_at end, submission_reason = ?, security_status = case when ? in ('anomaly_limit_reached','session_conflict') then 'flagged' else security_status end where id = ? and status = 'started'`, args: [JSON.stringify(nextMeta), result.score, result.total, now, now, reason, now, reason, reason, attempt.id] },
        { sql: `update assessment_sessions set status = 'ended', ended_at = ?, termination_reason = ? where attempt_id = ? and status = 'active'`, args: [now, reason, attempt.id] }
    ]);
    return { score: result.score, total: result.total, submittedAt: now, reason, manualGradingRequired: result.manualCount > 0 };
}
async function finalizeExpiredAttemptsForStudent(env, studentNo) {
    const now = nowIso();
    const [result] = await turso(env, [{ sql: `select * from assessment_attempts where student_no = ? and status = 'started' and deadline_at is not null and deadline_at <= ?`, args: [studentNo, now] }]);
    for (const attempt of rows(result)) await finalizeAttempt(env, attempt, 'time_expired');
}
async function enforceDeadline(env, attempt) {
    if (attempt.status !== 'started') return null;
    const deadline = Date.parse(attempt.deadline_at || '');
    if (Number.isFinite(deadline) && Date.now() >= deadline) return finalizeAttempt(env, attempt, 'time_expired');
    return null;
}
async function verifySecureBrowser(env, request, assessment, security, body = {}) {
    if (!security.requireSecureBrowser) return { status: 'not_required', passed: true, provider: security.secureBrowserProvider || 'none' };
    if (!security.secureBrowserVerificationEnabled) return { status: 'unavailable', passed: false, provider: security.secureBrowserProvider, message: 'Secure-browser verification is required but is not enabled for this deployment.' };
    const endpoint = safeHttpsUrl(envValue(env, 'SECURE_BROWSER_VERIFIER_URL'));
    const secret = envValue(env, 'SECURE_BROWSER_VERIFIER_SECRET');
    if (!endpoint || !secret) return { status: 'unavailable', passed: false, provider: security.secureBrowserProvider, message: 'The secure-browser verification service is not configured.' };
    const proof = clampText(request.headers.get('x-secure-browser-proof') || body.secure_browser_proof, 4000);
    if (!proof) return { status: 'failed', passed: false, provider: security.secureBrowserProvider, message: 'Secure-browser verification proof was not provided.' };
    try {
        const response = await fetch(endpoint, { method: 'POST', headers: { ...JSON_HEADERS, authorization: `Bearer ${secret}` }, body: JSON.stringify({ provider: security.secureBrowserProvider, config_id: security.secureBrowserConfigId, assessment_id: assessment.id, proof }) });
        const data = await response.json().catch(() => ({}));
        return data?.verified === true ? { status: 'verified', passed: true, provider: security.secureBrowserProvider } : { status: 'failed', passed: false, provider: security.secureBrowserProvider, message: 'Secure-browser verification failed.' };
    } catch {
        return { status: 'unavailable', passed: false, provider: security.secureBrowserProvider, message: 'The secure-browser verification service is unavailable.' };
    }
}
async function eligibility(env, request, profile, assessmentId, body = {}) {
    const identity = studentIdentity(profile);
    if (!assessmentId || !identity.studentNo) return { error: json({ error: 'Assessment eligibility could not be checked.' }, 422) };
    if (identity.status === 'inactive') return { error: json({ error: 'Account is inactive.' }, 403) };
    await finalizeExpiredAttemptsForStudent(env, identity.studentNo);
    const { assessment, questions } = await getAssessmentAndQuestions(env, assessmentId);
    if (!assessment) return { error: json({ error: 'Assessment not found.' }, 404) };
    if (!sectionAssigned(assessment.section, identity.section)) return { error: json({ error: 'This assessment is not assigned to your section.' }, 403) };
    if (assessment.status !== 'published') return { error: json({ error: 'Assessment is not published.' }, 403) };
    const now = Date.now();
    if (assessment.opens_at && now < Date.parse(assessment.opens_at)) return { error: json({ error: 'Assessment has not opened yet.' }, 403) };
    if (assessment.closes_at && now > Date.parse(assessment.closes_at)) return { error: json({ error: 'Assessment is already closed.' }, 403) };
    const settings = parseJson(assessment.settings_json, {}), security = normalizeSecurityConfig(settings);
    const [attemptResult] = await turso(env, [{ sql: `select * from assessment_attempts where assessment_id = ? and student_no = ? order by coalesce(attempt_no, 0) desc, started_at desc`, args: [assessmentId, identity.studentNo] }]);
    const attempts = rows(attemptResult), activeAttempt = attempts.find(item => item.status === 'started'), completedAttempts = attempts.filter(item => item.status === 'submitted').length;
    if (!activeAttempt && completedAttempts >= security.maxAttempts) return { error: json({ error: 'You have already used the maximum number of attempts for this assessment.', code: 'MAX_ATTEMPTS_REACHED' }, 403) };
    const secureBrowser = await verifySecureBrowser(env, request, assessment, security, body);
    return { assessment, questions, settings, security, attempts, activeAttempt, identity, nextAttemptNo: Math.max(0, ...attempts.map(item => Number(item.attempt_no || 0))) + 1, secureBrowser };
}
async function sessionIpHash(env, request) {
    const salt = envValue(env, 'ASSESSMENT_PRIVACY_SALT');
    const ip = request.headers.get('cf-connecting-ip') || '';
    return salt && ip ? (await sha256(`${salt}:${ip}`)).slice(0, 32) : '';
}
function sanitizeDevice(body = {}) {
    const source = body.device && typeof body.device === 'object' ? body.device : {};
    return {
        deviceId: clampText(body.device_id || source.device_id, 120),
        deviceType: clampText(source.device_type, 40), browserName: clampText(source.browser_name, 80),
        operatingSystem: clampText(source.operating_system, 80), userAgentSummary: clampText(source.user_agent_summary, 240),
        tabInstanceId: clampText(body.tab_instance_id, 120), clientSessionId: clampText(body.client_session_id, 120)
    };
}
async function recordServerIncident(env, attempt, security, code, details, sessionId = '', actionHint = 'server_recorded') {
    const canonical = canonicalIncidentCode(code);
    const policy = security?.eventPolicies?.[canonical] || DEFAULT_EVENT_POLICIES[canonical];
    if (!policy) return { warningCount: Number(attempt.warning_count || attempt.violations || 0), submitted: false };
    const [countResult] = await turso(env, [{ sql: `select count(*) as count from assessment_incidents where attempt_id=? and type=?`, args: [attempt.id, canonical] }]);
    const eventCount = Number(rows(countResult)[0]?.count || 0) + 1;
    const warningWeight = policy.enabled !== false && policy.countsWarning ? Number(policy.warningWeight || 0) : 0;
    const currentWarning = Number(attempt.warning_count || attempt.violations || 0);
    const nextWarning = Math.max(0, currentWarning + (security.warningCalculation === 'count' && warningWeight > 0 ? 1 : warningWeight));
    const severity = SEVERITIES.has(policy.severity) ? policy.severity : 'medium';
    const nextViolations = Math.ceil(nextWarning);
    const nextSecurityScore = Number(attempt.security_score || 0) + ({ info: 0, low: 1, medium: 2, high: 4, critical: 7 }[severity] || 1);
    const overTolerance = Number(policy.maxToleratedCount || 0) > 0 && eventCount > Number(policy.maxToleratedCount);
    const highRisk = severity === 'high' || severity === 'critical' || overTolerance;
    const reachedLimit = nextWarning >= Number(security.warningLimit || 5);
    const canAutoSubmit = policy.mayAutoSubmit !== false && (!security.autoSubmitHighRiskOnly || highRisk);
    const shouldAutoSubmit = security.autoSubmitAfterFinalViolation && reachedLimit && canAutoSubmit && !security.adminReviewInsteadOfAutoSubmit;
    const shouldPause = !!policy.pausesExam || (security.pauseAfterWarningCount > 0 && nextWarning >= security.pauseAfterWarningCount) || (reachedLimit && security.adminReviewInsteadOfAutoSubmit);
    const now = nowIso();
    const actionTaken = shouldAutoSubmit ? 'automatic_submission' : shouldPause ? 'assessment_paused' : actionHint;
    await turso(env, [
        { sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,client_event_id,session_id,event_group,severity,warning_weight,event_count,metadata_json,first_detected_at,last_detected_at,duration_seconds,action_taken,review_status,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unreviewed',?)`, args: [id('inc'), attempt.id, attempt.assessment_id, attempt.student_no, canonical, clampText(details, 1000), id('evt'), sessionId || null, canonical, severity, warningWeight, 1, '{}', now, now, 0, actionTaken, now] },
        { sql: `update assessment_attempts set warning_count=?,violations=?,security_score=?,security_status=? where id=? and status='started'`, args: [nextWarning, nextViolations, nextSecurityScore, shouldPause || highRisk ? 'flagged' : attempt.security_status || 'normal', attempt.id] }
    ]);
    let final = null;
    if (shouldAutoSubmit) final = await finalizeAttempt(env, { ...attempt, warning_count: nextWarning, violations: nextViolations, security_score: nextSecurityScore }, 'anomaly_limit_reached', null, sessionId);
    return { warningCount: nextWarning, violations: nextViolations, securityScore: nextSecurityScore, submitted: !!final, final };
}

async function preflightSessionStatus(env, activeAttempt, body, security) {
    if (!activeAttempt) return { passed: true, status: 'passed', message: 'No conflicting active session' };
    const staleCutoffMs = Date.now() - Math.max(60, Number(security.connectionGraceSeconds || 60) * 2) * 1000;
    const [result] = await turso(env, [{ sql: `select * from assessment_sessions where attempt_id = ? and status = 'active' order by started_at`, args: [activeAttempt.id] }]);
    const activeSessions = rows(result);
    const freshSessions = activeSessions.filter(item => {
        const heartbeat = Date.parse(item.last_heartbeat_at || item.started_at || '');
        return !Number.isFinite(heartbeat) || heartbeat >= staleCutoffMs;
    });
    if (!freshSessions.length) {
        return { passed: true, status: 'warning', message: 'An interrupted attempt is available for safe recovery' };
    }
    const suppliedSessionId = clampText(body.session_id, 100);
    const suppliedToken = clampText(body.session_token, 500);
    const suppliedClientSessionId = clampText(body.client_session_id, 120);
    if (suppliedSessionId && suppliedToken) {
        const matching = freshSessions.find(item => item.id === suppliedSessionId && (!suppliedClientSessionId || item.client_session_id === suppliedClientSessionId));
        if (matching && await sha256(suppliedToken) === matching.session_token_hash) {
            return { passed: true, status: 'warning', message: 'Your active assessment session can be resumed on this browser' };
        }
    }
    if (freshSessions.length >= Number(security.maxSimultaneousSessions || 1)) {
        return { passed: false, status: 'failed', message: 'This assessment is active in another tab, window, or device' };
    }
    return { passed: true, status: 'warning', message: 'Another allowed session is active for this attempt' };
}

async function createExamSession(env, request, attempt, identity, body, security, isResume = false) {
    const device = sanitizeDevice(body), now = nowIso(), staleCutoff = new Date(Date.now() - Math.max(60, security.connectionGraceSeconds * 2) * 1000).toISOString();
    const [staleResult] = await turso(env, [{ sql: `select * from assessment_sessions where attempt_id = ? and status = 'active' and last_heartbeat_at < ?`, args: [attempt.id, staleCutoff] }]);
    const staleSessions = rows(staleResult);
    if (staleSessions.length) {
        const statements = [{ sql: `update assessment_sessions set status = 'stale', ended_at = ?, termination_reason = 'heartbeat_timeout' where attempt_id = ? and status = 'active' and last_heartbeat_at < ?`, args: [now, attempt.id, staleCutoff] }];
        staleSessions.forEach(session => statements.push({ sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,client_event_id,session_id,event_group,severity,warning_weight,event_count,metadata_json,first_detected_at,last_detected_at,duration_seconds,action_taken,review_status,created_at) values (?,?,?,?,?,'The exam session stopped sending heartbeats and was marked stale.',?,?,?,'medium',0,1,'{}',?,?,0,'session_marked_stale','unreviewed',?)`, args: [id('inc'), attempt.id, attempt.assessment_id, identity.studentNo, 'heartbeat_timeout', id('evt'), session.id, 'heartbeat_timeout', session.last_heartbeat_at || now, now, now] }));
        await turso(env, statements);
    }
    const [sessionResult] = await turso(env, [{ sql: `select * from assessment_sessions where attempt_id = ? and status = 'active' order by started_at`, args: [attempt.id] }]);
    const activeSessions = rows(sessionResult);
    const suppliedToken = clampText(body.session_token, 500), suppliedSessionId = clampText(body.session_id, 100);
    if (suppliedToken && suppliedSessionId) {
        const existing = activeSessions.find(item => item.id === suppliedSessionId && item.client_session_id === device.clientSessionId);
        if (existing && await sha256(suppliedToken) === existing.session_token_hash) return { session: existing, token: suppliedToken, recovered: true };
    }
    if (isResume && !security.allowResumeAfterRefresh) {
        return { error: json({ error: 'This assessment does not allow resuming after the page is refreshed or closed.', code: 'RESUME_NOT_ALLOWED' }, 409) };
    }
    if (isResume && staleSessions.length && !security.allowResumeAfterConnectionLoss) {
        return { error: json({ error: 'This assessment does not allow resuming after a lost connection.', code: 'CONNECTION_RESUME_NOT_ALLOWED' }, 409) };
    }
    if (activeSessions.length >= security.maxSimultaneousSessions) {
        const differentDevice = activeSessions.some(item => device.deviceId && item.device_id && item.device_id !== device.deviceId);
        const code = differentDevice ? 'duplicate_device_session' : 'duplicate_exam_tab';
        const recorded = await recordServerIncident(
            env,
            { ...attempt, student_no: identity.studentNo },
            security,
            code,
            differentDevice ? 'A new device attempted to claim an already active exam.' : 'A new tab or window attempted to claim an already active exam.',
            activeSessions[0]?.id || '',
            'session_start_rejected'
        );
        return { error: json({
            error: recorded.submitted
                ? 'The warning limit was reached and the active attempt was finalized.'
                : differentDevice ? 'This assessment is active on another device.' : 'This assessment is active in another tab or window.',
            code: recorded.submitted ? 'ATTEMPT_FINALIZED' : differentDevice ? 'DUPLICATE_DEVICE_SESSION' : 'EXAM_ALREADY_ACTIVE',
            warning_count: recorded.warningCount
        }, 409) };
    }
    const sessionId = id('ses'), token = randomToken(36), tokenHash = await sha256(token), ipHash = await sessionIpHash(env, request);
    await turso(env, [{ sql: `insert into assessment_sessions (id,attempt_id,assessment_id,student_no,client_session_id,session_token_hash,tab_instance_id,device_id,device_type,browser_name,operating_system,user_agent_summary,ip_hash,status,started_at,last_heartbeat_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`, args: [sessionId, attempt.id, attempt.assessment_id, identity.studentNo, device.clientSessionId, tokenHash, device.tabInstanceId, device.deviceId, device.deviceType, device.browserName, device.operatingSystem, device.userAgentSummary, ipHash, now, now, now] }]);
    return { session: { id: sessionId, client_session_id: device.clientSessionId, device_id: device.deviceId, started_at: now, last_heartbeat_at: now, status: 'active' }, token, recovered: activeSessions.length === 0 && !!attempt.active_session_id };
}
async function verifyExamSession(env, attempt, body, studentNo) {
    const sessionId = clampText(body.session_id, 100), token = clampText(body.session_token, 500), clientSessionId = clampText(body.client_session_id, 120);
    if (sessionId && token) {
        const [result] = await turso(env, [{ sql: `select * from assessment_sessions where id = ? and attempt_id = ? and student_no = ? limit 1`, args: [sessionId, attempt.id, studentNo] }]);
        const session = rows(result)[0];
        if (!session || session.status !== 'active' || await sha256(token) !== session.session_token_hash) return { error: json({ error: 'This exam session is no longer active.', code: 'SESSION_MISMATCH' }, 409) };
        const config = normalizeSecurityConfig(parseJson(attempt.settings_json, {}));
        if (config.maxSimultaneousSessions <= 1 && attempt.active_session_id && attempt.active_session_id !== session.id) {
            const now = nowIso();
            await turso(env, [
                { sql: `update assessment_sessions set status='replaced',ended_at=?,termination_reason='session_replaced' where id=? and status='active'`, args: [now, session.id] }
            ]);
            const recorded = await recordServerIncident(
                env,
                { ...attempt, student_no: studentNo },
                config,
                'session_replaced',
                'An older exam session attempted to continue after another session became authoritative.',
                session.id,
                'session_rejected'
            );
            return { error: json({
                error: recorded.submitted ? 'The warning limit was reached and the active attempt was finalized.' : 'This exam session was replaced by another active session.',
                code: recorded.submitted ? 'ATTEMPT_FINALIZED' : 'SESSION_REPLACED',
                warning_count: recorded.warningCount
            }, 409) };
        }
        return { session };
    }
    // Backward compatibility for attempts created before the session table migration.
    const meta = parseJson(attempt.answers_json, {}), legacyId = clampText(meta.activeSessionId, 120);
    if (legacyId && clientSessionId === legacyId) return { session: { id: '', client_session_id: legacyId, legacy: true } };
    return { error: json({ error: 'A valid exam session is required.', code: 'SESSION_MISMATCH' }, 409) };
}
async function getAttemptForStudent(env, attemptId, studentNo) {
    const [result] = await turso(env, [{ sql: `select t.*, a.settings_json, a.section as assessment_section, a.status as assessment_status, a.closes_at as assessment_closes_at from assessment_attempts t join assessments a on a.id = t.assessment_id where t.id = ? and t.student_no = ? limit 1`, args: [attemptId, studentNo] }]);
    return rows(result)[0] || null;
}
async function logAdminAudit(env, admin, action, fields = {}) {
    await turso(env, [{ sql: `insert into assessment_admin_audit (id,assessment_id,attempt_id,incident_id,admin_id,action,details,created_at) values (?,?,?,?,?,?,?,?)`, args: [id('aud'), fields.assessment_id || null, fields.attempt_id || null, fields.incident_id || null, String(admin.id || admin.uid || admin.email || 'admin'), action, clampText(fields.details, 4000), nowIso()] }]);
}

async function adminList(env) {
    const [list] = await turso(env, [{ sql: `with question_totals as (select assessment_id,count(*) as question_count from assessment_questions group by assessment_id), attempt_totals as (select assessment_id,count(*) as attempt_count,coalesce(sum(violations),0) as violation_count from assessment_attempts group by assessment_id) select a.id,a.title,a.instructions,a.subject_code,a.section,a.status,a.duration_minutes,a.opens_at,a.closes_at,a.created_at,a.updated_at,coalesce(q.question_count,0) as question_count,coalesce(t.attempt_count,0) as attempt_count,coalesce(t.violation_count,0) as violation_count from assessments a left join question_totals q on q.assessment_id=a.id left join attempt_totals t on t.assessment_id=a.id order by a.updated_at desc,a.created_at desc` }]);
    return json({ assessments: rows(list).map(assessmentFromRow) });
}
async function adminGet(env, assessmentId) {
    const { assessment, questions } = await getAssessmentAndQuestions(env, assessmentId);
    if (!assessment) return json({ error: 'Assessment not found.' }, 404);
    return json({ assessment: assessmentFromRow(assessment), questions });
}
async function adminSave(request, env, admin) {
    const body = await readBody(request), now = nowIso(), assessment = body.assessment || {}, rawQuestions = Array.isArray(body.questions) ? body.questions : [];
    const assessmentId = clampText(assessment.id, 80) || id('asm'), title = clampText(assessment.title, 140), subject = clampText(assessment.subject_code, 80), section = clampText(assessment.section || 'ALL', 80);
    const status = ['draft', 'published', 'closed', 'archived'].includes(assessment.status) ? assessment.status : 'draft', duration = Math.max(1, Math.min(240, Number(assessment.duration_minutes || 30)));
    const incomingSettings = assessment.settings && typeof assessment.settings === 'object' ? assessment.settings : {};
    if (!title || !subject || !section) return json({ error: 'Complete the title, subject, and section.' }, 422);
    let builderSections = normalizeBuilderSections(incomingSettings, rawQuestions), questions = normalizeQuestions(rawQuestions, builderSections);
    builderSections = clampSectionPickCounts(builderSections, questions);
    if (status === 'published' && !questions.length) return json({ error: 'Add at least one question before publishing.' }, 422);
    if (status === 'published') { const error = validatePublishedQuestions(questions); if (error) return json({ error }, 422); }
    const security = normalizeSecurityConfig(incomingSettings), settings = { ...incomingSettings, security, fullscreen: security.requireFullscreen, maxViolations: security.warningLimit, autoSubmitOnViolation: security.autoSubmitAfterFinalViolation, builderSections };
    const sectionOrder = new Map(builderSections.map((item, index) => [item.id, index]));
    questions.sort((a, b) => (sectionOrder.get(a.category) ?? 999) - (sectionOrder.get(b.category) ?? 999) || Number(a.order_no || 0) - Number(b.order_no || 0) || a.source_index - b.source_index);
    const statements = [
        { sql: `insert into assessments (id,title,instructions,subject_code,section,status,duration_minutes,opens_at,closes_at,settings_json,created_by,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set title=excluded.title,instructions=excluded.instructions,subject_code=excluded.subject_code,section=excluded.section,status=excluded.status,duration_minutes=excluded.duration_minutes,opens_at=excluded.opens_at,closes_at=excluded.closes_at,settings_json=excluded.settings_json,updated_at=excluded.updated_at`, args: [assessmentId, title, clampText(assessment.instructions, 5000), subject, section, status, duration, assessment.opens_at || null, assessment.closes_at || null, JSON.stringify(settings), String(admin.id || admin.uid || admin.email || 'admin'), now, now] },
        { sql: `delete from assessment_questions where assessment_id = ?`, args: [assessmentId] }
    ];
    questions.forEach((question, index) => statements.push({ sql: `insert into assessment_questions (id,assessment_id,type,prompt,points,answer_key,choices_json,category,difficulty,explanation,order_no,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [question.id, assessmentId, question.type, question.prompt, question.points, question.answer_key, JSON.stringify(question.choices), question.category, question.difficulty, question.explanation, index + 1, now] }));
    await turso(env, statements);
    return json({ ok: true, id: assessmentId, sections: builderSections.length, questions: questions.length });
}
async function adminDelete(request, env) {
    const body = await readBody(request), assessmentId = clampText(body.id, 80);
    if (!assessmentId) return json({ error: 'Assessment ID is required.' }, 422);
    await turso(env, [{ sql: `delete from assessments where id = ?`, args: [assessmentId] }]); return json({ ok: true });
}
async function adminDuplicate(request, env, admin) {
    const body = await readBody(request), sourceId = clampText(body.source_id || body.id, 80);
    if (!sourceId) return json({ error: 'Select a test to duplicate.' }, 422);
    const { assessment: source, questions } = await getAssessmentAndQuestions(env, sourceId);
    if (!source) return json({ error: 'The source assessment no longer exists.' }, 404);
    const now = nowIso(), duplicateId = id('asm'), title = clampText(body.title, 140) || clampText(`${source.title} (Copy)`, 140), section = clampText(body.section, 80) || source.section || 'ALL', keep = body.keep_schedule === true;
    const statements = [{ sql: `insert into assessments (id,title,instructions,subject_code,section,status,duration_minutes,opens_at,closes_at,settings_json,created_by,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [duplicateId, title, source.instructions || '', source.subject_code || '', section, 'draft', Number(source.duration_minutes || 30), keep ? source.opens_at : null, keep ? source.closes_at : null, source.settings_json || '{}', String(admin.id || admin.uid || admin.email || 'admin'), now, now] }];
    questions.forEach((q, index) => statements.push({ sql: `insert into assessment_questions (id,assessment_id,type,prompt,points,answer_key,choices_json,category,difficulty,explanation,order_no,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id('q'), duplicateId, q.type, q.prompt, q.points, q.answer_key || '', JSON.stringify(q.choices || []), q.category || '', q.difficulty || '', q.explanation || '', index + 1, now] }));
    await turso(env, statements); return json({ ok: true, id: duplicateId, title, section, status: 'draft', questions: questions.length });
}
async function adminAttempts(env, assessmentId) {
    const [result] = await turso(env, [{ sql: `select * from assessment_attempts where assessment_id = ? order by submitted_at desc, started_at desc`, args: [assessmentId] }]);
    return json({ attempts: rows(result).map(row => ({ ...row, answers: parseJson(row.answers_json, {}), score: Number(row.score || 0), total_points: Number(row.total_points || 0), violations: Number(row.violations || 0), warning_count: Number(row.warning_count || row.violations || 0), security_score: Number(row.security_score || 0) })) });
}
function buildIncidentFilters(url) {
    const clauses = [], args = [];
    const add = (sql, value) => { if (value) { clauses.push(sql); args.push(value); } };
    add('i.assessment_id = ?', clampText(url.searchParams.get('assessment_id'), 80));
    add('a.section = ?', clampText(url.searchParams.get('section'), 80));
    add('i.student_no = ?', clampText(url.searchParams.get('student_no'), 80));
    add('i.attempt_id = ?', clampText(url.searchParams.get('attempt_id'), 80));
    add('i.session_id = ?', clampText(url.searchParams.get('session_id'), 80));
    add('i.type = ?', canonicalIncidentCode(url.searchParams.get('type')));
    add('i.severity = ?', clampText(url.searchParams.get('severity'), 20));
    add('i.review_status = ?', clampText(url.searchParams.get('review_status'), 40));
    add('t.submission_reason = ?', clampText(url.searchParams.get('submission_reason'), 80));
    const category = clampText(url.searchParams.get('category'), 40);
    if (category === 'duplicate_session') clauses.push("i.type in ('duplicate_exam_tab','duplicate_device_session','session_replaced')");
    if (category === 'automatic_submission') clauses.push("i.action_taken = 'automatic_submission'");
    if (category === 'connection') clauses.push("i.type in ('network_disconnected','network_reconnected','heartbeat_timeout')");
    const from = clampText(url.searchParams.get('date_from'), 40), to = clampText(url.searchParams.get('date_to'), 40), cursor = clampText(url.searchParams.get('cursor'), 40);
    if (from) { clauses.push('i.created_at >= ?'); args.push(from); }
    if (to) { clauses.push('i.created_at <= ?'); args.push(to); }
    if (cursor) { clauses.push('i.created_at < ?'); args.push(cursor); }
    return { where: clauses.length ? 'where ' + clauses.join(' and ') : '', args };
}
async function adminIncidents(env, url) {
    const { where, args } = buildIncidentFilters(url), limit = Math.floor(clampNumber(url.searchParams.get('limit'), 100, 20, 200));
    const [result] = await turso(env, [{ sql: `select i.*, a.title as assessment_title, a.section as assessment_section, a.subject_code, t.student_name, t.attempt_no, t.submission_reason, t.status as attempt_status from assessment_incidents i left join assessments a on a.id = i.assessment_id left join assessment_attempts t on t.id = i.attempt_id ${where} order by i.created_at desc, i.id desc limit ?`, args: [...args, limit + 1] }]);
    const list = rows(result), hasMore = list.length > limit, incidents = list.slice(0, limit);
    return json({ incidents, next_cursor: hasMore ? incidents[incidents.length - 1]?.created_at : null, has_more: hasMore });
}
async function adminAttemptDetail(env, attemptId) {
    const [attemptResult, sessionsResult, summaryResult] = await turso(env, [
        { sql: `select t.*, a.title as assessment_title, a.section as assessment_section, a.subject_code from assessment_attempts t join assessments a on a.id=t.assessment_id where t.id=? limit 1`, args: [attemptId] },
        { sql: `select id,client_session_id,tab_instance_id,device_id,device_type,browser_name,operating_system,user_agent_summary,status,started_at,last_heartbeat_at,ended_at,termination_reason from assessment_sessions where attempt_id=? order by started_at`, args: [attemptId] },
        { sql: `select count(*) as incident_count, coalesce(sum(duration_seconds),0) as total_duration, coalesce(sum(case when type='tab_switch' then 1 else 0 end),0) as tab_switch_count, coalesce(sum(case when type='fullscreen_exit' then 1 else 0 end),0) as fullscreen_exit_count, coalesce(sum(case when type in ('duplicate_exam_tab','duplicate_device_session') then 1 else 0 end),0) as duplicate_session_count, coalesce(sum(case when type='network_disconnected' then duration_seconds else 0 end),0) as offline_duration, coalesce(sum(case when type='tab_switch' then duration_seconds else 0 end),0) as hidden_duration, max(case severity when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 else 1 end) as max_severity_rank from assessment_incidents where attempt_id=?`, args: [attemptId] }
    ]);
    const attempt = rows(attemptResult)[0]; if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    const summary = rows(summaryResult)[0] || {};
    const rankLabels = { 1: 'info', 2: 'low', 3: 'medium', 4: 'high', 5: 'critical' };
    return json({ attempt: { ...attempt, answers: undefined, answers_json: undefined }, sessions: rows(sessionsResult), summary: { ...summary, highest_severity: rankLabels[Number(summary.max_severity_rank || 1)] } });
}
async function adminAttemptTimeline(env, attemptId, cursor = '') {
    const args = [attemptId], cursorClause = cursor ? 'and created_at < ?' : ''; if (cursor) args.push(cursor); args.push(201);
    const [result] = await turso(env, [{ sql: `select * from assessment_incidents where attempt_id=? ${cursorClause} order by created_at desc limit ?`, args }]);
    const list = rows(result), hasMore = list.length > 200, events = list.slice(0, 200);
    const groups = [];
    for (const event of events.slice().reverse()) {
        const key = event.event_group || event.type;
        const previous = groups[groups.length - 1];
        const closeInTime = previous && Math.abs(Date.parse(event.created_at) - Date.parse(previous.last_created_at)) <= 60000;
        if (previous && previous.key === key && closeInTime) {
            previous.count += 1;
            previous.last_created_at = event.created_at;
            previous.duration_seconds += Number(event.duration_seconds || 0);
            previous.event_ids.push(event.id);
            previous.highest_severity = severityRank(event.severity) > severityRank(previous.highest_severity) ? event.severity : previous.highest_severity;
        } else groups.push({ key, type: event.type, details: event.details, count: 1, first_created_at: event.created_at, last_created_at: event.created_at, duration_seconds: Number(event.duration_seconds || 0), highest_severity: event.severity || 'low', event_ids: [event.id] });
    }
    groups.reverse();
    return json({ events, groups, has_more: hasMore, next_cursor: hasMore ? events[events.length - 1]?.created_at : null });
}
function severityRank(value) { return ({ info:1, low:2, medium:3, high:4, critical:5 })[String(value || '').toLowerCase()] || 1; }
async function adminReviewIncident(request, env, admin) {
    const body = await readBody(request), incidentId = clampText(body.incident_id, 80), status = ['reviewed', 'false_positive', 'investigate', 'archived'].includes(body.review_status) ? body.review_status : 'reviewed', notes = clampText(body.review_notes, 4000), now = nowIso();
    const [result] = await turso(env, [{ sql: `select * from assessment_incidents where id=? limit 1`, args: [incidentId] }]); const incident = rows(result)[0];
    if (!incident) return json({ error: 'Incident not found.' }, 404);
    await turso(env, [{ sql: `update assessment_incidents set review_status=?,reviewed_by=?,reviewed_at=?,review_notes=? where id=?`, args: [status, String(admin.id || admin.email || 'admin'), now, notes, incidentId] }]);
    await logAdminAudit(env, admin, 'review_incident', { assessment_id: incident.assessment_id, attempt_id: incident.attempt_id, incident_id: incidentId, details: JSON.stringify({ status, notes }) });
    return json({ ok: true });
}
async function adminReviewAttempt(request, env, admin) {
    const body = await readBody(request), attemptId = clampText(body.attempt_id, 80), status = ['reviewed', 'investigate', 'approved', 'invalidated', 'unreviewed'].includes(body.review_status) ? body.review_status : 'reviewed', notes = clampText(body.review_notes, 4000), now = nowIso();
    const [result] = await turso(env, [{ sql: `select * from assessment_attempts where id=? limit 1`, args: [attemptId] }]); const attempt = rows(result)[0];
    if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    await turso(env, [{ sql: `update assessment_attempts set review_status=?,reviewed_by=?,reviewed_at=?,review_notes=? where id=?`, args: [status, String(admin.id || admin.email || 'admin'), now, notes, attemptId] }]);
    await logAdminAudit(env, admin, 'review_attempt', { assessment_id: attempt.assessment_id, attempt_id: attemptId, details: JSON.stringify({ status, notes }) });
    return json({ ok: true });
}
async function adminAttemptAction(request, env, admin, action) {
    const body = await readBody(request), attemptId = clampText(body.attempt_id, 80), reason = clampText(body.reason, 2000);
    if (!attemptId || !reason) return json({ error: 'Attempt and audit reason are required.' }, 422);
    const [result] = await turso(env, [{ sql: `select t.*,a.settings_json from assessment_attempts t join assessments a on a.id=t.assessment_id where t.id=? limit 1`, args: [attemptId] }]); const attempt = rows(result)[0];
    if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    const now = nowIso();
    if (action === 'invalidate') await turso(env, [{ sql: `update assessment_attempts set status='invalidated',submission_reason='administrator_invalidated',finalized_at=?,review_status='invalidated',review_notes=? where id=?`, args: [now, reason, attemptId] }, { sql: `update assessment_sessions set status='ended',ended_at=?,termination_reason='administrator_invalidated' where attempt_id=? and status='active'`, args: [now, attemptId] }]);
    if (action === 'reopen') {
        const extraMinutes = Math.floor(clampNumber(body.extra_minutes, 30, 1, 240)), deadline = new Date(Date.now() + extraMinutes * 60000).toISOString();
        await turso(env, [{ sql: `update assessment_attempts set status='started',submitted_at=null,finalized_at=null,expired_at=null,submission_reason=null,deadline_at=?,review_status='approved',review_notes=?,active_session_id=null where id=?`, args: [deadline, reason, attemptId] }]);
    }
    if (action === 'approve_recovery') {
        const config = normalizeSecurityConfig(parseJson(attempt.settings_json, {}));
        const resetWarning = body.reset_warning_count === true || (body.reset_warning_count === undefined && config.resetWarningOnApprovedResume);
        await turso(env, [{ sql: `update assessment_attempts set security_status='recovery_approved',review_status='approved',review_notes=?,warning_count=case when ? then 0 else warning_count end,violations=case when ? then 0 else violations end where id=?`, args: [reason, resetWarning ? 1 : 0, resetWarning ? 1 : 0, attemptId] }]);
    }
    await logAdminAudit(env, admin, `attempt_${action}`, { assessment_id: attempt.assessment_id, attempt_id: attemptId, details: reason });
    return json({ ok: true });
}
async function adminExportAudit(env, url) {
    const { where, args } = buildIncidentFilters(url);
    const [result] = await turso(env, [{ sql: `select i.created_at,a.title as assessment,a.section,i.student_no,t.student_name,t.attempt_no,i.type,i.severity,i.warning_weight,i.duration_seconds,i.details,i.review_status,i.review_notes from assessment_incidents i left join assessments a on a.id=i.assessment_id left join assessment_attempts t on t.id=i.attempt_id ${where} order by i.created_at desc limit 10000`, args }]);
    const escapeCsv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const header = ['created_at','assessment','section','student_no','student_name','attempt_no','type','severity','warning_weight','duration_seconds','details','review_status','review_notes'];
    const csv = [header.join(','), ...rows(result).map(row => header.map(key => escapeCsv(row[key])).join(','))].join('\n');
    return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="assessment-security-audit.csv"', 'cache-control': 'no-store' } });
}

async function studentList(env, profile) {
    const identity = studentIdentity(profile); await finalizeExpiredAttemptsForStudent(env, identity.studentNo);
    const [assessmentResult, attemptResult] = await turso(env, [
        { sql: `select * from assessments where status in ('published','closed') and (upper(section)='ALL' or upper(section)=upper(?)) order by created_at desc`, args: [identity.section] },
        { sql: `select * from assessment_attempts where student_no=? order by started_at desc`, args: [identity.studentNo] }
    ]);
    return json({ assessments: rows(assessmentResult).map(row => studentAssessmentFromRow(row, env)), attempts: rows(attemptResult).map(row => ({ id: row.id, assessment_id: row.assessment_id, status: row.status, attempt_no: Number(row.attempt_no || 1), score: Number(row.score || 0), total_points: Number(row.total_points || 0), warning_count: Number(row.warning_count || row.violations || 0), violations: Number(row.violations || 0), started_at: row.started_at, submitted_at: row.submitted_at, deadline_at: row.deadline_at, submission_reason: row.submission_reason, review_status: row.review_status })) });
}
async function studentPreflight(request, env, profile) {
    const body = await readBody(request), assessmentId = clampText(body.assessment_id, 80), checked = await eligibility(env, request, profile, assessmentId, body);
    if (checked.error) return checked.error;
    const { assessment, security, activeAttempt, identity, nextAttemptNo, secureBrowser } = checked;
    const activeSession = await preflightSessionStatus(env, activeAttempt, body, security);
    const statuses = [
        { key: 'identity', label: 'Student identity', status: 'passed', message: identity.studentName || identity.studentNo },
        { key: 'assignment', label: 'Section assignment', status: 'passed', message: assessment.section === 'ALL' ? 'Open to all assigned students' : assessment.section },
        { key: 'availability', label: 'Assessment availability', status: 'passed', message: 'Open and published' },
        { key: 'attempt', label: 'Attempt eligibility', status: 'passed', message: activeAttempt ? `Resume attempt ${activeAttempt.attempt_no || 1}` : `Attempt ${nextAttemptNo} of ${security.maxAttempts}` },
        { key: 'active_session', label: 'Active exam session', status: activeSession.status, message: activeSession.message },
        { key: 'server_time', label: 'Server-time synchronization', status: 'passed', message: nowIso() },
        { key: 'secure_browser', label: 'Secure-browser verification', status: secureBrowser.status === 'not_required' ? 'not_required' : secureBrowser.passed ? 'passed' : secureBrowser.status === 'unavailable' ? 'warning' : 'failed', message: secureBrowser.message || secureBrowser.status }
    ];
    return json({ assessment: studentAssessmentFromRow(assessment, env), student: { student_no: identity.studentNo, name: identity.studentName, section: identity.section }, attempt_no: Number(activeAttempt?.attempt_no || nextAttemptNo), resume_available: !!activeAttempt, secure_browser: secureBrowser, server_time: nowIso(), statuses, eligible: activeSession.passed && (!security.requireSecureBrowser || secureBrowser.passed) });
}
async function studentStart(request, env, profile) {
    const body = await readBody(request), assessmentId = clampText(body.assessment_id, 80);
    if (body.accept_rules !== true) return json({ error: 'Accept the assessment rules before starting.' }, 422);
    const checked = await eligibility(env, request, profile, assessmentId, body); if (checked.error) return checked.error;
    const { assessment, questions: bankQuestions, security, activeAttempt, attempts, identity, nextAttemptNo, secureBrowser } = checked;
    if (security.requireSecureBrowser && !secureBrowser.passed) return json({ error: secureBrowser.message || 'Secure-browser verification is required.', code: 'SECURE_BROWSER_REQUIRED' }, 403);
    const now = nowIso(); let attempt = activeAttempt, recovered = false;
    if (!attempt) {
        const runtime = buildRuntimeQuestions(assessment, bankQuestions); if (!runtime.length) return json({ error: 'This assessment has no available questions.' }, 422);
        const attemptId = id('att');
        const durationDeadlineMs = Date.now() + Number(assessment.duration_minutes || 30) * 60000;
        const closesAtMs = Date.parse(assessment.closes_at || '');
        const officialDeadlineMs = Number.isFinite(closesAtMs) ? Math.min(durationDeadlineMs, closesAtMs) : durationDeadlineMs;
        const deadline = new Date(officialDeadlineMs).toISOString();
        const meta = { runtimeQuestions: runtime, draftAnswers: {}, lastQuestionIndex: 0, flaggedQuestions: [], createdByServer: true };
        try {
            await turso(env, [{ sql: `insert into assessment_attempts (id,assessment_id,student_no,student_name,student_uid,status,answers_json,score,total_points,violations,attempt_no,warning_count,security_score,started_at,deadline_at,created_at,last_saved_at,last_heartbeat_at,security_status,review_status,save_version,last_question_index,flagged_json) values (?,?,?,?,?,'started',?,0,0,0,?,0,0,?,?,?,?,?,'normal','unreviewed',0,0,'[]')`, args: [attemptId, assessmentId, identity.studentNo, identity.studentName, identity.uid, JSON.stringify(meta), nextAttemptNo, now, deadline, now, now, now] }]);
        } catch { return json({ error: 'Another attempt was created at the same time. Refresh and try again.', code: 'ATTEMPT_CONFLICT' }, 409); }
        attempt = { id: attemptId, assessment_id: assessmentId, student_no: identity.studentNo, status: 'started', answers_json: JSON.stringify(meta), attempt_no: nextAttemptNo, warning_count: 0, security_score: 0, violations: 0, started_at: now, deadline_at: deadline, save_version: 0, last_question_index: 0, active_session_id: null };
    } else {
        const expired = await enforceDeadline(env, attempt); if (expired) return json({ error: 'This attempt has already expired and was submitted.', code: 'TIME_EXPIRED', finalized: expired }, 409);
        recovered = true;
    }
    const sessionResult = await createExamSession(env, request, attempt, identity, body, security, !!activeAttempt); if (sessionResult.error) return sessionResult.error;
    const session = sessionResult.session, meta = parseJson(attempt.answers_json, {}), runtime = Array.isArray(meta.runtimeQuestions) && meta.runtimeQuestions.length ? meta.runtimeQuestions : buildRuntimeQuestions(assessment, bankQuestions), draftAnswers = sanitizeDraftAnswers(runtime, meta.draftAnswers || {});
    await turso(env, [{ sql: `update assessment_attempts set active_session_id=?,last_heartbeat_at=? where id=? and status='started'`, args: [session.id, nowIso(), attempt.id] }]);
    if (recovered || sessionResult.recovered) {
        await turso(env, [{ sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,client_event_id,session_id,event_group,severity,warning_weight,event_count,metadata_json,first_detected_at,last_detected_at,duration_seconds,action_taken,review_status,created_at) values (?,?,?,?,?,?,?,?,?,'info',0,1,'{}',?,?,0,'session_restored','unreviewed',?)`, args: [id('inc'), attempt.id, assessmentId, identity.studentNo, 'session_recovered', 'A stale or interrupted exam session was recovered.', id('evt'), session.id, 'session_recovery', now, now, now] }]);
    }
    return json({
        attempt: { id: attempt.id, attempt_no: Number(attempt.attempt_no || 1), deadline_at: attempt.deadline_at, started_at: attempt.started_at, warning_count: Number(attempt.warning_count || attempt.violations || 0), security_score: Number(attempt.security_score || 0), violations: Number(attempt.violations || 0), last_question_index: Number(attempt.last_question_index ?? meta.lastQuestionIndex ?? 0), save_version: Number(attempt.save_version || 0), flagged_questions: parseJson(attempt.flagged_json, meta.flaggedQuestions || []) },
        session: { id: session.id, token: sessionResult.token, status: 'active', heartbeat_seconds: 20 },
        assessment: studentAssessmentFromRow(assessment, env), questions: runtime.map(safeRuntimeQuestion), answers: draftAnswers,
        recovered: recovered || sessionResult.recovered, server_time: nowIso()
    });
}
async function studentAutosave(request, env, profile) {
    const body = await readBody(request), identity = studentIdentity(profile), attemptId = clampText(body.attempt_id, 80);
    const attempt = await getAttemptForStudent(env, attemptId, identity.studentNo); const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    if (attempt.status !== 'started') return json({ ok: true, submitted: true, submission_reason: attempt.submission_reason, score: Number(attempt.score || 0), total_points: Number(attempt.total_points || 0) });
    const expired = await enforceDeadline(env, attempt); if (expired) return json({ ok: true, submitted: true, submission_reason: 'time_expired', score: expired.score, total_points: expired.total, submitted_at: expired.submittedAt });
    const verified = await verifyExamSession(env, attempt, body, identity.studentNo); if (verified.error) return verified.error;
    const runtime = await loadRuntimeQuestions(env, attempt), meta = parseJson(attempt.answers_json, {}), answers = sanitizeDraftAnswers(runtime, body.answers || meta.draftAnswers || {}), now = nowIso();
    const currentVersion = Number(attempt.save_version || 0);
    const incomingVersion = Math.floor(clampNumber(body.save_version, currentVersion + 1, 0, 1000000000));
    if (incomingVersion < currentVersion) return json({ ok: true, stale: true, saved_at: attempt.last_saved_at, save_version: currentVersion, deadline_at: attempt.deadline_at });
    if (incomingVersion === currentVersion) return json({ ok: true, duplicate: true, saved_at: attempt.last_saved_at, save_version: currentVersion, deadline_at: attempt.deadline_at, server_time: nowIso() });
    if (incomingVersion > currentVersion + 1) return json({ error: 'Answer save order is out of date. Restore the latest server state and try again.', code: 'SAVE_VERSION_CONFLICT', save_version: currentVersion }, 409);
    const questionIndex = Math.max(0, Math.min(runtime.length - 1, Number(body.question_index || 0))), flagged = Array.isArray(body.flagged_questions) ? body.flagged_questions.map(value => clampText(value, 80)).filter(Boolean).slice(0, runtime.length) : parseJson(attempt.flagged_json, []);
    const nextMeta = { ...meta, runtimeQuestions: runtime, draftAnswers: answers, lastQuestionIndex: questionIndex, flaggedQuestions: flagged };
    await turso(env, [
        { sql: `update assessment_attempts set answers_json=?,last_saved_at=?,last_heartbeat_at=?,save_version=?,last_question_index=?,flagged_json=? where id=? and status='started' and save_version<?`, args: [JSON.stringify(nextMeta), now, now, incomingVersion, questionIndex, JSON.stringify(flagged), attempt.id, incomingVersion] },
        ...(verified.session.id ? [{ sql: `update assessment_sessions set last_heartbeat_at=? where id=? and status='active'`, args: [now, verified.session.id] }] : [])
    ]);
    return json({ ok: true, saved_at: now, save_version: incomingVersion, warning_count: Number(attempt.warning_count || attempt.violations || 0), violations: Number(attempt.violations || 0), deadline_at: attempt.deadline_at, server_time: now });
}
async function studentHeartbeat(request, env, profile) {
    const body = await readBody(request), identity = studentIdentity(profile), attempt = await getAttemptForStudent(env, clampText(body.attempt_id, 80), identity.studentNo);
    const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    if (attempt.status !== 'started') return json({ ok: true, attempt_status: attempt.status, required_action: 'finalize', submission_reason: attempt.submission_reason });
    const expired = await enforceDeadline(env, attempt); if (expired) return json({ ok: true, attempt_status: 'submitted', required_action: 'finalize', submission_reason: 'time_expired', score: expired.score, total_points: expired.total });
    const verified = await verifyExamSession(env, attempt, body, identity.studentNo); if (verified.error) return verified.error;
    const now = nowIso(), questionIndex = Math.max(0, Number(body.question_index || 0));
    await turso(env, [
        { sql: `update assessment_attempts set last_heartbeat_at=?,last_question_index=? where id=? and status='started'`, args: [now, questionIndex, attempt.id] },
        ...(verified.session.id ? [{ sql: `update assessment_sessions set last_heartbeat_at=? where id=? and status='active'`, args: [now, verified.session.id] }] : [])
    ]);
    const settings = normalizeSecurityConfig(parseJson(attempt.settings_json, {})), warningCount = Number(attempt.warning_count || attempt.violations || 0);
    return json({ ok: true, server_time: now, deadline_at: attempt.deadline_at, warning_count: warningCount, security_score: Number(attempt.security_score || 0), session_status: 'active', attempt_status: 'started', required_action: warningCount >= settings.pauseAfterWarningCount && settings.pauseAfterWarningCount > 0 ? 'pause' : 'continue' });
}
async function studentSessionStatus(request, env, profile) {
    const body = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams.entries()) : await readBody(request), identity = studentIdentity(profile), attempt = await getAttemptForStudent(env, clampText(body.attempt_id, 80), identity.studentNo);
    const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    const verified = attempt.status === 'started' ? await verifyExamSession(env, attempt, body, identity.studentNo) : { session: null };
    if (verified.error) return verified.error;
    return json({ attempt_status: attempt.status, session_status: verified.session?.status || 'ended', deadline_at: attempt.deadline_at, server_time: nowIso(), warning_count: Number(attempt.warning_count || attempt.violations || 0), submission_reason: attempt.submission_reason });
}
async function studentRestore(request, env, profile) {
    const body = await readBody(request), identity = studentIdentity(profile), attempt = await getAttemptForStudent(env, clampText(body.attempt_id, 80), identity.studentNo);
    const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    if (attempt.status !== 'started') return json({ submitted: true, submission_reason: attempt.submission_reason, score: Number(attempt.score || 0), total_points: Number(attempt.total_points || 0) });
    const expired = await enforceDeadline(env, attempt); if (expired) return json({ submitted: true, submission_reason: 'time_expired', score: expired.score, total_points: expired.total });
    const verified = await verifyExamSession(env, attempt, body, identity.studentNo); if (verified.error) return verified.error;
    const runtime = await loadRuntimeQuestions(env, attempt), meta = parseJson(attempt.answers_json, {});
    const [assessmentResult] = await turso(env, [{ sql: `select * from assessments where id=? limit 1`, args: [attempt.assessment_id] }]); const assessment = rows(assessmentResult)[0];
    return json({ attempt: { id: attempt.id, deadline_at: attempt.deadline_at, started_at: attempt.started_at, attempt_no: Number(attempt.attempt_no || 1), warning_count: Number(attempt.warning_count || attempt.violations || 0), violations: Number(attempt.violations || 0), last_question_index: Number(attempt.last_question_index || 0), save_version: Number(attempt.save_version || 0), flagged_questions: parseJson(attempt.flagged_json, []) }, assessment: studentAssessmentFromRow(assessment, env), questions: runtime.map(safeRuntimeQuestion), answers: sanitizeDraftAnswers(runtime, meta.draftAnswers || {}), server_time: nowIso() });
}
async function studentSubmit(request, env, profile) {
    const body = await readBody(request), identity = studentIdentity(profile), attempt = await getAttemptForStudent(env, clampText(body.attempt_id, 80), identity.studentNo);
    const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    if (attempt.status === 'submitted') return json({ ok: true, alreadySubmitted: true, score: Number(attempt.score || 0), total_points: Number(attempt.total_points || 0), submission_reason: attempt.submission_reason });
    const expired = await enforceDeadline(env, attempt); if (expired) return json({ ok: true, score: expired.score, total_points: expired.total, submitted_at: expired.submittedAt, submission_reason: 'time_expired' });
    const verified = await verifyExamSession(env, attempt, body, identity.studentNo); if (verified.error) return verified.error;
    // Student clients cannot choose privileged or security-sensitive submission reasons.
    const result = await finalizeAttempt(env, attempt, 'student_submitted', body.answers, verified.session.id);
    return json({ ok: true, score: result.score, total_points: result.total, submitted_at: result.submittedAt, submission_reason: result.reason, manual_grading_required: result.manualGradingRequired });
}
async function studentIncident(request, env, profile) {
    const body = await readBody(request), identity = studentIdentity(profile), attempt = await getAttemptForStudent(env, clampText(body.attempt_id, 80), identity.studentNo);
    const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    if (attempt.status !== 'started') return json({ ok: true, submitted: true, warning_count: Number(attempt.warning_count || attempt.violations || 0), submission_reason: attempt.submission_reason });
    const expired = await enforceDeadline(env, attempt); if (expired) return json({ ok: true, submitted: true, submission_reason: 'time_expired', score: expired.score, total_points: expired.total });
    const verified = await verifyExamSession(env, attempt, body, identity.studentNo); if (verified.error) return verified.error;
    const code = canonicalIncidentCode(body.type); if (!INCIDENT_CODES.has(code)) return json({ error: 'Unknown incident code.' }, 422);
    const config = normalizeSecurityConfig(parseJson(attempt.settings_json, {})), policy = config.eventPolicies[code];
    if (!policy || policy.enabled === false) return json({ ok: true, ignored: true, warning_count: Number(attempt.warning_count || attempt.violations || 0) });
    const clientEventId = clampText(body.client_event_id, 160) || id('evt');
    const [duplicateResult, rateResult, typeCountResult, latestResult] = await turso(env, [
        { sql: `select id from assessment_incidents where attempt_id=? and client_event_id=? limit 1`, args: [attempt.id, clientEventId] },
        { sql: `select count(*) as count from assessment_incidents where attempt_id=? and session_id=? and type=? and created_at>=?`, args: [attempt.id, verified.session.id || '', code, new Date(Date.now() - 10000).toISOString()] },
        { sql: `select count(*) as count from assessment_incidents where attempt_id=? and type=?`, args: [attempt.id, code] },
        { sql: `select last_detected_at,created_at from assessment_incidents where attempt_id=? and session_id=? and event_group=? order by created_at desc limit 1`, args: [attempt.id, verified.session.id || '', clampText(body.event_group || code, 80)] }
    ]);
    if (rows(duplicateResult).length) return json({ ok: true, duplicate: true, warning_count: Number(attempt.warning_count || attempt.violations || 0) });
    if (Number(rows(rateResult)[0]?.count || 0) >= 12) return json({ error: 'Incident submissions are temporarily throttled.' }, 429);
    const severity = SEVERITIES.has(policy.severity) ? policy.severity : 'low';
    const latestGrouped = rows(latestResult)[0];
    const latestGroupedAt = Date.parse(latestGrouped?.last_detected_at || latestGrouped?.created_at || '');
    const withinCooldown = Number.isFinite(latestGroupedAt) && Date.now() - latestGroupedAt < Number(policy.cooldownMs || 0);
    const warningWeight = policy.countsWarning && !withinCooldown ? Number(policy.warningWeight || 0) : 0;
    const currentWarning = Number(attempt.warning_count || attempt.violations || 0), nextWarning = Math.max(0, currentWarning + (config.warningCalculation === 'count' && warningWeight > 0 ? 1 : warningWeight)), nextViolations = Math.ceil(nextWarning), securityScore = Number(attempt.security_score || 0) + (withinCooldown ? 0 : ({ info: 0, low: 1, medium: 2, high: 4, critical: 7 }[severity] || 1));
    const eventCount = Number(rows(typeCountResult)[0]?.count || 0) + 1, overTolerance = Number(policy.maxToleratedCount || 0) > 0 && eventCount > Number(policy.maxToleratedCount), highRisk = severity === 'high' || severity === 'critical' || overTolerance;
    const reachedLimit = nextWarning >= config.warningLimit, canAutoSubmit = policy.mayAutoSubmit !== false && (!config.autoSubmitHighRiskOnly || highRisk), shouldAutoSubmit = config.autoSubmitAfterFinalViolation && reachedLimit && canAutoSubmit && !config.adminReviewInsteadOfAutoSubmit;
    const shouldPause = !!policy.pausesExam || (config.pauseAfterWarningCount > 0 && nextWarning >= config.pauseAfterWarningCount) || (reachedLimit && config.adminReviewInsteadOfAutoSubmit);
    const now = nowIso(), first = clampText(body.first_detected_at, 40) || now, last = clampText(body.last_detected_at, 40) || now, duration = clampNumber(body.duration_seconds, 0, 0, 86400), metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const action = withinCooldown ? 'grouped_with_previous_event' : shouldAutoSubmit ? 'automatic_submission' : shouldPause ? 'assessment_paused' : reachedLimit ? 'administrator_review_required' : 'recorded';
    await turso(env, [
        { sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,client_event_id,session_id,event_group,severity,warning_weight,event_count,metadata_json,first_detected_at,last_detected_at,duration_seconds,action_taken,review_status,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unreviewed',?)`, args: [id('inc'), attempt.id, attempt.assessment_id, identity.studentNo, code, clampText(body.details, 1000), clientEventId, verified.session.id || null, clampText(body.event_group || code, 80), severity, warningWeight, 1, JSON.stringify(metadata), first, last, duration, action, now] },
        { sql: `update assessment_attempts set warning_count=?,violations=?,security_score=?,last_heartbeat_at=?,security_status=? where id=? and status='started'`, args: [nextWarning, nextViolations, securityScore, now, shouldPause || highRisk ? 'flagged' : attempt.security_status || 'normal', attempt.id] }
    ]);
    let final = null;
    if (shouldAutoSubmit) {
        final = await finalizeAttempt(env, { ...attempt, warning_count: nextWarning, violations: nextViolations, security_score: securityScore }, 'anomaly_limit_reached', null, verified.session.id);
        await turso(env, [{ sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,client_event_id,session_id,event_group,severity,warning_weight,event_count,metadata_json,first_detected_at,last_detected_at,duration_seconds,action_taken,review_status,created_at) values (?,?,?,?,?,'The configured warning limit triggered server-side automatic submission.',?,?,?,'critical',0,1,'{}',?,?,0,'automatic_submission','unreviewed',?)`, args: [id('inc'), attempt.id, attempt.assessment_id, identity.studentNo, 'anomaly_limit_reached', id('evt'), verified.session.id || null, 'anomaly_limit', now, now, now] }]);
    }
    return json({ ok: true, warning_count: nextWarning, violations: nextViolations, security_score: securityScore, warning_limit: config.warningLimit, final_warning_threshold: config.finalWarningThreshold, severity, pause: shouldPause && !shouldAutoSubmit, requires_fullscreen_restore: !!policy.requireFullscreenRestore, administrator_review: reachedLimit && config.adminReviewInsteadOfAutoSubmit, auto_submit: shouldAutoSubmit, submitted: shouldAutoSubmit, score: final?.score, total_points: final?.total, required_action: shouldAutoSubmit ? 'finalize' : shouldPause ? 'pause' : nextWarning >= config.finalWarningThreshold ? 'final_warning' : 'continue' });
}
async function studentIncidentBatch(request, env, profile) {
    const body = await readBody(request);
    const events = Array.isArray(body.events) ? body.events.slice(0, 8) : [];
    if (!events.length) return json({ error: 'Provide at least one incident event.' }, 422);
    const base = {
        attempt_id: clampText(body.attempt_id, 80),
        session_id: clampText(body.session_id, 100),
        session_token: clampText(body.session_token, 500),
        client_session_id: clampText(body.client_session_id, 120)
    };
    const results = [];
    for (const event of events) {
        const payload = { ...base, ...(event && typeof event === 'object' ? event : {}) };
        const synthetic = new Request(request.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const response = await studentIncident(synthetic, env, profile);
        const data = await response.json().catch(() => ({}));
        results.push({
            client_event_id: clampText(payload.client_event_id, 160),
            status: response.status,
            ...data
        });
        if (!response.ok || data.submitted || data.auto_submit) {
            if (!response.ok) return json({ error: data.error || 'Incident synchronization failed.', code: data.code || '', results }, response.status);
            break;
        }
    }
    const last = results[results.length - 1] || {};
    return json({
        ok: true,
        results,
        warning_count: last.warning_count,
        violations: last.violations,
        security_score: last.security_score,
        submitted: !!last.submitted,
        auto_submit: !!last.auto_submit,
        score: last.score,
        total_points: last.total_points,
        required_action: last.required_action
    });
}

async function studentFinalizeExpired(request, env, profile) {
    const body = await readBody(request), identity = studentIdentity(profile), attempt = await getAttemptForStudent(env, clampText(body.attempt_id, 80), identity.studentNo);
    const accessError = attemptAccessError(attempt, identity); if (accessError) return accessError;
    const expired = await enforceDeadline(env, attempt);
    if (!expired && attempt.status === 'started') return json({ ok: true, finalized: false, deadline_at: attempt.deadline_at });
    return json({ ok: true, finalized: true, submission_reason: attempt.submission_reason || 'time_expired', score: expired?.score ?? Number(attempt.score || 0), total_points: expired?.total ?? Number(attempt.total_points || 0) });
}

export async function onRequest({ request, env, params }) {
    try {
        await ensureSchemaOnce(env);
        const rawPath = params.path, path = '/' + (Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '')), url = new URL(request.url);
        if (path.startsWith('/admin')) {
            const auth = await requireRole(request, env, 'admin'); if (auth.error) return auth.error;
            if (request.method === 'GET' && path === '/admin/list') return adminList(env);
            if (request.method === 'GET' && path === '/admin/get') return adminGet(env, url.searchParams.get('id') || '');
            if (request.method === 'POST' && path === '/admin/save') return adminSave(request, env, auth.profile);
            if (request.method === 'POST' && path === '/admin/duplicate') return adminDuplicate(request, env, auth.profile);
            if (request.method === 'POST' && path === '/admin/delete') return adminDelete(request, env);
            if (request.method === 'GET' && path === '/admin/attempts') return adminAttempts(env, url.searchParams.get('assessment_id') || '');
            if (request.method === 'GET' && path === '/admin/incidents') return adminIncidents(env, url);
            if (request.method === 'GET' && path === '/admin/attempt-detail') return adminAttemptDetail(env, clampText(url.searchParams.get('attempt_id'), 80));
            if (request.method === 'GET' && path === '/admin/attempt-timeline') return adminAttemptTimeline(env, clampText(url.searchParams.get('attempt_id'), 80), clampText(url.searchParams.get('cursor'), 40));
            if (request.method === 'POST' && path === '/admin/review-incident') return adminReviewIncident(request, env, auth.profile);
            if (request.method === 'POST' && path === '/admin/review-attempt') return adminReviewAttempt(request, env, auth.profile);
            if (request.method === 'POST' && path === '/admin/invalidate-attempt') return adminAttemptAction(request, env, auth.profile, 'invalidate');
            if (request.method === 'POST' && path === '/admin/reopen-attempt') return adminAttemptAction(request, env, auth.profile, 'reopen');
            if (request.method === 'POST' && path === '/admin/approve-session-recovery') return adminAttemptAction(request, env, auth.profile, 'approve_recovery');
            if (request.method === 'GET' && path === '/admin/export-audit') return adminExportAudit(env, url);
        }
        if (path.startsWith('/student')) {
            const auth = await requireStudent(request, env); if (auth.error) return auth.error;
            if (request.method === 'GET' && path === '/student/list') return studentList(env, auth.profile);
            if (request.method === 'POST' && path === '/student/preflight') return studentPreflight(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/start') return studentStart(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/autosave') return studentAutosave(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/heartbeat') return studentHeartbeat(request, env, auth.profile);
            if ((request.method === 'POST' || request.method === 'GET') && path === '/student/session-status') return studentSessionStatus(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/restore') return studentRestore(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/submit') return studentSubmit(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/incident') return studentIncident(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/incidents-batch') return studentIncidentBatch(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/finalize-expired') return studentFinalizeExpired(request, env, auth.profile);
        }
        return json({ error: 'Assessment route not found.' }, 404);
    } catch (error) {
        console.error('Assessment API error', error);
        const message = String(error?.message || '');
        return json({ error: message.includes('missing') ? message : 'Assessment service is temporarily unavailable.' }, 500);
    }
}
