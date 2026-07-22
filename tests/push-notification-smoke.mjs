import assert from 'node:assert/strict';

import { onRequestPost as registerDevice } from '../functions/api/push/register.js';
import { onRequestPost as handleDatabaseEvent } from '../functions/api/push/database-event.js';

const userId = '37f2dcb7-7b36-4a20-a94c-7f66a81bfb85';
const subscriptionId = 'a29a864c-4fa4-4fbc-a6c6-4a1bc78c53d2';
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'server-test-key',
  ONESIGNAL_APP_ID: '8583c179-f2ba-4da6-b73f-f2ab13fa31dc',
  ONESIGNAL_APP_API_KEY: 'private-test-key',
  PUSH_WEBHOOK_SECRET: 'long-random-webhook-test-secret',
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).endsWith('/auth/v1/user')) {
    return Response.json({ id: userId, email: 'student@example.invalid' });
  }
  if (String(url).includes('/rest/v1/push_subscriptions') && init.method === 'POST') {
    return new Response(null, { status: 201 });
  }
  if (String(url).includes('/rest/v1/push_subscriptions')) {
    return Response.json([{ subscription_id: subscriptionId }]);
  }
  if (String(url) === 'https://api.onesignal.com/notifications') {
    return Response.json({ id: '9bb36922-9e34-421e-b046-047b368147fb' });
  }
  throw new Error(`Unexpected test request: ${url}`);
};

const registration = await registerDevice({
  env,
  request: new Request('https://portal.example/api/push/register', {
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-user-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'register', subscriptionId }),
  }),
});
assert.equal(registration.status, 204);
const registrationWrite = calls.find((call) => call.init.method === 'POST' && call.url.includes('push_subscriptions'));
assert.ok(registrationWrite, 'device registration must be written server-side');
assert.equal(JSON.parse(registrationWrite.init.body).user_id, userId);

const unauthorized = await registerDevice({
  env,
  request: new Request('https://portal.example/api/push/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'register', subscriptionId }),
  }),
});
assert.equal(unauthorized.status, 401);

const beforeWebhook = calls.length;
const webhook = await handleDatabaseEvent({
  env,
  request: new Request('https://portal.example/api/push/database-event', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.PUSH_WEBHOOK_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'INSERT',
      table: 'announcements',
      schema: 'public',
      record: { title: 'Portal update', message: 'A new announcement is ready.' },
      old_record: null,
    }),
  }),
});
assert.equal(webhook.status, 200);
const pushCall = calls.slice(beforeWebhook).find((call) => call.url === 'https://api.onesignal.com/notifications');
assert.ok(pushCall, 'announcement webhook must call the push provider');
const pushBody = JSON.parse(pushCall.init.body);
assert.deepEqual(pushBody.include_subscription_ids, [subscriptionId]);
assert.equal(pushBody.include_aliases, undefined);
assert.equal(JSON.stringify(pushBody).includes(userId), false, 'push payload must not expose the account id');

const rejectedWebhook = await handleDatabaseEvent({
  env,
  request: new Request('https://portal.example/api/push/database-event', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'INSERT', table: 'announcements', schema: 'public', record: {} }),
  }),
});
assert.equal(rejectedWebhook.status, 401);

console.log('Push notification security smoke tests passed.');
