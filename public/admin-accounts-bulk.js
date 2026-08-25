export function normalizeLookupValue(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase('en-US');
}

export function normalizeUploadHeader(value) {
    return normalizeLookupValue(value)
        .replace(/\s*\(.*?\)/g, '')
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

export function scheduleLookupKey(subjectCode, sectionName) {
    return `${normalizeLookupValue(subjectCode)}::${normalizeLookupValue(sectionName)}`;
}

export function createBulkReferenceIndex({ subjects = [], sections = [], schedules = [] } = {}) {
    const subjectByCode = new Map();
    const sectionByName = new Map();
    const scheduleBySubjectSection = new Map();

    subjects.forEach(subject => {
        const key = normalizeLookupValue(subject?.subjectCode);
        if (key) subjectByCode.set(key, subject);
    });
    sections.forEach(section => {
        const key = normalizeLookupValue(section?.sectionName);
        if (key) sectionByName.set(key, section);
    });
    schedules.forEach(schedule => {
        const key = scheduleLookupKey(schedule?.subjectCode, schedule?.section);
        if (key !== '::') scheduleBySubjectSection.set(key, schedule);
    });

    return { subjectByCode, sectionByName, scheduleBySubjectSection };
}

export function findSubject(referenceIndex, subjectCode) {
    return referenceIndex?.subjectByCode?.get(normalizeLookupValue(subjectCode)) || null;
}

export function findSection(referenceIndex, sectionName) {
    return referenceIndex?.sectionByName?.get(normalizeLookupValue(sectionName)) || null;
}

export function findSchedule(referenceIndex, subjectCode, sectionName) {
    return referenceIndex?.scheduleBySubjectSection?.get(scheduleLookupKey(subjectCode, sectionName)) || null;
}

function firstValue(row, ...keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
    }
    return '';
}

export function prepareBulkUploadRows(rawRows, referenceIndex) {
    return (rawRows || []).map((row, index) => {
        const normalizedRow = {};
        Object.keys(row || {}).forEach(key => {
            normalizedRow[normalizeUploadHeader(key)] = row[key];
        });

        return {
            Student_No: String(firstValue(normalizedRow, 'student_no', 'studentno')).trim(),
            Full_Name: String(firstValue(normalizedRow, 'full_name', 'fullname')).trim(),
            Email: String(firstValue(normalizedRow, 'email')).trim(),
            Course_Year: String(firstValue(normalizedRow, 'course_year', 'courseyear')).trim(),
            Section: String(firstValue(normalizedRow, 'section', 'section_name', 'sectionname')).trim(),
            Subject_Code: String(firstValue(normalizedRow, 'subject_code', 'subjectcode')).trim(),
            Password: String(firstValue(normalizedRow, 'password') || 'PLV12345').trim(),
            _sourceRow: index + 2
        };
    }).filter(row => row.Student_No && row.Subject_Code).map(row => {
        const subject = findSubject(referenceIndex, row.Subject_Code);
        const section = findSection(referenceIndex, row.Section);
        const canonicalSubjectCode = String(subject?.subjectCode || row.Subject_Code).trim();
        const canonicalSectionName = String(section?.sectionName || row.Section).trim();
        const schedule = findSchedule(referenceIndex, canonicalSubjectCode, canonicalSectionName);
        const warnings = [];

        if (!subject) warnings.push('Unknown subject');
        if (!section) warnings.push('Unknown section');
        if (!schedule) warnings.push('No schedule');

        const scheduleText = schedule
            ? `${schedule.time || ''}${schedule.time && schedule.room ? ' | ' : ''}${schedule.room || ''}`
            : (subject?.schedule || 'TBA');

        return {
            ...row,
            Section: canonicalSectionName,
            Subject_Code: canonicalSubjectCode,
            Subject_Name: subject?.subjectName || '',
            Prof_Name: subject?.profName || '',
            Schedule: scheduleText,
            Year_Level: section?.yearLevel || '',
            _subOk: !!subject,
            _secOk: !!section,
            _schedOk: !!schedule,
            _warns: warnings,
            _ok: !!subject && !!section
        };
    });
}

export async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));

    async function runNext() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, runNext));
    return results;
}

export function uniqueBy(items, keyForItem) {
    const unique = new Map();
    items.forEach(item => unique.set(keyForItem(item), item));
    return [...unique.values()];
}

export function updateBulkUploadCount(root, count) {
    const countElement = root?.getElementById?.('commitCount');
    if (!countElement) return false;
    countElement.textContent = String(count);
    return true;
}
