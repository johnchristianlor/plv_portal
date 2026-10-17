import { supabase } from './supabase-adapter.js';
import { startAdminSessionGuard } from './admin-session.js';
import { bonusMapFromRows, effectiveExamScore, examBonusKey, fetchExamIncentiveTotals } from './exam-incentive-utils.mjs';
import { getConversionStatus } from './recitation-conversion-status.mjs';

const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'admin') window.location.replace('index.html');
const token = user?.activeSessionToken || user?.sessionToken || '';
const guard = startAdminSessionGuard(supabase, user);
const $ = id => document.getElementById(id);
const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = value => Number(value || 0).toLocaleString('en-PH', {maximumFractionDigits:2});
const formatDate = date => new Date(date).toLocaleString('en-PH', {dateStyle:'medium',timeStyle:'short'});
let activities = [], enrollments = [], scores = [], wallets = [], history = [], rules = [], bonusRows = [];
let bonusMap = new Map();
let conversionRows = [], conversionMap = new Map();
let submitting = false;
function chosenExam() { return activities.find(a => String(a.id) === $('examSelect').value); }
function chosenStudent() { return enrollments.find(e => e.studentNo === $('studentSelect').value && e.section === chosenExam()?.section && e.subjectCode === chosenExam()?.subjectCode); }
function currentRule() { return rules.find(r => String(r.activity_id) === String(chosenExam()?.id)); }
function showToast(message, error=false) { const t=$('toast'); t.textContent=message; t.className=`toast show${error?' error':''}`; clearTimeout(showToast.timeout); showToast.timeout=setTimeout(()=>t.className='toast',4600); }
function showError(error) { $('errorPanel').hidden=false; $('errorPanel').textContent=String(error?.message || error); }
function assertResult(response) {
  if (response.error) throw response.error;
  if (!response.data?.success) throw new Error(({invalid_session:'Your admin session is no longer valid.',invalid_rate:'Choose 1–1000 chips per exam point.',exam_not_found:'This exam is no longer available.',student_not_enrolled:'Student is not enrolled in this exam class.',insufficient_or_full:'Not enough convertible chips, or the exam bonus has reached its limit.',rule_required:'Save a conversion rule before redeeming.',invalid_points:'Enter 1–1000 bonus points.',bonus_exceeds_max:'These points would exceed the remaining score allowed for this exam. Reduce the bonus amount.',automatic_conversion_disabled:'Automatic conversion is disabled. Choose a student or confirm a section manually.',section_mismatch:'The section changed. Reload the exam and try again.'})[response.data?.code] || response.data?.code || 'Unable to complete the request.');
  return response.data;
}
async function rpc(name, params) { const result=await supabase.rpc(name,params); if(result.error) throw result.error; return result.data; }
async function all(table, columns) {
  const collected=[];
  for(let start=0;start<30000;start+=1000){
    const {data,error}=await supabase.from(table).select(columns).order('id',{ascending:true}).range(start,start+999);
    if(error) throw error;
    collected.push(...(data||[]));
    if(!data||data.length<1000) break;
  }
  return collected;
}
function fillSelect(select, options, placeholder) {
  const last=select.value;
  select.innerHTML=`<option value="">${safe(placeholder)}</option>`+options.map(o=>`<option value="${safe(o.value)}">${safe(o.label)}</option>`).join('');
  if(options.some(o=>String(o.value)===last))select.value=last;
}
function updateFilters() {
  fillSelect($('sectionFilter'),[...new Set(activities.map(a=>a.section))].sort().map(v=>({value:v,label:v})),'All sections');
  fillSelect($('subjectFilter'),[...new Set(activities.filter(a=>!$('sectionFilter').value||a.section===$('sectionFilter').value).map(a=>a.subjectCode))].sort().map(v=>({value:v,label:v})),'All subjects');
  updateExams();
}
function updateExams() {
  const sec=$('sectionFilter').value, sub=$('subjectFilter').value, term=$('termFilter').value;
  const available=activities.filter(a=>(!sec||a.section===sec)&&(!sub||a.subjectCode===sub)&&(!term||a.term===term))
    .sort((a,b)=>`${a.subjectCode}${a.section}${a.title}`.localeCompare(`${b.subjectCode}${b.section}${b.title}`));
  fillSelect($('examSelect'),available.map(a=>({value:a.id,label:`${a.subjectCode} · ${a.section} · ${a.term==='final'?'Final':'Midterm'} — ${a.title} (/${fmt(a.perfectScore)})`})),'Choose existing major exam');
  updateExamDetails();
}
function updateExamDetails() {
  const exam=chosenExam(), rule=currentRule();
  $('saveRule').disabled=!exam;
  $('ruleRate').value=rule?.recitation_rate ?? 3;
  $('examInfo').innerHTML=exam?`<strong>${safe(exam.title)} / ${fmt(exam.perfectScore)} pts</strong>${safe(exam.subjectCode)} · ${safe(exam.section)} · ${exam.term==='final'?'Final term':'Midterm'} · Bonus is added to the raw score and capped at this exam maximum.`:'Choose a saved exam to configure incentives.';
  fillSelect($('studentSelect'),exam?enrollments.filter(e=>e.section===exam.section&&e.subjectCode===exam.subjectCode)
    .sort((a,b)=>String(a.studentName).localeCompare(String(b.studentName))).map(e=>({value:e.studentNo,label:`${e.studentName} · ${e.studentNo}`})):[],'Choose enrolled student');
  updateRulePreview(); updateStudentDetails(); renderRoster();
}
function updateRulePreview() { const n=Number($('ruleRate').value); $('rulePreview').textContent=Number.isInteger(n)&&n>0?`${fmt(n)} chips = +1 exam point`:'Enter a valid conversion rate'; }
function updateStudentDetails() {
  const exam=chosenExam(), e=chosenStudent();
  const bonus=e&&exam?bonusMap.get(examBonusKey(exam.id,e.studentNo))||0:0;
  const rawRow=e&&exam?scores.find(s=>String(s.activityId)===String(exam.id)&&s.studentNo===e.studentNo):null;
  const raw=rawRow?.score===undefined?null:rawRow.score;
  const effective=exam?effectiveExamScore(exam,raw,bonus):null;
  const wallet=e?wallets.find(w=>w.student_no===e.studentNo):null;
  const balance=Number(wallet?.balance)||0;
  const rate=Number(currentRule()?.recitation_rate ?? $('ruleRate').value);
  const headroom=Math.max(0,Math.floor((Number(exam?.perfectScore)||0)-(raw === null || raw === undefined ? 0 : Number(raw))-bonus));
  const convert=rate>0&&Number.isInteger(rate)?Math.min(headroom,Math.floor(Math.max(0,balance)/rate)):0;
  $('rawScore').textContent=raw===null||raw===undefined?'Pending':`${fmt(raw)} / ${fmt(exam.perfectScore)}`;
  $('bonusScore').textContent=e?`+${fmt(bonus)}`:'—';
  $('effectiveScore').textContent=effective===null?'Pending':`${fmt(effective)} / ${fmt(exam.perfectScore)}`;
  $('studentChips').textContent=e?fmt(balance):'—';
  $('bonusButton').disabled=submitting||!e||headroom<1;
  $('redeemButton').disabled=submitting||!e||!currentRule()||convert<1;
  $('redeemPoints').textContent=e?`+${fmt(convert)} exam pt${convert===1?'':'s'}`:'—';
  $('redeemDescription').textContent=e?`${fmt(balance)} available chips · ${fmt(rate||0)} per exam point. Manual approval deducts ${fmt(convert*(rate||0))} chips. Nothing happens automatically.`:'Choose an exam and student to preview available conversion.';
}
function renderHistory() {
  const query=$('historySearch').value.trim().toLowerCase(), type=$('historyType').value;
  const matched=history.filter(row=>(type==='all'||row.source===type)&&[row.student_name,row.student_no,row.exam_title,row.admin_name,row.reason].some(v=>String(v||'').toLowerCase().includes(query)));
  $('historyBody').innerHTML=matched.map(row=>{
    const converted=row.source!=='manual';
    const label=row.source==='recitation_auto'?'Legacy auto conversion':row.source==='recitation_manual'?'Manual conversion':'Bonus added';
    return `<tr><td><strong>${safe(row.student_name)}</strong><small>${safe(row.student_no)} · ${safe(row.exam_title||row.activity_id)}</small></td><td><span class="pill ${converted?(row.source==='recitation_auto'?'green':'amber'):''}">${label}</span>${row.reason?`<small>${safe(row.reason)}</small>`:''}</td><td><span class="positive">+${fmt(row.bonus_points)}</span></td><td>${converted?`${fmt(row.recitation_spent)} chips<small>${fmt(row.conversion_rate)} : 1 rate</small>`:'<span class="pill">No chips used</span>'}</td><td>${safe(row.admin_name||'System')}</td><td>${formatDate(row.created_at)}</td></tr>`;
  }).join('')||'<tr><td colspan="6" class="empty">No matching incentive activity.</td></tr>';
  $('historyCount').textContent=`Showing ${matched.length} of ${history.length} most recent transactions. Older entries are retained in the database.`;
  $('issuedCount').textContent=fmt(history.reduce((n,r)=>n+Number(r.bonus_points||0),0));
  $('redeemedCount').textContent=fmt(history.reduce((n,r)=>n+Number(r.recitation_spent||0),0));
  $('conversionCount').textContent=fmt(history.filter(r=>r.source!=='manual').length);
}
function examStudents(exam=chosenExam()) {
  if (!exam) return [];
  const students = new Map();
  for (const e of enrollments) if (e.section===exam.section && e.subjectCode===exam.subjectCode && e.studentNo)
    students.set(e.studentNo,e);
  return [...students.values()].sort((a,b)=>String(a.studentName||'').localeCompare(String(b.studentName||'')));
}
function studentConversion(e,exam=chosenExam()) {
  const rule=currentRule();
  const w=wallets.find(row=>row.student_no===e.studentNo);
  const balance=Math.max(0,Number(w?.balance)||0);
  const historyRow=conversionMap.get(examBonusKey(exam.id,e.studentNo));
  const converted=Number(historyRow?.converted_points||0);
  const rawRow=scores.find(row=>String(row.activityId)===String(exam.id) && row.studentNo===e.studentNo);
  const bonus=Number(bonusMap.get(examBonusKey(exam.id,e.studentNo))||0);
  const headroom=Math.max(0,Math.floor(Number(exam.perfectScore||0)-Number(rawRow?.score||0)-bonus));
  const state=rule?getConversionStatus({balance,rate:rule.recitation_rate,converted,headroom}):{kind:'neutral',label:'Set conversion rate',convertible:0,description:'Configure an exam conversion rate first'};
  return {balance,converted,spent:Number(historyRow?.spent_chips||0),headroom,state};
}
function renderRoster() {
  const exam=chosenExam(),body=$('rosterBody'),students=exam?examStudents(exam):[];
  const rows=students.map(e=>({e,...studentConversion(e,exam)}));
  const pending=rows.filter(row=>row.state.kind==='pending').length;
  const converted=rows.filter(row=>row.state.kind==='converted').length;
  const ready=rows.reduce((sum,row)=>sum+row.state.convertible,0);
  $('rosterTotal').textContent=fmt(students.length);
  $('rosterPending').textContent=fmt(pending);
  $('rosterConverted').textContent=fmt(converted);
  $('rosterReady').textContent=fmt(ready);
  $('rosterContext').textContent=exam?`${exam.subjectCode} / ${exam.section} · ${exam.title} · ${currentRule()?`${currentRule().recitation_rate} chips per exam point`:'Save a conversion rate before redeeming'} · Shared wallet balances update after an admin conversion.`:'Select an existing exam to view its recitation conversion sheet.';
  $('convertSectionButton').disabled=submitting||!exam||!currentRule()||ready<1;
  const search=$('rosterSearch').value.trim().toLowerCase(),status=$('rosterStatus').value;
  const visible=rows.filter(r=>(status==='all'||r.state.kind===status)&&(!search||[r.e.studentName,r.e.studentNo].some(v=>String(v||'').toLowerCase().includes(search))));
  body.innerHTML=visible.map(r=>`<tr>
    <td><strong>${safe(r.e.studentName||r.e.studentNo)}</strong><small>${safe(r.e.studentNo)}</small></td>
    <td class="chip-cell">${fmt(r.balance)}</td><td><b>${fmt(r.state.convertible)}</b><small>${r.state.convertible?`${fmt(r.state.convertible*currentRule().recitation_rate)} chips to spend`:'—'}</small></td>
    <td class="positive">+${fmt(r.converted)}</td><td>${fmt(r.spent)}</td>
    <td><span class="status-dot ${r.state.kind}">${safe(r.state.label)}</span><small>${safe(r.state.description)}</small></td>
    <td><button type="button" class="btn outline row-action" data-convert-student="${safe(r.e.studentNo)}" ${submitting||!currentRule()||r.state.convertible<1?'disabled':''}>Convert</button></td>
  </tr>`).join('') || `<tr><td colspan="7" class="empty">${exam?'No students match these filters.':'Choose an exam to view the roster.'}</td></tr>`;
  body.querySelectorAll('[data-convert-student]').forEach(btn=>btn.addEventListener('click',()=>{
    $('studentSelect').value=btn.dataset.convertStudent;
    updateStudentDetails();
    redeem();
  }));
}
function exportRosterCsv() {
  const exam=chosenExam();if(!exam)return showToast('Select an exam before exporting.',true);
  // Protect spreadsheet imports against formula injection in student names/identifiers.
  const escapeCsv=value=>{
    let s=String(value??'');
    if (/^[\s]*[=+@-]/.test(s)) s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  };
  const columns=['Student number','Student name','Section','Subject','Exam','Rate (chips / point)','Wallet balance','Convertible exam points','Previously converted points','Chips spent','Status'];
  const rows=examStudents(exam).map(e=>{
    const r=studentConversion(e,exam);
    return [e.studentNo,e.studentName,exam.section,exam.subjectCode,exam.title,currentRule()?.recitation_rate??'Not configured',r.balance,r.state.convertible,r.converted,r.spent,r.state.label];
  });
  const csv='\ufeff'+[columns,...rows].map(values=>values.map(escapeCsv).join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;
  const sanitize=v=>String(v).replace(/[^a-zA-Z0-9_-]/g,'_');
  link.download=`recitation_conversion_${sanitize(exam.section)}_${sanitize(exam.subjectCode)}_${sanitize(exam.title)}.csv`;
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),500);
  showToast(`Exported ${rows.length} students with their current conversion status.`);
}
function openBatch() {
  const exam=chosenExam(); if(!exam||!currentRule()||submitting)return;
  const candidates=examStudents(exam).map(e=>studentConversion(e,exam));
  const ready=candidates.filter(r=>r.state.convertible>0),points=ready.reduce((t,r)=>t+r.state.convertible,0);
  if(!ready.length)return showToast('No enrolled students have convertible chips for this exam.',true);
  $('batchStudents').textContent=fmt(ready.length);
  $('batchPoints').textContent=`+${fmt(points)}`;
  $('batchChips').textContent=fmt(points*currentRule().recitation_rate);
  $('batchDetails').textContent=`Approve a manual conversion for ${exam.section} · ${exam.subjectCode} into “${exam.title}” at ${currentRule().recitation_rate} chips per exam point. All enrolled students will be checked, but only eligible balances will be deducted. This cannot be undone automatically.`;
  $('batchAcknowledged').checked=false;
  $('confirmBatch').disabled=true;
  $('batchModal').hidden=false;
  $('batchAcknowledged').focus();
}
function closeBatch(){if(!submitting)$('batchModal').hidden=true;}
async function convertSection() {
  if(submitting||!$('batchAcknowledged').checked)return;
  const exam=chosenExam();if(!exam||!currentRule())return;
  submitting=true;$('confirmBatch').disabled=true;$('convertSectionButton').disabled=true;
  try{
    const result=assertResult(await supabase.rpc('admin_convert_recitation_section',{
      p_admin_session_token:token,p_activity_id:String(exam.id),p_section:exam.section
    }));
    $('batchModal').hidden=true;
    await refreshLedger();
    showToast(`Converted ${result.converted} student(s): +${fmt(result.points)} exam points, ${fmt(result.spent)} chips used. ${result.skipped} skipped.`);
  }catch(e){showToast(e.message,true);}finally{submitting=false;renderRoster();updateStudentDetails();}
}
async function refreshLedger() {
  const [ruleData,bonusData,historyData,walletData,conversionData]=await Promise.all([
    rpc('admin_get_exam_incentive_rules',{p_admin_session_token:token}),
    fetchExamIncentiveTotals(supabase,{p_admin_session_token:token}),
    rpc('admin_get_exam_incentive_history',{p_admin_session_token:token,p_limit:500}),
    rpc('admin_get_recitation_overview',{p_admin_session_token:token,p_section:null,p_search:null}),
    rpc('admin_get_recitation_conversion_totals',{p_admin_session_token:token})
  ]);
  rules=ruleData||[];bonusRows=bonusData||[];history=historyData||[];wallets=walletData||[];
  bonusMap=bonusMapFromRows(bonusRows);
  conversionRows=conversionData||[];
  conversionMap=new Map(conversionRows.map(r=>[examBonusKey(r.activity_id,r.student_no),r]));
  updateExamDetails();renderHistory();
}
async function saveRule(event) {
  event.preventDefault(); const exam=chosenExam(), rate=Number($('ruleRate').value);
  if(!exam || !Number.isInteger(rate) || rate<1 || rate>1000) return showToast('Select an exam and a conversion rate from 1 to 1000.',true);
  if(submitting) return;submitting=true;$('saveRule').disabled=true;
  try{
    assertResult(await supabase.rpc('admin_set_exam_incentive_rule',{p_admin_session_token:token,p_activity_id:String(exam.id),p_rate:rate,p_auto_convert:false}));
    await refreshLedger();showToast('Conversion rule saved. No student points were converted.');
  }catch(e){showToast(e.message,true);}finally{submitting=false;updateStudentDetails();$('saveRule').disabled=!chosenExam();}
}
async function grantBonus(event) {
  event.preventDefault(); if(submitting)return;
  const exam=chosenExam(),student=chosenStudent(),points=Number($('bonusPoints').value);
  if(!exam||!student||!Number.isInteger(points)||points<1||points>1000)return showToast('Choose a student and 1–1000 bonus points.',true);
  const rawRow=scores.find(s=>String(s.activityId)===String(exam.id)&&s.studentNo===student.studentNo);
  const limit=Math.max(0,Math.floor(Number(exam.perfectScore)-Number(rawRow?.score||0)-(bonusMap.get(examBonusKey(exam.id,student.studentNo))||0)));
  if(points>limit)return showToast(`Only ${fmt(limit)} bonus point(s) can still count toward this exam.`,true);
  if(!confirm(`Award +${points} points on ${exam.title} to ${student.studentName}? This is permanently recorded and will not deduct recitation chips.`))return;
  submitting=true;updateStudentDetails();renderRoster();
  try{
    assertResult(await supabase.rpc('admin_grant_exam_incentive',{p_admin_session_token:token,p_activity_id:String(exam.id),p_student_no:student.studentNo,p_points:points,p_reason:$('bonusReason').value.trim()||null}));
    $('bonusPoints').value='';$('bonusReason').value='';await refreshLedger();showToast(`Awarded +${points} exam bonus points.`);
  }catch(e){showToast(e.message,true);}finally{submitting=false;updateStudentDetails();renderRoster();}
}
async function redeem() {
  if(submitting)return;const exam=chosenExam(),student=chosenStudent();if(!exam||!student||!currentRule())return;
  if(!confirm(`Convert ${student.studentName}'s eligible recitation chips into ${exam.title}? Chips will be permanently deducted and the original conversion rate stored.`))return;
  submitting=true;updateStudentDetails();renderRoster();
  try{
    const result=assertResult(await supabase.rpc('admin_convert_recitation_to_exam',{p_admin_session_token:token,p_activity_id:String(exam.id),p_student_no:student.studentNo}));
    await refreshLedger();showToast(`Converted ${fmt(result.spent)} chips into +${fmt(result.points)} exam points.`);
  }catch(e){showToast(e.message,true);}finally{submitting=false;updateStudentDetails();renderRoster();}
}
$('sectionFilter').addEventListener('change',()=>{const selected=$('subjectFilter').value;fillSelect($('subjectFilter'),[...new Set(activities.filter(a=>!$('sectionFilter').value||a.section===$('sectionFilter').value).map(a=>a.subjectCode))].sort().map(v=>({value:v,label:v})),'All subjects');if([...$('subjectFilter').options].some(o=>o.value===selected))$('subjectFilter').value=selected;updateExams();});
$('subjectFilter').addEventListener('change',updateExams);
$('termFilter').addEventListener('change',updateExams);
$('examSelect').addEventListener('change',updateExamDetails);
$('studentSelect').addEventListener('change',updateStudentDetails);
$('ruleRate').addEventListener('input',()=>{updateRulePreview();updateStudentDetails();});
$('ruleForm').addEventListener('submit',saveRule);
$('bonusForm').addEventListener('submit',grantBonus);
$('redeemButton').addEventListener('click',redeem);
$('exportRoster').addEventListener('click',exportRosterCsv);
$('rosterSearch').addEventListener('input',renderRoster);
$('rosterStatus').addEventListener('change',renderRoster);
$('convertSectionButton').addEventListener('click',openBatch);
$('cancelBatch').addEventListener('click',closeBatch);
$('batchAcknowledged').addEventListener('change',()=>{$('confirmBatch').disabled=!$('batchAcknowledged').checked;});
$('confirmBatch').addEventListener('click',convertSection);
$('batchModal').addEventListener('click',event=>{if(event.target===$('batchModal'))closeBatch();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeBatch();});
$('refreshRoster').addEventListener('click',async()=>{try{await refreshLedger();showToast('Recitation sheet refreshed.');}catch(e){showError(e);}});
$('historySearch').addEventListener('input',renderHistory);
$('historyType').addEventListener('change',renderHistory);
$('refreshHistory').addEventListener('click',async()=>{try{await refreshLedger();showToast('Latest history loaded.');}catch(e){showError(e);}});
function updateThemeIcon(){ $('themeIcon').className=document.body.classList.contains('dark-theme')?'ph-fill ph-moon':'ph-fill ph-sun'; }
$('themeButton').addEventListener('click',()=>{const isDark=document.body.classList.toggle('dark-theme');localStorage.setItem('theme',isDark?'dark':'light');updateThemeIcon();});
async function logoutFromIncentives(event){
  event?.preventDefault();
  guard.stop();try{await supabase.rpc('admin_log_session_event',{p_admin_session_token:token,p_action:'logout'});}catch(e){console.warn('Logout audit unavailable',e);}
  try{await supabase.auth.signOut();}catch(e){}localStorage.removeItem('loggedInUser');location.href='index.html';
}
$('logoutButton').addEventListener('click',logoutFromIncentives);
$('mobileLogoutButton').addEventListener('click',logoutFromIncentives);
if(localStorage.getItem('theme')==='dark')document.body.classList.add('dark-theme');
updateThemeIcon();
try{
  const [a,e,s]=await Promise.all([all('activities','id,title,category,term,perfectScore,subjectCode,section'),all('enrollments','studentNo,studentName,section,subjectCode'),all('scores','id,activityId,studentNo,score')]);
  activities=a.filter(row=>row.category==='exam');enrollments=e;scores=s;
  updateFilters();await refreshLedger();
}catch(e){console.error('Incentives unavailable',e);showError(`Unable to load incentives. Apply the 20261018 Supabase migration first. Details: ${e.message}`);}
