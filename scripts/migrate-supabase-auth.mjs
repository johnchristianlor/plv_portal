import process from 'node:process';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your shell. Do not commit them.');
  process.exit(1);
}

async function supabase(path, options = {}) {
  const res = await fetch(SUPABASE_URL.replace(/\/$/, '') + path, {
    ...options,
    headers: { apikey: SERVICE_ROLE, authorization: 'Bearer ' + SERVICE_ROLE, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error('Supabase request failed: ' + res.status + ' ' + await res.text());
  return res.json().catch(() => null);
}

const legacy = await supabase('/rest/v1/users?select=*&role=eq.student');
for (const row of legacy || []) {
  if (!row.email || !row.password) { console.warn('Skipped user missing email or temporary password:', row.studentNo || row.id); continue; }
  const created = await supabase('/auth/v1/admin/users', { method:'POST', body: JSON.stringify({ email: row.email, password: row.password, email_confirm: true, app_metadata: { role: 'student' }, user_metadata: { student_no: row.studentNo } }) });
  await supabase('/rest/v1/profiles', { method:'POST', headers:{prefer:'resolution=merge-duplicates'}, body: JSON.stringify({ id: created.id, student_no: row.studentNo, email: row.email, full_name: row.fullName || row.studentName || row.name, role:'student', section: row.section, status: row.status || 'active', must_change_password: true }) });
  console.log('Migrated student account:', row.studentNo || row.email);
}
console.log('Done. Verify profiles, then apply the migration that drops users.password.');
