import assert from 'node:assert/strict';
import { escapeCsvCell, sortRecordRows } from '../public/admin-records-utils.mjs';

const records = [
  { studentNo: '2026-10', studentName: 'Zoey Cruz', section: 'B', subjectCode: 'IT102', rank: 2, scorePercent: 91 },
  { studentNo: '2026-2', studentName: 'Ana Reyes', section: 'A', subjectCode: 'IT101', rank: 1, scorePercent: 95 },
  { studentNo: '2026-1', studentName: 'Ben Santos', section: 'A', subjectCode: 'IT101', rank: 1, scorePercent: 95 },
];

assert.deepEqual(sortRecordRows(records, 'name_asc').map(row => row.studentName), ['Ana Reyes', 'Ben Santos', 'Zoey Cruz']);
assert.deepEqual(sortRecordRows(records, 'name_desc').map(row => row.studentName), ['Zoey Cruz', 'Ben Santos', 'Ana Reyes']);
assert.deepEqual(sortRecordRows(records, 'rank').map(row => row.studentName), ['Ana Reyes', 'Ben Santos', 'Zoey Cruz']);
assert.deepEqual(sortRecordRows(records, 'student_no').map(row => row.studentNo), ['2026-1', '2026-2', '2026-10']);
assert.deepEqual(sortRecordRows(records, 'section_name').map(row => row.studentName), ['Ana Reyes', 'Ben Santos', 'Zoey Cruz']);
assert.deepEqual(records.map(row => row.studentName), ['Zoey Cruz', 'Ana Reyes', 'Ben Santos']);

assert.equal(escapeCsvCell('Ana Reyes'), 'Ana Reyes');
assert.equal(escapeCsvCell('Reyes, Ana'), '"Reyes, Ana"');
assert.equal(escapeCsvCell('Ana "Ace" Reyes'), '"Ana ""Ace"" Reyes"');
assert.equal(escapeCsvCell('Line 1\nLine 2'), '"Line 1\nLine 2"');

console.log('Admin records export ordering and CSV checks passed.');
