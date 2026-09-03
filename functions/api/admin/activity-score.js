import {
  getAuthenticatedUser,
  isUuid,
  json,
  supabaseServiceFetch,
} from '../../_shared/push.js';

const STUDENT_NUMBER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,49}$/i;

async function responseJson(response) {
  return response.json().catch(() => ({}));
}

async function findActiveAdmin(env, authUser) {
  const checks = [
    ['uid', authUser.id],
    ['id', authUser.id],
    ['email', authUser.email],
  ].filter(([, value]) => Boolean(value));

  for (const [field, value] of checks) {
    const query = new URLSearchParams({
      select: 'id,role,status',
      [field]: `eq.${value}`,
      role: 'eq.admin',
      limit: '1',
    });
    const response = await supabaseServiceFetch(env, `/rest/v1/users?${query}`);
    if (!response.ok) continue;
    const rows = await responseJson(response);
    const admin = Array.isArray(rows) ? rows[0] : null;
    if (admin && String(admin.status || 'Active').toLowerCase() !== 'inactive') return admin;
  }
  return null;
}

async function selectRows(env, table, query) {
  const response = await supabaseServiceFetch(env, `/rest/v1/${table}?${query}`);
  if (!response.ok) throw new Error(`${table}_lookup_failed`);
  const rows = await responseJson(response);
  return Array.isArray(rows) ? rows : [];
}

function nextDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function isAbsent(status) {
  const value = String(status || '').trim().toUpperCase();
  return value === 'A' || value.startsWith('ABSENT');
}

async function loadActivity(env, activityId) {
  const query = new URLSearchParams({
    select: 'id,section,subjectCode,date,perfectScore',
    id: `eq.${activityId}`,
    limit: '1',
  });
  return (await selectRows(env, 'activities', query))[0] || null;
}

async function assertEnrollment(env, activity, studentNo) {
  const query = new URLSearchParams({
    select: 'id',
    studentNo: `eq.${studentNo}`,
    section: `eq.${activity.section}`,
    subjectCode: `eq.${activity.subjectCode}`,
    limit: '1',
  });
  return Boolean((await selectRows(env, 'enrollments', query))[0]);
}

async function isAbsentForActivity(env, activity, studentNo) {
  const startDate = String(activity.date || '').slice(0, 10);
  const endDate = nextDateKey(startDate);
  if (!startDate || !endDate) return false;
  const query = new URLSearchParams({
    select: 'status',
    studentNo: `eq.${studentNo}`,
    section: `eq.${activity.section}`,
    subjectCode: `eq.${activity.subjectCode}`,
    date: `gte.${startDate}`,
    limit: '20',
  });
  query.append('date', `lt.${endDate}`);
  return (await selectRows(env, 'attendance', query)).some((row) => isAbsent(row.status));
}

async function findExistingScore(env, activityId, studentNo) {
  const query = new URLSearchParams({
    select: 'id,activityId,studentNo,score',
    activityId: `eq.${activityId}`,
    studentNo: `eq.${studentNo}`,
    limit: '20',
  });
  return selectRows(env, 'scores', query);
}

async function runScoreWriteRpc(env, action, activityId, studentNo, score = null) {
  const response = await supabaseServiceFetch(env, '/rest/v1/rpc/plv_write_activity_score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      p_action: action,
      p_activity_id: activityId,
      p_student_no: studentNo,
      p_score: score,
    }),
  });
  const details = await responseJson(response);
  const code = String(details?.code || '').toUpperCase();
  if (!response.ok && (response.status === 404 || code === 'PGRST202')) return { available: false };
  if (!response.ok) return { available: true, error: databaseErrorFromDetails(details, response.status) };
  return { available: true, value: details };
}

async function writeScore(env, activity, studentNo, score) {
  if (await isAbsentForActivity(env, activity, studentNo)) {
    return { error: json({ error: 'This student is marked absent for the activity date.', code: 'absent' }, 409) };
  }

  const existing = await findExistingScore(env, activity.id, studentNo);
  if (existing.length) {
    const query = new URLSearchParams({
      activityId: `eq.${activity.id}`,
      studentNo: `eq.${studentNo}`,
    });
    const response = await supabaseServiceFetch(env, `/rest/v1/scores?${query}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ score }),
    });
    if (!response.ok) return { error: await databaseError(response) };
    return { score: { ...existing[0], score } };
  }

  const scoreValues = {
    activityId: activity.id,
    studentNo,
    score,
    createdAt: new Date().toISOString(),
  };
  let response = await supabaseServiceFetch(env, '/rest/v1/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'missing=default,return=representation' },
    body: JSON.stringify(scoreValues),
  });
  let details = await responseJson(response);

  // Existing PLV databases generate UUIDs for scores. Let the database own that
  // default, while retaining compatibility with older installations that require
  // the caller to provide an id explicitly.
  if (!response.ok && isMissingGeneratedId(details)) {
    response = await supabaseServiceFetch(env, '/rest/v1/scores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'missing=default,return=representation' },
      body: JSON.stringify({ id: crypto.randomUUID(), ...scoreValues }),
    });
    details = await responseJson(response);
  }

  // If another autosave created the row after our lookup, convert the unique
  // conflict into an update instead of asking the administrator to retry.
  if (!response.ok && String(details.code || '') === '23505') {
    const concurrent = await findExistingScore(env, activity.id, studentNo);
    if (concurrent.length) {
      const query = new URLSearchParams({
        activityId: `eq.${activity.id}`,
        studentNo: `eq.${studentNo}`,
      });
      const update = await supabaseServiceFetch(env, `/rest/v1/scores?${query}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ score }),
      });
      if (!update.ok) return { error: await databaseError(update) };
      return { score: { ...concurrent[0], score } };
    }
  }

  if (!response.ok) return { error: databaseErrorFromDetails(details, response.status) };
  const savedScore = Array.isArray(details) ? details[0] : details;
  return { score: savedScore?.id ? savedScore : scoreValues };
}

async function deleteScore(env, activityId, studentNo) {
  const query = new URLSearchParams({
    activityId: `eq.${activityId}`,
    studentNo: `eq.${studentNo}`,
  });
  const response = await supabaseServiceFetch(env, `/rest/v1/scores?${query}`, { method: 'DELETE' });
  if (!response.ok) return databaseError(response);
  return null;
}

async function databaseError(response) {
  const details = await responseJson(response);
  return databaseErrorFromDetails(details, response.status);
}

function isMissingGeneratedId(details) {
  const code = String(details?.code || '').toUpperCase();
  const message = `${details?.message || ''} ${details?.details || ''}`.toLowerCase();
  return code === '23502' && /\bid\b/.test(message);
}

function databaseErrorFromDetails(details, status) {
  const code = String(details?.code || '').toUpperCase();
  const message = String(details?.message || '');
  const absent = message.toLowerCase().includes('absent');
  const reference = code === '23503';
  const validation = code === '23514';
  const precision = ['22P02', '42804'].includes(code)
    && /score|bigint|integer|numeric/i.test(message);
  const configuration = ['22P02', '23502', '42703', '42804', '42883', 'PGRST204'].includes(code)
    || status === 401
    || status === 403;
  const safeCode = absent ? 'absent'
    : reference ? 'reference'
      : validation ? 'validation'
        : precision ? 'precision'
        : configuration ? 'configuration'
          : 'storage';
  console.error(JSON.stringify({ event: 'activity_score_write_failed', status, code: code || 'unknown' }));
  return json({
    error: absent
      ? 'This student is marked absent for the activity date.'
      : reference
        ? 'The activity or enrollment no longer exists.'
      : validation
          ? 'The database rejected this score value.'
          : precision
            ? 'Decimal scores require the latest score storage migration.'
          : configuration
            ? 'The score service needs its database connection updated.'
            : 'The score storage service rejected the change.',
    code: safeCode,
  }, absent || reference ? 409 : validation || precision ? 422 : 503);
}

export async function onRequestPost({ request, env }) {
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4096) return json({ error: 'Invalid score request.' }, 413);

    const authUser = await getAuthenticatedUser(request, env);
    if (!authUser) return json({ error: 'Admin authentication is required.', code: 'auth' }, 401);
    if (!await findActiveAdmin(env, authUser)) return json({ error: 'Active administrator access is required.', code: 'auth' }, 403);

    const body = await request.json().catch(() => null);
    const action = String(body?.action || '');
    const activityId = String(body?.activityId || '');
    const studentNo = String(body?.studentNo || '').trim();
    if (!['save', 'delete'].includes(action) || !isUuid(activityId) || !STUDENT_NUMBER_PATTERN.test(studentNo)) {
      return json({ error: 'Invalid score request.', code: 'validation' }, 422);
    }

    const activity = await loadActivity(env, activityId);
    if (!activity) return json({ error: 'The activity no longer exists.', code: 'reference' }, 404);
    if (!await assertEnrollment(env, activity, studentNo)) {
      return json({ error: 'The student is not enrolled in this class.', code: 'reference' }, 409);
    }

    const rawScore = body?.score;
    const score = rawScore === null || rawScore === undefined || String(rawScore).trim() === '' ? Number.NaN : Number(rawScore);
    const maximum = Number(activity.perfectScore);
    if (action === 'save' && (!Number.isFinite(score) || !Number.isFinite(maximum) || maximum <= 0 || score < 0 || score > maximum)) {
      return json({ error: `Enter a score from 0 to ${maximum}.`, code: 'validation' }, 422);
    }

    const rpcResult = await runScoreWriteRpc(env, action, activityId, studentNo, action === 'save' ? score : null);
    if (rpcResult.available) {
      if (rpcResult.error) return rpcResult.error;
      return json(action === 'delete'
        ? { deleted: true }
        : { saved: true, score: rpcResult.value });
    }

    if (action === 'delete') {
      const error = await deleteScore(env, activityId, studentNo);
      return error || json({ deleted: true });
    }

    const result = await writeScore(env, activity, studentNo, score);
    return result.error || json({ saved: true, score: result.score });
  } catch (error) {
    console.error(JSON.stringify({ event: 'activity_score_request_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return json({ error: 'Score saving is temporarily unavailable.', code: 'network' }, 503);
  }
}

export async function onRequestGet({ env }) {
  try {
    const response = await supabaseServiceFetch(env, '/rest/v1/rpc/plv_write_activity_score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        p_action: 'probe',
        p_activity_id: '00000000-0000-4000-8000-000000000000',
        p_student_no: 'health-check',
        p_score: null,
      }),
    });
    const details = await responseJson(response);
    const code = String(details?.code || '').toUpperCase();
    if (code === '22023') return json({ ready: true, version: '2026-09-03.5' });
    const reason = code === 'PGRST202' || response.status === 404
      ? 'function_missing'
      : code === '42501' || response.status === 401 || response.status === 403
        ? 'function_permission'
        : 'function_unexpected';
    return json({ ready: false, version: '2026-09-03.5', reason }, 503);
  } catch (error) {
    console.error(JSON.stringify({ event: 'activity_score_health_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return json({ ready: false, version: '2026-09-03.5', reason: 'server_configuration' }, 503);
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { 'x-plv-score-api-version': '2026-09-03.5' },
  });
}
