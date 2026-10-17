import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const recitation=read('public/student-recitation.html');
const recitationJS=read('public/student-recitation.js');
const scores=read('public/student-scores.html');
const stylesheet=read('public/student-score-bonuses.css');

test('Scores credits have a single title, subtle type, and bonus amount, without developer-facing copy',()=>{
  assert.match(scores,/activity-item standalone-credit/);
  assert.match(scores,/bonus-credit-amount/);
  assert.match(scores,/entry\.entry_title/);
  assert.doesNotMatch(scores,/New separate score item|Counts toward total, not the original examination mark/);
  assert.match(scores,/totalScore \+= myScore;/);
  assert.match(scores,/totalScore \+= points;/);
  assert.match(stylesheet,/dark-theme|\.standalone-credit/);
});
test('Recitation overview shows three easy to read totals and approved history only',()=>{
  assert.match(recitation,/id="conversionOverviewChips"/);
  assert.match(recitation,/id="conversionOverviewPoints"/);
  assert.match(recitation,/id="conversionOverviewExams"/);
  assert.match(recitationJS,/named-incentive-list/);
  assert.match(recitationJS,/\.startsWith\('recitation_'\)/);
  assert.doesNotMatch(recitationJS,/Your wallet chips are shared across subjects|exam points converted as separate credits/);
  assert.doesNotMatch(recitationJS,/SEPARATE SCORE ITEMS|NOT PART OF YOUR EXAM MARK/);
});
test('Conversion overview waits for latest wallet data before calculating a preview',()=>{
  assert.match(recitationJS,/loadWallet\(\)\.then\(loadExamConversionStatus\)/);
  assert.match(recitationJS,/await loadWallet\(\);\s*await Promise\.all\(\[loadActivity\(\), loadRecipients\(''\), loadExamConversionStatus\(\)\]\)/);
  assert.match(recitationJS,/walletBalance/);
});
