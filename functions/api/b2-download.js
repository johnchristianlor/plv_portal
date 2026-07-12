function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' }
    });
}

function envValue(env, ...names) {
    for (const name of names) {
        if (env[name]) return env[name];
    }
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

function getB2StorageApi(auth) {
    return (auth && auth.apiInfo && auth.apiInfo.storageApi) ? auth.apiInfo.storageApi : (auth || {});
}

function getB2ApiUrl(auth) {
    const storageApi = getB2StorageApi(auth);
    return storageApi.apiUrl || auth.apiUrl || '';
}

function getB2DownloadUrl(auth) {
    const storageApi = getB2StorageApi(auth);
    return storageApi.downloadUrl || auth.downloadUrl || '';
}

function getB2AuthToken(auth) {
    const storageApi = getB2StorageApi(auth);
    return auth.authorizationToken || storageApi.authorizationToken || '';
}
async function authorizeB2(env) {
    const keyId = envValue(env, 'B2_KEY_ID', 'B2_APPLICATION_KEY_ID');
    const appKey = envValue(env, 'B2_APPLICATION_KEY');
    if (!keyId || !appKey) throw new Error('Backblaze application key variables are missing.');

    const credentials = btoa(keyId + ':' + appKey);
    const response = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
        headers: { authorization: 'Basic ' + credentials }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error('Backblaze authorization failed: ' + body.slice(0, 160));
    }

    return response.json();
}

async function getSupabaseUser(env, accessToken) {
    const supabaseUrl = envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
    const supabaseAnonKey = envValue(env, 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    if (!supabaseUrl || !supabaseAnonKey) throw new Error('Supabase environment variables are missing.');

    const response = await fetch(supabaseUrl.replace(/\/$/, '') + '/auth/v1/user', {
        headers: { apikey: supabaseAnonKey, authorization: 'Bearer ' + accessToken }
    });

    if (!response.ok) return null;
    return response.json();
}

async function supabaseFetch(env, path, accessToken = '') {
    const supabaseUrl = envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
    const serviceRoleKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = envValue(env, 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    const apiKey = serviceRoleKey || anonKey;
    const bearer = serviceRoleKey || accessToken;
    if (!supabaseUrl || !apiKey) throw new Error('Supabase environment variables are missing.');

    return fetch(supabaseUrl + path, {
        headers: { apikey: apiKey, authorization: 'Bearer ' + bearer }
    });
}

async function findAdminProfile(env, accessToken, authUser) {
    const checks = [
        ['uid', authUser.id],
        ['id', authUser.id],
        ['email', authUser.email]
    ].filter(([, value]) => !!value);

    for (const [field, value] of checks) {
        const url = new URL('https://local/rest/v1/users');
        url.searchParams.set('select', 'id,uid,email,role,status');
        url.searchParams.set(field, 'eq.' + value);
        url.searchParams.set('role', 'eq.admin');
        url.searchParams.set('limit', '1');
        const response = await supabaseFetch(env, url.pathname + url.search, accessToken);
        if (!response.ok) continue;
        const rows = await response.json();
        const admin = (rows || []).find(row => row.role === 'admin');
        if (admin) return admin;
    }

    return null;
}

async function isAdminRequest(request, env) {
    const token = getBearerToken(request);
    if (!token) return false;
    const authUser = await getSupabaseUser(env, token);
    if (!authUser || !authUser.id) return false;
    const profile = await findAdminProfile(env, token, authUser);
    return !!profile && String(profile.status || '').toLowerCase() !== 'inactive';
}

async function getSharedFile(env, fileId) {
    if (!fileId) throw new Error('File id is required.');
    const url = new URL('https://local/rest/v1/sharedFiles');
    url.searchParams.set('select', '*');
    url.searchParams.set('id', 'eq.' + fileId);
    url.searchParams.set('limit', '1');

    const response = await supabaseFetch(env, url.pathname + url.search);
    if (!response.ok) throw new Error('Could not verify file access.');
    const rows = await response.json();
    const file = rows && rows[0];
    if (!file) throw new Error('File was not found.');
    return file;
}

function canStudentAccess(file, studentNo) {
    const recipient = String(file.recipientStudentNo || '').trim();
    const student = String(studentNo || '').trim();
    return !!student && (recipient === 'all' || recipient === student);
}

async function createDownloadUrl(env, b2FileName) {
    const bucketId = envValue(env, 'B2_BUCKET_ID');
    const bucketName = envValue(env, 'B2_BUCKET_NAME');
    if (!bucketId) throw new Error('B2_BUCKET_ID is missing.');
    if (!bucketName) throw new Error('B2_BUCKET_NAME is missing.');
    if (!b2FileName) throw new Error('Backblaze file name is missing.');

    const auth = await authorizeB2(env);
    const validDurationInSeconds = Number(envValue(env, 'B2_DOWNLOAD_URL_SECONDS')) || 3600;
    const apiUrl = getB2ApiUrl(auth);
    const downloadUrl = getB2DownloadUrl(auth);
    const authorizationToken = getB2AuthToken(auth);
    if (!apiUrl || !downloadUrl || !authorizationToken) throw new Error('Backblaze authorization response is missing the API URL, download URL, or token.');

    const response = await fetch(apiUrl + '/b2api/v3/b2_get_download_authorization', {
        method: 'POST',
        headers: {
            authorization: authorizationToken,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ bucketId, fileNamePrefix: b2FileName, validDurationInSeconds })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error('Could not create private download link: ' + body.slice(0, 160));
    }

    const data = await response.json();
    return downloadUrl.replace(/\/$/, '') + '/file/' + encodeURIComponent(bucketName) + '/' + encodeB2FileName(b2FileName) + '?Authorization=' + encodeURIComponent(data.authorizationToken);
}

export async function onRequestOptions() {
    return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
    try {
        const body = await context.request.json();
        const file = await getSharedFile(context.env, body.fileId);
        const admin = await isAdminRequest(context.request, context.env);

        if (!admin && !canStudentAccess(file, body.studentNo)) {
            return json({ error: 'You do not have access to this file.' }, 403);
        }

        if (file.storage === 'backblaze-private' || file.b2FileName) {
            const url = await createDownloadUrl(context.env, file.b2FileName);
            return json({ url, expiresInSeconds: Number(envValue(context.env, 'B2_DOWNLOAD_URL_SECONDS')) || 3600 });
        }

        if (file.fileUrl) return json({ url: file.fileUrl, expiresInSeconds: 0 });
        return json({ error: 'This file has no downloadable location.' }, 404);
    } catch (error) {
        console.error(error);
        return json({ error: error.message || 'Could not open file.' }, 500);
    }
}

