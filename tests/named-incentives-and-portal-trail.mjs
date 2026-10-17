import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {namedIncentiveColumns,namedIncentiveValue,effectiveExamScore} from '../public/exam-incentive-utils.mjs';
import {aggregateExamTotals} from '../public/exam-total-utils.mjs';
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const exam={id:'x1',title:'Major Exam',category:'exam',perfectScore:40};
const awards=[{activity_id:'x1',student_no:'S1',entry_title:'Recitation Bonus',source:'recitation_manual',bonus_points:2},{activity_id:'x1',student_no:'S1',entry_title:'Attendance Incentive',source:'manual',bonus_points:1},{activity_id:'x1',student_no:'S2',entry_title:'Recitation Bonus',source:'recitation_manual',bonus_points:3},{activity_id:'x2',student_no:'S1',entry_title:'Other Subject',source:'manual',bonus_points:9}];
test('raw 35/40 remains unchanged while named +3 credits make earned 38',()=>{
 assert.equal(effectiveExamScore(exam,35,3),35);
 const totals=aggregateExamTotals([exam],[{activityId:'x1',studentNo:'S1',score:35}],[{studentNo:'S1'}],[{activity_id:'x1',student_no:'S1',bonus_points:3}]);
 assert.equal(totals.rows[0].rawEarned,35);
 assert.equal(totals.rows[0].bonusEarned,3);
 assert.equal(totals.rows[0].earned,38);
 assert.equal(totals.rows[0].components[0].score,35);
});
test('export groups separate titles without mixing students or exams',()=>{
 const columns=namedIncentiveColumns(awards,['x1']);
 assert.equal(columns.length,2);
 assert.equal(columns.reduce((n,col)=>n+namedIncentiveValue(awards,'S1',col),0),3);
 assert.equal(columns.reduce((n,col)=>n+namedIncentiveValue(awards,'S2',col),0),3);
 assert.ok(columns.every(c=>c.activityId==='x1'));
});
test('new migration preserves chips and writes independent titled ledger records',()=>{
 const sql=read('supabase_migrations/20261018_named_bonus_and_portal_access.sql');
 assert.match(sql,/public\.admin_grant_named_exam_bonus/);
 assert.match(sql,/entry_title/);
 assert.match(sql,/FROM public\.recitation_wallets w[\s\S]*?FOR UPDATE/i);
 assert.match(sql,/v_points:=least\(v_balance\/v_rate/i);
 assert.match(sql,/IF v_points<1 THEN RETURN jsonb_build_object/i);
 assert.match(sql,/DROP TRIGGER IF EXISTS exam_auto_convert_award/i);
 assert.doesNotMatch(sql,/UPDATE public\.scores SET/i);
});
test('admin and student audit events have server validation and database-level filters',()=>{
 const sql=read('supabase_migrations/20261018_named_bonus_and_portal_access.sql');
 assert.match(sql,/public\.student_log_portal_session_event/);
 assert.match(sql,/u\."activeSessionToken"=p_session_token/);
 assert.match(sql,/public\.admin_get_portal_access_trail/);
 assert.match(sql,/p_date_from date/);
 assert.match(sql,/p_date_to date/);
 assert.match(sql,/p_role text/);
 assert.match(sql,/p_action text/);
 assert.match(sql,/LIMIT least\(greatest\(coalesce\(p_limit,100\),1\),200\)/);
 for(const p of ['student-dashboard.html','student-scores.html','student-activity.html','student-attendance.html','student-grades.html','student-settings.html','student-recitation.js']){
  assert.match(read('public/'+p),/student_log_portal_session_event/,p);
 }
});
test('separate named score entries visible on student screens and excel exports',()=>{
 const exportHtml=read('public/admin-records.html');
 const studentScores=read('public/student-scores.html');
 assert.match(exportHtml,/BONUS · /);
 assert.match(exportHtml,/namedIncentiveValue/);
 assert.match(exportHtml,/EXAMS \+ BONUS TOTAL/);
 assert.match(studentScores,/named-incentive-lines/);
 assert.match(studentScores,/fetchNamedIncentiveEntries/);
 assert.match(read('public/student-recitation.js'),/named-incentive-list/);
 const admin=read('public/admin-incentives.js');
 assert.match(admin,/admin_convert_named_recitation_section/);
 assert.match(admin,/admin_grant_named_exam_bonus/);
 assert.match(read('public/admin-dashboard.html'),/id="auditRole"/);
});
