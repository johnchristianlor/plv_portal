const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx']);

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

async function getSupabaseUser(env, accessToken) {
    const supabaseUrl = envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
    const supabaseAnonKey = envValue(env, 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error('Supabase environment variables are missing.');
    }

    const response = await fetch(supabaseUrl.replace(/\/$/, '') + '/auth/v1/user', {
        headers: {
            apikey: supabaseAnonKey,
            authorization: 'Bearer ' + accessToken
        }
    });

    if (!response.ok) return null;
    return response.json();
}

async function findAdminProfile(env, accessToken, authUser) {
    const supabaseUrl = envValue(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
    const supabaseAnonKey = envValue(env, 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    const serviceRoleKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const apiKey = serviceRoleKey || supabaseAnonKey;
    const dbBearer = serviceRoleKey || accessToken;

    const checks = [
        ['uid', authUser.id],
        ['id', authUser.id],
        ['email', authUser.email]
    ].filter(([, value]) => !!value);

    for (const [field, value] of checks) {
        const url = new URL(supabaseUrl + '/rest/v1/users');
        url.searchParams.set('select', 'id,uid,email,role,status');
        url.searchParams.set(field, 'eq.' + value);
        url.searchParams.set('role', 'eq.admin');
        url.searchParams.set('limit', '1');

        const response = await fetch(url.toString(), {
            headers: {
                apikey: apiKey,
                authorization: 'Bearer ' + dbBearer
            }
        });

        if (!response.ok) continue;
        const rows = await response.json();
        const admin = (rows || []).find(row => row.role === 'admin');
        if (admin) return admin;
    }

    return null;
}

async function requireAdmin(request, env) {
    const token = getBearerToken(request);
    if (!token) return { error: json({ error: 'Admin session is required.' }, 401) };

    const authUser = await getSupabaseUser(env, token);
    if (!authUser || !authUser.id) return { error: json({ error: 'Admin session is invalid or expired.' }, 401) };

    const profile = await findAdminProfile(env, token, authUser);
    if (!profile) return { error: json({ error: 'Only active admin accounts can upload files.' }, 403) };
    if (String(profile.status || '').toLowerCase() === 'inactive') return { error: json({ error: 'Admin account is inactive.' }, 403) };

    return { authUser, profile };
}

function getExtension(fileName) {
    const parts = String(fileName || '').toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
}

function safeFileName(fileName) {
    const cleaned = String(fileName || 'file')
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return cleaned || 'file';
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

function getB2Allowed(auth) {
    const storageApi = getB2StorageApi(auth);
    return storageApi.allowed || auth.allowed || {};
}

function hasB2Capability(auth, capability) {
    const capabilities = getB2Allowed(auth).capabilities || [];
    return capabilities.includes('all') || capabilities.includes(capability);
}

function normalizeB2ObjectPrefix(prefix) {
    const cleaned = String(prefix || '').trim().replace(/^\/+/, '');
    if (!cleaned) return '';
    return cleaned.endsWith('/') ? cleaned : cleaned + '/';
}

function getB2ObjectPrefix(env, auth) {
    const allowedPrefix = getB2Allowed(auth).namePrefix || '';
    return normalizeB2ObjectPrefix(envValue(env, 'B2_FILE_PREFIX') || allowedPrefix || 'plv_shared_files');
}

function assertB2UploadAllowed(env, auth, objectName) {
    const allowed = getB2Allowed(auth);
    const bucketId = envValue(env, 'B2_BUCKET_ID');
    const buckets = Array.isArray(allowed.buckets) ? allowed.buckets : [];
    const allowedPrefix = String(allowed.namePrefix || '');

    if (allowed.capabilities && !hasB2Capability(auth, 'writeFiles')) {
        throw new Error('Backblaze key needs the writeFiles permission to upload files.');
    }

    if (bucketId && buckets.length && !buckets.some(bucket => bucket.id === bucketId || bucket.bucketId === bucketId)) {
        throw new Error('Backblaze key is not allowed to use the configured B2_BUCKET_ID.');
    }

    if (allowedPrefix && !objectName.startsWith(allowedPrefix)) {
        throw new Error('Backblaze key is restricted to file prefix "' + allowedPrefix + '". Set B2_FILE_PREFIX to that same prefix or create a key without a prefix restriction.');
    }
}
async function authorizeB2(env) {
    const keyId = envValue(env, 'B2_KEY_ID', 'B2_APPLICATION_KEY_ID');
    const appKey = envValue(env, 'B2_APPLICATION_KEY');
    if (!keyId || !appKey) throw new Error('Backblaze application key variables are missing.');

    const credentials = btoa(keyId + ':' + appKey);
    const response = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
        headers: { authorization: 'Basic ' + credentials }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error('Backblaze authorization failed: ' + body.slice(0, 160));
    }

    return response.json();
}

async function getUploadUrl(env, auth) {
    const bucketId = envValue(env, 'B2_BUCKET_ID');
    if (!bucketId) throw new Error('B2_BUCKET_ID is missing.');

    const apiUrl = getB2ApiUrl(auth);
    const authorizationToken = getB2AuthToken(auth);
    if (!apiUrl || !authorizationToken) throw new Error('Backblaze authorization response is missing the API URL or token.');

    const response = await fetch(apiUrl + '/b2api/v4/b2_get_upload_url', {
        method: 'POST',
        headers: {
            authorization: authorizationToken,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ bucketId })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error('Could not get Backblaze upload URL: ' + body.slice(0, 160));
    }

    return response.json();
}

async function uploadToB2(env, file) {
    const extension = getExtension(file.name);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new Error('This file type is not allowed.');
    }

    const maxBytes = Number(envValue(env, 'B2_MAX_UPLOAD_BYTES')) || MAX_UPLOAD_BYTES;
    if (file.size > maxBytes) {
        throw new Error('File is too large. Maximum allowed size is ' + Math.round(maxBytes / 1024 / 1024) + ' MB.');
    }

    const auth = await authorizeB2(env);
    const upload = await getUploadUrl(env, auth);
    const buffer = await file.arrayBuffer();
    const checksum = await sha1Hex(buffer);
    const objectPrefix = getB2ObjectPrefix(env, auth);
    const objectName = objectPrefix + new Date().toISOString().slice(0, 10) + '/' + Date.now() + '-' + safeFileName(file.name);
    assertB2UploadAllowed(env, auth, objectName);

    const response = await fetch(upload.uploadUrl, {
        method: 'POST',
        headers: {
            authorization: upload.authorizationToken,
            'x-bz-file-name': encodeB2FileName(objectName),
            'content-type': file.type || 'application/octet-stream',
            'x-bz-content-sha1': checksum
        },
        body: buffer
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error('Backblaze upload failed: ' + body.slice(0, 160));
    }

    const uploaded = await response.json();
    return {
        fileUrl: '',
        b2FileId: uploaded.fileId,
        b2FileName: uploaded.fileName || objectName,
        storage: 'backblaze-private',
        contentType: file.type || 'application/octet-stream',
        fileSize: file.size
    };
}

export async function onRequestOptions() {
    return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
    try {
        const admin = await requireAdmin(context.request, context.env);
        if (admin.error) return admin.error;

        const formData = await context.request.formData();
        const file = formData.get('file');
        if (!file || typeof file === 'string') {
            return json({ error: 'No file was uploaded.' }, 400);
        }

        const uploaded = await uploadToB2(context.env, file);
        return json(uploaded);
    } catch (error) {
        console.error(error);
        return json({ error: error.message || 'Upload failed.' }, 500);
    }
}


