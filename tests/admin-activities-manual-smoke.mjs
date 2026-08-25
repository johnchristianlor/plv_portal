import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    filterSavedActivityRecords,
    getActivityProgress,
    parseActivityScore,
    planActivityScoreChanges
} from '../public/admin-activities-manual.v2.js';

assert.deepEqual(parseActivityScore('', 50), { kind: 'blank', value: null });
assert.deepEqual(parseActivityScore('0', 50), { kind: 'score', value: 0 });
assert.deepEqual(parseActivityScore('37.5', 50), { kind: 'score', value: 37.5 });
assert.equal(parseActivityScore('51', 50).kind, 'invalid');
assert.equal(parseActivityScore('-1', 50).kind, 'invalid');
assert.equal(parseActivityScore('not-a-score', 50).kind, 'invalid');

const existingScores = new Map([
    ['2026-00001', { id: 101, studentNo: '2026-00001', score: 45 }],
    ['2026-00002', { id: 102, studentNo: '2026-00002', score: 38 }],
    ['2026-00003', { id: 103, studentNo: '2026-00003', score: 20 }]
]);

const changes = planActivityScoreChanges([
    { studentNo: '2026-00001', value: '45' },
    { studentNo: '2026-00002', value: '40' },
    { studentNo: '2026-00003', value: '' },
    { studentNo: '2026-00004', value: '0' },
    { studentNo: '2026-00005', value: '' }
], existingScores, 50);

assert.equal(changes.unchangedCount, 1, 'an unchanged saved score should not be rewritten');
assert.deepEqual(changes.updates, [{ id: 102, studentNo: '2026-00002', score: 40 }]);
assert.deepEqual(changes.deletes, [{ id: 103, studentNo: '2026-00003' }], 'clearing a score should restore ungraded state');
assert.deepEqual(changes.inserts, [{ studentNo: '2026-00004', score: 0 }], 'zero is a valid completed score, not a blank');
assert.equal(changes.gradedCount, 3);

assert.deepEqual(getActivityProgress(20, 0), { total: 20, graded: 0, percent: 0, status: 'not-started' });
assert.deepEqual(getActivityProgress(20, 7), { total: 20, graded: 7, percent: 35, status: 'in-progress' });
assert.deepEqual(getActivityProgress(20, 20), { total: 20, graded: 20, percent: 100, status: 'complete' });
assert.equal(getActivityProgress(0, 3).status, 'empty');

const savedActivities = [
    { title: 'Quiz 1', subjectCode: 'IT312', section: 'BLOCK A', term: 'midterm', progressStatus: 'in-progress' },
    { title: 'Final Project', subjectCode: 'IT313', section: 'BLOCK B', term: 'final', progressStatus: 'complete' }
];
assert.deepEqual(filterSavedActivityRecords(savedActivities, { query: 'block a', status: 'all', term: 'all' }), [savedActivities[0]]);
assert.deepEqual(filterSavedActivityRecords(savedActivities, { query: '', status: 'complete', term: 'final' }), [savedActivities[1]]);

const page = fs.readFileSync(new URL('../public/admin-activities.html', import.meta.url), 'utf8');
assert.match(page, /Save & Initialize Activity/, 'manual setup must save before score entry');
assert.match(page, /window\.openActivityForScoring/, 'saved activities must be resumable');
assert.match(page, /id="savedActivitiesGrid"/, 'manual entry must show initialized activities as a grading workspace');
assert.match(page, /id="scoreRosterSearch"/, 'student score entry must be searchable');
assert.match(page, /data-score-filter="ungraded"/, 'the roster must support an ungraded-student filter');
assert.match(page, /@media \(max-width: 700px\)[\s\S]+score-table tr\.student-score-row/, 'score rows must become mobile-friendly cards');
assert.match(page, /async function selectAllRows[\s\S]+\.range\(start, start \+ pageSize - 1\)/, 'saved activity progress must include records beyond the first database page');
assert.doesNotMatch(page, /class="score-input stud-score"[^>]+required/, 'unfinished students must not be forced to receive scores');
assert.match(page, /if\(scoreRaw === ''[^\n]+continue;/, 'blank spreadsheet scores must remain ungraded');

console.log('admin activities manual-entry smoke checks passed');
