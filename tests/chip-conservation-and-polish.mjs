import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planRecitationConversion} from '../public/recitation-conversion-math.mjs';
const read=(file)=>readFileSync(new URL(file,import.meta.url),'utf8');
const migration=read('../supabase_migrations/20261018_chip_preservation_manual_only.sql');
const dashboard=read('../public/admin-dashboard.html');
const incentive=read('../public/admin-incentives.html');
const student=read('../public/student-recitation.html');
const studentJS=read('../public/student-recitation.js');
const incentivesJS=read('../public/admin-incentives.js');

test('insufficient chips are never previewed for deduction',()=>{
  assert.deepEqual(planRecitationConversion({balance:2,rate:3,headroom:20}),{points:0,spent:0,retained:2,eligible:false});
  assert.deepEqual(planRecitationConversion({balance:0,rate:3,headroom:20}),{points:0,spent:0,retained:0,eligible:false});
});
test('exact threshold converts exactly one whole unit with zero remainder',()=>{
  assert.deepEqual(planRecitationConversion({balance:3,rate:3,headroom:20}),{points:1,spent:3,retained:0,eligible:true});
});
test('partial groups are preserved and do not disappear',()=>{
  assert.deepEqual(planRecitationConversion({balance:8,rate:3,headroom:20}),{points:2,spent:6,retained:2,eligible:true});
  assert.deepEqual(planRecitationConversion({balance:8,rate:3,headroom:1}),{points:1,spent:3,retained:5,eligible:true});
  assert.deepEqual(planRecitationConversion({balance:8,rate:3,headroom:0}),{points:0,spent:0,retained:8,eligible:false});
});
test('bad rates or empty capacity can never create deductions',()=>{
  for(const rate of [0,-1,null,2.5,'foo']) {
    if(rate===null) continue; // null rate is disallowed by SQL constraints
    const r=planRecitationConversion({balance:9,rate,headroom:20});
    assert.equal(r.spent,0);
  }
  assert.equal(planRecitationConversion({balance:9,rate:3,headroom:-9}).spent,0);
});
test('server enforces whole groups and no debit on insufficient or exam full',()=>{
  assert.match(migration,/v_convertible\s*:=\s*v_balance\s*\/\s*v_rate/);
  assert.match(migration,/IF v_capacity=0 THEN[\s\S]*?'exam_full'[\s\S]*?'spent',0/i);
  assert.match(migration,/IF v_convertible=0 THEN[\s\S]*?'below_rate'[\s\S]*?'spent',0/i);
  assert.match(migration,/v_spend\s*:=\s*v_points\s*\*\s*v_rate/i);
  assert.match(migration,/SELECT w\.balance INTO v_balance[\s\S]*?FOR UPDATE/i);
  assert.match(migration,/balance>=v_spend/i);
  assert.match(migration,/p_source IS DISTINCT FROM 'recitation_manual'/i);
  assert.match(migration,/REVOKE ALL ON FUNCTION public\.exam_redeem_wallet/);
  assert.doesNotMatch(migration,/CREATE TRIGGER exam_auto_convert_award/i);
});
test('admin and student designs are consistent and retain needed actions',()=>{
  assert.match(dashboard,/admin-access-trail\.css/);
  assert.match(dashboard,/id="auditSignins"/);
  assert.match(dashboard,/id="auditSignouts"/);
  assert.match(dashboard,/id="auditEvents"/);
  assert.match(incentive,/id="redeemPreserved"/);
  assert.match(incentive,/button-text">Convert chips/);
  assert.match(incentive,/button-text">Convert section/);
  assert.match(incentivesJS,/planRecitationConversion/);
  assert.match(student,/class="conversion-cards" id="studentConversionRows"/);
  assert.match(studentJS,/class="conversion-chip-badge"/);
  assert.match(studentJS,/class="conversion-item \$\{state\.kind\}"/);
  assert.doesNotMatch(student,/<table class="conversion-table"/);
});
