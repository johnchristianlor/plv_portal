import assert from 'node:assert/strict';

import { onRequestPost as studentLogin } from '../functions/api/auth/student-login.js';

const authUserId = '37f2dcb7-7b36-4a20-a94c-7f66a81bfb85';
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'server-test-key',
};

globalThis.fetch = async (url, init = {}) => {
  const value = String(url);
  if (value.includes('/rest/v1/users')) {
    return Response.json([{
      id: authUserId,
      uid: authUserId,
      studentNo: 'TEST001',
      email: 'student@example.invalid',
      fullName: 'Test Student',
      role: 'student',
      status: 'Active',
      section: 'TEST SECTION',
    }]);
  }
  if (value.includes('/auth/v1/token')) {
    const credentials = JSON.parse(init.body);
    assert.equal(credentials.email, 'student@example.invalid');
    assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    return Response.json({
      access_token: 'signed-access-token',
      refresh_token: 'rotating-refresh-token',
      user: { id: authUserId, email: credentials.email },
    });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const response = await studentLogin({
  env,
  request: new Request('https://portal.example/api/auth/student-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'TEST001', password: 'valid-password' }),
  }),
});
assert.equal(response.status, 200);
const payload = await response.json();
assert.equal(payload.profile.studentNo, 'TEST001');
assert.equal(payload.profile.uid, authUserId);
assert.equal(payload.profile.role, 'student');
assert.equal(payload.profile.password, undefined);
assert.equal(payload.accessToken, 'signed-access-token');

const malformed = await studentLogin({
  env,
  request: new Request('https://portal.example/api/auth/student-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'bad,filter()', password: 'valid-password' }),
  }),
});
assert.equal(malformed.status, 401);
assert.deepEqual(await malformed.json(), { error: 'Invalid account ID or password.' });

console.log('Student number login security smoke tests passed.');
