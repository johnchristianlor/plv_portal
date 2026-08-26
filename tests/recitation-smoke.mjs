import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('supabase_migrations/20260826_recitation_wallet.sql');
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

test('admin awards require admin session and subject enrollment', () => {
  assert.match(migration, /recitation_admin_is_valid\(p_admin_session_token\)/i);
  assert.match(migration, /from public\.enrollments e/i);
  assert.match(migration, /subject_not_enrolled/i);
  assert.match(adminScript, /admin_award_recitation/);
  assert.match(adminScript, /admin_reset_recitation_pin/);
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
