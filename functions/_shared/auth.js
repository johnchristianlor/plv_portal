import { envValue } from './http.js';

const jwksCache = new Map();

function b64urlToBytes(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function decodeJson(input) { return JSON.parse(new TextDecoder().decode(b64urlToBytes(input))); }
function bearer(request) { const m = String(request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : ''; }
async function getJwks(env) {
  const supabaseUrl = envValue(env, 'SUPABASE_URL').replace(/\/$/, '');
  if (!supabaseUrl) throw Object.assign(new Error('Server authentication is not configured.'), { status: 500, code: 'auth_not_configured' });
  const cached = jwksCache.get(supabaseUrl);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const res = await fetch(supabaseUrl + '/auth/v1/.well-known/jwks.json');
  if (!res.ok) throw Object.assign(new Error('Could not verify session.'), { status: 401, code: 'jwks_unavailable' });
  const body = await res.json();
  jwksCache.set(supabaseUrl, { keys: body.keys || [], expires: Date.now() + 600000 });
  return body.keys || [];
}
async function importJwk(jwk) {
  if (jwk.kty === 'RSA') return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (jwk.kty === 'EC') return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: jwk.crv || 'P-256' }, false, ['verify']);
  throw Object.assign(new Error('Unsupported session key.'), { status: 401, code: 'jwt_unsupported_key' });
}
async function verify(jwk, signingInput, signature) {
  const key = await importJwk(jwk);
  if (jwk.kty === 'RSA') return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(signingInput));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(signingInput));
}
export async function verifySupabaseJwt(request, env) {
  const token = bearer(request);
  if (!token) throw Object.assign(new Error('Sign in is required.'), { status: 401, code: 'missing_token' });
  const parts = token.split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Invalid session.'), { status: 401, code: 'malformed_token' });
  let header, payload;
  try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { throw Object.assign(new Error('Invalid session.'), { status: 401, code: 'malformed_token' }); }
  if (!header.kid) throw Object.assign(new Error('Invalid session.'), { status: 401, code: 'missing_kid' });
  const jwk = (await getJwks(env)).find(k => k.kid === header.kid);
  if (!jwk) throw Object.assign(new Error('Invalid session.'), { status: 401, code: 'unknown_kid' });
  if (!(await verify(jwk, parts[0] + '.' + parts[1], b64urlToBytes(parts[2])))) throw Object.assign(new Error('Invalid session.'), { status: 401, code: 'bad_signature' });
  const now = Math.floor(Date.now() / 1000);
  if (!payload.sub || (payload.exp && payload.exp <= now)) throw Object.assign(new Error('Session expired.'), { status: 401, code: 'jwt_expired' });
  const expectedIss = envValue(env, 'SUPABASE_URL').replace(/\/$/, '') + '/auth/v1';
  if (payload.iss !== expectedIss) throw Object.assign(new Error('Invalid session issuer.'), { status: 401, code: 'bad_issuer' });
  if (payload.aud !== 'authenticated') throw Object.assign(new Error('Invalid session audience.'), { status: 401, code: 'bad_audience' });
  return { token, payload, userId: payload.sub, role: payload.app_metadata?.role || payload.app_metadata?.portal_role || '' };
}
export async function requireRole(request, env, roles) {
  const auth = await verifySupabaseJwt(request, env);
  if (!roles.includes(auth.role)) throw Object.assign(new Error('You do not have access to this resource.'), { status: 403, code: 'forbidden' });
  return auth;
}
export async function requireAdmin(request, env) { return requireRole(request, env, ['admin']); }
export async function requireStudent(request, env) { return requireRole(request, env, ['student']); }
