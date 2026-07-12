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
function avatarKeyFromValue(value) {
    const raw = String(value || '').trim();
    if (!raw.startsWith('b2:')) throw new Error('Avatar is not stored in Backblaze.');
    return raw.slice(3);
}
function assertB2Allowed(auth, bucketId, objectName) {
    const allowed = getB2Allowed(auth);
    const buckets = Array.isArray(allowed.buckets) ? allowed.buckets : [];
    const allowedPrefix = String(allowed.namePrefix || '');
    if (bucketId && buckets.length && !buckets.some(bucket => bucket.id === bucketId || bucket.bucketId === bucketId)) throw new Error('Backblaze key cannot use this bucket.');
    if (allowedPrefix && !objectName.startsWith(allowedPrefix)) throw new Error('Backblaze key prefix does not allow this avatar path.');
}
async function getUploadUrl(env, auth) {
    const bucketId = envValue(env, 'B2_BUCKET_ID');
    if (!bucketId) throw new Error('B2_BUCKET_ID is missing.');
    const apiUrl = getB2ApiUrl(auth);
    const authorizationToken = getB2AuthToken(auth);
    if (!apiUrl || !authorizationToken) throw new Error('Backblaze authorization response is missing the API URL or token.');
    const response = await fetch(apiUrl + '/b2api/v4/b2_get_upload_url', {
        method: 'POST',
        headers: { authorization: authorizationToken, 'content-type': 'application/json' },
        body: JSON.stringify({ bucketId })
    });
    if (!response.ok) throw new Error('Could not get Backblaze upload URL: ' + (await response.text()).slice(0, 160));
    return response.json();
}

export async function onRequestOptions() { return new Response(null, { status: 204 }); }

export async function onRequestPost(context) {
    try {
        const formData = await context.request.formData();
        const studentNo = String(formData.get('studentNo') || '').trim();
        const sessionToken = String(formData.get('sessionToken') || '').trim();
        const file = formData.get('file');
        if (!(await validateStudentSession(context.env, studentNo, sessionToken))) return json({ error: 'Student session is invalid or expired.' }, 401);
        if (!file || typeof file === 'string') return json({ error: 'No avatar image was uploaded.' }, 400);
        if (!ALLOWED_TYPES.has(file.type)) return json({ error: 'Avatar must be JPG, PNG, or WebP.' }, 400);
        if (file.size > MAX_AVATAR_BYTES) return json({ error: 'Avatar must be 1 MB or smaller after cropping.' }, 400);

        const auth = await authorizeB2(context.env);
        if (!hasB2Capability(auth, 'writeFiles')) throw new Error('Backblaze key needs writeFiles permission.');
        const upload = await getUploadUrl(context.env, auth);
        const buffer = await file.arrayBuffer();
        const checksum = await sha1Hex(buffer);
        const bucketId = envValue(context.env, 'B2_BUCKET_ID');
        const objectName = getBasePrefix(context.env, auth) + 'avatars/' + safeStudentNo(studentNo) + '/' + shortId() + '.jpg';
        assertB2Allowed(auth, bucketId, objectName);

        const response = await fetch(upload.uploadUrl, {
            method: 'POST',
            headers: {
                authorization: upload.authorizationToken,
                'x-bz-file-name': encodeB2FileName(objectName),
                'content-type': 'image/jpeg',
                'x-bz-content-sha1': checksum
            },
            body: buffer
        });
        if (!response.ok) throw new Error('Backblaze avatar upload failed: ' + (await response.text()).slice(0, 160));
        const uploaded = await response.json();
        return json({ avatarUrl: 'b2:' + (uploaded.fileName || objectName), storage: 'backblaze-private', bytes: file.size });
    } catch (error) {
        console.error(error);
        return json({ error: error.message || 'Avatar upload failed.' }, 500);
    }
}