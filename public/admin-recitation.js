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

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'ST';
const number = (value) => new Intl.NumberFormat('en-PH').format(Number(value) || 0);
const dateTime = (value) => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const messages = {
  invalid_session: 'Your admin session has expired. Please sign in again.',
  invalid_amount: 'Enter a whole number of chips greater than zero.',
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
  select.innerHTML = '<option value="">Choose a student</option>' + walletRows.map((row) => `<option value="${escapeHtml(row.student_no)}">${escapeHtml(row.full_name)} • ${escapeHtml(row.section || 'No section')}</option>`).join('');
  if (walletRows.some((row) => row.student_no === current)) select.value = current;
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
    <td><span class="amount plus">${number(row.balance)}</span></td>
    <td><span class="status-pill ${row.pin_set ? 'earned' : ''}"><i class="ph-fill ${row.pin_set ? 'ph-shield-check' : 'ph-lock-simple-open'}"></i>${row.pin_set ? 'Protected' : 'Not set'}</span></td>
    <td><div style="display:flex;gap:6px;white-space:nowrap"><button class="btn btn-soft" type="button" data-award="${escapeHtml(row.student_no)}" style="padding:8px 10px;min-height:34px"><i class="ph-bold ph-plus"></i> Award</button>${row.pin_set ? `<button class="btn btn-danger-soft" type="button" data-reset="${escapeHtml(row.student_no)}" data-name="${escapeHtml(row.full_name)}" aria-label="Reset ${escapeHtml(row.full_name)} PIN" style="padding:8px 10px;min-height:34px"><i class="ph-bold ph-password"></i></button>` : ''}</div></td>
  </tr>`).join('');
  body.querySelectorAll('[data-award]').forEach((button) => button.addEventListener('click', () => {
    $('awardStudent').value = button.dataset.award; populateSubjects(button.dataset.award); $('awardAmount').focus(); window.scrollTo({ top: 360, behavior: 'smooth' });
  }));
  body.querySelectorAll('[data-reset]').forEach((button) => button.addEventListener('click', () => {
    pendingResetStudent = button.dataset.reset; $('resetPinText').textContent = `Remove the current PIN for ${button.dataset.name}? The balance and ledger will not change.`; openModal('resetPinModal');
  }));
  renderStats(); populateStudents();
}

function renderLedger(rows) {
  const body = $('ledgerRows');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty"><i class="ph ph-receipt"></i><b>No Recitation activity yet</b><span>Awards and transfers will appear here automatically.</span></div></td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `<tr>
    <td><span class="status-pill ${row.transaction_type === 'award' ? 'earned' : ''}"><i class="ph-fill ${row.transaction_type === 'award' ? 'ph-star' : 'ph-arrows-left-right'}"></i>${escapeHtml(row.transaction_type)}</span></td>
    <td>${escapeHtml(row.from_name || 'Instructor')}</td><td>${escapeHtml(row.to_name || '—')}</td><td>${escapeHtml(row.section || '—')}</td><td>${escapeHtml(row.subject_code || '—')}</td>
    <td><span class="amount plus">+${number(row.amount)}</span></td><td>${escapeHtml(dateTime(row.created_at))}</td>
  </tr>`).join('');
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
  const { data, error } = await supabase.rpc('admin_get_recitation_transactions', { p_admin_session_token: sessionToken, p_limit: 150 });
  if (error) throw error;
  renderLedger(data || []);
}

async function awardRecitation(event) {
  event.preventDefault();
  const amount = Number($('awardAmount').value);
  if (!Number.isInteger(amount) || amount < 1) return showToast(messages.invalid_amount, 'err');
  const button = $('awardButton'); button.disabled = true; button.innerHTML = '<span class="loading"></span> Awarding securely';
  try {
    const { data, error } = await supabase.rpc('admin_award_recitation', {
      p_admin_session_token: sessionToken,
      p_student_no: $('awardStudent').value,
      p_amount: amount,
      p_subject_code: $('awardSubject').value,
      p_note: $('awardNote').value.trim() || null
    });
    if (error || !data?.success) throw new Error(friendlyError(error, data));
    showToast(`${number(amount)} chip${amount === 1 ? '' : 's'} awarded to ${data.studentName}.`);
    $('awardAmount').value = ''; $('awardNote').value = '';
    await Promise.all([loadWallets(), loadLedger()]);
  } catch (error) { showToast(error.message, 'err'); }
  finally { button.disabled = false; button.innerHTML = '<i class="ph-bold ph-plus-circle"></i> Award chips'; }
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
$('awardForm').addEventListener('submit', awardRecitation);
$('awardStudent').addEventListener('change', (event) => populateSubjects(event.target.value));
$('confirmResetPin').addEventListener('click', resetPin);
$('sectionFilter').addEventListener('change', () => loadWallets().catch((error) => showToast(friendlyError(error), 'err')));
$('studentSearch').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => loadWallets().catch((error) => showToast(friendlyError(error), 'err')), 240); });

loadReferenceData().then(() => Promise.all([loadWallets(), loadLedger()])).catch((error) => {
  showToast(friendlyError(error), 'err');
  $('walletRows').innerHTML = '<tr><td colspan="5"><div class="empty"><i class="ph ph-warning-circle"></i><b>Could not load Recitation</b><span>Apply the database migration, then refresh this page.</span></div></td></tr>';
  $('ledgerRows').innerHTML = '<tr><td colspan="7"><div class="empty"><span>Ledger unavailable.</span></div></td></tr>';
});
