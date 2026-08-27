import { supabase } from './supabase-adapter.js';
import { startAdminSessionGuard } from './admin-session.js';

const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'admin') window.location.href = 'index.html';

const sessionToken = user && (user.activeSessionToken || user.sessionToken || '');
const adminSessionGuard = startAdminSessionGuard(supabase, user);
let walletRows = [];
let subjects = [];
let enrollments = [];
let pendingResetStudent = null;
let filterTimer = null;
let adjustmentMode = 'add';

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'ST';
const number = (value) => new Intl.NumberFormat('en-PH').format(Number(value) || 0);
const dateTime = (value) => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const messages = {
  invalid_session: 'Your admin session has expired. Please sign in again.',
  invalid_amount: 'Enter a whole number of chips greater than zero.',
  invalid_adjustment_type: 'Choose whether to add or reduce chips.',
  subject_required: 'Choose the subject where the student earned the recitation.',
  student_not_found: 'The selected student account is no longer active.',
  subject_not_enrolled: 'This student is not enrolled in the selected subject.',
  note_too_long: 'Keep the reason within 240 characters.'
};

function showToast(message, type = 'ok') {
  const toast = $('toast');
  toast.className = `toast ${type}`;
  toast.querySelector('i').className = type === 'ok' ? 'ph-fill ph-check-circle' : 'ph-fill ph-warning-circle';
  $('toastMessage').textContent = message;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 4300);
}

function friendlyError(error, result) {
  if (result?.code && messages[result.code]) return messages[result.code];
  const message = String(error?.message || 'Something went wrong. Please try again.');
  if (message.toLowerCase().includes('could not find the function')) return 'Recitation is waiting for its database migration to be applied.';
  return message;
}

function openModal(id) { $(id).classList.add('show'); document.body.style.overflow = 'hidden'; }
function closeModal(id) { $(id).classList.remove('show'); if (!document.querySelector('.modal-backdrop.show')) document.body.style.overflow = ''; }

function renderStats() {
  $('issuedTotal').textContent = number(walletRows.reduce((sum, row) => sum + Number(row.balance || 0), 0));
  $('walletCount').textContent = number(walletRows.length);
  $('pinCount').textContent = number(walletRows.filter((row) => row.pin_set).length);
  $('sectionCount').textContent = number(new Set(walletRows.map((row) => row.section).filter(Boolean)).size);
}

function populateStudents() {
  const select = $('awardStudent');
  const current = select.value;
  const grouped = new Map();
  walletRows.forEach((row) => {
    const section = row.section || 'Unassigned';
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(row);
  });
  select.innerHTML = '<option value="">Choose a student</option>' + [...grouped.entries()].map(([section, rows]) => `<optgroup label="${escapeHtml(section)}">${rows.map((row) => `<option value="${escapeHtml(row.student_no)}">${escapeHtml(row.full_name)} • ${escapeHtml(row.student_no)}</option>`).join('')}</optgroup>`).join('');
  if (walletRows.some((row) => row.student_no === current)) select.value = current;
  updateSelectedStudent();
}

function populateSubjects(studentNo = '') {
  const allowedCodes = studentNo ? new Set(enrollments.filter((row) => row.studentNo === studentNo).map((row) => row.subjectCode)) : null;
  const available = allowedCodes?.size ? subjects.filter((subject) => allowedCodes.has(subject.subjectCode)) : subjects;
  const select = $('awardSubject');
  const current = select.value;
  select.innerHTML = '<option value="">Choose subject</option>' + available.map((subject) => `<option value="${escapeHtml(subject.subjectCode)}">${escapeHtml(subject.subjectCode)} — ${escapeHtml(subject.subjectName || 'Subject')}</option>`).join('');
  if (available.some((subject) => subject.subjectCode === current)) select.value = current;
}

function renderWallets() {
  const body = $('walletRows');
  if (!walletRows.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty"><i class="ph ph-users"></i><b>No students found</b><span>Try another search or section.</span></div></td></tr>';
    renderStats(); populateStudents(); return;
  }
  body.innerHTML = walletRows.map((row) => `<tr>
    <td><div class="student-cell"><span class="recipient-avatar">${escapeHtml(initials(row.full_name))}</span><div><b>${escapeHtml(row.full_name)}</b><small>${escapeHtml(row.student_no)}</small></div></div></td>
    <td>${escapeHtml(row.section || 'Unassigned')}</td>
    <td><span class="amount ${Number(row.balance) < 0 ? 'minus' : 'plus'}">${number(row.balance)}</span></td>
    <td><span class="status-pill ${row.pin_set ? 'earned' : ''}"><i class="ph-fill ${row.pin_set ? 'ph-shield-check' : 'ph-lock-simple-open'}"></i>${row.pin_set ? 'Protected' : 'Not set'}</span></td>
    <td><div style="display:flex;gap:6px;white-space:nowrap"><button class="btn btn-soft" type="button" data-award="${escapeHtml(row.student_no)}" style="padding:8px 10px;min-height:34px"><i class="ph-bold ph-sliders-horizontal"></i> Adjust</button>${row.pin_set ? `<button class="btn btn-danger-soft" type="button" data-reset="${escapeHtml(row.student_no)}" data-name="${escapeHtml(row.full_name)}" aria-label="Reset ${escapeHtml(row.full_name)} PIN" style="padding:8px 10px;min-height:34px"><i class="ph-bold ph-password"></i></button>` : ''}</div></td>
  </tr>`).join('');
  body.querySelectorAll('[data-award]').forEach((button) => button.addEventListener('click', () => {
    $('awardStudent').value = button.dataset.award; populateSubjects(button.dataset.award); updateSelectedStudent(); $('awardAmount').focus(); window.scrollTo({ top: 360, behavior: 'smooth' });
  }));
  body.querySelectorAll('[data-reset]').forEach((button) => button.addEventListener('click', () => {
    pendingResetStudent = button.dataset.reset; $('resetPinText').textContent = `Remove the current PIN for ${button.dataset.name}? The balance and ledger will not change.`; openModal('resetPinModal');
  }));
  renderStats(); populateStudents();
}

function renderLedger(rows) {
  const body = $('ledgerRows');
  $('ledgerCount').innerHTML = `<i class="ph-bold ph-list-bullets"></i> ${number(rows.length)} ${rows.length === 1 ? 'entry' : 'entries'} shown`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty"><i class="ph ph-receipt"></i><b>No Recitation activity yet</b><span>Awards and transfers will appear here automatically.</span></div></td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const deduction = row.transaction_type === 'deduction';
    const award = row.transaction_type === 'award';
    return `<tr>
    <td><span class="status-pill ${award ? 'earned' : deduction ? 'sent' : ''}"><i class="ph-fill ${award ? 'ph-star' : deduction ? 'ph-minus-circle' : 'ph-arrows-left-right'}"></i>${escapeHtml(row.transaction_type)}</span></td>
    <td>${escapeHtml(row.from_name || 'Instructor')}</td><td>${escapeHtml(row.to_name || '—')}</td><td>${escapeHtml(row.section || '—')}</td><td>${escapeHtml(row.subject_code || '—')}</td>
    <td><span class="amount ${deduction ? 'minus' : 'plus'}">${deduction ? '−' : '+'}${number(row.amount)}</span></td><td>${escapeHtml(dateTime(row.created_at))}</td>
  </tr>`;
  }).join('');
}

async function loadReferenceData() {
  const [sectionsResult, subjectsResult, enrollmentsResult] = await Promise.all([
    supabase.from('sections').select('sectionName').order('sectionName'),
    supabase.from('subjects').select('subjectCode,subjectName').order('subjectCode'),
    supabase.from('enrollments').select('studentNo,subjectCode')
  ]);
  if (sectionsResult.error) throw sectionsResult.error;
  if (subjectsResult.error) throw subjectsResult.error;
  if (enrollmentsResult.error) throw enrollmentsResult.error;
  subjects = subjectsResult.data || [];
  enrollments = enrollmentsResult.data || [];
  $('sectionFilter').innerHTML = '<option value="">All sections</option>' + (sectionsResult.data || []).map((row) => `<option value="${escapeHtml(row.sectionName)}">${escapeHtml(row.sectionName)}</option>`).join('');
  $('ledgerSectionFilter').innerHTML = '<option value="">All sections</option>' + (sectionsResult.data || []).map((row) => `<option value="${escapeHtml(row.sectionName)}">${escapeHtml(row.sectionName)}</option>`).join('');
  populateSubjects();
}

async function loadWallets() {
  const { data, error } = await supabase.rpc('admin_get_recitation_overview', {
    p_admin_session_token: sessionToken,
    p_section: $('sectionFilter').value || null,
    p_search: $('studentSearch').value.trim() || null
  });
  if (error) throw error;
  walletRows = data || [];
  renderWallets();
}

async function loadLedger() {
  $('ledgerCount').innerHTML = '<span class="loading"></span> Updating ledger…';
  const { data, error } = await supabase.rpc('admin_get_recitation_transactions', {
    p_admin_session_token: sessionToken,
    p_limit: 150,
    p_section: $('ledgerSectionFilter').value || null,
    p_transaction_type: $('ledgerTypeFilter').value || null
  });
  if (error) throw error;
  renderLedger(data || []);
}

async function adjustRecitation(event) {
  event.preventDefault();
  const amount = Number($('awardAmount').value);
  if (!Number.isInteger(amount) || amount < 1) return showToast(messages.invalid_amount, 'err');
  const reducing = adjustmentMode === 'reduce';
  const button = $('awardButton'); button.disabled = true; button.innerHTML = `<span class="loading"></span> ${reducing ? 'Reducing' : 'Adding'} securely`;
  try {
    const { data, error } = await supabase.rpc('admin_adjust_recitation', {
      p_admin_session_token: sessionToken,
      p_student_no: $('awardStudent').value,
      p_amount: amount,
      p_adjustment_type: adjustmentMode,
      p_subject_code: $('awardSubject').value,
      p_note: $('awardNote').value.trim() || null
    });
    if (error || !data?.success) throw new Error(friendlyError(error, data));
    showToast(`${number(amount)} chip${amount === 1 ? '' : 's'} ${reducing ? 'reduced from' : 'added to'} ${data.studentName}. New balance: ${number(data.balance)}.`);
    $('awardAmount').value = ''; $('awardNote').value = '';
    await Promise.all([loadWallets(), loadLedger()]);
  } catch (error) { showToast(error.message, 'err'); }
  finally { button.disabled = false; updateAdjustmentMode(adjustmentMode); }
}

function updateAdjustmentMode(mode) {
  adjustmentMode = mode === 'reduce' ? 'reduce' : 'add';
  const reducing = adjustmentMode === 'reduce';
  document.querySelectorAll('.mode-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === adjustmentMode));
  $('amountLabel').innerHTML = `<span class="field-step">3</span> ${reducing ? 'Chips to reduce' : 'Chips to add'}`;
  $('awardNote').placeholder = reducing ? 'Example: Balance correction or classroom penalty' : 'Example: Excellent explanation during recitation';
  $('adjustmentNotice').classList.toggle('reduce', reducing);
  $('adjustmentNotice').innerHTML = reducing
    ? '<i class="ph-fill ph-warning-circle"></i><span>Reductions can move a wallet below zero. Students with insufficient balance cannot send chips.</span>'
    : '<i class="ph-fill ph-info"></i><span>Adding chips increases the student\'s available balance.</span>';
  $('awardButton').className = `btn ${reducing ? 'btn-danger-soft' : 'btn-gold'} full`;
  $('awardButton').innerHTML = reducing ? '<i class="ph-bold ph-minus-circle"></i> Reduce chips' : '<i class="ph-bold ph-plus-circle"></i> Add chips';
  document.querySelectorAll('.quick-amounts button[data-amount]').forEach((button) => { button.textContent = `${reducing ? '−' : '+'}${button.dataset.amount}`; });
  updateBalanceImpact();
}

function updateSelectedStudent() {
  const row = walletRows.find((item) => item.student_no === $('awardStudent').value);
  const card = $('selectedStudentCard');
  card.hidden = !row;
  if (!row) { updateBalanceImpact(); return; }
  $('selectedStudentAvatar').textContent = initials(row.full_name);
  $('selectedStudentName').textContent = row.full_name;
  $('selectedStudentMeta').textContent = `${row.student_no} • ${row.section || 'Unassigned'}`;
  $('selectedStudentBalance').textContent = number(row.balance);
  $('selectedStudentBalance').classList.toggle('negative', Number(row.balance) < 0);
  updateBalanceImpact();
}

function updateBalanceImpact() {
  const row = walletRows.find((item) => item.student_no === $('awardStudent').value);
  const amount = Number($('awardAmount').value);
  const valid = row && Number.isInteger(amount) && amount > 0;
  $('balanceImpact').hidden = !valid;
  document.querySelectorAll('.quick-amounts button[data-amount]').forEach((button) => button.classList.toggle('active', Number(button.dataset.amount) === amount));
  if (!valid) return;
  const current = Number(row.balance) || 0;
  const next = current + (adjustmentMode === 'reduce' ? -amount : amount);
  $('impactCurrent').textContent = number(current);
  $('impactNext').textContent = number(next);
  $('impactNext').style.color = next < 0 ? 'var(--danger)' : 'var(--success)';
}

async function resetPin() {
  if (!pendingResetStudent) return;
  const button = $('confirmResetPin'); button.disabled = true;
  try {
    const { data, error } = await supabase.rpc('admin_reset_recitation_pin', { p_admin_session_token: sessionToken, p_student_no: pendingResetStudent });
    if (error || !data?.success) throw new Error(friendlyError(error, data));
    closeModal('resetPinModal'); showToast('Wallet PIN reset. The student can now create a new PIN.'); pendingResetStudent = null; await loadWallets();
  } catch (error) { showToast(error.message, 'err'); }
  finally { button.disabled = false; }
}

function initTheme() {
  const dark = localStorage.getItem('theme') === 'dark';
  document.body.classList.toggle('dark-theme', dark); $('themeIcon').className = dark ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
  $('themeToggle').addEventListener('click', () => { const isDark = document.body.classList.toggle('dark-theme'); localStorage.setItem('theme', isDark ? 'dark' : 'light'); $('themeIcon').className = isDark ? 'ph-fill ph-moon' : 'ph-fill ph-sun'; });
}

window.logout = async () => { adminSessionGuard.stop(); try { await supabase.auth.signOut(); } catch (error) {} localStorage.removeItem('loggedInUser'); window.location.href = 'index.html'; };

initTheme();
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
$('awardForm').addEventListener('submit', adjustRecitation);
$('modeAdd').addEventListener('click', () => updateAdjustmentMode('add'));
$('modeReduce').addEventListener('click', () => updateAdjustmentMode('reduce'));
$('awardStudent').addEventListener('change', (event) => { populateSubjects(event.target.value); updateSelectedStudent(); });
$('awardAmount').addEventListener('input', updateBalanceImpact);
document.querySelectorAll('.quick-amounts button[data-amount]').forEach((button) => button.addEventListener('click', () => { $('awardAmount').value = button.dataset.amount; updateBalanceImpact(); }));
$('confirmResetPin').addEventListener('click', resetPin);
$('sectionFilter').addEventListener('change', () => loadWallets().catch((error) => showToast(friendlyError(error), 'err')));
$('ledgerSectionFilter').addEventListener('change', () => loadLedger().catch((error) => showToast(friendlyError(error), 'err')));
$('ledgerTypeFilter').addEventListener('change', () => loadLedger().catch((error) => showToast(friendlyError(error), 'err')));
$('resetLedgerFilters').addEventListener('click', () => { $('ledgerSectionFilter').value = ''; $('ledgerTypeFilter').value = ''; loadLedger().catch((error) => showToast(friendlyError(error), 'err')); });
$('studentSearch').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => loadWallets().catch((error) => showToast(friendlyError(error), 'err')), 240); });

loadReferenceData().then(() => Promise.all([loadWallets(), loadLedger()])).catch((error) => {
  showToast(friendlyError(error), 'err');
  $('walletRows').innerHTML = '<tr><td colspan="5"><div class="empty"><i class="ph ph-warning-circle"></i><b>Could not load Recitation</b><span>Apply the database migration, then refresh this page.</span></div></td></tr>';
  $('ledgerRows').innerHTML = '<tr><td colspan="7"><div class="empty"><span>Ledger unavailable.</span></div></td></tr>';
});

updateAdjustmentMode('add');
