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
            Student_No: String(firstValue(normalizedRow, 'student_no', 'studentno', 'student_id', 'studentid')).trim(),
            Full_Name: String(firstValue(normalizedRow, 'full_name', 'fullname', 'student_name', 'studentname', 'name')).trim(),
            Email: String(firstValue(normalizedRow, 'email', 'email_address', 'emailaddress')).trim(),
            Course_Year: String(firstValue(normalizedRow, 'course_year', 'courseyear', 'course_and_year', 'course')).trim(),
            Section: String(firstValue(normalizedRow, 'section', 'section_name', 'sectionname')).trim(),
            Subject_Code: String(firstValue(normalizedRow, 'subject_code', 'subjectcode', 'subject')).trim(),
            Password: String(firstValue(normalizedRow, 'password', 'temporary_password', 'temp_password') || 'PLV12345').trim(),
            _sourceRow: index + 2
        };
    }).filter(row => [row.Student_No,row.Full_Name,row.Email,row.Course_Year,row.Section,row.Subject_Code].some(Boolean)).map(row => {
        const subject = findSubject(referenceIndex, row.Subject_Code);
        const section = findSection(referenceIndex, row.Section);
        const canonicalSubjectCode = String(subject?.subjectCode || row.Subject_Code).trim();
        const canonicalSectionName = String(section?.sectionName || row.Section).trim();
        const schedule = findSchedule(referenceIndex, canonicalSubjectCode, canonicalSectionName);
        const warnings = [];
        const validationErrors = [];

        if (!row.Student_No) validationErrors.push('Student number is required');
        if (!row.Full_Name) validationErrors.push('Full name is required');
        if (!row.Course_Year) validationErrors.push('Course and year are required');
        if (!row.Section) validationErrors.push('Section is required');
        if (!row.Subject_Code) validationErrors.push('Subject code is required');
        if (row.Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.Email)) validationErrors.push('Email format is invalid');
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
            _warns: [...validationErrors, ...warnings],
            _validationErrors: validationErrors,
            _ok: !validationErrors.length && !!subject && !!section
        };
    });
}

export function validateBulkUploadRows(rows) {
    const errorsByRow = new Map();
    const studentProfiles = new Map();
    const emailOwners = new Map();

    function addError(row, message) {
        const messages = errorsByRow.get(row) || [];
        if (!messages.includes(message)) messages.push(message);
        errorsByRow.set(row, messages);
    }

    (rows || []).forEach(row => {
        (row._validationErrors || []).forEach(message => addError(row, message));
        if (!row._subOk) addError(row, 'Subject code does not exist');
        if (!row._secOk) addError(row, 'Section does not exist');

        const studentKey = normalizeLookupValue(row.Student_No);
        if (studentKey) {
            const profile = [row.Full_Name,row.Email,row.Course_Year,row.Section].map(normalizeLookupValue).join('::');
            const existingProfile = studentProfiles.get(studentKey);
            if (existingProfile && existingProfile.profile !== profile) {
                addError(existingProfile.row, 'Student details conflict across rows');
                addError(row, 'Student details conflict across rows');
            } else if (!existingProfile) {
                studentProfiles.set(studentKey,{profile,row});
            }
        }

        const emailKey = normalizeLookupValue(row.Email);
        if (emailKey) {
            const owner = emailOwners.get(emailKey);
            if (owner && owner.studentKey !== studentKey) {
                addError(owner.row, 'Email is assigned to more than one student');
                addError(row, 'Email is assigned to more than one student');
            } else if (!owner) {
                emailOwners.set(emailKey,{studentKey,row});
            }
        }
    });

    return (rows || []).map(row => {
        const validationErrors = errorsByRow.get(row) || [];
        return {
            ...row,
            _validationErrors: validationErrors,
            _warns: [...validationErrors,...(row._warns || []).filter(message=>!validationErrors.includes(message))],
            _ok: validationErrors.length === 0
        };
    });
}

export function friendlyBulkUploadError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || error || 'Database rejected this row');
    const lowered = message.toLowerCase();
    if (code === '23505' || lowered.includes('duplicate key') || lowered.includes('unique constraint')) {
        if (lowered.includes('email')) return 'Email is already assigned to another account';
        if (lowered.includes('username')) return 'Username is already assigned to another account';
        if (lowered.includes('student')) return 'Student number already exists with conflicting data';
        return 'A unique account value is already in use';
    }
    if (code === '23502' || lowered.includes('not-null')) return 'A required database field is missing';
    if (code === '42501' || lowered.includes('row-level security')) return 'The admin session is not allowed to save this row';
    return message;
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
