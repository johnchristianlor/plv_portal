const MAX_AVATAR_BYTES = 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function envValue(env, ...names) {
    for (const name of names) if (env[name]) return env[name];
    return '';
}

function getBearerToken(request) {
    const auth = request.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function encodeB2FileName(fileName) {
    return encodeURIComponent(fileName).replace(/%2F/g, '/');
}

async function sha1Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-1', buffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function getB2StorageApi(auth) {
    return (auth && auth.apiInfo && auth.apiInfo.storageApi) ? auth.apiInfo.storageApi : (auth || {});
}
function getB2ApiUrl(auth) { const storageApi = getB2StorageApi(auth); return storageApi.apiUrl || auth.apiUrl || ''; }
function getB2DownloadUrl(auth) { const storageApi = getB2StorageApi(auth); return storageApi.downloadUrl || auth.downloadUrl || ''; }
function getB2AuthToken(auth) { const storageApi = getB2StorageApi(auth); return auth.authorizationToken || storageApi.authorizationToken || ''; }
function getB2Allowed(auth) { const storageApi = getB2StorageApi(auth); return storageApi.allowed || auth.allowed || {}; }
function hasB2Capability(auth, capability) {
    const capabilities = getB2Allowed(auth).capabilities || [];
    return capabilities.includes('all') || capabilities.includes(capability);
}
function normalizePrefix(prefix) {
    const cleaned = String(prefix || '').trim().replace(/^\/+/, '');
    return cleaned ? (cleaned.endsWith('/') ? cleaned : cleaned + '/') : '';
}
function getBasePrefix(env, auth) {
    const allowedPrefix = getB2Allowed(auth).namePrefix || '';
    return normalizePrefix(envValue(env, 'B2_AVATAR_PREFIX') || envValue(env, 'B2_FILE_PREFIX') || allowedPrefix || 'uploads/');
}
function safeStudentNo(value) {
    return String(value || 'student').replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'student';
}
function shortId() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function authorizeB2(env) {
    const keyId = envValue(env, 'B2_KEY_ID', 'B2_APPLICATION_KEY_ID');
    const appKey = envValue(env, 'B2_APPLICATION_KEY');
    if (!keyId || !appKey) throw new Error('Backblaze application key variables are missing.');
    const response = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
        headers: { authorization: 'Basic ' + btoa(keyId + ':' + appKey) }
    });
    if (!response.ok) throw new Error('Backblaze authorization failed: ' + (await response.text()).slice(0, 160));
    return response.json();
}
async function supabaseFetch(env, path, init = {}) {
    const supabaseUrl = envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
    const serviceRoleKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase service role variables are missing.');
    return fetch(supabaseUrl + path, {
        ...init,
        headers: { apikey: serviceRoleKey, authorization: 'Bearer ' + serviceRoleKey, ...(init.headers || {}) }
    });
}
async function validateStudentSession(env, studentNo, sessionToken) {
    if (!studentNo || !sessionToken) return false;
    const url = new URL('https://local/rest/v1/users');
    url.searchParams.set('select', 'id,studentNo,role,status,activeSessionToken');
    url.searchParams.set('studentNo', 'eq.' + studentNo);
    url.searchParams.set('role', 'eq.student');
    url.searchParams.set('limit', '1');
    const response = await supabaseFetch(env, url.pathname + url.search);
    if (!response.ok) return false;
    const rows = await response.json();
    const user = rows && rows[0];
    return !!user && String(user.status || '').toLowerCase() !== 'inactive' && user.activeSessionToken === sessionToken;
}
async function getSupabaseUser(env, accessToken) {
    const supabaseUrl = envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
    const anonKey = envValue(env, 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    if (!supabaseUrl || !anonKey || !accessToken) return null;
    const response = await fetch(supabaseUrl.replace(/\/$/, '') + '/auth/v1/user', {
        headers: { apikey: anonKey, authorization: 'Bearer ' + accessToken }
    });
    return response.ok ? response.json() : null;
}
async function isAdminRequest(request, env) {
    const token = getBearerToken(request);
    const authUser = await getSupabaseUser(env, token);
    if (!authUser || !authUser.id) return false;
    const url = new URL('https://local/rest/v1/users');
    url.searchParams.set('select', 'id,uid,email,role,status');
    url.searchParams.set('role', 'eq.admin');
    url.searchParams.set('limit', '1');
    const orFilter = 'uid.eq.' + authUser.id + ',id.eq.' + authUser.id + ',email.eq.' + (authUser.email || '');
    const response = await supabaseFetch(env, url.pathname + url.search + '&or=(' + encodeURIComponent(orFilter) + ')');
    if (!response.ok) return false;
    const rows = await response.json();
    const admin = rows && rows.find(row => row.role === 'admin');
    return !!admin && String(admin.status || '').toLowerCase() !== 'inactive';
}

async function getStudentProfileFromBearer(request, env) {
    const token = getBearerToken(request);
    const authUser = await getSupabaseUser(env, token);
    if (!authUser || !authUser.id) return null;
    const url = new URL('https://local/rest/v1/users');
    url.searchParams.set('select', 'id,uid,email,studentNo,username,role,status,avatarUrl');
    url.searchParams.set('role', 'eq.student');
    url.searchParams.set('limit', '1');
    const orFilter = 'uid.eq.' + authUser.id + ',id.eq.' + authUser.id + ',email.eq.' + (authUser.email || '');
    const response = await supabaseFetch(env, url.pathname + url.search + '&or=(' + encodeURIComponent(orFilter) + ')');
    if (!response.ok) return null;
    const rows = await response.json();
    const profile = rows && rows.find(row => row.role === 'student');
    return profile && String(profile.status || '').toLowerCase() !== 'inactive' ? profile : null;
}

function sameStudent(profile, studentNo) {
    const requested = String(studentNo || '').trim().toLowerCase();
    if (!requested) return true;
    return [profile.studentNo, profile.username, profile.id, profile.uid]
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .includes(requested);
}

function ownsAvatar(profile, avatarUrl) {
    const requested = String(avatarUrl || '').trim();
    if (!requested) return false;
    return [profile.avatarUrl]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .includes(requested);
}

async function isStudentBearerAvatarRequest(request, env, studentNo, avatarUrl) {
    const profile = await getStudentProfileFromBearer(request, env);
    return !!profile && sameStudent(profile, studentNo) && ownsAvatar(profile, avatarUrl);
}

async function validateStudentAvatarSession(env, studentNo, sessionToken, avatarUrl) {
    if (!studentNo || !sessionToken || !avatarUrl) return false;
    const url = new URL('https://local/rest/v1/users');
    url.searchParams.set('select', 'id,studentNo,username,role,status,activeSessionToken,avatarUrl');
    url.searchParams.set('studentNo', 'eq.' + studentNo);
    url.searchParams.set('role', 'eq.student');
    url.searchParams.set('limit', '1');
    const response = await supabaseFetch(env, url.pathname + url.search);
    if (!response.ok) return false;
    const rows = await response.json();
    const user = rows && rows[0];
    return !!user &&
        String(user.status || '').toLowerCase() !== 'inactive' &&
        user.activeSessionToken === sessionToken &&
        ownsAvatar(user, avatarUrl);
}
function avatarKeyFromValue(value) {
    const raw = String(value || '').trim();
    if (raw.startsWith('b2:')) return raw.slice(3);
    if (raw.startsWith('uploads/') || raw.startsWith('avatars/') || raw.startsWith('student-avatars/')) return raw;
    throw new Error('Avatar is not stored in Backblaze.');
}
function assertB2Allowed(auth, bucketId, objectName) {
    const allowed = getB2Allowed(auth);
    const buckets = Array.isArray(allowed.buckets) ? allowed.buckets : [];
    const allowedPrefix = String(allowed.namePrefix || '');
    if (bucketId && buckets.length && !buckets.some(bucket => bucket.id === bucketId || bucket.bucketId === bucketId)) throw new Error('Backblaze key cannot use this bucket.');
    if (allowedPrefix && !objectName.startsWith(allowedPrefix)) throw new Error('Backblaze key prefix does not allow this avatar path.');
}
async function createDownloadUrl(env, b2FileName) {
    const bucketId = envValue(env, 'B2_BUCKET_ID');
    const bucketName = envValue(env, 'B2_BUCKET_NAME');
    if (!bucketId) throw new Error('B2_BUCKET_ID is missing.');
    if (!bucketName) throw new Error('B2_BUCKET_NAME is missing.');
    const auth = await authorizeB2(env);
    if (!hasB2Capability(auth, 'shareFiles')) throw new Error('Backblaze key needs shareFiles permission.');
    assertB2Allowed(auth, bucketId, b2FileName);
    const apiUrl = getB2ApiUrl(auth);
    const downloadUrl = getB2DownloadUrl(auth);
    const authorizationToken = getB2AuthToken(auth);
    const validDurationInSeconds = Number(envValue(env, 'B2_AVATAR_URL_SECONDS')) || 900;
    const response = await fetch(apiUrl + '/b2api/v4/b2_get_download_authorization', {
        method: 'POST',
        headers: { authorization: authorizationToken, 'content-type': 'application/json' },
        body: JSON.stringify({ bucketId, fileNamePrefix: b2FileName, validDurationInSeconds })
    });
    if (!response.ok) throw new Error('Could not create avatar link: ' + (await response.text()).slice(0, 160));
    const data = await response.json();
    return downloadUrl.replace(/\/$/, '') + '/file/' + encodeURIComponent(bucketName) + '/' + encodeB2FileName(b2FileName) + '?Authorization=' + encodeURIComponent(data.authorizationToken);
}

export async function onRequestOptions() { return new Response(null, { status: 204 }); }

export async function onRequestPost(context) {
    try {
        const body = await context.request.json();
        const key = avatarKeyFromValue(body.avatarUrl);
        const admin = await isAdminRequest(context.request, context.env);
        const bearerStudent = await isStudentBearerAvatarRequest(context.request, context.env, body.studentNo, body.avatarUrl);
        const sessionStudent = await validateStudentAvatarSession(context.env, body.studentNo, body.sessionToken, body.avatarUrl);
        if (!admin && !bearerStudent && !sessionStudent) return json({ error: 'Avatar access is not allowed.' }, 403);
        const url = await createDownloadUrl(context.env, key);
        return json({ url, expiresInSeconds: Number(envValue(context.env, 'B2_AVATAR_URL_SECONDS')) || 900 });
    } catch (error) {
        console.error(error);
        return json({ error: error.message || 'Could not open avatar.' }, 500);
    }
}
