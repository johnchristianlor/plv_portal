const DICEBEAR_BASE = 'https://api.dicebear.com/7.x';

export function defaultAvatarFor(userOrName) {
    const seed = typeof userOrName === 'string'
        ? userOrName
        : (userOrName && (userOrName.studentNo || userOrName.fullName || userOrName.name || userOrName.username)) || 'student';
    return DICEBEAR_BASE + '/notionists/svg?seed=' + encodeURIComponent(seed) + '&backgroundColor=b6e3f4';
}

export function compactDicebearAvatar(style, seed) {
    return 'db:' + String(style || 'notionists').replace(/[^a-z0-9-]/gi, '') + ':' + encodeURIComponent(String(seed || 'student'));
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
    const raw = String(value || '').trim();
    const staticUrl = avatarStaticUrl(raw, options.user || options.studentNo || 'student');
    if (staticUrl) {
        img.src = staticUrl;
        return staticUrl;
    }

    img.src = fallback;
    if (!isBackblazeAvatar(raw)) return fallback;

    try {
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
        img.src = data.url;
        return data.url;
    } catch (error) {
        console.warn('Avatar image could not be loaded.', error);
        img.src = fallback;
        return fallback;
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