# Admin Records — Simplified Color-Coded Excel Export

## What changed

Open **Admin → Records → Export → Excel (.xlsx)**.

The default export now keeps only student number, student name, one column for each individual activity, and **one combined exam total**. Optional ranking, course grades, status and overall activities remain available via unchecked export options. It exports **one worksheet per subject and section**, rather than an extra duplicate Exam Totals worksheet.

Example column headings in Excel row 1:

| Student No. | Student Name | [MID] L-EXAM (/40) | [MID] Written Exam (/60) | [FIN] Lab Exam (/30) | [FIN] Written Exam (/70) | EXAMS TOTAL (/200) |
|---|---|---|---|---|---|---|
| 2026-001 | Ana Reyes | 38 | 50 | 27 | 65 | 180 |
| 2026-002 | Ben Santos | 0 | *(pending)* | *(pending)* | 50 | 50 |

Each **(/maximum)** in the header is dynamically calculated from the actual configured `perfectScore`, not hard-coded. Only activities in the **Major Exam** (`category='exam'`) category contribute to the combined exam column, whether laboratory or written. Regular activities may appear in the individual activity columns but do not inflate the exam total. Individual exam titles and the maximum come directly from the activity record.

The combined exam points are **numeric Excel formulas** summing only major-exam score cells, with cached results. Missing scores are left blank (not converted to a saved zero) and marked pale amber. A recorded `0` is a regular numeric zero. The combined total is highlighted amber and receives a cell note when any exam score is pending; the `/maximum` still includes every exam, including ones not yet recorded. A bold teal total is shown for completed sets. Percentages are not duplicated by default.

The Excel workbook uses **navy** headers for student details, **blue** for midterm, **purple** for finals, and **teal** for combined scores. Rows have subtle banding and thin separators; row 1 and the student-identifying columns are frozen. Excel filters and print-layout settings are enabled. Real .xlsx formatting is handled by a separately loaded, browser-compatible ExcelJS vendor (`vendor-loader.v2.js`), so the existing SheetJS workflows elsewhere on the site are unaffected. The v2 filename avoids browsers reusing a long-cached loader from previous deployments.

**CSV:** CSV is plain text and cannot preserve colors, frozen columns or cell notes. Its headers and column structure have also been made more compact. For CSV covering multiple classes, the exam-total header says that the maximum differs by class; filter to one class to get an exact `(/maximum)` header.

## Deploy

Deploy the updated website project to Cloudflare Pages. There is **no database migration** for this export-only update. If prior migrations from the attendance and grading update have not yet been run, apply those first. Internet access is needed the first time the updated Records page downloads the ExcelJS browser library from jsDelivr.

The included `SAMPLE_Compact_Exam_Export.xlsx` contains fictitious students to demonstrate the intended appearance. It is **not real student data**.

## Validation

`node --test tests/*.mjs` — **65 tests passed**, including subject/section isolation, four exam types, pending vs recorded zero, exact `(/max)` headers, Excel formula references, styling, and CSV behavior. This is a browser-mocked export test, **not** an end-to-end production download; verify one exported workbook on your deployed site.

## Numeric display cleanup (2026-10-16)

Whole-number scores, zeroes, and combined exam totals now use Excel's `0` number format, so they display as `40`, `0`, and `169` without a trailing dot or `.00`. The values stay numeric for direct copy/paste into another Excel workbook. True fractional scores remain fractional instead of being silently rounded, and optional Philippine university grade equivalents retain two decimal places. No database migration is required.
