import {
  getAuthenticatedUser,
  isUuid,
  json,
  supabaseServiceFetch,
} from '../../_shared/push.js';

const ACTIONS = new Set(['register', 'preferences', 'unregister']);

export async function onRequestPost({ request, env }) {
  try {
    const user = await getAuthenticatedUser(request, env);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4096) return json({ error: 'Request is too large.' }, 413);
    const body = await request.json().catch(() => null);
    const action = String(body?.action || '');
    const subscriptionId = String(body?.subscriptionId || '');
    if (!ACTIONS.has(action) || !isUuid(subscriptionId)) {
      return json({ error: 'Invalid notification registration.' }, 422);
    }

    const match = `subscription_id=eq.${encodeURIComponent(subscriptionId)}`;
    if (action === 'unregister') {
      const response = await supabaseServiceFetch(env, `/rest/v1/push_subscriptions?${match}&user_id=eq.${user.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('registration_failed');
      return new Response(null, { status: 204 });
    }

    const announcements = body.announcements !== false;
    const academicResults = body.academicResults !== false;
    if (action === 'preferences') {
      const response = await supabaseServiceFetch(env, `/rest/v1/push_subscriptions?${match}&user_id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          announcements,
          academic_results: academicResults,
          enabled: announcements || academicResults,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!response.ok) throw new Error('registration_failed');
      return new Response(null, { status: 204 });
    }

    const response = await supabaseServiceFetch(env, '/rest/v1/push_subscriptions?on_conflict=subscription_id', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        subscription_id: subscriptionId,
        user_id: user.id,
        announcements,
        academic_results: academicResults,
        enabled: announcements || academicResults,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error('registration_failed');
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('Push registration failed.', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'Phone notifications are temporarily unavailable.' }, 503);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
