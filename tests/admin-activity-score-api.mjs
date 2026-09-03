import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequestPost } from '../functions/api/admin/activity-score.js';

const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVITY_ID = '33333333-3333-4333-8333-333333333333';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function request(body, authorized = true) {
  return new Request('https://portal.example/api/admin/activity-score', {
    method: 'POST',
    headers: {
      ...(authorized ? { authorization: 'Bearer test-token' } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const env = {
  SUPABASE_URL: 'https://database.example',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

function installSuccessfulFetch({ absent = false, existingScore = false } = {}) {
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: AUTH_ID, email: 'admin@example.edu' });
    if (url.pathname === '/rest/v1/users') return jsonResponse([{ id: ADMIN_ID, role: 'admin', status: 'Active' }]);
    if (url.pathname === '/rest/v1/activities') return jsonResponse([{
      id: ACTIVITY_ID,
      section: 'BSIT 2-1',
      subjectCode: 'IT101',
      date: '2026-09-03',
      perfectScore: 50,
    }]);
    if (url.pathname === '/rest/v1/enrollments') return jsonResponse([{ id: 'enrollment-1' }]);
    if (url.pathname === '/rest/v1/attendance') return jsonResponse(absent ? [{ status: 'Absent' }] : []);
    if (url.pathname === '/rest/v1/scores' && (!init.method || init.method === 'GET')) {
      return jsonResponse(existingScore ? [{ id: '44444444-4444-4444-8444-444444444444', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 30 }] : []);
    }
    if (url.pathname === '/rest/v1/scores' && ['POST', 'PATCH', 'DELETE'].includes(init.method)) {
      writes.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return new Response(null, { status: init.method === 'POST' ? 201 : 204 });
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  };
  return { writes, restore: () => { globalThis.fetch = originalFetch; } };
}

test('activity score API rejects requests without an authenticated admin', async () => {
  const response = await onRequestPost({
    request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 }, false),
    env,
  });
  assert.equal(response.status, 401);
});

test('activity score API validates enrollment and saves through the service role', async () => {
  const mock = installSuccessfulFetch();
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal(mock.writes.length, 1);
    assert.equal(mock.writes[0].method, 'POST');
    assert.match(mock.writes[0].body.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual({
      activityId: mock.writes[0].body.activityId,
      studentNo: mock.writes[0].body.studentNo,
      score: mock.writes[0].body.score,
    }, { activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 });
  } finally {
    mock.restore();
  }
});

test('activity score API updates an existing score without creating a duplicate', async () => {
  const mock = installSuccessfulFetch({ existingScore: true });
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 45 }),
      env,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(mock.writes, [{ method: 'PATCH', body: { score: 45 } }]);
  } finally {
    mock.restore();
  }
});

test('activity score API deletes a cleared score by activity and student', async () => {
  const mock = installSuccessfulFetch();
  try {
    const response = await onRequestPost({
      request: request({ action: 'delete', activityId: ACTIVITY_ID, studentNo: '25-2900' }),
      env,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(mock.writes, [{ method: 'DELETE', body: null }]);
  } finally {
    mock.restore();
  }
});

test('activity score API preserves the same-day absence rule', async () => {
  const mock = installSuccessfulFetch({ absent: true });
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 }),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, 'absent');
    assert.equal(mock.writes.length, 0);
  } finally {
    mock.restore();
  }
});

test('activity score API rejects a blank score instead of converting it to zero', async () => {
  const mock = installSuccessfulFetch();
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: null }),
      env,
    });
    assert.equal(response.status, 422);
    assert.equal(mock.writes.length, 0);
  } finally {
    mock.restore();
  }
});
