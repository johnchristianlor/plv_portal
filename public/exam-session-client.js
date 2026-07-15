export function createAssessmentApiClient({ supabase, user, basePath = '/api/assessments/' }) {
  let refreshPromise = null;

  async function authHeaders(forceRefresh = false) {
    if (forceRefresh && !refreshPromise) {
      refreshPromise = supabase.auth.refreshSession().catch(() => ({ data: { session: null } })).finally(() => { refreshPromise = null; });
    }
    if (refreshPromise) await refreshPromise;
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token || '';
    if (accessToken) return { authorization: `Bearer ${accessToken}` };
    const sessionToken = user?.activeSessionToken || user?.sessionToken || '';
    return {
      'x-student-no': user?.studentNo || user?.student_no || '',
      'x-student-session': sessionToken
    };
  }

  async function request(path, options = {}, mayRetry = true) {
    const response = await fetch(basePath + path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(await authHeaders(false)),
        ...(options.headers || {})
      },
      cache: 'no-store'
    });
    if (response.status === 401 && mayRetry) {
      await authHeaders(true);
      return request(path, options, false);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Assessment request failed.');
      error.code = data.code || '';
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function keepalive(path, payload) {
    const headers = await authHeaders(false);
    return fetch(basePath + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload || {}),
      keepalive: true,
      cache: 'no-store'
    }).catch(() => null);
  }

  return { request, keepalive, authHeaders };
}
