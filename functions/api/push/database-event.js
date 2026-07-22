import {
  bearerToken,
  constantTimeEqual,
  envValue,
  isUuid,
  json,
  sendOneSignalPush,
  supabaseServiceFetch,
} from '../../_shared/push.js';

function text(record, ...keys) {
  for (const key of keys) {
    const value = String(record?.[key] || '').trim();
    if (value) return value;
  }
  return '';
}

async function userIdForStudent(env, studentNo) {
  if (!studentNo) return '';
  const query = new URLSearchParams({
    select: 'uid,id',
    studentNo: `eq.${studentNo}`,
    limit: '1',
  });
  const response = await supabaseServiceFetch(env, `/rest/v1/users?${query}`);
  if (!response.ok) return '';
  const row = (await response.json())[0] || {};
  const id = text(row, 'uid', 'id');
  return isUuid(id) ? id : '';
}

async function subscriptions(env, { userId = '', category }) {
  const query = new URLSearchParams({
    select: 'subscription_id',
    enabled: 'eq.true',
    [category]: 'eq.true',
    limit: '20000',
  });
  if (userId) query.set('user_id', `eq.${userId}`);
  const response = await supabaseServiceFetch(env, `/rest/v1/push_subscriptions?${query}`);
  if (!response.ok) throw new Error('subscription_lookup_failed');
  return (await response.json()).map((row) => row.subscription_id).filter(isUuid);
}

function gradeChanged(record, previous) {
  const keys = ['midtermGrade', 'midtermRawGrade', 'finalGrade', 'finalRawGrade'];
  return keys.some((key) => record?.[key] !== previous?.[key] && record?.[key] != null);
}

async function notificationFor(env, payload) {
  const event = String(payload.type || '').toUpperCase();
  const table = String(payload.table || '').toLowerCase();
  const record = payload.record || {};
  const previous = payload.old_record || {};

  if (table === 'announcements' && event === 'INSERT') {
    return {
      audience: await subscriptions(env, { category: 'announcements' }),
      title: text(record, 'title') || 'New PLV announcement',
      body: text(record, 'message').slice(0, 180) || 'Open PLV Portal to read the announcement.',
      type: 'announcement',
    };
  }

  if (table === 'scores' && (event === 'INSERT' || event === 'UPDATE')) {
    const userId = await userIdForStudent(env, text(record, 'studentNo', 'student_no'));
    return {
      audience: userId ? await subscriptions(env, { userId, category: 'academic_results' }) : [],
      title: 'New score available',
      body: 'A new activity score was published. Sign in to PLV Portal to view it.',
      type: 'score',
    };
  }

  if (table === 'attendance' && (event === 'INSERT' || event === 'UPDATE')) {
    const userId = await userIdForStudent(env, text(record, 'studentNo', 'student_no'));
    const subject = text(record, 'subjectCode', 'subject_code');
    return {
      audience: userId ? await subscriptions(env, { userId, category: 'academic_results' }) : [],
      title: 'Attendance updated',
      body: subject
        ? `Your attendance for ${subject} was updated. Open PLV Portal for details.`
        : 'Your attendance was updated. Open PLV Portal for details.',
      type: 'attendance',
    };
  }

  if (table === 'enrollments' && event === 'UPDATE' && gradeChanged(record, previous)) {
    const userId = await userIdForStudent(env, text(record, 'studentNo', 'student_no'));
    return {
      audience: userId ? await subscriptions(env, { userId, category: 'academic_results' }) : [],
      title: 'Grade published',
      body: 'A term grade was published. Sign in to PLV Portal to view your result.',
      type: 'grade',
    };
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    const configuredSecret = envValue(env, 'PUSH_WEBHOOK_SECRET');
    if (!configuredSecret || !constantTimeEqual(bearerToken(request), configuredSecret)) {
      return json({ error: 'Unauthorized.' }, 401);
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 65536) return json({ error: 'Request is too large.' }, 413);
    const payload = await request.json().catch(() => null);
    if (!payload || payload.schema !== 'public') return json({ error: 'Invalid event.' }, 422);
    const message = await notificationFor(env, payload);
    if (!message) return json({ accepted: true, skipped: true });
    const result = await sendOneSignalPush(env, message.audience, message);
    return json({
      accepted: true,
      delivered: result.delivered,
      recipients: result.recipients || 0,
    });
  } catch (error) {
    console.error('Push webhook failed.', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'Notification delivery is temporarily unavailable.' }, 503);
  }
}
