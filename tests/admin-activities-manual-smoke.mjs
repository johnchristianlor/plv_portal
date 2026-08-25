import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    parseActivityScore,
    planActivityScoreChanges
} from '../public/admin-activities-manual.v1.js';

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

const page = fs.readFileSync(new URL('../public/admin-activities.html', import.meta.url), 'utf8');
assert.match(page, /Save & Initialize Activity/, 'manual setup must save before score entry');
assert.match(page, /window\.openActivityForScoring/, 'saved activities must be resumable');
assert.doesNotMatch(page, /class="score-input stud-score"[^>]+required/, 'unfinished students must not be forced to receive scores');
assert.match(page, /if\(scoreRaw === ''[^\n]+continue;/, 'blank spreadsheet scores must remain ungraded');

console.log('admin activities manual-entry smoke checks passed');
