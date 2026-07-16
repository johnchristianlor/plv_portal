const DICEBEAR_BASE = 'https://api.dicebear.com/7.x';
const signedAvatarCache = new Map();
const signedAvatarRequests = new Map();

function initialsFor(userOrName) {
    const source = typeof userOrName === 'string'
        ? userOrName
        : (userOrName && (userOrName.fullName || userOrName.name || userOrName.studentName || userOrName.studentNo || userOrName.username)) || 'Student';
    const words = String(source).trim().split(/\s+/).filter(Boolean);
    return (((words[0] && words[0][0]) || 'S') + ((words.length > 1 && words[words.length - 1][0]) || '')).slice(0, 2).toUpperCase();
}

function localAvatarPlaceholder(userOrName) {
    const initials = initialsFor(userOrName).replace(/[<>&"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="80" fill="#003DA5"/><text x="80" y="91" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="54" font-weight="700">${initials}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function cacheKey(value, options) {
    const owner = options.studentNo || (options.user && options.user.studentNo) || '';
    return String(owner) + '|' + String(value || '');
}

function readSignedAvatarCache(key) {
    const memory = signedAvatarCache.get(key);
    if (memory && memory.expiresAt > Date.now()) return memory.url;
    try {
        const saved = JSON.parse(sessionStorage.getItem('plv-avatar:' + key) || 'null');
        if (saved && saved.url && saved.expiresAt > Date.now()) {
            signedAvatarCache.set(key, saved);
            return saved.url;
        }
    } catch (_) {}
    return '';
}

function writeSignedAvatarCache(key, url, seconds) {
    const lifetimeMs = Math.max(60, Number(seconds) || 900) * 1000;
    const entry = { url, expiresAt: Date.now() + lifetimeMs - 60000 };
    signedAvatarCache.set(key, entry);
    try { sessionStorage.setItem('plv-avatar:' + key, JSON.stringify(entry)); } catch (_) {}
}

function preloadImage(url) {
    return new Promise((resolve, reject) => {
        const probe = new Image();
        probe.decoding = 'async';
        probe.onload = () => resolve(url);
        probe.onerror = reject;
        probe.src = url;
        if (probe.complete && probe.naturalWidth) resolve(url);
    });
}

export function defaultAvatarFor(userOrName) {
    return localAvatarPlaceholder(userOrName);
}

export function isBackblazeAvatar(value) {
    return String(value || '').startsWith('b2:');
}

export function avatarStaticUrl(value, fallbackUser) {
    const raw = String(value || '').trim();
    if (!raw) return defaultAvatarFor(fallbackUser);
    if (raw.startsWith('db:')) {
        const parts = raw.split(':');
        const style = parts[1] || 'notionists';
        const seed = decodeURIComponent(parts[2] || 'student');
        return DICEBEAR_BASE + '/' + encodeURIComponent(style) + '/svg?seed=' + encodeURIComponent(seed) + '&backgroundColor=transparent';
    }
    if (raw.startsWith('b2:')) return '';
    return raw;
}

export async function resolveAvatarElement(img, value, options = {}) {
    if (!img) return '';
    const fallback = options.fallbackUrl || defaultAvatarFor(options.user || options.studentNo || 'student');
    const useFallback = () => {
        img.dataset.avatarFallback = '1';
        img.src = fallback;
        return fallback;
    };

    img.loading = img.loading || 'lazy';
    img.decoding = 'async';
    img.dataset.avatarFallback = '0';
    img.onerror = () => {
        if (img.dataset.avatarFallback === '1') return;
        useFallback();
    };

    const raw = String(value || '').trim();
    const staticUrl = avatarStaticUrl(raw, options.user || options.studentNo || 'student');
    if (staticUrl) {
        img.src = staticUrl;
        return staticUrl;
    }

    const requestId = String(Date.now()) + Math.random();
    img.dataset.avatarRequestId = requestId;
    useFallback();
    if (!isBackblazeAvatar(raw)) return fallback;

    try {
        const key = cacheKey(raw, options);
        let resolvedUrl = readSignedAvatarCache(key);
        if (!resolvedUrl) {
            let request = signedAvatarRequests.get(key);
            if (!request) {
                request = (async () => {
                    const headers = { 'content-type': 'application/json' };
                    if (options.supabase && options.supabase.auth) {
                        const { data } = await options.supabase.auth.getSession();
                        const accessToken = data && data.session && data.session.access_token;
                        if (accessToken) headers.authorization = 'Bearer ' + accessToken;
                    }
                    const body = {
                        avatarUrl: raw,
                        studentNo: options.studentNo || (options.user && options.user.studentNo) || '',
                        sessionToken: (options.user && (options.user.activeSessionToken || options.user.sessionToken)) || ''
                    };
                    const response = await fetch('/api/b2-avatar-download', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) throw new Error('Avatar download link failed.');
                    const data = await response.json();
                    if (!data.url) throw new Error('Avatar download link was empty.');
                    writeSignedAvatarCache(key, data.url, data.expiresInSeconds);
                    return data.url;
                })().finally(() => signedAvatarRequests.delete(key));
                signedAvatarRequests.set(key, request);
            }
            resolvedUrl = await request;
        }
        await preloadImage(resolvedUrl);
        if (img.dataset.avatarRequestId !== requestId) return resolvedUrl;
        img.dataset.avatarFallback = '0';
        img.src = resolvedUrl;
        return resolvedUrl;
    } catch (error) {
        console.warn('Avatar image could not be loaded.', error);
        return useFallback();
    }
}
export async function uploadStudentAvatarBlob(blob, user) {
    if (!blob) throw new Error('No avatar image was prepared.');
    if (!user || !user.studentNo) throw new Error('Student session is missing.');
    const formData = new FormData();
    formData.append('studentNo', user.studentNo);
    formData.append('sessionToken', user.activeSessionToken || user.sessionToken || '');
    formData.append('file', blob, 'avatar.jpg');

    const response = await fetch('/api/b2-avatar-upload', {
        method: 'POST',
        body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Avatar upload failed.');
    if (!data.avatarUrl) throw new Error('Avatar upload did not return a storage key.');
    return data.avatarUrl;
}
