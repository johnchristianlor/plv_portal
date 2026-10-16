# Admin Records – Combined Major Exam Export (October 16, 2026)

## New Excel output

From **Admin → Master Records → Export**, check **Combined exam points / max score (Midterm, Final & Overall)** (checked by default) and choose **Excel (.xlsx)**.

- **Exam Totals**: a dedicated first worksheet showing every selected student with **Midterm Exam Points / Max**, **Final Exam Points / Max**, **Combined Exam Points / Max**, **Combined Exam %**, **Exams Graded**, and **Exams Pending**.
- **Subject - Section** worksheets: existing individual activity, rank, grade and status columns, plus the same exam subtotal/combined columns. Each worksheet is scoped to one specific subject **and** section; activity scores from other classes will not appear in the class sheet.
- **CSV**: the nine exam-total columns are included as well, when enabled. CSV has one flat table, not multiple sheets.

Example for a student with four major exams:

| Exam | Earned | Maximum |
|---|---:|---:|
| Midterm Laboratory | 40 | 50 |
| Midterm Written | 75 | 100 |
| Final Laboratory | 35 | 40 |
| Final Written | 54 | 60 |
| **Combined** | **204** | **250** |

Combined raw exam percentage = 204 / 250 = **81.60%**. This is **not** the official numerical grade, a weighted course average, or the existing Total Score (which includes written output and performance activities). It is the point-based raw exam percentage, suitable for reconciling a collection of different-length major examinations.

Only activities whose **category is `exam`** are included. Laboratory and written exams should both be created under the *Major Exam* category, not the *Written Output* category, if they should contribute to this exam total. The records export considers its existing **midterm and final** periods. When a score is **unrecorded**, its exam maximum is still included, but the score is not silently marked 0: the **Exams Pending** count identifies it. A recorded score of 0 is counted as graded. **Combined Exam %** is saved to Excel as a numeric cell with percentage formatting, so it can be used for sorting, formulas and calculations.

## Reliability enhancement

Admin Records previously fetched the first Supabase query page (often 1,000 records); a busy school may have more scores than that. The page now retrieves all enrollment, activity and score pages in stable order before computing/exporting totals, avoiding missing exam scores solely due to query limits.

## Deployment

Deploy this zip as the updated Cloudflare Pages project, keeping your existing Supabase environment settings. This change is to the website's JavaScript/HTML and needs **no new SQL migration**. If you have not deployed the previous **Attendance, Grading and Exam Totals** update, follow `GRADING_ATTENDANCE_EXAMS_UPDATE_20261016.md` first, including its database migration.

## Validation

- `node --test tests/*.mjs`: **62 tests passed** (includes tests for four different exams, different section/subject codes, pending vs 0, generated Excel sheet structure and CSV totals).
- Both embedded scripts in `public/admin-records.html` passed `node --check` after import removal for parsing.
- Export was exercised using a deterministic SheetJS-compatible test double; live Excel downloads should still be checked against your real deployed portal and actual Supabase records.
