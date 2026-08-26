import { supabase } from './supabase-adapter.js';
import { startStudentPresence } from './student-presence.js';
import { startStudentSessionGuard } from './student-session.js';

const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'student') window.location.href = 'index.html';

const sessionToken = user && (user.activeSessionToken || user.sessionToken || '');
const studentPresence = startStudentPresence(supabase, user);
const studentSessionGuard = startStudentSessionGuard(supabase, user);
let wallet = { balance: 0, pinSet: false, section: user.section || '' };
let selectedRecipient = null;
let recipientTimer = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'ST';
const number = (value) => new Intl.NumberFormat('en-PH').format(Number(value) || 0);
const dateTime = (value) => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const errorMessages = {
  invalid_session: 'Your session has expired. Please sign in again.',
  invalid_pin_format: 'Your PIN must contain exactly four digits.',
  pin_already_set: 'A PIN is already protecting this wallet.',
  pin_not_set: 'Set up your wallet PIN before sharing chips.',
  pin_locked: 'Too many incorrect attempts. Your PIN is temporarily locked for 15 minutes.',
  invalid_pin: 'That PIN is incorrect. Please try again carefully.',
  invalid_recipient: 'Please choose a valid classmate.',
  different_section: 'Recitation chips can only be shared within your section.',
  invalid_amount: 'Enter a whole number of chips greater than zero.',
  insufficient_balance: 'You do not have enough chips for this transfer.',
  note_too_long: 'Keep your message within 240 characters.'
};

function showToast(message, type = 'ok') {
  const toast = $('toast');
  toast.className = `toast ${type}`;
  toast.querySelector('i').className = type === 'ok' ? 'ph-fill ph-check-circle' : 'ph-fill ph-warning-circle';
  $('toastMessage').textContent = message;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function friendlyError(error, result) {
  const code = result && result.code;
  if (code && errorMessages[code]) return errorMessages[code];
  const message = String(error?.message || 'Something went wrong. Please try again.');
  if (message.toLowerCase().includes('could not find the function')) return 'Recitation is waiting for its database update. Please ask the administrator to apply the new migration.';
  return message;
}

function openModal(id) {
  const modal = $(id);
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
  setTimeout(() => modal.querySelector('input')?.focus(), 70);
}

function closeModal(id) {
  $(id).classList.remove('show');
  if (!document.querySelector('.modal-backdrop.show')) document.body.style.overflow = '';
}

function pinValue(group) {
  return [...document.querySelectorAll(`[data-pin-group="${group}"] .pin-box`)].map((input) => input.value).join('');
}

function clearPinGroup(group) {
  const inputs = [...document.querySelectorAll(`[data-pin-group="${group}"] .pin-box`)];
  inputs.forEach((input) => { input.value = ''; });
  inputs[0]?.focus();
}

function createPinInputs(group) {
  const container = document.querySelector(`[data-pin-group="${group}"]`);
  for (let index = 0; index < 4; index += 1) {
    const input = document.createElement('input');
    input.className = 'pin-box';
    input.type = 'password';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]';
    input.maxLength = 1;
    input.autocomplete = 'new-password';
    input.setAttribute('aria-label', `PIN digit ${index + 1}`);
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value) input.nextElementSibling?.focus();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value) input.previousElementSibling?.focus();
    });
    input.addEventListener('paste', (event) => {
      const digits = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
      if (!digits) return;
      event.preventDefault();
      [...container.children].forEach((box, position) => { box.value = digits[position] || ''; });
      container.children[Math.min(digits.length, 4) - 1]?.focus();
    });
    container.appendChild(input);
  }
}

function renderWallet() {
  $('balance').textContent = number(wallet.balance);
  $('balance').classList.toggle('negative-balance', Number(wallet.balance) < 0);
  $('totalEarned').textContent = number(wallet.totalEarned);
  $('totalShared').textContent = number(wallet.totalShared);
  $('walletSection').textContent = wallet.section || 'Unassigned';
  $('studentLine').textContent = `${wallet.fullName || user.fullName || 'Student'} • ${wallet.section || user.section || 'No section assigned'}`;
  $('transferAmount').max = String(Math.max(Number(wallet.balance) || 0, 1));
  const banner = $('pinBanner');
  banner.classList.toggle('good', Boolean(wallet.pinSet));
  banner.querySelector('i').className = wallet.pinSet ? 'ph-fill ph-shield-check' : 'ph-fill ph-lock-key';
  $('pinTitle').textContent = wallet.pinSet ? 'Wallet PIN is active' : 'Set your 4-digit PIN first';
  $('pinMessage').textContent = wallet.pinSet ? 'Every transfer requires your private PIN.' : 'Your PIN protects every transfer and is never displayed.';
  $('pinAction').innerHTML = wallet.pinSet ? '<i class="ph-bold ph-password"></i> Change PIN' : '<i class="ph-bold ph-password"></i> Set up PIN';
}

async function loadWallet() {
  const { data, error } = await supabase.rpc('get_recitation_wallet', {
    p_student_no: user.studentNo,
    p_session_token: sessionToken
  });
  if (error || !data?.success) throw new Error(friendlyError(error, data));
  wallet = data;
  renderWallet();
}

function renderActivity(rows) {
  const list = $('activityList');
  if (!rows.length) {
    list.innerHTML = '<div class="empty"><i class="ph ph-coin-vertical"></i><b>No wallet activity yet</b><span>Your first recitation award will appear here.</span></div>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const direction = row.direction || 'earned';
    const sent = direction === 'sent';
    const deducted = direction === 'deducted';
    const outgoing = sent || deducted;
    const label = direction === 'earned' ? `Earned${row.subject_code ? ` in ${escapeHtml(row.subject_code)}` : ''}` : deducted ? `Reduced by instructor${row.subject_code ? ` • ${escapeHtml(row.subject_code)}` : ''}` : sent ? `Sent to ${escapeHtml(row.counterparty_name)}` : `Received from ${escapeHtml(row.counterparty_name)}`;
    const icon = direction === 'earned' ? 'ph-fill ph-star' : deducted ? 'ph-fill ph-minus-circle' : sent ? 'ph-fill ph-arrow-up-right' : 'ph-fill ph-arrow-down-left';
    return `<div class="activity-item">
      <div class="activity-icon ${deducted ? 'sent' : escapeHtml(direction)}"><i class="${icon}"></i></div>
      <div class="activity-copy"><b>${label}</b><span>${escapeHtml(row.note || 'No message')} • ${escapeHtml(dateTime(row.created_at))}</span></div>
      <div class="activity-amount ${outgoing ? 'negative' : 'positive'}">${outgoing ? '−' : '+'}${number(row.amount)}<small>chips</small></div>
    </div>`;
  }).join('');
}

async function loadActivity() {
  const { data, error } = await supabase.rpc('get_recitation_transactions', {
    p_student_no: user.studentNo,
    p_session_token: sessionToken,
    p_limit: 60
  });
  if (error) throw error;
  renderActivity(data || []);
}

function renderRecipients(rows) {
  const results = $('recipientResults');
  if (!rows.length) {
    results.innerHTML = '<div class="empty"><span>No classmates match your search.</span></div>';
    return;
  }
  results.innerHTML = rows.map((row) => `<button type="button" class="recipient${selectedRecipient?.student_no === row.student_no ? ' selected' : ''}" data-student-no="${escapeHtml(row.student_no)}" data-full-name="${escapeHtml(row.full_name)}">
    <span class="recipient-avatar">${escapeHtml(initials(row.full_name))}</span>
    <span class="recipient-copy"><b>${escapeHtml(row.full_name)}</b><span>${escapeHtml(row.student_no)} • ${escapeHtml(row.section)}</span></span>
    <i class="ph-fill ph-check-circle check"></i>
  </button>`).join('');
  results.querySelectorAll('.recipient').forEach((button) => button.addEventListener('click', () => {
    selectedRecipient = { student_no: button.dataset.studentNo, full_name: button.dataset.fullName };
    results.querySelectorAll('.recipient').forEach((item) => item.classList.toggle('selected', item === button));
  }));
}

async function loadRecipients(search = '') {
  const { data, error } = await supabase.rpc('list_recitation_recipients', {
    p_student_no: user.studentNo,
    p_session_token: sessionToken,
    p_search: search.trim()
  });
  if (error) throw error;
  renderRecipients(data || []);
}

async function submitSetupPin(event) {
  event.preventDefault();
  const pin = pinValue('new');
  const confirmPin = pinValue('confirm');
  if (!/^\d{4}$/.test(pin)) return showToast('Enter all four PIN digits.', 'err');
  if (pin !== confirmPin) return showToast('The two PIN entries do not match.', 'err');
  const button = event.submitter;
  button.disabled = true;
  button.innerHTML = '<span class="loading"></span> Protecting wallet';
  try {
    const { data, error } = await supabase.rpc('setup_recitation_pin', { p_student_no: user.studentNo, p_session_token: sessionToken, p_pin: pin });
    if (error || !data?.success) throw new Error(friendlyError(error, data));
    closeModal('setupPinModal');
    clearPinGroup('new'); clearPinGroup('confirm');
    wallet.pinSet = true; renderWallet();
    showToast('Your Recitation wallet is now protected.');
  } catch (error) { showToast(error.message, 'err'); }
  finally { button.disabled = false; button.innerHTML = '<i class="ph-bold ph-shield-check"></i> Protect my wallet'; }
}

async function submitChangePin(event) {
  event.preventDefault();
  const currentPin = $('currentPin').value.replace(/\D/g, '');
  const newPin = $('newPin').value.replace(/\D/g, '');
  if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) return showToast('Both PINs must contain exactly four digits.', 'err');
  const button = event.submitter; button.disabled = true;
  try {
    const { data, error } = await supabase.rpc('change_recitation_pin', { p_student_no: user.studentNo, p_session_token: sessionToken, p_current_pin: currentPin, p_new_pin: newPin });
    if (error || !data?.success) throw new Error(friendlyError(error, data));
    event.target.reset(); closeModal('changePinModal'); showToast('Your wallet PIN has been updated.');
  } catch (error) { showToast(error.message, 'err'); }
  finally { button.disabled = false; }
}

function reviewTransfer(event) {
  event.preventDefault();
  const amount = Number($('transferAmount').value);
  if (!selectedRecipient) return showToast('Choose a classmate first.', 'err');
  if (!Number.isInteger(amount) || amount < 1) return showToast(errorMessages.invalid_amount, 'err');
  if (amount > Number(wallet.balance)) return showInsufficientBalance(amount);
  if (!wallet.pinSet) { openModal('setupPinModal'); return; }
  $('transferSummary').textContent = `Send ${number(amount)} chip${amount === 1 ? '' : 's'} to ${selectedRecipient.full_name}. This cannot be undone.`;
  $('transferPin').value = '';
  openModal('confirmTransferModal');
}

async function confirmTransfer(event) {
  event.preventDefault();
  const pin = $('transferPin').value.replace(/\D/g, '');
  if (!/^\d{4}$/.test(pin)) return showToast('Enter your four-digit PIN.', 'err');
  const button = $('confirmTransferButton'); button.disabled = true; button.innerHTML = '<span class="loading"></span> Sending securely';
  try {
    const { data, error } = await supabase.rpc('transfer_recitation', {
      p_student_no: user.studentNo,
      p_session_token: sessionToken,
      p_recipient_student_no: selectedRecipient.student_no,
      p_amount: Number($('transferAmount').value),
      p_pin: pin,
      p_note: $('transferNote').value.trim() || null
    });
    if (data?.code === 'insufficient_balance') {
      closeModal('confirmTransferModal');
      await loadWallet();
      showInsufficientBalance(Number($('transferAmount').value));
      return;
    }
    if (error || !data?.success) throw new Error(friendlyError(error, data));
    closeModal('confirmTransferModal');
    showToast(`Recitation sent securely to ${data.recipientName || selectedRecipient.full_name}.`);
    selectedRecipient = null; $('transferForm').reset();
    await Promise.all([loadWallet(), loadActivity(), loadRecipients('')]);
  } catch (error) { showToast(error.message, 'err'); }
  finally { button.disabled = false; button.innerHTML = '<i class="ph-bold ph-check-circle"></i> Confirm and send'; $('transferPin').value = ''; }
}

function showInsufficientBalance(requestedAmount) {
  const available = Number(wallet.balance) || 0;
  $('insufficientAvailable').textContent = `${number(available)} chip${Math.abs(available) === 1 ? '' : 's'}`;
  $('insufficientMessage').textContent = available <= 0
    ? `Your current balance is ${number(available)}. Earn more Recitation chips before sending to another student.`
    : `You need ${number(requestedAmount)} chips for this transfer, but only ${number(available)} ${available === 1 ? 'is' : 'are'} available.`;
  openModal('insufficientBalanceModal');
}

function initTheme() {
  const dark = localStorage.getItem('theme') === 'dark';
  document.body.classList.toggle('dark-theme', dark);
  $('themeIcon').className = dark ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
  $('themeToggle').addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    $('themeIcon').className = isDark ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
  });
}

window.logout = async () => {
  studentSessionGuard.stop(); await studentPresence.stop();
  try { await supabase.auth.signOut(); } catch (error) {}
  localStorage.removeItem('loggedInUser'); window.location.href = 'index.html';
};

createPinInputs('new'); createPinInputs('confirm'); initTheme();
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
document.querySelectorAll('.modal-backdrop').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(modal.id); }));
$('pinAction').addEventListener('click', () => openModal(wallet.pinSet ? 'changePinModal' : 'setupPinModal'));
$('setupPinForm').addEventListener('submit', submitSetupPin);
$('changePinForm').addEventListener('submit', submitChangePin);
$('transferForm').addEventListener('submit', reviewTransfer);
$('confirmTransferForm').addEventListener('submit', confirmTransfer);
$('recipientSearch').addEventListener('input', (event) => {
  clearTimeout(recipientTimer);
  recipientTimer = setTimeout(() => loadRecipients(event.target.value).catch((error) => showToast(friendlyError(error), 'err')), 220);
});
['currentPin', 'newPin', 'transferPin'].forEach((id) => $(id).addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4); }));

Promise.all([loadWallet(), loadActivity(), loadRecipients('')]).catch((error) => {
  showToast(friendlyError(error), 'err');
  $('activityList').innerHTML = '<div class="empty"><i class="ph ph-warning-circle"></i><b>Could not load Recitation</b><span>Please refresh after the database update is installed.</span></div>';
});
