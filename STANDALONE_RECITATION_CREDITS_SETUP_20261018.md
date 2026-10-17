# PLV Portal — Standalone Recitation and Plus-Point Entries

## Main behavior

Every **manual** conversion now creates a **new independent extra-credit score item**. It is **not added to, shown inside, or saved as** the student's original exam score. The original exam (`scores.score` and `activities.perfectScore`) never changes.

An administrator selects an existing major exam **only to determine the subject, section, grading period, and configured chip conversion ratio**. The new score item has its **own ID and title** in the incentive ledger, shows up as a **separate card under the Exam category** in Student Scores, and has its **own Excel/CSV export column**.

**Example:**

- Actual Midterm Exam: **35/40** (unchanged)
- Recitation Bonus #0001: **+2** (a separate score item)
- Leadership Incentive: **+1** (a separate score item)
- Combined earned: **38 points**, maximum remains **40 raw exam points**. The combined earned total may exceed the maximum because extra credit is outside the exam.

## Automatic naming does not mean automatic chip conversion

- Conversion is **never automatic**. An administrator must click **Convert chips** or approve **Convert section**.
- The *name* is automatic **if the title input is left blank**: `Recitation Bonus #0001`, `Recitation Bonus #0002`, etc. The title can also be customized.
- Each conversion approval gets its own **entry ID**, even if a custom title is reused. Repeated conversions do not silently merge into one existing bonus.
- A whole-section approval creates **one named class-wide item** with separate student scores for everyone eligible. Students without enough chips are skipped, untouched.
- With 3 chips = 1 point, 8 chips yields +2 and leaves 2; a wallet with 2 chips yields 0 and **no deduction**. Wallet rows are locked during conversion to avoid double spending.
- Old incentive entries are preserved and displayed independently. Existing admin and student access history remains intact.

## Deployment on an existing portal

1. Back up Supabase and trial-run in a staging project.
2. Your earlier October 18 base, manual, chip-preservation and named incentive SQL migrations must already be applied.
3. Go to **Supabase Dashboard → SQL Editor** and run `supabase_migrations/20261018_standalone_extra_credit_entries.sql`.
4. Deploy the updated `public/` files from the complete project or from the smaller patch ZIP to Cloudflare Pages **after** the SQL upgrade succeeds.
5. Hard-refresh the browser. In Admin → Exam Incentives, select a section, subject and an existing exam as a classification reference; save a rate (e.g. 3:1). Leave the conversion title blank and manually convert one student.
6. Verify Student Scores has **two distinct items**, an exam and a separate `Recitation Bonus #...`. Confirm the spreadsheet has an independent BONUS column and a combined total. Test a whole-section conversion and repeated conversion of the same student.

**Fresh installation order:** after the portal's existing recitation wallet and session tables:

1. `20261018_exam_incentives_and_admin_audit.sql`
2. `20261018_manual_recitation_conversion.sql`
3. `20261018_chip_preservation_manual_only.sql`
4. `20261018_named_bonus_and_portal_access.sql`
5. `20261018_standalone_extra_credit_entries.sql` (NEW)

> This SQL is an incremental upgrade. It is not a replacement for the original Supabase schema. Do not run only the last file on a fresh database.

## Regression checks

- Run `node --test tests/*.mjs` in the project directory. There are currently **93 passing automated checks**, including independent conversion IDs, raw exam score preservation, separate student cards, chip transaction protections, and export totals.
- Javascript syntax checks pass for `admin-incentives.js`, `exam-incentive-utils.mjs`, `student-recitation.js`, and the updated inline page scripts.
- These are local checks; **live Supabase permissions/functions and Cloudflare deployment have not been tested**. Test a small class in staging before using production student points.

Note: the **official posted grade fields** are not automatically recalculated or overwritten. Extra credits are counted in the combined earned-points totals and exports, not written into stored original exam grades.
