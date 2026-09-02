import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('supabase_migrations/20260826_recitation_wallet.sql');
const adjustmentMigration = read('supabase_migrations/20260827_recitation_admin_adjustments.sql');
const ledgerFilterMigration = read('supabase_migrations/20260827_recitation_ledger_filters.sql');
const studentPage = read('public/student-recitation.html');
const studentScript = read('public/student-recitation.js');
const adminPage = read('public/admin-recitation.html');
const adminScript = read('public/admin-recitation.js');

test('Recitation database uses protected wallets and an auditable ledger', () => {
  assert.match(migration, /create table if not exists public\.recitation_wallets/i);
  assert.match(migration, /create table if not exists public\.recitation_transactions/i);
  assert.match(migration, /alter table public\.recitation_wallets enable row level security/i);
  assert.match(migration, /revoke all on table public\.recitation_wallets from anon, authenticated/i);
  assert.match(migration, /pin_hash text/i);
  assert.doesNotMatch(migration, /\bpin\s+(?:text|varchar|character)/i);
  assert.match(migration, /crypt\(p_pin, gen_salt\('bf'/i);
  assert.match(migration, /failed_pin_attempts \+ 1 >= 5/i);
});

test('student transfers are atomic, balance checked, and same-section only', () => {
  assert.match(migration, /create or replace function public\.transfer_recitation/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /v_recipient\.section is distinct from v_sender\.section/i);
  assert.match(migration, /v_wallet\.balance < p_amount/i);
  assert.match(migration, /set balance = balance - p_amount/i);
  assert.match(migration, /set balance = balance \+ p_amount/i);
  assert.match(migration, /insert into public\.recitation_transactions/i);
});

test('admin adjustments require admin session and subject enrollment', () => {
  assert.match(migration, /recitation_admin_is_valid\(p_admin_session_token\)/i);
  assert.match(migration, /from public\.enrollments e/i);
  assert.match(migration, /subject_not_enrolled/i);
  assert.match(adminScript, /admin_adjust_recitation/);
  assert.match(adminScript, /admin_reset_recitation_pin/);
});

test('admins can reduce balances below zero while transfers remain balance-gated', () => {
  assert.match(adjustmentMigration, /drop constraint if exists recitation_wallets_balance_check/i);
  assert.match(adjustmentMigration, /transaction_type in \('award', 'deduction', 'transfer'\)/i);
  assert.match(adjustmentMigration, /v_delta := case when v_transaction_type = 'deduction' then -p_amount else p_amount end/i);
  assert.match(adjustmentMigration, /balance = public\.recitation_wallets\.balance \+ excluded\.balance/i);
  assert.match(migration, /v_wallet\.balance < p_amount/i);
  assert.match(studentPage, /id="insufficientBalanceModal"/i);
  assert.match(studentScript, /showInsufficientBalance/);
});

test('student wallet uses secure RPCs and never stores a PIN locally', () => {
  for (const rpc of ['get_recitation_wallet', 'setup_recitation_pin', 'change_recitation_pin', 'list_recitation_recipients', 'transfer_recitation', 'get_recitation_transactions']) {
    assert.match(studentScript, new RegExp(rpc));
  }
  assert.doesNotMatch(studentScript, /localStorage\.setItem\([^\n]*pin/i);
  assert.doesNotMatch(studentScript, /\.from\(['"]recitation_(?:wallets|transactions)['"]\)/i);
  assert.match(studentPage, /inputmode="numeric"/i);
  assert.match(studentPage, /recitation-token\.png/);
});

test('Recitation pages expose responsive navigation throughout the portal', () => {
  assert.match(studentPage, /mobile-nav-bar/);
  assert.match(adminPage, /mobile-nav-bar/);
  assert.match(studentPage, /plv-responsive\.css\?v=20260826global1/);
  assert.match(adminPage, /plv-responsive\.css\?v=20260826global1/);
  assert.equal(fs.existsSync(path.join(root, 'public/recitation-token.png')), true);

  const portalPages = fs.readdirSync(path.join(root, 'public'))
    .filter((name) => /^(?:admin|student)-.*\.html$/.test(name))
    .filter((name) => read(`public/${name}`).includes('mobile-nav-bar'));
  for (const name of portalPages) {
    const source = read(`public/${name}`);
    const target = name.startsWith('admin-') ? 'admin-recitation.html' : 'student-recitation.html';
    assert.match(source, new RegExp(`href=["']${target.replace('.', '\\.')}["']`), `${name} must link to Recitation`);
  }
});

test('Recitation client modules have the expected session guards', () => {
  assert.match(studentScript, /startStudentSessionGuard/);
  assert.match(adminScript, /startAdminSessionGuard/);
  assert.match(studentScript, /p_session_token: sessionToken/);
  assert.match(adminScript, /p_admin_session_token: sessionToken/);
});

test('student Recitation matches portal branding and mounts the notification center', () => {
  assert.match(studentPage, /<div class="logo-text"><h2>PLV<\/h2><p>Pamantasan ng<br>Lungsod ng Valenzuela<\/p><\/div>/);
  assert.match(studentPage, /aria-label="Open notifications"/);
  assert.match(studentPage, /src="\.\/student-notifications\.js"/);
});

test('admin Recitation offers a guided adjustment workflow and filtered ledger', () => {
  assert.match(adminPage, /id="selectedStudentCard"/);
  assert.match(adminPage, /class="quick-amounts"/);
  assert.match(adminPage, /id="balanceImpact"/);
  assert.match(adminPage, /id="ledgerSectionFilter"/);
  assert.match(adminPage, /id="ledgerTypeFilter"/);
  assert.match(adminScript, /const section = \$\('ledgerSectionFilter'\)\.value/);
  assert.match(adminScript, /const transactionType = \$\('ledgerTypeFilter'\)\.value/);
  assert.match(adminScript, /p_section: section/);
  assert.match(adminScript, /p_transaction_type: transactionType/);
  assert.match(adminScript, /isMissingRpc\(error, 'admin_get_recitation_transactions'\)/);
  assert.match(adminScript, /p_limit: 250/);
  assert.match(adminScript, /isMissingRpc\(error, 'admin_adjust_recitation'\)/);
  assert.match(adminScript, /admin_award_recitation/);
  assert.match(ledgerFilterMigration, /t\.section = p_section/i);
  assert.match(ledgerFilterMigration, /t\.transaction_type = p_transaction_type/i);
  assert.match(adjustmentMigration, /notify pgrst, 'reload schema'/i);
  assert.match(ledgerFilterMigration, /notify pgrst, 'reload schema'/i);
});

test('admin Recitation has professional scrollable rosters with complete filtering and sorting', () => {
  for (const id of ['studentSearch', 'sectionFilter', 'walletStatusFilter', 'walletSort', 'resetWalletFilters', 'ledgerSearch', 'ledgerSectionFilter', 'ledgerTypeFilter', 'ledgerSort']) {
    assert.match(adminPage, new RegExp(`id=["']${id}["']`));
  }
  assert.match(adminPage, /class="table-wrap wallet-table-wrap"[^>]+tabindex="0"[^>]+role="region"/);
  assert.match(adminPage, /class="table-wrap ledger-table-wrap"[^>]+tabindex="0"[^>]+role="region"/);
  assert.match(adminScript, /filterAndSortWallets/);
  assert.match(adminScript, /filterAndSortLedger/);
  assert.match(adminScript, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  assert.match(read('public/recitation.css'), /\.admin-recitation-page \.data-table thead\{position:sticky;top:0/);
  assert.match(read('public/recitation.css'), /\.admin-recitation-page \.wallet-table th:last-child,[^{]+\{position:sticky;right:0/);
  assert.match(read('public/recitation.css'), /@media\(max-width:720px\)[\s\S]+\.admin-recitation-page \.wallet-table tr\{display:grid/);
});
