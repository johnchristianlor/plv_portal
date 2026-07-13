import { envValue } from './http.js';

export async function supabaseRest(env, path, options = {}) {
  const url = envValue(env, 'SUPABASE_URL').replace(/\/$/, '');
  const service = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !service) throw Object.assign(new Error('Supabase server credentials are not configured.'), { status: 500, code: 'supabase_not_configured' });
  const headers = { apikey: service, authorization: 'Bearer ' + service, 'content-type': 'application/json', ...(options.headers || {}) };
  return fetch(url + path, { ...options, headers });
}

export async function getProfile(env, userId) {
  const res = await supabaseRest(env, '/rest/v1/profiles?select=*&id=eq.' + encodeURIComponent(userId) + '&limit=1');
  if (res.ok) { const found = await res.json(); if (found && found[0]) return found[0]; }
  const legacy = await supabaseRest(env, '/rest/v1/users?select=*&or=(uid.eq.' + encodeURIComponent(userId) + ',id.eq.' + encodeURIComponent(userId) + ')&limit=1');
  if (!legacy.ok) return null;
  const rows = await legacy.json();
  return rows && rows[0] ? rows[0] : null;
}

export async function listSectionsAndSubjects(env) {
  const [sectionsRes, subjectsRes] = await Promise.all([
    supabaseRest(env, '/rest/v1/sections?select=*&order=sectionName.asc'),
    supabaseRest(env, '/rest/v1/subjects?select=*&order=subjectCode.asc')
  ]);
  return { sections: sectionsRes.ok ? await sectionsRes.json() : [], subjects: subjectsRes.ok ? await subjectsRes.json() : [] };
}

export async function syncAssessmentScore(env, summary) {
  const res = await supabaseRest(env, '/rest/v1/assessment_score_summaries', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(summary)
  });
  return res.ok;
}
