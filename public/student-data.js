const DEFAULT_TTL_MS = 20_000;
const ENROLLMENT_FIELDS = 'id,studentNo,subjectCode,section,schedule,midtermRawGrade,midtermGrade,finalTermRawGrade,finalTermGrade';
const SUBJECT_FIELDS = 'id,subjectCode,subjectName,profName,schedule';
const SETTINGS_FIELDS = 'showStanding';
const ANNOUNCEMENT_FIELDS = 'id,title,message,isUrgent,createdAt';
const DEADLINE_FIELDS = 'id,title,desc,status,createdAt';

function safeStorage() {
    try { return globalThis.sessionStorage || null; }
    catch (_) { return null; }
}

export function createStudentDataCache({ storage = safeStorage(), now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    const inFlight = new Map();
    const prefix = 'plv:student-data:v1:';

    function read(key) {
        if (!storage) return undefined;
        try {
            const cached = JSON.parse(storage.getItem(prefix + key) || 'null');
            if (!cached || cached.expiresAt <= now()) {
                storage.removeItem(prefix + key);
                return undefined;
            }
            return cached.value;
        } catch (_) {
            return undefined;
        }
    }

    function write(key, value, maxAgeMs) {
        if (!storage) return;
        try {
            storage.setItem(prefix + key, JSON.stringify({
                expiresAt: now() + maxAgeMs,
                value
            }));
        } catch (_) {}
    }

    async function get(key, loader, { force = false, maxAgeMs = ttlMs } = {}) {
        if (inFlight.has(key)) return inFlight.get(key);
        if (!force) {
            const cached = read(key);
            if (cached !== undefined) return cached;
        }

        const request = Promise.resolve()
            .then(loader)
            .then(value => {
                write(key, value, maxAgeMs);
                return value;
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, request);
        return request;
    }

    function clear(key) {
        if (!storage) return;
        try { storage.removeItem(prefix + key); } catch (_) {}
    }

    return { get, clear };
}

const cache = createStudentDataCache();

function valueOrThrow(result) {
    if (result.error) throw result.error;
    return result.data;
}

export function getStudentEnrollments(supabase, studentNo, { force = false } = {}) {
    const normalized = String(studentNo || '').trim();
    return cache.get(`enrollments:${normalized}`, async () => {
        const result = await supabase.from('enrollments')
            .select(ENROLLMENT_FIELDS)
            .eq('studentNo', normalized);
        return valueOrThrow(result) || [];
    }, { force });
}

export function getSubject(supabase, subjectCode, { force = false } = {}) {
    const normalized = String(subjectCode || '').trim();
    return cache.get(`subject:${normalized}`, async () => {
        const result = await supabase.from('subjects')
            .select(SUBJECT_FIELDS)
            .eq('subjectCode', normalized)
            .limit(1)
            .maybeSingle();
        return valueOrThrow(result) || null;
    }, { force, maxAgeMs: 60_000 });
}

export function getGlobalSettings(supabase, { force = false } = {}) {
    return cache.get('settings:global', async () => {
        const result = await supabase.from('settings')
            .select(SETTINGS_FIELDS)
            .eq('id', 'global')
            .limit(1)
            .maybeSingle();
        return valueOrThrow(result) || { showStanding: false };
    }, { force });
}

export function getRecentAnnouncements(supabase, { force = false, limit = 25 } = {}) {
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 25));
    return cache.get(`announcements:${boundedLimit}`, async () => {
        const result = await supabase.from('announcements')
            .select(ANNOUNCEMENT_FIELDS)
            .order('createdAt', { ascending: false })
            .limit(boundedLimit);
        return valueOrThrow(result) || [];
    }, { force });
}

export function getRecentDeadlines(supabase, { force = false, limit = 4 } = {}) {
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 4));
    return cache.get(`deadlines:${boundedLimit}`, async () => {
        const result = await supabase.from('deadlines')
            .select(DEADLINE_FIELDS)
            .order('createdAt', { ascending: false })
            .limit(boundedLimit);
        return valueOrThrow(result) || [];
    }, { force });
}

export const STUDENT_DATA_FIELDS = Object.freeze({
    enrollments: ENROLLMENT_FIELDS,
    subject: SUBJECT_FIELDS,
    settings: SETTINGS_FIELDS,
    announcements: ANNOUNCEMENT_FIELDS,
    deadlines: DEADLINE_FIELDS
});
