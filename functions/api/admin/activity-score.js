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

  const savedScore = { id: crypto.randomUUID(), activityId: activity.id, studentNo, score };
  const response = await supabaseServiceFetch(env, '/rest/v1/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(savedScore),
  });
  if (!response.ok) return { error: await databaseError(response) };
  return { score: savedScore };
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
  const message = String(details.message || '');
  const absent = message.toLowerCase().includes('absent');
  console.error(JSON.stringify({ event: 'activity_score_write_failed', status: response.status, code: details.code || 'unknown' }));
  return json({
    error: absent ? 'This student is marked absent for the activity date.' : 'The score could not be stored.',
    code: absent ? 'absent' : String(details.code || 'score_write_failed'),
  }, absent ? 409 : 503);
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

    if (action === 'delete') {
      const error = await deleteScore(env, activityId, studentNo);
      return error || json({ deleted: true });
    }

    const rawScore = body?.score;
    const score = rawScore === null || rawScore === undefined || String(rawScore).trim() === '' ? Number.NaN : Number(rawScore);
    const maximum = Number(activity.perfectScore);
    if (!Number.isFinite(score) || !Number.isFinite(maximum) || maximum <= 0 || score < 0 || score > maximum) {
      return json({ error: `Enter a score from 0 to ${maximum}.`, code: 'validation' }, 422);
    }

    const result = await writeScore(env, activity, studentNo, score);
    return result.error || json({ saved: true, score: result.score });
  } catch (error) {
    console.error(JSON.stringify({ event: 'activity_score_request_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return json({ error: 'Score saving is temporarily unavailable.', code: 'network' }, 503);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
