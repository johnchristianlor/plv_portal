import assert from 'node:assert/strict';
import {
  normalizeAttendanceStatus,
  summarizeAttendance,
} from '../public/attendance-utils.mjs';

assert.equal(normalizeAttendanceStatus('P'), 'P');
assert.equal(normalizeAttendanceStatus('Present'), 'P');
assert.equal(normalizeAttendanceStatus('late'), 'L');
assert.equal(normalizeAttendanceStatus('Excused absence'), 'E');
assert.equal(normalizeAttendanceStatus('Pending'), '');

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
