import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAndSortLedger, filterAndSortWallets } from '../public/admin-recitation-utils.mjs';

const wallets = [
  { student_no: '2026-10', full_name: 'Zoey Cruz', section: 'B', balance: 0, pin_set: false },
  { student_no: '2026-02', full_name: 'Ana Reyes', section: 'A', balance: 12, pin_set: true },
  { student_no: '2026-01', full_name: 'Ben Santos', section: 'A', balance: -2, pin_set: true },
];

test('wallet roster filters operational states and sorts predictably', () => {
  assert.deepEqual(filterAndSortWallets(wallets).map((row) => row.full_name), ['Ana Reyes', 'Ben Santos', 'Zoey Cruz']);
  assert.deepEqual(filterAndSortWallets(wallets, { status: 'protected', sort: 'balance_desc' }).map((row) => row.full_name), ['Ana Reyes', 'Ben Santos']);
  assert.deepEqual(filterAndSortWallets(wallets, { status: 'negative' }).map((row) => row.full_name), ['Ben Santos']);
  assert.deepEqual(filterAndSortWallets(wallets, { status: 'zero' }).map((row) => row.full_name), ['Zoey Cruz']);
  assert.equal(wallets[0].full_name, 'Zoey Cruz', 'sorting must not mutate the RPC result order');
});

const ledger = [
  { transaction_type: 'award', from_name: 'Instructor', to_name: 'Ana Reyes', section: 'A', subject_code: 'IT101', amount: 2, created_at: '2026-09-01T08:00:00Z' },
  { transaction_type: 'transfer', from_name: 'Ben Santos', to_name: 'Zoey Cruz', section: 'B', subject_code: 'IT102', amount: 5, created_at: '2026-09-02T08:00:00Z' },
];

test('ledger search covers people and course metadata with selectable ordering', () => {
  assert.deepEqual(filterAndSortLedger(ledger).map((row) => row.transaction_type), ['transfer', 'award']);
  assert.deepEqual(filterAndSortLedger(ledger, { query: 'it101' }).map((row) => row.to_name), ['Ana Reyes']);
  assert.deepEqual(filterAndSortLedger(ledger, { query: 'zoey' }).map((row) => row.transaction_type), ['transfer']);
  assert.deepEqual(filterAndSortLedger(ledger, { sort: 'amount_asc' }).map((row) => row.amount), [2, 5]);
});
