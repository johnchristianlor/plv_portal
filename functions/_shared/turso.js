import { envValue } from './http.js';

function normalizeDatabaseUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (value.startsWith('libsql://')) return `https://${value.slice('libsql://'.length)}`;
  if (value.startsWith('http://') || value.startsWith('https://')) return value.replace(/\/$/, '');
  return value;
}

function toHranaValue(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
    return { type: 'float', value };
  }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  return { type: 'text', value: String(value) };
}

function fromHranaValue(value) {
  if (!value || value.type === 'null') return null;
  if (value.type === 'integer') {
    const numberValue = Number(value.value);
    return Number.isSafeInteger(numberValue) ? numberValue : value.value;
  }
  if (value.type === 'float') return Number(value.value);
  if (value.type === 'text') return value.value || '';
  if (value.type === 'blob') return value.base64 || '';
  return value.value ?? null;
}

function statement(input) {
  if (typeof input === 'string') return { sql: input, args: [] };
  if (!input || typeof input.sql !== 'string') throw Object.assign(new Error('Invalid database statement.'), { status: 422, code: 'invalid_statement' });
  return { sql: input.sql, args: Array.isArray(input.args) ? input.args : [] };
}

function decodeExecuteResult(result) {
  const cols = Array.isArray(result?.cols) ? result.cols : [];
  const rawRows = Array.isArray(result?.rows) ? result.rows : [];
  const names = cols.map((col, index) => col?.name || `column_${index}`);
  const decodedRows = rawRows.map((row) => Object.fromEntries(row.map((cell, index) => [names[index], fromHranaValue(cell)])));
  return {
    rows: decodedRows,
    columns: names,
    rowsAffected: result?.affected_row_count || 0,
    lastInsertRowid: result?.last_insert_rowid || undefined
  };
}

export function turso(env) {
  const databaseUrl = normalizeDatabaseUrl(envValue(env, 'TURSO_DATABASE_URL'));
  const authToken = envValue(env, 'TURSO_AUTH_TOKEN');
  if (!databaseUrl || !authToken) throw Object.assign(new Error('Turso database is not configured.'), { status: 500, code: 'turso_not_configured' });

  async function request(statements) {
    const requests = statements.map((item) => {
      const stmt = statement(item);
      return {
        type: 'execute',
        stmt: {
          sql: stmt.sql,
          args: stmt.args.map(toHranaValue)
        }
      };
    });
    requests.push({ type: 'close' });

    const response = await fetch(`${databaseUrl}/v2/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requests })
    });

    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }

    if (!response.ok) {
      console.error('Turso HTTP request failed', { status: response.status, code: payload?.code });
      throw Object.assign(new Error('Database request failed.'), { status: 500, code: 'turso_request_failed' });
    }

    const results = Array.isArray(payload?.results) ? payload.results : [];
    const failed = results.find((item) => item?.type === 'error' || item?.error);
    if (failed) {
      console.error('Turso statement failed', { code: failed?.error?.code || failed?.code });
      throw Object.assign(new Error('Database query failed.'), { status: 500, code: 'turso_query_failed' });
    }

    return results
      .filter((item) => item?.response?.type !== 'close' && item?.type !== 'close')
      .map((item) => decodeExecuteResult(item?.response?.result || item?.result || {}));
  }

  return {
    async execute(input) {
      const [result] = await request([input]);
      return result || { rows: [], columns: [], rowsAffected: 0 };
    },
    async batch(inputs) {
      if (!Array.isArray(inputs)) throw Object.assign(new Error('Invalid database batch.'), { status: 422, code: 'invalid_batch' });
      return request(inputs);
    }
  };
}

export function uuid() { return crypto.randomUUID(); }
export function rows(result) { return Array.from(result?.rows || []); }

export async function audit(db, actorId, role, action, entityType, entityId, details = {}) {
  await db.execute({
    sql: "insert into assessment_audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, details_json, created_at) values (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    args: [uuid(), actorId, role, action, entityType, entityId, JSON.stringify(details).slice(0, 4000)]
  });
}
