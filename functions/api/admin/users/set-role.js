import { json, readJson, safeError, envValue } from '../../../_shared/http.js';
import { requireAdmin } from '../../../_shared/auth.js';

export async function onRequestPost(context) {
  try {
    await requireAdmin(context.request, context.env);
    const body = await readJson(context.request, 32 * 1024);
    const userId = String(body.userId || '').trim();
    const role = String(body.role || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(userId) || !['admin','student'].includes(role)) return json({ error: 'Invalid user or role.' }, 422);
    const url = envValue(context.env, 'SUPABASE_URL').replace(/\/$/, '');
    const service = envValue(context.env, 'SUPABASE_SERVICE_ROLE_KEY');
    const res = await fetch(url + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      method: 'PATCH',
      headers: { apikey: service, authorization: 'Bearer ' + service, 'content-type': 'application/json' },
      body: JSON.stringify({ app_metadata: { role } })
    });
    if (!res.ok) return json({ error: 'Could not update role.' }, 500);
    return json({ ok: true });
  } catch (error) { return safeError(error); }
}

