import test from 'node:test';
import assert from 'node:assert/strict';
import { GRADE_SCALE, transmutePercentage } from '../public/grade-scale.mjs';
import { aggregateExamTotals } from '../public/exam-total-utils.mjs';

test('percentage conversion has exact, continuous fractional boundaries and never silently rounds upward', () => {
  assert.equal(GRADE_SCALE.length, 10);
  for (let i = 0; i < GRADE_SCALE.length - 1; i++)
    assert.equal(GRADE_SCALE[i].minimum, GRADE_SCALE[i + 1].maximum);
  for (const [raw, grade] of [[100,1],[97,1],[96.99,1.25],[94,1.25],
    [93.999,1.5],[91,1.5],[88,1.75],[85,2],[82,2.25],[79,2.5],
    [76,2.75],[75.9999,3],[75,3],[74.9999,5],[0,5]])
    assert.equal(transmutePercentage(raw),grade, `${raw} should map to ${grade}`);
  for(const bad of [null, undefined, '', -1, 100.001, 'broken', NaN])
    assert.equal(transmutePercentage(bad),null);
});

test('lab + written exams sum earned and possible points; blank stays pending and zero counts as graded', () => {
  const exams = [
    {id:'lab',title:'Laboratory Exam',category:'exam',perfectScore:50},
    {id:'written',title:'Written Exam',category:'exam',perfectScore:100},
    {id:'quiz',title:'Quiz',category:'written',perfectScore:10},
  ];
  const scores = [
    {activityId:'lab',studentNo:'a',score:40}, {activityId:'written',studentNo:'a',score:75},
    {activityId:'lab',studentNo:'b',score:0},
  ];
  const { examCount,maxScore,rows } = aggregateExamTotals(exams,scores,[
    {studentNo:'a',studentName:'Alpha'}, {studentNo:'b',studentName:'Bravo'}
  ]);
  assert.equal(examCount,2);
  assert.equal(maxScore,150);
  assert.equal(rows[0].earned,115);
  assert.equal(rows[0].pending,0);
  assert.equal(rows[0].percentage,115/150*100);
  assert.equal(rows[1].earned,0);
  assert.equal(rows[1].pending,1);
  assert.equal(rows[1].components[0].score,0);
  assert.equal(rows[1].components[1].score,null);
});
