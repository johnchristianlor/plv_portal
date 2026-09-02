import assert from 'node:assert/strict';
import { assignClassStanding, sortClassStanding } from '../public/class-standing-utils.mjs';

const gradeRows = [
  { studentNo: '4', studentName: 'Delta', section: 'A', subjectCode: 'IT101', midtermRawGrade: 92, finalTermRawGrade: 92, totalMax: 100, scorePercent: 99 },
  { studentNo: '2', studentName: 'Bravo', section: 'A', subjectCode: 'IT101', midtermRawGrade: 95.9, finalTermRawGrade: 95.9, totalMax: 100, scorePercent: 70 },
  { studentNo: '1', studentName: 'Alpha', section: 'A', subjectCode: 'IT101', midtermRawGrade: 98, finalTermRawGrade: 98, totalMax: 100, scorePercent: 60 },
  { studentNo: '3', studentName: 'Charlie', section: 'A', subjectCode: 'IT101', midtermRawGrade: 95.9, finalTermRawGrade: 95.9, totalMax: 100, scorePercent: 80 },
];
const gradeStanding = sortClassStanding(assignClassStanding(gradeRows));
assert.deepEqual(gradeStanding.map(row => row.rank), [1, 2, 2, 4], 'ties use standard competition ranking');
assert.deepEqual(gradeStanding.map(row => row.studentName), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
assert.equal(gradeStanding[1].standingValue, 95.9);
assert.equal(gradeStanding[1].standingBasis, 'final-average');

const partialGrades = [
  { studentNo: '1', studentName: 'Alpha', section: 'A', subjectCode: 'IT101', midtermRawGrade: 99, totalMax: 50, scorePercent: 80 },
  { studentNo: '2', studentName: 'Bravo', section: 'A', subjectCode: 'IT101', midtermRawGrade: null, totalMax: 50, scorePercent: 90 },
];
const fallbackStanding = sortClassStanding(assignClassStanding(partialGrades));
assert.equal(fallbackStanding[0].studentName, 'Bravo', 'the whole cohort uses scores when official grades are incomplete');
assert.equal(fallbackStanding[0].standingBasis, 'activity-score');

const perSection = assignClassStanding([
  { studentNo: '1', studentName: 'A One', section: 'A', subjectCode: 'IT101', totalMax: 10, scorePercent: 80 },
  { studentNo: '2', studentName: 'A Two', section: 'A', subjectCode: 'IT101', totalMax: 10, scorePercent: 70 },
  { studentNo: '3', studentName: 'B One', section: 'B', subjectCode: 'IT101', totalMax: 10, scorePercent: 60 },
]);
assert.equal(perSection.find(row => row.studentNo === '1').rank, 1);
assert.equal(perSection.find(row => row.studentNo === '3').rank, 1, 'each section and subject has its own first place');

const transmuted = sortClassStanding(assignClassStanding([
  { studentNo: '1', studentName: 'One', section: 'A', subjectCode: 'IT101', midtermGrade: 1.5, finalTermGrade: 1.5, totalMax: 0, scorePercent: 0 },
  { studentNo: '2', studentName: 'Two', section: 'A', subjectCode: 'IT101', midtermGrade: 1.25, finalTermGrade: 1.25, totalMax: 0, scorePercent: 0 },
]));
assert.equal(transmuted[0].studentName, 'Two', 'lower transmuted grades rank higher');
assert.equal(transmuted[0].standingUnit, 'transmuted');

const pending = assignClassStanding([{ studentNo: '1', section: 'A', subjectCode: 'IT101', totalMax: 0, scorePercent: 0 }]);
assert.equal(pending[0].rank, null, 'students are not assigned a misleading rank without comparable data');

console.log('Class standing ranking checks passed.');
