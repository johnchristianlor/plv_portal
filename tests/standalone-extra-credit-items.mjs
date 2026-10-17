import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {namedIncentiveColumns,namedIncentiveValue} from '../public/exam-incentive-utils.mjs';
const read = name => readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const credits=[
 {entry_id:'batch-a',activity_id:'exam1',student_no:'S1',entry_title:'Recitation Bonus #0001',source:'recitation_manual',bonus_points:2},
 {entry_id:'batch-a',activity_id:'exam1',student_no:'S2',entry_title:'Recitation Bonus #0001',source:'recitation_manual',bonus_points:1},
 {entry_id:'batch-b',activity_id:'exam1',student_no:'S1',entry_title:'Recitation Bonus #0001',source:'recitation_manual',bonus_points:1},
 {entry_id:'manual-c',activity_id:'exam1',student_no:'S1',entry_title:'Participation',source:'manual',bonus_points:3}
];
test('each recitation approval creates a distinct named bonus item even with a repeated title',()=>{
 const cols=namedIncentiveColumns(credits,['exam1']);
 assert.equal(cols.length,3);
 const recitationCols=cols.filter(c=>c.source==='recitation_manual');
 assert.equal(recitationCols.length,2);
 assert.notEqual(recitationCols[0].displayTitle,recitationCols[1].displayTitle);
 assert.equal(recitationCols.reduce((n,col)=>n+namedIncentiveValue(credits,'S1',col),0),3);
 assert.equal(recitationCols.reduce((n,col)=>n+namedIncentiveValue(credits,'S2',col),0),1);
 assert.equal(cols.reduce((n,col)=>n+namedIncentiveValue(credits,'S1',col),0),6);
});
test('student exam grade remains a raw exam-only row, then credits become separate cards',()=>{
 const student=read('public/student-scores.html');
 assert.match(student,/activity-item standalone-credit/);
 assert.match(student,/totalScore \+= myScore;/);
 assert.match(student,/totalScore \+= points;/);
 assert.doesNotMatch(student,/\$\{attendanceNote\}\$\{incentiveNote\}/);
 const examHelper=read('public/exam-incentive-utils.mjs');
 assert.match(examHelper,/get_standalone_exam_incentive_entries/);
});
test('the database saves unique entry groups, creates automatic names, and locks chip balances',()=>{
 const sql=read('supabase_migrations/20261018_standalone_extra_credit_entries.sql');
 assert.match(sql,/entry_group_id uuid/);
 assert.match(sql,/CREATE SEQUENCE IF NOT EXISTS/);
 assert.match(sql,/nextval\('public\.recitation_bonus_name_seq'\)/);
 assert.match(sql,/FOR UPDATE/);
 assert.match(sql,/WHERE student_no=p_student_no AND balance>=v_spend/);
 assert.match(sql,/v_entry_group_id:=gen_random_uuid/);
 assert.match(sql,/public\.get_standalone_exam_incentive_entries/);
 assert.doesNotMatch(sql,/UPDATE public\.scores SET/);
});
test('Excel and CSV show an independent incentive column and combined total',()=>{
 const records=read('public/admin-records.html');
 assert.match(records,/BONUS · /);
 assert.match(records,/col\.displayTitle\|\|col\.title/);
 assert.match(records,/namedIncentiveValue/);
 assert.match(records,/EXAMS \+ BONUS TOTAL/);
});
