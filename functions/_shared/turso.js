import { createClient } from '@libsql/client/web';
import { envValue } from './http.js';

export function turso(env) {
  const url = envValue(env, 'TURSO_DATABASE_URL');
  const authToken = envValue(env, 'TURSO_AUTH_TOKEN');
  if (!url || !authToken) throw Object.assign(new Error('Turso database is not configured.'), { status: 500, code: 'turso_not_configured' });
  return createClient({ url, authToken });
}

export function uuid() { return crypto.randomUUID(); }
export function rows(result) { return Array.from(result.rows || []); }

export async function audit(db, actorId, role, action, entityType, entityId, details = {}) {
  await db.execute({
    sql: "insert into assessment_audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, details_json, created_at) values (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    args: [uuid(), actorId, role, action, entityType, entityId, JSON.stringify(details).slice(0, 4000)]
  });
}
