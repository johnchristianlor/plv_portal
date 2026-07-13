import { json, readJson, safeError, envValue } from '../../_shared/http.js';
import { supabaseRest } from '../../_shared/supabase.js';

async function findLoginEmail(env, identifier) {
  const value = String(identifier || '').trim();
  if (!value || value.length > 120) return '';
  if (value.includes('@')) return value;
  const res = await supabaseRest(env, '/rest/v1/profiles?select=id,email,student_no,role,status&student_no=eq.' + encodeURIComponent(value) + '&role=eq.student&limit=1');
  if (!res.ok) return '';
  const rows = await res.json();
  const profile = rows && rows[0];
  if (!profile || String(profile.status || 'active').toLowerCase() === 'inactive') return '';
  return profile.email || '';
}

export async function onRequestOptions() { return new Response(null, { status: 204 }); }

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request, 32 * 1024);
    const email = await findLoginEmail(context.env, body.identifier || body.studentNo || body.email);
    const password = String(body.password || '');
    if (!email || !password || password.length > 256) return json({ error: 'Invalid username or password.' }, 401);
    const url = envValue(context.env, 'SUPABASE_URL').replace(/\/$/, '');
    const publishable = envValue(context.env, 'SUPABASE_PUBLISHABLE_KEY');
    const res = await fetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: publishable, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) return json({ error: 'Invalid username or password.' }, 401);
    const session = await res.json();
    return json({ session });
  } catch (error) { return safeError(error); }
}

