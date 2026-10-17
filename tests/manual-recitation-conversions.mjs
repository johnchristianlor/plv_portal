import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getConversionStatus} from '../public/recitation-conversion-status.mjs';
const read=file=>readFileSync(new URL(file,import.meta.url),'utf8');
const base=read('../supabase_migrations/20261018_exam_incentives_and_admin_audit.sql');
const manual=read('../supabase_migrations/20261018_manual_recitation_conversion.sql');
const admin=read('../public/admin-incentives.js');
const html=read('../public/admin-incentives.html');
const student=read('../public/student-recitation.js');

test('a new install never creates an automatic conversion trigger',()=>{
  assert.doesNotMatch(base,/create trigger\s+exam_auto_convert_award\s+after\s+insert/i);
  assert.match(base,/drop trigger if exists exam_auto_convert_award/i);
  assert.match(base,/automatic_conversion_disabled/);
  assert.doesNotMatch(html,/id="autoConvert"/);
});
test('an upgrade actively disables any existing automatic behavior',()=>{
  assert.match(manual,/drop trigger if exists exam_auto_convert_award on public\.recitation_transactions/i);
  assert.match(manual,/drop function if exists public\.exam_auto_convert_recitation_award\(\)/i);
  assert.match(manual,/update public\.exam_incentive_rules set auto_convert = false/i);
  assert.match(manual,/automatic_conversion_disabled/);
});
test('individual and section conversion require an explicit administrator action',()=>{
  assert.match(manual,/function public\.admin_convert_recitation_section/i);
  assert.match(manual,/public\.exam_incentive_admin_id\(p_admin_session_token\)/i);
  assert.match(manual,/p_section is distinct from v_exam\.section/i);
  assert.match(manual,/public\.exam_redeem_wallet\(p_activity_id,v_student\.student_no/i);
  assert.match(admin,/p_auto_convert:false/);
  assert.match(admin,/\$\('batchAcknowledged'\)\.checked/);
  assert.match(admin,/admin_convert_recitation_section/);
  assert.match(admin,/admin_convert_recitation_to_exam/);
});
test('yellow, green and neutral states are clearly differentiated',()=>{
  assert.deepEqual(getConversionStatus({balance:8,rate:3,converted:0,headroom:10}),{
    kind:'pending',label:'Not converted',convertible:2,description:'2 exam points ready for manual conversion'
  });
  assert.equal(getConversionStatus({balance:4,rate:3,converted:2,headroom:5}).label,'More to convert');
  assert.equal(getConversionStatus({balance:1,rate:3,converted:2,headroom:5}).kind,'converted');
  assert.equal(getConversionStatus({balance:1,rate:3,converted:0,headroom:5}).kind,'pending');
  assert.equal(getConversionStatus({balance:0,rate:3,converted:0,headroom:5}).kind,'neutral');
  assert.equal(getConversionStatus({balance:8,rate:3,converted:0,headroom:0}).convertible,0);
  assert.equal(getConversionStatus({balance:9,rate:3,converted:0,headroom:2}).convertible,2);
});
test('student conversion RPC is session scoped, read only and displayed',()=>{
  assert.match(manual,/function public\.student_get_exam_conversion_status/i);
  assert.match(manual,/u\."studentNo"=p_student_no/i);
  assert.match(manual,/u\."activeSessionToken"=p_session_token/i);
  assert.match(manual,/a\.category='exam' and exists/i);
  assert.match(student,/student_get_exam_conversion_status/);
  assert.match(student,/getConversionStatus/);
  assert.match(read('../public/student-recitation.html'),/id="studentConversionRows"/);
});
test('history and previous conversion rate snapshot are preserved',()=>{
  assert.match(manual,/source in \('recitation_manual','recitation_auto'\)/i);
  assert.match(base,/conversion_rate integer/i);
  assert.match(base,/recitation_spent = bonus_points \* conversion_rate/i);
  assert.match(manual,/recitation_rate=excluded\.recitation_rate/i);
});
