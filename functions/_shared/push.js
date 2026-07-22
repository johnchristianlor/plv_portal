export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function envValue(env, ...names) {
  for (const name of names) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function bearerToken(request) {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0)
      ^ (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
  }
  return mismatch === 0;
}

export async function getAuthenticatedUser(request, env) {
  const token = bearerToken(request);
  const url = envValue(env, 'SUPABASE_URL').replace(/\/$/, '');
  const publishableKey = envValue(env, 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
  if (!token || !url || !publishableKey) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user && isUuid(user.id) ? user : null;
}

export async function supabaseServiceFetch(env, path, init = {}) {
  const url = envValue(env, 'SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('server_configuration');
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(init.headers || {}),
    },
  });
}

export async function sendOneSignalPush(env, subscriptionIds, message) {
  const appId = envValue(env, 'ONESIGNAL_APP_ID');
  const apiKey = envValue(env, 'ONESIGNAL_APP_API_KEY');
  if (!appId || !apiKey) throw new Error('server_configuration');
  const ids = [...new Set(subscriptionIds.filter(isUuid))].slice(0, 20000);
  if (!ids.length) return { delivered: false, reason: 'no_subscriptions' };

  const response = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      authorization: `Key ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      app_id: appId,
      target_channel: 'push',
      include_subscription_ids: ids,
      headings: { en: message.title.slice(0, 80) },
      contents: { en: message.body.slice(0, 180) },
      data: { type: message.type },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !isUuid(result.id)) {
    console.error('Push provider rejected a message.', response.status);
    throw new Error('push_delivery_failed');
  }
  return { delivered: true, recipients: ids.length };
}
