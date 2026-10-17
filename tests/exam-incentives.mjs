import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bonusMapFromRows,examBonusKey,effectiveExamScore} from '../public/exam-incentive-utils.mjs';
import {aggregateExamTotals} from '../public/exam-total-utils.mjs';
const exam={id:'lab-01',category:'exam',title:'Lab',perfectScore:40};
const written={id:'quiz-01',category:'written',perfectScore:10};

test('bonuses are summed per student and per activity without mixing sections',()=>{
  const map=bonusMapFromRows([
    {activity_id:'lab-01',student_no:'A',bonus_points:1},
    {activity_id:'lab-01',student_no:'A',bonus_points:2},
    {activity_id:'lab-01',student_no:'B',bonus_points:5},
    {activity_id:'lab-02',student_no:'A',bonus_points:9},
  ]);
  assert.equal(map.get(examBonusKey('lab-01','A')),3);
  assert.equal(map.get(examBonusKey('lab-01','B')),5);
  assert.equal(map.get(examBonusKey('lab-02','A')),9);
});
test('exam effective points are capped; the raw mark remains unmodified',()=>{
  const raw={activityId:'lab-01',studentNo:'A',score:37};
  assert.equal(effectiveExamScore(exam,raw.score,5),40);
  assert.equal(raw.score,37);
  assert.equal(effectiveExamScore(exam,0,3),3);
  assert.equal(effectiveExamScore(exam,null,5),null);
  assert.equal(effectiveExamScore(written,8,9),8);
  assert.equal(effectiveExamScore(exam,38,0),38);
});
test('combined exam totals correctly reflect bonuses but preserve pending entries',()=>{
  const rows=aggregateExamTotals(
    [{...exam}, {id:'written-01',title:'Written exam',category:'exam',perfectScore:60}],
    [{activityId:'lab-01',studentNo:'A',score:38},{activityId:'lab-01',studentNo:'B',score:0}],
    [{studentNo:'A',studentName:'Ana'},{studentNo:'B',studentName:'Ben'}],
    [{activity_id:'lab-01',student_no:'A',bonus_points:5},{activity_id:'written-01',student_no:'B',bonus_points:3}]
  );
  assert.equal(rows.rows[0].earned,40);
  assert.equal(rows.rows[0].pending,1);
  assert.equal(rows.rows[0].components[0].rawScore,38);
  assert.equal(rows.rows[0].components[0].bonus,5);
  assert.equal(rows.rows[1].earned,0);
  assert.equal(rows.rows[1].pending,1);
  assert.equal(rows.rows[1].components[1].bonus,3);
});
test('conversion SQL is transactional with row locking, rate snapshots, RLS and admin-only writes',()=>{
  const sql=readFileSync(new URL('../supabase_migrations/20261018_exam_incentives_and_admin_audit.sql',import.meta.url),'utf8');
  for(const expected of ['for update','recitation_rate','conversion_rate','recitation_spent','enable row level security','security definer','admin_get_session_history',"encode(extensions.digest(",'admin_grant_exam_incentive'])assert.ok(sql.toLowerCase().includes(expected.toLowerCase()),expected);
  assert.doesNotMatch(sql,/create trigger exam_auto_convert_award after insert/);
  assert.match(sql,/drop trigger if exists exam_auto_convert_award/);
});
