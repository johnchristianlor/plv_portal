import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequestGet, onRequestOptions, onRequestPost } from '../functions/api/admin/activity-score.js';

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

test('activity score API exposes a safe deployment version on preflight', () => {
  const response = onRequestOptions();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('x-plv-score-api-version'), '2026-09-03.5');
});

function installSuccessfulFetch({ absent = false, existingScore = false, generatedIdRequired = false, writeError = null, rpcAvailable = false } = {}) {
  const writes = [];
  const rpcWrites = [];
  const serviceHeaders = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: AUTH_ID, email: 'admin@example.edu' });
    if (url.pathname.startsWith('/rest/v1/')) serviceHeaders.push(new Headers(init.headers));
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
    if (url.pathname === '/rest/v1/rpc/plv_write_activity_score') {
      const body = JSON.parse(init.body);
      rpcWrites.push(body);
      if (!rpcAvailable) return jsonResponse({ code: 'PGRST202', message: 'Function not found' }, 404);
      if (body.p_action === 'probe') return jsonResponse({ code: '22023', message: 'Invalid activity score request.' }, 400);
      return jsonResponse(body.p_action === 'delete'
        ? { deleted: true }
        : { id: '55555555-5555-4555-8555-555555555555', activityId: body.p_activity_id, studentNo: body.p_student_no, score: body.p_score });
    }
    if (url.pathname === '/rest/v1/scores' && (!init.method || init.method === 'GET')) {
      return jsonResponse(existingScore ? [{ id: '44444444-4444-4444-8444-444444444444', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 30 }] : []);
    }
    if (url.pathname === '/rest/v1/scores' && ['POST', 'PATCH', 'DELETE'].includes(init.method)) {
      const body = init.body ? JSON.parse(init.body) : null;
      writes.push({ method: init.method, body });
      if (init.method === 'POST' && writeError) return jsonResponse(writeError, 400);
      if (init.method === 'POST' && generatedIdRequired && !body.id) {
        return jsonResponse({ code: '23502', message: 'null value in column "id" violates not-null constraint' }, 400);
      }
      if (init.method === 'POST') {
        return jsonResponse([{ id: body.id || '55555555-5555-4555-8555-555555555555', ...body }], 201);
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init.method || 'GET'} ${url.pathname}`);
  };
  return { writes, rpcWrites, serviceHeaders, restore: () => { globalThis.fetch = originalFetch; } };
}

test('activity score health probe verifies the server can execute the installed writer without changing data', async () => {
  const mock = installSuccessfulFetch({ rpcAvailable: true });
  try {
    const response = await onRequestGet({ env });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ready: true, version: '2026-09-03.5' });
    assert.equal(mock.writes.length, 0);
    assert.equal(mock.rpcWrites[0].p_action, 'probe');
  } finally {
    mock.restore();
  }
});

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
    assert.equal(Object.hasOwn(mock.writes[0].body, 'id'), false, 'the database should normally generate the score id');
    assert.equal(Number.isNaN(Date.parse(mock.writes[0].body.createdAt)), false, 'new scores must include the live table timestamp');
    assert.deepEqual({
      activityId: mock.writes[0].body.activityId,
      studentNo: mock.writes[0].body.studentNo,
      score: mock.writes[0].body.score,
    }, { activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 });
  } finally {
    mock.restore();
  }
});

test('activity score API prefers the atomic server-only database function when installed', async () => {
  const mock = installSuccessfulFetch({ rpcAvailable: true });
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 }),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.saved, true);
    assert.deepEqual(mock.rpcWrites, [{
      p_action: 'save',
      p_activity_id: ACTIVITY_ID,
      p_student_no: '25-2900',
      p_score: 40,
    }]);
    assert.equal(mock.writes.length, 0, 'the direct table fallback must not run when the RPC succeeds');
  } finally {
    mock.restore();
  }
});

test('activity score API supports modern Supabase secret keys without using them as bearer JWTs', async () => {
  const mock = installSuccessfulFetch();
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 }),
      env: {
        ...env,
        SUPABASE_SECRET_KEY: 'sb_secret_server-only-test-key',
      },
    });
    assert.equal(response.status, 200);
    assert.ok(mock.serviceHeaders.length > 0);
    mock.serviceHeaders.forEach(headers => {
      assert.equal(headers.get('apikey'), 'sb_secret_server-only-test-key');
      assert.equal(headers.has('authorization'), false, 'opaque secret keys are API keys, not bearer JWTs');
    });
  } finally {
    mock.restore();
  }
});

test('activity score API falls back to an explicit UUID for older score tables without an id default', async () => {
  const mock = installSuccessfulFetch({ generatedIdRequired: true });
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 40 }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal(mock.writes.length, 2);
    assert.equal(Object.hasOwn(mock.writes[0].body, 'id'), false);
    assert.match(mock.writes[1].body.id, /^[0-9a-f-]{36}$/i);
  } finally {
    mock.restore();
  }
});

test('activity score API identifies an integer-only score column instead of returning a generic failure', async () => {
  const mock = installSuccessfulFetch({
    writeError: { code: '22P02', message: 'invalid input syntax for type bigint in score' },
  });
  try {
    const response = await onRequestPost({
      request: request({ action: 'save', activityId: ACTIVITY_ID, studentNo: '25-2900', score: 9.5 }),
      env,
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.code, 'precision');
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
