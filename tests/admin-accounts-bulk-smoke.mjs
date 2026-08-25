import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    createBulkReferenceIndex,
    findSchedule,
    friendlyBulkUploadError,
    prepareBulkUploadRows,
    runWithConcurrency,
    scheduleLookupKey,
    uniqueBy,
    updateBulkUploadCount,
    validateBulkUploadRows
} from '../public/admin-accounts-bulk.js';

const subjects = [
    { subjectCode: 'IT312', subjectName: 'Web Systems', profName: 'Prof. Reyes' },
    { subjectCode: 'IT313', subjectName: 'Database Systems', profName: 'Prof. Santos' }
];
const sections = [
    { id: 41, sectionName: 'BLOCK A', yearLevel: '3rd Year' },
    { id: 42, sectionName: 'BLOCK B', yearLevel: '3rd Year' }
];
const schedules = [
    { id: 91, subjectCode: 'IT312', section: 'BLOCK A', time: '8:00 AM - 10:00 AM', room: 'LAB 2' },
    { id: 92, subjectCode: 'IT313', section: 'BLOCK B', time: '1:00 PM - 3:00 PM', room: 'ROOM 4' }
];

const references = createBulkReferenceIndex({ subjects, sections, schedules });
assert.equal(scheduleLookupKey(' it312 ', 'block   a'), scheduleLookupKey('IT312', 'BLOCK A'));
assert.equal(findSchedule(references, 'it312', ' block a ')?.id, 91);

const prepared = prepareBulkUploadRows([
    {
        Student_No: '2021-00001',
        Full_Name: 'Student One',
        Email: 'one@example.test',
        Course_Year: 'BSIT 3rd Year',
        Section: ' block   a ',
        Subject_Code: 'it312',
        Password: 'PLV12345'
    },
    {
        Student_No: '2021-00002',
        Full_Name: 'Student Two',
        Email: 'two@example.test',
        Course_Year: 'BSIT 3rd Year',
        Section: 'BLOCK B',
        Subject_Code: 'IT313',
        Password: 'PLV12345'
    },
    {
        Student_No: '2021-00003',
        Full_Name: 'Student Three',
        Email: 'three@example.test',
        Course_Year: 'BSIT 3rd Year',
        Section: 'BLOCK A',
        Subject_Code: 'IT312',
        Password: 'PLV12345'
    }
], references);

assert.equal(prepared.length, 3, 'every populated spreadsheet row should be retained');
assert.deepEqual(prepared.map(row => row.Student_No), ['2021-00001', '2021-00002', '2021-00003']);
assert.equal(prepared[0].Section, 'BLOCK A', 'uploaded section should use the canonical database name');
assert.equal(prepared[0].Subject_Code, 'IT312', 'uploaded subject should use the canonical database code');
assert.equal(prepared[0].Schedule, '8:00 AM - 10:00 AM | LAB 2');
assert.equal(prepared[0]._ok, true);
assert.equal(prepared[1].Schedule, '1:00 PM - 3:00 PM | ROOM 4');

const aliasPrepared = prepareBulkUploadRows([{
    'Student ID': '2021-00004',
    'Student Name': 'Student Four',
    'Email Address': 'four@example.test',
    'Course and Year': 'BSIT 3rd Year',
    'Section Name': 'BLOCK A',
    'Subject': 'IT312',
    'Temporary Password': 'PLV12345'
}], references);
assert.equal(aliasPrepared[0].Student_No, '2021-00004');
assert.equal(aliasPrepared[0].Email, 'four@example.test');

const validatedDuplicates = validateBulkUploadRows(prepareBulkUploadRows([
    { Student_No: '2021-00005', Full_Name: 'Student Five', Email: 'shared@example.test', Course_Year: 'BSIT 3rd Year', Section: 'BLOCK A', Subject_Code: 'IT312' },
    { Student_No: '2021-00006', Full_Name: 'Student Six', Email: 'shared@example.test', Course_Year: 'BSIT 3rd Year', Section: 'BLOCK A', Subject_Code: 'IT312' }
], references));
assert.equal(validatedDuplicates.every(row => !row._ok), true, 'duplicate emails must be caught before any database writes');
assert.match(validatedDuplicates[0]._validationErrors.join(' '), /more than one student/);
assert.equal(friendlyBulkUploadError({ code: '23505', message: 'duplicate key violates unique constraint users_email_key' }), 'Email is already assigned to another account');

const fortySevenRows = validateBulkUploadRows(prepareBulkUploadRows(
    Array.from({ length: 47 }, (_, index) => ({
        'Student ID': `2026-${String(index + 1).padStart(5, '0')}`,
        'Student Name': `Student ${index + 1}`,
        'Email Address': '',
        'Course and Year': 'BSIT 3rd Year',
        'Section Name': 'BLOCK A',
        'Subject': 'IT312',
        'Temporary Password': 'PLV12345'
    })),
    references
));
assert.equal(fortySevenRows.length, 47, 'all 47 spreadsheet rows must survive parsing');
assert.equal(fortySevenRows.every(row => row._ok), true, 'blank optional emails must not reject otherwise valid students');
assert.equal(uniqueBy(fortySevenRows, row => row.Student_No).length, 47, 'all 47 distinct student accounts must be retained');

const duplicateStudents = uniqueBy([...prepared, { ...prepared[0], Subject_Code: 'IT313' }], row => row.Student_No);
assert.equal(duplicateStudents.length, 3, 'one student account should be saved once even with multiple enrollment rows');

const started = [];
const results = await runWithConcurrency(prepared, 2, async row => {
    started.push(row.Student_No);
    if (row.Student_No === '2021-00002') throw new Error('simulated row failure');
    return row.Student_No;
});
assert.equal(started.length, 3, 'a failed row must not prevent later rows from being processed');
assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);

assert.equal(
    updateBulkUploadCount({ getElementById: () => null }, 3),
    false,
    'a temporarily missing upload counter must not crash partial-failure rendering'
);
const fakeCount = { textContent: '' };
assert.equal(updateBulkUploadCount({ getElementById: () => fakeCount }, 3), true);
assert.equal(fakeCount.textContent, '3');

assert.equal(
    fs.existsSync(new URL('../public/outputs/student-accounts/PLV_Student_Accounts_Bulk_Upload.xlsx', import.meta.url)),
    true,
    'the verified professional Excel template must ship with the portal'
);

const accountsPage = fs.readFileSync(new URL('../public/admin-accounts.html', import.meta.url), 'utf8');
assert.match(accountsPage, /username:r\.Student_No/, 'bulk-created accounts must receive a distinct username');
assert.match(accountsPage, /if\(!insertPayload\.email\)insertPayload\.email=null/, 'blank emails must be stored as null instead of one repeated empty value');

console.log('admin account bulk upload smoke checks passed');
