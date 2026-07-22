import {
  envValue,
  json,
  supabaseServiceFetch,
} from '../../_shared/push.js';

const STUDENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,49}$/i;

function publicProfile(profile, authUser) {
  return {
    uid: authUser.id,
    studentNo: profile.studentNo || profile.student_no || profile.username || '',
    username: profile.username || profile.studentNo || profile.student_no || '',
    email: profile.email || authUser.email || '',
    fullName: profile.fullName || profile.name || 'PLV Student',
    courseYear: profile.courseYear || profile.course_year || profile.course || '',
    course: profile.course || profile.program || '',
    year: profile.year || profile.yearLevel || profile.year_level || '',
    section: profile.section || 'Unassigned',
    schoolYear: profile.schoolYear || profile.school_year || '',
    status: profile.status || 'Active',
    avatarUrl: profile.avatarUrl || profile.avatar_url || '',
    role: 'student',
  };
}

async function findStudentProfile(env, identifier) {
  for (const field of ['studentNo', 'username']) {
    const query = new URLSearchParams({
      select: '*',
      [field]: `eq.${identifier}`,
      limit: '2',
    });
    const response = await supabaseServiceFetch(env, `/rest/v1/users?${query}`);
    if (!response.ok) throw new Error('profile_lookup_failed');
    const rows = await response.json();
    const profile = rows.find((row) => String(row.role || '').toLowerCase() === 'student');
    if (profile) return profile;
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4096) return json({ error: 'Invalid login request.' }, 413);

    const body = await request.json().catch(() => null);
    const identifier = String(body?.identifier || '').trim();
    const password = String(body?.password || '');
    if (!STUDENT_ID_PATTERN.test(identifier) || password.length < 8 || password.length > 128) {
      return json({ error: 'Invalid account ID or password.' }, 401);
    }

    const supabaseUrl = envValue(env, 'SUPABASE_URL').replace(/\/$/, '');
    const publishableKey = envValue(env, 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
    if (!supabaseUrl || !publishableKey) throw new Error('server_configuration');

    const profile = await findStudentProfile(env, identifier);
    const profileEmail = String(profile?.email || '').trim().toLowerCase();
    const loginEmail = /^\S+@\S+\.\S+$/.test(profileEmail)
      ? profileEmail
      : `invalid-${crypto.randomUUID()}@invalid.local`;

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: loginEmail, password }),
    });
    const authData = await authResponse.json().catch(() => ({}));
    const authUser = authData.user;
    if (!profile || !authResponse.ok || !authUser?.id || !authData.access_token || !authData.refresh_token) {
      return json({ error: 'Invalid account ID or password.' }, 401);
    }

    const isActive = String(profile.status || 'Active').toLowerCase() !== 'inactive';
    const linkedIds = [profile.uid, profile.id].filter(Boolean).map(String);
    const emailMatches = profileEmail && profileEmail === String(authUser.email || '').toLowerCase();
    if (!isActive || (!linkedIds.includes(String(authUser.id)) && !emailMatches)) {
      return json({ error: 'Invalid account ID or password.' }, 401);
    }

    return json({
      accessToken: authData.access_token,
      refreshToken: authData.refresh_token,
      profile: publicProfile(profile, authUser),
    });
  } catch (error) {
    console.error('Student number login failed.', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'Login is temporarily unavailable.' }, 503);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
