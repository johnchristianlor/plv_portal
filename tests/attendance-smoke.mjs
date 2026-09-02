import assert from 'node:assert/strict';
import {
  formatLocalDateInput,
  getAbsentDateKeys,
  getAbsentStudentNumbers,
  normalizeDateKey,
  normalizeAttendanceStatus,
  summarizeAttendance,
} from '../public/attendance-utils.mjs';

assert.equal(formatLocalDateInput({
  getFullYear: () => 2026,
  getMonth: () => 7,
  getDate: () => 28,
}), '2026-08-28');

assert.equal(normalizeAttendanceStatus('P'), 'P');
assert.equal(normalizeAttendanceStatus('Present'), 'P');
assert.equal(normalizeAttendanceStatus('late'), 'L');
assert.equal(normalizeAttendanceStatus('Excused absence'), 'E');
assert.equal(normalizeAttendanceStatus('Pending'), '');
assert.equal(normalizeDateKey('2026-09-02T08:30:00+08:00'), '2026-09-02');
assert.equal(normalizeDateKey('not-a-date'), '');

const absenceRecords = [
  { studentNo: '2026-001', date: '2026-09-02', status: 'Absent' },
  { studentNo: '2026-002', date: '2026-09-02T00:00:00', status: 'A' },
  { studentNo: '2026-003', date: '2026-09-03', status: 'Present' },
];
assert.deepEqual([...getAbsentStudentNumbers(absenceRecords, '2026-09-02')], ['2026-001', '2026-002']);
assert.deepEqual([...getAbsentDateKeys(absenceRecords)], ['2026-09-02']);

const twoPresent = summarizeAttendance([
  { status: 'P' },
  { status: 'Present' },
]);
assert.equal(twoPresent.present, 2);
assert.equal(twoPresent.rate, 100);

const mixed = summarizeAttendance([
  { status: 'L' },
  { status: 'Absent' },
  { status: 'E' },
]);
assert.equal(mixed.attended, 1);
assert.equal(mixed.rateDenominator, 2);
assert.equal(mixed.rate, 50);

console.log('Attendance normalization and rate checks passed.');
