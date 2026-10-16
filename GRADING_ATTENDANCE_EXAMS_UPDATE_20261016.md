# PLV Portal – Attendance, Grading and Exam Totals (2026-10-16)

## What's changed

### Scores and attendance are independent

- A student marked **Absent (A)** or **Excused (E)** on an activity's date can still receive a score in Admin Activities, including a late submission during completion week.
- The administrator's grading roster displays attendance badges alongside editable score fields and includes **Absent** and **Excused** filters.
- Clearing the score sets it to **Pending/Ungraded**; entering `0` stores a real zero. Neither action edits attendance.
- Bulk-imported grades no longer skip absent students.
- The Student Scores page and the **Recent Activity Scores** section of the student home dashboard display **Absent/Excused** independently of the score. Example: **Absent on date · 35 / 50**.
- Existing stored scores are no longer deleted merely because attendance is later marked absent.

### Major Exams (40% category)

- Open an exam in **Admin → Activities Setup → Manual Entry**.
- A new **Combined Major Exams** table appears below the editable roster.
- It combines all `exam` category activities for the **same subject, section, and grading period**, regardless of exam title (such as Written Exam and Lab Exam).
- Each student gets separate exam columns, combined earned points, combined maximum points, raw percentage, and a pending count.
- Example: Lab `40 / 50` + Written `75 / 100` = **115 / 150**, raw **76.67%**.
- **Pending is not saved as zero**: the UI shows pending and includes the exam maximum in the possible-points denominator. This keeps progress honest and makes it clear when a category grade is provisional.
- The Student Scores page also shows the combined exam earned/maximum total; its existing 30% / 30% / 40% category weights are preserved.

### Percentage to number-grade conversion

The student and admin grade-conversion functions now use **one shared module**, `public/grade-scale.mjs`.

| Percentage (exact, decimal-safe) | Numeric grade |
| --- | --- |
| 97 through 100 inclusive | 1.00 |
| 94 to below 97 | 1.25 |
| 91 to below 94 | 1.50 |
| 88 to below 91 | 1.75 |
| 85 to below 88 | 2.00 |
| 82 to below 85 | 2.25 |
| 79 to below 82 | 2.50 |
| 76 to below 79 | 2.75 |
| 75 to below 76 | 3.00 |
| Below 75 | 5.00 |

The conversion does **not** round fractional percentages before comparing them. In particular, 74.99 = 5.00, 75.00 = 3.00, 96.99 = 1.25, and 97.00 = 1.00. Percentages outside 0–100 are invalid. This preserves the preexisting cutoff policy but removes ambiguity between the printed integer ranges and real decimal grades. Confirm the official registrar rounding policy before changing the thresholds.

## Deployment – important

1. Back up the database and current Cloudflare Pages project.
2. If not already applied, execute the previous database repair at `supabase_migrations/20260903_repair_activity_score_storage.sql` using the Supabase SQL Editor (this project includes it).
3. **Execute `supabase_migrations/20261016_scores_independent_of_attendance.sql` in Supabase SQL Editor.** This is a REQUIRED step. It removes the previous database triggers that rejected/deleted absent students' grades and revises the atomic grade writer. It does not modify attendance rows or weaken the requirement that students be enrolled to receive scores.
4. Deploy the source to the same Cloudflare Pages project, including the `public/` folder and `functions/` folder. Retain your existing Cloudflare environment variables and secrets; these are not included in this ZIP.
5. Verify with an administrator account: mark a test student Absent, record 35/50 in an activity on that date, save, reload; then check that attendance still says Absent and that 35/50 appears on both student score pages and recent home scores. Repeat with Excused. Create two exam activities in the same section/period and verify their combined totals.

**Important:** The previous database trigger may already have deleted some historic scores when attendance was changed to Absent. This migration stops future deletion, but cannot automatically reconstruct scores that are already missing. Restore missing historical grades from your existing backups or teacher records as needed.

This package is **source code + SQL migration**, not a live deployment. No changes have been made to your existing Supabase project or `plv-portal.pages.dev` deployment.

## Validation performed

`node --test tests/*.mjs` – **56 tests passed**. Embedded module/classic script syntax checked for the modified HTML pages. Runtime behavior still needs the normal post-deployment smoke test against your school's actual Supabase instance.
