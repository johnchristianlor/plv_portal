import { supabase } from './supabase-adapter.js';

export async function requireSession(role) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('Please sign in again.');
  const actual = data.session.user?.app_metadata?.role || data.session.user?.app_metadata?.portal_role || '';
  if (role && actual !== role) throw new Error('This page is not available for your account.');
  return data.session;
}

export async function api(path, options = {}) {
  const session = await requireSession(options.role);
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + session.access_token,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error || 'Request failed.');
  return data;
}

export function text(el, value) { if (el) el.textContent = value == null ? '' : String(value); }
export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
export function option(value, label) { const o=document.createElement('option'); o.value=value || ''; o.textContent=label || value || ''; return o; }
export function fmtDate(value) { if (!value) return 'Not scheduled'; try { return new Date(value).toLocaleString(); } catch { return value; } }
export function uid() { return crypto.randomUUID(); }
