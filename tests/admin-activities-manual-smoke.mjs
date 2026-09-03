import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    filterSavedActivityRecords,
    getActivityProgress,
    getActivityScoreSaveErrorKind,
    parseActivityScore,
    planActivityScoreChanges
} from '../public/admin-activities-manual.v2.js';

assert.deepEqual(parseActivityScore('', 50), { kind: 'blank', value: null });
assert.deepEqual(parseActivityScore('0', 50), { kind: 'score', value: 0 });
assert.deepEqual(parseActivityScore('37.5', 50), { kind: 'score', value: 37.5 });
assert.equal(parseActivityScore('51', 50).kind, 'invalid');
assert.equal(parseActivityScore('-1', 50).kind, 'invalid');
assert.equal(parseActivityScore('not-a-score', 50).kind, 'invalid');
assert.equal(getActivityScoreSaveErrorKind({ code: '23514', message: 'Cannot record a score for a student marked absent.' }), 'absent');
assert.equal(getActivityScoreSaveErrorKind({ code: '23514', message: 'check constraint failed' }), 'validation');
assert.equal(getActivityScoreSaveErrorKind({ code: '23505', message: 'duplicate key' }), 'duplicate');
assert.equal(getActivityScoreSaveErrorKind({ code: '42501', message: 'row-level security policy' }), 'auth');
assert.equal(getActivityScoreSaveErrorKind({ code: '23503', message: 'foreign key violation' }), 'reference');
assert.equal(getActivityScoreSaveErrorKind(new TypeError('Failed to fetch')), 'network');

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

const absenceChanges = planActivityScoreChanges([
    { studentNo: '2026-00001', value: '45' },
    { studentNo: '2026-00004', value: '25' }
], existingScores, 50, new Set(['2026-00001', '2026-00004']));
assert.deepEqual(absenceChanges.deletes, [{ id: 101, studentNo: '2026-00001' }], 'a saved score must be removed after same-day absence');
assert.deepEqual(absenceChanges.inserts, [], 'absent students must never receive a new score');
assert.equal(absenceChanges.absentCount, 2);

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
assert.match(page, /data-score-filter="absent"/, 'the roster must clearly separate absent students');
assert.match(page, /from\('attendance'\)[\s\S]+?\.select\('studentNo,status,date'\)/, 'activity scoring must load same-day attendance');
assert.match(page, /\.gte\('date', startDate\)[\s\S]+\.lt\('date', endDate\)/, 'historical attendance matching must support date and timestamp columns');
assert.match(page, /absentStudentNumbers/, 'activity scoring must lock absent students');
assert.match(page, /absentForActivity\.has\(sNo\)/, 'spreadsheet uploads must skip absent students');
assert.match(page, /id="scoreAutosaveState"/, 'score entry must show an accessible autosave status');
assert.match(page, /function scheduleScoreAutosave/, 'score entry must debounce automatic saves');
assert.match(page, /Promise\.allSettled/, 'one failed score must not discard successful score saves');
assert.match(page, /const payload = \{ id: crypto\.randomUUID\(\), \.\.\.row \}/, 'new scores must carry their own stable UUID');
assert.match(page, /from\('scores'\)\.insert\(payload\)/, 'score inserts must not depend on a post-insert select response');
assert.match(page, /supabase\.auth\.refreshSession\(\)/, 'an expired authenticated session must receive one safe retry');
assert.match(page, /findSavedScore\(row\.activityId, row\.studentNo\)/, 'a duplicate retry must reconcile with the existing score');
assert.doesNotMatch(page, /insertRow\('scores'/, 'score inserts must use the resilient score-specific write path');
assert.match(page, /activity-type-badge/, 'saved activity cards must display the activity type');
assert.match(page, /written: 'Written Output'[\s\S]+perf: 'Performance Based'[\s\S]+exam: 'Major Exam'/, 'activity type labels must be clear and consistent');
assert.match(page, /@media \(max-width: 700px\)[\s\S]+score-table tr\.student-score-row/, 'score rows must become mobile-friendly cards');
assert.match(page, /async function selectAllRows[\s\S]+\.range\(start, start \+ pageSize - 1\)/, 'saved activity progress must include records beyond the first database page');
assert.doesNotMatch(page, /class="score-input stud-score"[^>]+required/, 'unfinished students must not be forced to receive scores');
assert.match(page, /if\(scoreRaw === ''[^\n]+continue;/, 'blank spreadsheet scores must remain ungraded');
assert.doesNotMatch(page, /Failed to save scores\. No activity setup was lost\./, 'score failures must keep entries visible and give a useful retry state');

const studentScoresPage = fs.readFileSync(new URL('../public/student-scores.html', import.meta.url), 'utf8');
assert.match(studentScoresPage, /from\("attendance"\)\.select\("date,status"\)/, 'student scores must read attendance for the selected class');
assert.match(studentScoresPage, /getAbsentDateKeys/, 'student scores must map absences by activity date');
assert.match(studentScoresPage, /Attendance marked absent · no score recorded/, 'students must see a clear absent state instead of a numeric score');

const migration = fs.readFileSync(new URL('../supabase_migrations/20260902_absent_activity_scores.sql', import.meta.url), 'utf8');
assert.match(migration, /scores_reject_absent_activity/, 'the database must reject a score for same-day absence');
assert.match(migration, /attendance_remove_same_day_activity_scores/, 'marking attendance absent must remove an existing same-day score');
assert.match(migration, /activity\.section = new\.section[\s\S]+activity\."subjectCode" = new\."subjectCode"[\s\S]+activity\.date::date = new\.date::date/, 'cleanup must be scoped to the exact class and date');
assert.doesNotMatch(migration, /disable row level security|alter table[^;]+disable/i, 'absence enforcement must not weaken RLS');

console.log('admin activities manual-entry smoke checks passed');
