export function parseActivityScore(rawValue, perfectScore) {
    const text = String(rawValue ?? '').trim();
    if (text === '') return { kind: 'blank', value: null };

    const value = Number(text);
    const maximum = Number(perfectScore);
    if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0 || value < 0 || value > maximum) {
        return { kind: 'invalid', value: null };
    }

    return { kind: 'score', value };
}

export function getActivityScoreSaveErrorKind(error) {
    const code = String(error?.code || error?.status || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();

    if (code === 'ABSENT' || message.includes('marked absent') || message.includes('absent on the activity date')) return 'absent';
    if (code === 'PRECISION' || message.includes('decimal scores require')) return 'precision';
    if (code === 'VALIDATION' || code === '23514' || message.includes('check constraint')) return 'validation';
    if (code === '23505' || message.includes('duplicate') || message.includes('unique constraint')) return 'duplicate';
    if (['AUTH', '401', '403', '42501', 'PGRST301'].includes(code) || message.includes('jwt') || message.includes('row-level security')) return 'auth';
    if (code === 'REFERENCE' || code === '23503' || message.includes('foreign key')) return 'reference';
    if (['CONFIGURATION', 'STORAGE', '23502', '22P02', 'PGRST204'].includes(code) || message.includes('null value') || message.includes('database connection')) return 'configuration';
    if (code === 'NETWORK' || message.includes('failed to fetch') || message.includes('network') || message.includes('offline')) return 'network';
    return 'unknown';
}

export function planActivityScoreChanges(entries, existingScores, perfectScore, absentStudentNumbers = new Set()) {
    const absentSet = new Set([...absentStudentNumbers].map(value => String(value ?? '').trim()).filter(Boolean));
    const changes = {
        inserts: [],
        updates: [],
        deletes: [],
        invalid: [],
        gradedCount: 0,
        absentCount: 0,
        unchangedCount: 0
    };

    for (const entry of entries) {
        const studentNo = String(entry.studentNo ?? '').trim();
        if (!studentNo) continue;

        const existing = existingScores.get(studentNo);
        if (absentSet.has(studentNo) || entry.absent === true) {
            changes.absentCount++;
            if (existing?.id) changes.deletes.push({ id: existing.id, studentNo });
            continue;
        }

        const parsed = parseActivityScore(entry.value, perfectScore);

        if (parsed.kind === 'invalid') {
            changes.invalid.push(studentNo);
            continue;
        }

        if (parsed.kind === 'blank') {
            if (existing?.id) changes.deletes.push({ id: existing.id, studentNo });
            continue;
        }

        changes.gradedCount++;
        if (!existing?.id) {
            changes.inserts.push({ studentNo, score: parsed.value });
        } else if (Number(existing.score) !== parsed.value) {
            changes.updates.push({ id: existing.id, studentNo, score: parsed.value });
        } else {
            changes.unchangedCount++;
        }
    }

    return changes;
}

export function getActivityProgress(totalStudents, gradedStudents) {
    const total = Math.max(0, Number(totalStudents) || 0);
    const graded = Math.max(0, Math.min(total, Number(gradedStudents) || 0));
    if (total === 0) return { total, graded: 0, percent: 0, status: 'empty' };
    if (graded === 0) return { total, graded, percent: 0, status: 'not-started' };
    if (graded >= total) return { total, graded: total, percent: 100, status: 'complete' };
    return { total, graded, percent: Math.round((graded / total) * 100), status: 'in-progress' };
}

export function filterSavedActivityRecords(records, filters = {}) {
    const query = String(filters.query || '').trim().toLowerCase();
    const status = String(filters.status || 'all');
    const term = String(filters.term || 'all');

    return records.filter(record => {
        const searchText = [record.title, record.subjectCode, record.section].map(value => String(value || '').toLowerCase()).join(' ');
        return (!query || searchText.includes(query))
            && (status === 'all' || record.progressStatus === status)
            && (term === 'all' || record.term === term);
    });
}

export function filterAndSortManagedActivities(records, filters = {}) {
    const query = String(filters.query || '').trim().toLowerCase();
    const term = String(filters.term || 'all').toLowerCase();
    const category = String(filters.category || 'all').toLowerCase();
    const section = String(filters.section || 'all');
    const sort = String(filters.sort || 'newest');

    const filtered = (records || []).filter(record => {
        const searchText = [record.title, record.subjectCode, record.section, record.category, record.term]
            .map(value => String(value || '').toLowerCase())
            .join(' ');
        return (!query || searchText.includes(query))
            && (term === 'all' || String(record.term || '').toLowerCase() === term)
            && (category === 'all' || String(record.category || '').toLowerCase() === category)
            && (section === 'all' || String(record.section || '') === section);
    });

    const compareText = (left, right) => String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
    const compareDate = (left, right) => String(left.date || '').localeCompare(String(right.date || ''));
    const sorters = {
        oldest: (left, right) => compareDate(left, right) || compareText(left.title, right.title),
        title: (left, right) => compareText(left.title, right.title) || compareDate(right, left),
        subject: (left, right) => compareText(left.subjectCode, right.subjectCode) || compareText(left.title, right.title),
        points: (left, right) => Number(right.perfectScore || 0) - Number(left.perfectScore || 0) || compareText(left.title, right.title),
        newest: (left, right) => compareDate(right, left) || compareText(left.title, right.title)
    };
    return filtered.sort(sorters[sort] || sorters.newest);
}
