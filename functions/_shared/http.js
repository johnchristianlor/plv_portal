export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()',
  'cache-control': 'no-store'
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders }
  });
}

export function errorResponse(status, code, message = 'Request failed.') {
  return json({ error: { code, message } }, status);
}

export function methodNotAllowed() { return errorResponse(405, 'method_not_allowed', 'Method not allowed.'); }

export async function readJson(request, maxBytes = 256 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw Object.assign(new Error('Payload is too large.'), { status: 413, code: 'payload_too_large' });
  try { return await request.json(); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400, code: 'invalid_json' }); }
}

export function routePath(context) {
  const value = context.params && context.params.path;
  if (Array.isArray(value)) return value.join('/');
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

export function envValue(env, ...names) {
  for (const name of names) if (env && env[name]) return env[name];
  return '';
}

export function safeError(error) {
  const status = Number(error && error.status) || 500;
  const code = String((error && error.code) || (status === 500 ? 'server_error' : 'request_error'));
  const message = status === 500 ? 'Something went wrong. Please try again.' : String(error.message || 'Request failed.');
  return errorResponse(status, code, message);
}
