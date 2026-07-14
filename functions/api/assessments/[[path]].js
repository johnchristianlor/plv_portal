const JSON_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function envValue(env, ...names) {
    for (const name of names) if (env[name]) return env[name];
    return '';
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

function supabaseUrl(env) {
    return envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
}

function supabaseAnonKey(env) {
    return envValue(env, 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
}

function arg(value) {
    if (value === null || value === undefined) return { type: 'null' };
    if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
    if (typeof value === 'number') return { type: 'float', value };
    return { type: 'text', value: String(value) };
}

async function turso(env, statements) {
    const token = envValue(env, 'TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN');
    if (!token) throw new Error('Turso auth token is missing.');

    const requests = statements.map(item => ({
        type: 'execute',
        stmt: {
            sql: item.sql,
            args: (item.args || []).map(arg)
        }
    }));

    const response = await fetch(dbEndpoint(env), {
        method: 'POST',
        headers: { ...JSON_HEADERS, authorization: 'Bearer ' + token },
        body: JSON.stringify({ requests })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Turso request failed.');

    return (body.results || []).map(result => {
        if (result.type === 'error') throw new Error('Turso statement failed.');
        const exec = result.response && result.response.result ? result.response.result : result.result;
        return exec || { cols: [], rows: [], affected_row_count: 0 };
    });
}

function rows(result) {
    const cols = (result.cols || []).map(col => col.name || col);
    return (result.rows || []).map(row => {
        const out = {};
        row.forEach((cell, index) => {
            out[cols[index]] = cell && Object.prototype.hasOwnProperty.call(cell, 'value') ? cell.value : null;
        });
        return out;
    });
}

function id(prefix = 'id') {
    const uuid = crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return prefix + '_' + uuid.replace(/-/g, '');
}

function clampText(value, max = 1000) {
    return String(value || '').trim().slice(0, max);
}

function parseJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

async function getSupabaseUser(env, token) {
    const url = supabaseUrl(env);
    const anonKey = supabaseAnonKey(env);
    if (!url || !anonKey || !token) return null;

    const response = await fetch(url + '/auth/v1/user', {
        headers: { apikey: anonKey, authorization: 'Bearer ' + token }
    });
    if (!response.ok) return null;
    return response.json();
}

async function findProfile(env, accessToken, authUser, role) {
    const url = supabaseUrl(env);
    const anonKey = supabaseAnonKey(env);
    const serviceKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anonKey) return null;

    const apiKey = serviceKey || anonKey;
    const dbBearer = serviceKey || accessToken;
    const checks = [['uid', authUser.id], ['id', authUser.id], ['email', authUser.email]].filter(([, value]) => !!value);

    for (const [field, value] of checks) {
        const requestUrl = new URL(url + '/rest/v1/users');
        requestUrl.searchParams.set('select', '*');
        requestUrl.searchParams.set(field, 'eq.' + value);
        requestUrl.searchParams.set('limit', '1');
        const response = await fetch(requestUrl.toString(), {
            headers: { apikey: apiKey, authorization: 'Bearer ' + dbBearer }
        });
        if (!response.ok) continue;
        const data = await response.json();
        const profile = (data || []).find(row => String(row.role || '').toLowerCase() === role);
        if (profile) return profile;
    }
    return null;
}

async function supabaseRpc(env, name, payload, accessToken = '') {
    const url = supabaseUrl(env);
    const anonKey = supabaseAnonKey(env);
    if (!url || !anonKey) throw new Error('Supabase connection is missing.');

    const serviceKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const response = await fetch(url + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: {
            ...JSON_HEADERS,
            apikey: serviceKey || anonKey,
            authorization: 'Bearer ' + (serviceKey || accessToken || anonKey)
        },
        body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data && data.message) || 'Supabase RPC failed.');
    return data;
}

async function validateStudentSession(env, studentNo, sessionToken) {
    if (!studentNo || !sessionToken) return false;
    try {
        return await supabaseRpc(env, 'validate_student_session', {
            p_student_no: studentNo,
            p_session_token: sessionToken
        }) === true;
    } catch {
        return false;
    }
}

async function getStudentProfile(env, studentNo, sessionToken) {
    if (!studentNo || !sessionToken) return null;
    try {
        const data = await supabaseRpc(env, 'get_student_profile', {
            p_student_no: studentNo,
            p_session_token: sessionToken
        });
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

async function requireRole(request, env, role) {
    const token = bearer(request);
    if (!token) return { error: json({ error: 'Please login again.' }, 401) };

    const authUser = await getSupabaseUser(env, token);
    if (!authUser || !authUser.id) return { error: json({ error: 'Please login again.' }, 401) };

    const profile = await findProfile(env, token, authUser, role);
    if (!profile) return { error: json({ error: 'Access denied.' }, 403) };
    if (String(profile.status || '').toLowerCase() === 'inactive') {
        return { error: json({ error: 'Account is inactive.' }, 403) };
    }
    return { token, authUser, profile };
}

async function requireStudent(request, env) {
    const token = bearer(request);
    if (token) return requireRole(request, env, 'student');

    const studentNo = clampText(request.headers.get('x-student-no') || request.headers.get('x-studentno') || '', 80);
    const sessionToken = clampText(request.headers.get('x-student-session') || request.headers.get('x-session-token') || '', 200);
    if (!studentNo || !sessionToken) return { error: json({ error: 'Please login again.' }, 401) };

    const valid = await validateStudentSession(env, studentNo, sessionToken);
    if (!valid) return { error: json({ error: 'Please login again.' }, 401) };

    const profile = await getStudentProfile(env, studentNo, sessionToken);
    if (!profile) return { error: json({ error: 'Access denied.' }, 403) };
    if (String(profile.status || '').toLowerCase() === 'inactive') {
        return { error: json({ error: 'Account is inactive.' }, 403) };
    }
    return { token: sessionToken, authUser: { id: studentNo }, profile };
}

async function ensureSchema(env) {
    await turso(env, [
        { sql: `create table if not exists assessments (id text primary key, title text not null, instructions text, subject_code text, section text, status text not null default 'draft', duration_minutes integer not null default 30, opens_at text, closes_at text, settings_json text, created_by text, created_at text not null, updated_at text not null)` },
        { sql: `create table if not exists assessment_questions (id text primary key, assessment_id text not null, type text not null, prompt text not null, points integer not null default 1, answer_key text, choices_json text, category text, difficulty text, explanation text, order_no integer not null default 1, created_at text not null, foreign key (assessment_id) references assessments(id) on delete cascade)` },
        { sql: `create table if not exists assessment_attempts (id text primary key, assessment_id text not null, student_no text not null, student_name text, student_uid text, status text not null, answers_json text, score real not null default 0, total_points real not null default 0, violations integer not null default 0, started_at text not null, submitted_at text, deadline_at text, created_at text not null, foreign key (assessment_id) references assessments(id) on delete cascade)` },
        { sql: `create table if not exists assessment_incidents (id text primary key, attempt_id text, assessment_id text, student_no text, type text not null, details text, created_at text not null)` },
        { sql: `create index if not exists idx_assessments_status_section on assessments(status, section)` },
        { sql: `create index if not exists idx_questions_assessment_order on assessment_questions(assessment_id, order_no)` },
        { sql: `create index if not exists idx_attempts_student on assessment_attempts(student_no, assessment_id, status)` },
        { sql: `create index if not exists idx_incidents_attempt on assessment_incidents(attempt_id, created_at)` }
    ]);
}

async function readBody(request) {
    return request.json().catch(() => ({}));
}

function assessmentFromRow(row) {
    return {
        ...row,
        duration_minutes: Number(row.duration_minutes || 30),
        settings: parseJson(row.settings_json, {})
    };
}

function questionFromRow(row, includeKey = false) {
    const question = {
        id: row.id,
        assessment_id: row.assessment_id,
        type: row.type,
        prompt: row.prompt,
        points: Number(row.points || 1),
        choices: parseJson(row.choices_json, []),
        category: row.category || '',
        difficulty: row.difficulty || '',
        explanation: row.explanation || '',
        order_no: Number(row.order_no || 1)
    };
    if (includeKey) question.answer_key = row.answer_key || '';
    return question;
}

function shuffleList(items) {
    const list = Array.isArray(items) ? items.slice() : [];
    for (let index = list.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [list[index], list[swap]] = [list[swap], list[index]];
    }
    return list;
}

function uniqueId(base, used, fallbackPrefix = 'sec') {
    let candidate = clampText(base, 80) || id(fallbackPrefix);
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    let suffix = 2;
    while (used.has(`${candidate}_${suffix}`)) suffix += 1;
    candidate = `${candidate}_${suffix}`;
    used.add(candidate);
    return candidate;
}

function normalizeBuilderSections(settings, bankQuestions = []) {
    const source = Array.isArray(settings?.builderSections) ? settings.builderSections : [];
    const inferred = [];
    if (!source.length) {
        for (const question of bankQuestions) {
            const category = clampText(question.sectionId || question.category, 80);
            if (category && !inferred.some(item => item.id === category)) {
                inferred.push({ id: category, title: category });
            }
        }
    }

    const input = source.length ? source : inferred;
    const used = new Set();
    const sections = input.map((section, index) => ({
        id: uniqueId(section?.id, used, 'sec'),
        title: clampText(section?.title || `Section ${index + 1}`, 120) || `Section ${index + 1}`,
        pickCount: Math.max(0, Math.floor(Number(section?.pickCount || 0))),
        shuffleQuestions: !!section?.shuffleQuestions,
        shuffleChoices: !!section?.shuffleChoices,
        collapsed: !!section?.collapsed
    }));

    if (!sections.length) {
        sections.push({
            id: 'default_section',
            title: 'Section 1',
            pickCount: 0,
            shuffleQuestions: false,
            shuffleChoices: false,
            collapsed: false
        });
    }
    return sections;
}

function normalizeChoices(question, type) {
    if (type === 'true_false') return ['True', 'False'];
    if (type !== 'multiple_choice') return [];

    const clean = [];
    const seen = new Set();
    for (const value of Array.isArray(question.choices) ? question.choices : []) {
        const choice = clampText(value, 500);
        const key = choice.toLowerCase();
        if (!choice || seen.has(key)) continue;
        seen.add(key);
        clean.push(choice);
        if (clean.length >= 40) break;
    }
    return clean;
}

function normalizeQuestions(rawQuestions, builderSections) {
    const sectionIds = new Set(builderSections.map(section => section.id));
    const firstSectionId = builderSections[0].id;

    return rawQuestions.slice(0, 500).map((question, index) => {
        const type = ['multiple_choice', 'true_false', 'short_answer', 'essay'].includes(question?.type)
            ? question.type
            : 'multiple_choice';
        const choices = normalizeChoices(question || {}, type);
        let answerKey = type === 'essay' ? '' : clampText(question?.answer_key, 1000);
        if (type === 'true_false') {
            answerKey = /^false$/i.test(answerKey) ? 'False' : 'True';
        }

        const requestedSection = clampText(question?.sectionId || question?.category, 80);
        return {
            id: clampText(question?.id, 80) || id('q'),
            type,
            prompt: clampText(question?.prompt, 6000),
            points: Math.max(1, Math.min(1000, Number(question?.points || 1))),
            answer_key: answerKey,
            choices,
            category: sectionIds.has(requestedSection) ? requestedSection : firstSectionId,
            difficulty: clampText(question?.difficulty, 50),
            explanation: clampText(question?.explanation, 2000),
            order_no: Number.isFinite(Number(question?.order_no)) ? Number(question.order_no) : index + 1,
            source_index: index
        };
    }).filter(question => question.prompt);
}

function validatePublishedQuestions(questions) {
    for (const [index, question] of questions.entries()) {
        if (question.type === 'multiple_choice') {
            if (question.choices.length < 2) return `Question ${index + 1} needs at least two choices.`;
            if (!question.answer_key || !question.choices.includes(question.answer_key)) {
                return `Question ${index + 1} needs a valid correct choice.`;
            }
        }
        if (question.type === 'true_false' && !['True', 'False'].includes(question.answer_key)) {
            return `Question ${index + 1} needs a True or False answer.`;
        }
    }
    return '';
}

function clampSectionPickCounts(builderSections, questions) {
    const counts = new Map(builderSections.map(section => [section.id, 0]));
    questions.forEach(question => counts.set(question.category, (counts.get(question.category) || 0) + 1));
    return builderSections.map(section => {
        const count = counts.get(section.id) || 0;
        return {
            ...section,
            pickCount: section.pickCount > 0 && section.pickCount < count ? section.pickCount : 0
        };
    });
}

function sectionDefinitions(settingsJson, bankQuestions) {
    const settings = typeof settingsJson === 'string' ? parseJson(settingsJson, {}) : (settingsJson || {});
    return normalizeBuilderSections(settings, bankQuestions);
}

function buildRuntimeQuestions(assessment, bankQuestions) {
    const sections = sectionDefinitions(assessment.settings_json || assessment.settings, bankQuestions);
    const grouped = new Map(sections.map(section => [section.id, []]));
    const fallbackSectionId = sections[0].id;

    bankQuestions.forEach(question => {
        const sectionId = grouped.has(String(question.category || '')) ? String(question.category) : fallbackSectionId;
        grouped.get(sectionId).push(question);
    });

    const runtimeQuestions = [];
    sections.forEach((section, sectionIndex) => {
        const ordered = (grouped.get(section.id) || [])
            .slice()
            .sort((a, b) => Number(a.order_no || 0) - Number(b.order_no || 0));

        let selected = ordered;
        if (section.pickCount > 0 && section.pickCount < ordered.length) {
            const pickedIds = new Set(shuffleList(ordered).slice(0, section.pickCount).map(question => question.id));
            selected = ordered.filter(question => pickedIds.has(question.id));
        }
        if (section.shuffleQuestions) selected = shuffleList(selected);

        selected.forEach((question, questionIndex) => {
            runtimeQuestions.push({
                ...question,
                choices: section.shuffleChoices ? shuffleList(question.choices || []) : (question.choices || []).slice(),
                section_id: section.id,
                section_title: section.title,
                section_order: sectionIndex + 1,
                section_question_no: questionIndex + 1
            });
        });
    });

    return runtimeQuestions;
}

function safeRuntimeQuestion(question) {
    const { answer_key, explanation, ...safeQuestion } = question;
    return safeQuestion;
}

async function adminList(env) {
    const [list] = await turso(env, [{ sql: `select * from assessments order by created_at desc` }]);
    return json({ assessments: rows(list).map(assessmentFromRow) });
}

async function adminGet(env, assessmentId) {
    const [assessmentResult, questionsResult] = await turso(env, [
        { sql: `select * from assessments where id = ? limit 1`, args: [assessmentId] },
        { sql: `select * from assessment_questions where assessment_id = ? order by order_no`, args: [assessmentId] }
    ]);
    const assessment = rows(assessmentResult)[0];
    if (!assessment) return json({ error: 'Assessment not found.' }, 404);
    return json({
        assessment: assessmentFromRow(assessment),
        questions: rows(questionsResult).map(row => questionFromRow(row, true))
    });
}

async function adminSave(request, env, admin) {
    const body = await readBody(request);
    const now = new Date().toISOString();
    const assessment = body.assessment || {};
    const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
    const assessmentId = clampText(assessment.id, 80) || id('asm');
    const title = clampText(assessment.title, 140);
    const subject = clampText(assessment.subject_code, 80);
    const section = clampText(assessment.section || 'ALL', 80);
    const status = ['draft', 'published', 'closed', 'archived'].includes(assessment.status) ? assessment.status : 'draft';
    const duration = Math.max(1, Math.min(240, Number(assessment.duration_minutes || 30)));
    const settings = assessment.settings && typeof assessment.settings === 'object' ? assessment.settings : {};

    if (!title || !subject || !section) {
        return json({ error: 'Complete the title, subject, and section.' }, 422);
    }

    let builderSections = normalizeBuilderSections(settings, rawQuestions);
    let questions = normalizeQuestions(rawQuestions, builderSections);
    builderSections = clampSectionPickCounts(builderSections, questions);

    if (status === 'published' && !questions.length) {
        return json({ error: 'Add at least one question before publishing.' }, 422);
    }
    if (status === 'published') {
        const validationError = validatePublishedQuestions(questions);
        if (validationError) return json({ error: validationError }, 422);
    }

    const sectionOrder = new Map(builderSections.map((sectionDef, index) => [sectionDef.id, index]));
    questions = questions.sort((a, b) => {
        const sectionDiff = (sectionOrder.get(a.category) ?? 999) - (sectionOrder.get(b.category) ?? 999);
        if (sectionDiff !== 0) return sectionDiff;
        const orderDiff = Number(a.order_no || 0) - Number(b.order_no || 0);
        return orderDiff !== 0 ? orderDiff : a.source_index - b.source_index;
    });

    const statements = [
        {
            sql: `insert into assessments (id,title,instructions,subject_code,section,status,duration_minutes,opens_at,closes_at,settings_json,created_by,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set title=excluded.title,instructions=excluded.instructions,subject_code=excluded.subject_code,section=excluded.section,status=excluded.status,duration_minutes=excluded.duration_minutes,opens_at=excluded.opens_at,closes_at=excluded.closes_at,settings_json=excluded.settings_json,updated_at=excluded.updated_at`,
            args: [
                assessmentId,
                title,
                clampText(assessment.instructions, 5000),
                subject,
                section,
                status,
                duration,
                assessment.opens_at || null,
                assessment.closes_at || null,
                JSON.stringify({ ...settings, builderSections }),
                String(admin.id || admin.uid || admin.email || 'admin'),
                now,
                now
            ]
        },
        { sql: `delete from assessment_questions where assessment_id = ?`, args: [assessmentId] }
    ];

    questions.forEach((question, index) => {
        statements.push({
            sql: `insert into assessment_questions (id,assessment_id,type,prompt,points,answer_key,choices_json,category,difficulty,explanation,order_no,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
                question.id,
                assessmentId,
                question.type,
                question.prompt,
                question.points,
                question.answer_key,
                JSON.stringify(question.choices),
                question.category,
                question.difficulty,
                question.explanation,
                index + 1,
                now
            ]
        });
    });

    await turso(env, statements);
    return json({ ok: true, id: assessmentId, sections: builderSections.length, questions: questions.length });
}

async function adminDelete(request, env) {
    const body = await readBody(request);
    const assessmentId = clampText(body.id, 80);
    if (!assessmentId) return json({ error: 'Assessment ID is required.' }, 422);
    await turso(env, [{ sql: `delete from assessments where id = ?`, args: [assessmentId] }]);
    return json({ ok: true });
}

async function adminAttempts(env, assessmentId) {
    const [result] = await turso(env, [{
        sql: `select * from assessment_attempts where assessment_id = ? order by submitted_at desc, started_at desc`,
        args: [assessmentId]
    }]);
    return json({
        attempts: rows(result).map(row => ({
            ...row,
            answers: parseJson(row.answers_json, {}),
            score: Number(row.score || 0),
            total_points: Number(row.total_points || 0),
            violations: Number(row.violations || 0)
        }))
    });
}

async function adminIncidents(env) {
    const [result] = await turso(env, [{ sql: `select * from assessment_incidents order by created_at desc limit 200` }]);
    return json({ incidents: rows(result) });
}

async function studentList(env, profile) {
    const section = String(profile.section || '').trim();
    const studentNo = String(profile.studentNo || profile.student_no || profile.username || '').trim();
    const [assessmentsResult, attemptsResult] = await turso(env, [
        {
            sql: `select * from assessments where status in ('published','closed') and (section = 'ALL' or section = ?) order by created_at desc`,
            args: [section]
        },
        {
            sql: `select * from assessment_attempts where student_no = ? order by started_at desc`,
            args: [studentNo]
        }
    ]);

    return json({
        assessments: rows(assessmentsResult).map(assessmentFromRow),
        attempts: rows(attemptsResult).map(row => ({
            ...row,
            answers: undefined,
            answers_json: undefined,
            score: Number(row.score || 0),
            total_points: Number(row.total_points || 0),
            violations: Number(row.violations || 0)
        }))
    });
}

function sessionIsFresh(meta, nowMs = Date.now()) {
    const last = Date.parse(meta?.lastHeartbeatAt || '');
    return Number.isFinite(last) && nowMs - last < 45000;
}

function sanitizeDraftAnswers(runtimeQuestions, rawAnswers) {
    const source = rawAnswers && typeof rawAnswers === 'object' ? rawAnswers : {};
    const allowed = new Set((runtimeQuestions || []).map(question => String(question.id)));
    const clean = {};
    for (const [questionId, value] of Object.entries(source)) {
        if (!allowed.has(String(questionId))) continue;
        clean[String(questionId)] = String(value ?? '').slice(0, 12000);
    }
    return clean;
}

function attemptSessionError(attemptMeta, clientSessionId) {
    const active = clampText(attemptMeta?.activeSessionId, 120);
    if (!active) return '';
    if (!clientSessionId || active !== clientSessionId) {
        return 'This exam is active in another tab or window. Close the other exam tab and wait about one minute before resuming.';
    }
    return '';
}

async function studentStart(request, env, profile) {
    const body = await readBody(request);
    const assessmentId = clampText(body.assessment_id, 80);
    const clientSessionId = clampText(body.client_session_id, 120);
    const studentNo = String(profile.studentNo || profile.student_no || profile.username || '').trim();
    const studentName = String(profile.studentName || profile.fullName || profile.name || profile.email || 'Student').trim();
    if (!assessmentId || !studentNo || !clientSessionId) return json({ error: 'Assessment session cannot be started.' }, 422);

    const [assessmentResult, questionsResult, attemptResult] = await turso(env, [
        { sql: `select * from assessments where id = ? limit 1`, args: [assessmentId] },
        { sql: `select * from assessment_questions where assessment_id = ? order by order_no`, args: [assessmentId] },
        {
            sql: `select * from assessment_attempts where assessment_id = ? and student_no = ? and status = 'started' order by started_at desc limit 1`,
            args: [assessmentId, studentNo]
        }
    ]);

    const assessment = rows(assessmentResult)[0];
    if (!assessment || assessment.status !== 'published') {
        return json({ error: 'Assessment is not available.' }, 404);
    }

    const nowMs = Date.now();
    if (assessment.opens_at && nowMs < Date.parse(assessment.opens_at)) {
        return json({ error: 'Assessment has not opened yet.' }, 403);
    }
    if (assessment.closes_at && nowMs > Date.parse(assessment.closes_at)) {
        return json({ error: 'Assessment is already closed.' }, 403);
    }

    const allQuestions = rows(questionsResult).map(row => questionFromRow(row, true));
    const existing = rows(attemptResult)[0];
    const now = new Date(nowMs).toISOString();
    const computedDeadline = new Date(nowMs + Number(assessment.duration_minutes || 30) * 60000).toISOString();

    let attemptId = existing?.id || '';
    const startedAt = existing?.started_at || now;
    const deadlineAt = existing?.deadline_at || computedDeadline;
    let attemptMeta = parseJson(existing?.answers_json, {});
    const previousSessionId = clampText(attemptMeta.activeSessionId, 120);
    const activeElsewhere = previousSessionId && previousSessionId !== clientSessionId && sessionIsFresh(attemptMeta, nowMs);
    if (activeElsewhere) {
        return json({
            error: 'This assessment is already open in another active tab or window.',
            code: 'EXAM_ALREADY_ACTIVE'
        }, 409);
    }

    const hadRuntimeQuestions = Array.isArray(attemptMeta.runtimeQuestions) && attemptMeta.runtimeQuestions.length > 0;
    let runtimeQuestions = hadRuntimeQuestions ? attemptMeta.runtimeQuestions : [];
    if (!runtimeQuestions.length) runtimeQuestions = buildRuntimeQuestions(assessment, allQuestions);

    const draftAnswers = sanitizeDraftAnswers(runtimeQuestions, attemptMeta.draftAnswers || {});
    const recoveredSession = !!(previousSessionId && previousSessionId !== clientSessionId);
    attemptMeta = {
        ...attemptMeta,
        runtimeQuestions,
        draftAnswers,
        activeSessionId: clientSessionId,
        lastHeartbeatAt: now,
        lastQuestionIndex: Math.max(0, Number(attemptMeta.lastQuestionIndex || 0))
    };

    if (!attemptId) {
        attemptId = id('att');
        await turso(env, [{
            sql: `insert into assessment_attempts (id,assessment_id,student_no,student_name,student_uid,status,answers_json,score,total_points,violations,started_at,deadline_at,created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
                attemptId,
                assessmentId,
                studentNo,
                studentName,
                String(profile.uid || profile.id || ''),
                'started',
                JSON.stringify(attemptMeta),
                0,
                0,
                0,
                startedAt,
                deadlineAt,
                now
            ]
        }]);
    } else {
        const statements = [{
            sql: `update assessment_attempts set answers_json = ? where id = ? and student_no = ? and status = 'started'`,
            args: [JSON.stringify(attemptMeta), attemptId, studentNo]
        }];
        if (recoveredSession) {
            statements.push({
                sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,created_at) values (?,?,?,?,?,?,?)`,
                args: [id('inc'), attemptId, assessmentId, studentNo, 'session_recovered', 'A stale exam session was recovered in a new tab.', now]
            });
        }
        await turso(env, statements);
    }

    return json({
        attempt: {
            id: attemptId,
            deadline_at: deadlineAt,
            started_at: startedAt,
            violations: Number(existing?.violations || 0),
            last_question_index: Math.max(0, Number(attemptMeta.lastQuestionIndex || 0))
        },
        assessment: assessmentFromRow(assessment),
        questions: runtimeQuestions.map(safeRuntimeQuestion),
        answers: draftAnswers,
        recovered: recoveredSession
    });
}

async function studentAutosave(request, env, profile) {
    const body = await readBody(request);
    const attemptId = clampText(body.attempt_id, 80);
    const clientSessionId = clampText(body.client_session_id, 120);
    const studentNo = String(profile.studentNo || profile.student_no || profile.username || '').trim();
    if (!attemptId || !clientSessionId) return json({ error: 'Invalid exam session.' }, 422);

    const [attemptResult] = await turso(env, [{
        sql: `select * from assessment_attempts where id = ? and student_no = ? limit 1`,
        args: [attemptId, studentNo]
    }]);
    const attempt = rows(attemptResult)[0];
    if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    if (attempt.status === 'submitted') return json({ ok: true, submitted: true });

    const attemptMeta = parseJson(attempt.answers_json, {});
    const sessionError = attemptSessionError(attemptMeta, clientSessionId);
    if (sessionError) return json({ error: sessionError, code: 'SESSION_MISMATCH' }, 409);

    let runtimeQuestions = Array.isArray(attemptMeta.runtimeQuestions) ? attemptMeta.runtimeQuestions : [];
    if (!runtimeQuestions.length) {
        const [questionsResult] = await turso(env, [{
            sql: `select * from assessment_questions where assessment_id = ? order by order_no`,
            args: [attempt.assessment_id]
        }]);
        runtimeQuestions = rows(questionsResult).map(row => questionFromRow(row, true));
    }

    const cleanAnswers = sanitizeDraftAnswers(runtimeQuestions, body.answers || attemptMeta.draftAnswers || {});
    const now = new Date().toISOString();
    const nextMeta = {
        ...attemptMeta,
        runtimeQuestions,
        draftAnswers: cleanAnswers,
        activeSessionId: clientSessionId,
        lastHeartbeatAt: now,
        lastQuestionIndex: Math.max(0, Math.min(runtimeQuestions.length - 1, Number(body.question_index || 0)))
    };
    await turso(env, [{
        sql: `update assessment_attempts set answers_json = ? where id = ? and student_no = ? and status = 'started'`,
        args: [JSON.stringify(nextMeta), attemptId, studentNo]
    }]);

    return json({
        ok: true,
        saved_at: now,
        violations: Number(attempt.violations || 0),
        deadline_at: attempt.deadline_at
    });
}

function grade(questions, answers) {
    let score = 0;
    let total = 0;
    const detail = {};

    for (const question of questions) {
        const points = Number(question.points || 1);
        total += points;
        const expected = String(question.answer_key || '').trim();
        const actual = String(answers[question.id] || '').trim();
        const manual = question.type === 'essay' || !expected;
        const correct = !manual && expected.toLowerCase() === actual.toLowerCase();
        const earned = correct ? points : 0;
        score += earned;
        detail[question.id] = { answer: actual, points: earned, manual };
    }

    return { score, total, detail };
}

async function studentSubmit(request, env, profile) {
    const body = await readBody(request);
    const attemptId = clampText(body.attempt_id, 80);
    const clientSessionId = clampText(body.client_session_id, 120);
    const studentNo = String(profile.studentNo || profile.student_no || profile.username || '').trim();

    const [attemptResult] = await turso(env, [{
        sql: `select * from assessment_attempts where id = ? and student_no = ? limit 1`,
        args: [attemptId, studentNo]
    }]);
    const attempt = rows(attemptResult)[0];
    if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    if (attempt.status === 'submitted') return json({ ok: true, alreadySubmitted: true, score: Number(attempt.score || 0), total_points: Number(attempt.total_points || 0) });

    const attemptMeta = parseJson(attempt.answers_json, {});
    const sessionError = attemptSessionError(attemptMeta, clientSessionId);
    if (sessionError) return json({ error: sessionError, code: 'SESSION_MISMATCH' }, 409);

    let runtimeQuestions = Array.isArray(attemptMeta.runtimeQuestions) ? attemptMeta.runtimeQuestions : [];
    if (!runtimeQuestions.length) {
        const [questionsResult] = await turso(env, [{
            sql: `select * from assessment_questions where assessment_id = ? order by order_no`,
            args: [attempt.assessment_id]
        }]);
        runtimeQuestions = rows(questionsResult).map(row => questionFromRow(row, true));
    }

    const submittedAnswers = body.answers && typeof body.answers === 'object' ? body.answers : attemptMeta.draftAnswers;
    const answers = sanitizeDraftAnswers(runtimeQuestions, submittedAnswers || {});
    const result = grade(runtimeQuestions, answers);
    const now = new Date().toISOString();
    await turso(env, [{
        sql: `update assessment_attempts set status = 'submitted', answers_json = ?, score = ?, total_points = ?, submitted_at = ? where id = ? and student_no = ?`,
        args: [
            JSON.stringify({
                raw: answers,
                graded: result.detail,
                runtimeQuestionIds: runtimeQuestions.map(question => question.id),
                completedSessionId: clientSessionId,
                completedAt: now
            }),
            result.score,
            result.total,
            now,
            attemptId,
            studentNo
        ]
    }]);

    return json({ ok: true, score: result.score, total_points: result.total, submitted_at: now });
}

async function studentIncident(request, env, profile) {
    const body = await readBody(request);
    const attemptId = clampText(body.attempt_id, 80);
    const clientSessionId = clampText(body.client_session_id, 120);
    const type = clampText(body.type, 80) || 'unknown';
    const details = clampText(body.details, 1000);
    const studentNo = String(profile.studentNo || profile.student_no || profile.username || '').trim();

    const [attemptResult] = await turso(env, [{
        sql: `select a.*, s.settings_json from assessment_attempts a join assessments s on s.id = a.assessment_id where a.id = ? and a.student_no = ? limit 1`,
        args: [attemptId, studentNo]
    }]);
    const attempt = rows(attemptResult)[0];
    if (!attempt) return json({ error: 'Attempt not found.' }, 404);
    if (attempt.status === 'submitted') return json({ ok: true, submitted: true, violations: Number(attempt.violations || 0) });

    const attemptMeta = parseJson(attempt.answers_json, {});
    const sessionError = attemptSessionError(attemptMeta, clientSessionId);
    if (sessionError) return json({ error: sessionError, code: 'SESSION_MISMATCH' }, 409);

    const settings = parseJson(attempt.settings_json, {});
    const maxViolations = Math.max(1, Math.min(50, Number(settings.maxViolations || settings.maxViol || 5)));
    const autoSubmitOnViolation = settings.autoSubmitOnViolation !== false;
    const now = new Date().toISOString();
    const newCount = Number(attempt.violations || 0) + 1;
    const shouldAutoSubmit = autoSubmitOnViolation && newCount >= maxViolations;
    const statements = [{
        sql: `insert into assessment_incidents (id,attempt_id,assessment_id,student_no,type,details,created_at) values (?,?,?,?,?,?,?)`,
        args: [id('inc'), attemptId, attempt.assessment_id, studentNo, type, details, now]
    }];

    let automaticResult = null;
    if (shouldAutoSubmit) {
        let runtimeQuestions = Array.isArray(attemptMeta.runtimeQuestions) ? attemptMeta.runtimeQuestions : [];
        if (!runtimeQuestions.length) {
            const [questionsResult] = await turso(env, [{
                sql: `select * from assessment_questions where assessment_id = ? order by order_no`,
                args: [attempt.assessment_id]
            }]);
            runtimeQuestions = rows(questionsResult).map(row => questionFromRow(row, true));
        }
        const answers = sanitizeDraftAnswers(runtimeQuestions, attemptMeta.draftAnswers || {});
        automaticResult = grade(runtimeQuestions, answers);
        statements.push({
            sql: `update assessment_attempts set status = 'submitted', violations = ?, answers_json = ?, score = ?, total_points = ?, submitted_at = ? where id = ? and student_no = ? and status = 'started'`,
            args: [
                newCount,
                JSON.stringify({
                    raw: answers,
                    graded: automaticResult.detail,
                    runtimeQuestionIds: runtimeQuestions.map(question => question.id),
                    completedSessionId: clientSessionId,
                    completedAt: now,
                    autoSubmitReason: 'anomaly_limit',
                    triggeringIncident: type
                }),
                automaticResult.score,
                automaticResult.total,
                now,
                attemptId,
                studentNo
            ]
        });
    } else {
        const nextMeta = { ...attemptMeta, lastHeartbeatAt: now };
        statements.push({
            sql: `update assessment_attempts set violations = ?, answers_json = ? where id = ?`,
            args: [newCount, JSON.stringify(nextMeta), attemptId]
        });
    }

    await turso(env, statements);
    return json({
        ok: true,
        violations: newCount,
        max_violations: maxViolations,
        auto_submit: shouldAutoSubmit,
        submitted: shouldAutoSubmit,
        score: automaticResult?.score,
        total_points: automaticResult?.total
    });
}

export async function onRequest({ request, env, params }) {
    try {
        await ensureSchema(env);
        const rawPath = params.path;
        const path = '/' + (Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || ''));
        const url = new URL(request.url);

        if (path.startsWith('/admin')) {
            const auth = await requireRole(request, env, 'admin');
            if (auth.error) return auth.error;
            if (request.method === 'GET' && path === '/admin/list') return adminList(env);
            if (request.method === 'GET' && path === '/admin/get') return adminGet(env, url.searchParams.get('id') || '');
            if (request.method === 'POST' && path === '/admin/save') return adminSave(request, env, auth.profile);
            if (request.method === 'POST' && path === '/admin/delete') return adminDelete(request, env);
            if (request.method === 'GET' && path === '/admin/attempts') return adminAttempts(env, url.searchParams.get('assessment_id') || '');
            if (request.method === 'GET' && path === '/admin/incidents') return adminIncidents(env);
        }

        if (path.startsWith('/student')) {
            const auth = await requireStudent(request, env);
            if (auth.error) return auth.error;
            if (request.method === 'GET' && path === '/student/list') return studentList(env, auth.profile);
            if (request.method === 'POST' && path === '/student/start') return studentStart(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/autosave') return studentAutosave(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/submit') return studentSubmit(request, env, auth.profile);
            if (request.method === 'POST' && path === '/student/incident') return studentIncident(request, env, auth.profile);
        }

        return json({ error: 'Assessment route not found.' }, 404);
    } catch (error) {
        const message = error?.message || '';
        return json({
            error: message.includes('missing') ? message : 'Assessment service is temporarily unavailable.'
        }, 500);
    }
}
