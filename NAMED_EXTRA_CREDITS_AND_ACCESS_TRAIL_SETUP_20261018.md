# PLV Portal — Named Exam Bonuses and Complete Access Trail

## Changes

### Exam bonuses are separate score entries

An exam's **original mark and maximum are never edited** by an incentive. For example:

| Row | Earned | Maximum |
| --- | ---: | ---: |
| Midterm Major Exam | 35 | 40 |
| Recitation Bonus (named credit) | +2 | — |
| Participation Bonus (named credit) | +1 | — |
| **Exam and bonuses combined** | **38** | **40 raw exam maximum** |

The combined earned score may **exceed the raw examination maximum** when enough extra credit is awarded. This is intentional extra credit, **not** a change to the examination's `perfectScore`. The official enrollment grade fields are not automatically recalculated.

- In **Admin → Exam Incentives**, choose the parent examination (it determines the subject, section and term), name a bonus (such as “Midterm Participation Bonus”) and enter points. One or multiple distinct named bonus entries can be granted to a student.
- For **recitation**, set the conversion ratio (such as 3 chips for 1 bonus point), type the title (such as “Midterm Recitation Bonus”) and manually approve one student or a whole section. There is **no automatic conversion**.
- Only complete chip groups are spent: at a 3:1 rate, 8 chips earn 2 bonus points and leave 2 chips. An insufficient balance is untouched. Conversions use a locked wallet row and transactional database update.
- The **Student Scores** page shows the raw exam score together with separate named extra-credit lines, and the **Student Recitation** page shows the historical named bonuses and wallet-conversion state.
- **Admin Records Excel / CSV** includes an individual column for each named credit (with type **PLUS POINTS** or **RECITATION**) and a combined **EXAMS + BONUS TOTAL**. Raw exam cells remain raw. All-Activities totals also count incentives, without increasing the raw activities maximum.
- Previously stored manual bonuses and conversions stay in the ledger and are backfilled with names. No previous history is deleted. The previous conversion rate snapshot is kept.

### Portal Access Trail (administrators and students)

- Dashboard shows both **administrator** and **student** login and explicit logout events.
- Filter by Philippine-local **start date**, **end date**, **account type**, **action**, and **name/email**. Includes search debounce, pagination, refresh and reset.
- Filtering occurs in the database across the retained event history, not only the last 50 rows.
- Historical administrator events are retained. Student tracking begins **after this migration and the updated frontend are deployed**; past student logins cannot be backfilled accurately.
- Closing a tab, losing internet access, or going idle is not counted as an explicit logout. No raw token or password is written to the event table; only an irreversible session fingerprint is stored.

## Installing an update to the October 18 manual-conversion version

1. Back up the Supabase database and test this upgrade on a nonproduction project first.
2. **Supabase Dashboard → SQL Editor:** execute **only** `supabase_migrations/20261018_named_bonus_and_portal_access.sql` after the previous migrations are present.
3. Deploy the updated `public/` folder to Cloudflare Pages. Deploy all changed `.html`, `.css`, `.js` and `.mjs` files together. A fresh user session may be needed after updating.
4. Verify: original exam 35/40 + separately titled bonus +3, named columns and total 38 in XLSX, a 2-chip wallet at 3:1 costs **zero**, 8 chips costs **six**, and both student/admin sign-ins and explicit sign-outs appear in the dashboard.

### Fresh installation order

Install your portal's **existing recitation wallet and student/admin session SQL first**, then run these portal migrations in order:

1. `20261018_exam_incentives_and_admin_audit.sql`
2. `20261018_manual_recitation_conversion.sql`
3. `20261018_chip_preservation_manual_only.sql`
4. **`20261018_named_bonus_and_portal_access.sql`** (this upgrade)

## Validation and limitations

- `node --test tests/*.mjs` runs project smoke tests and extra tests for named credits, Excel formulas, wallet arithmetic and event-audit wiring.
- Tested with local browser views at 1440px and 390px for Dashboard, Incentives, Student Recitation. No document-wide horizontal overflow seen in these sample layouts.
- **No live Supabase database migration or production Cloudflare deployment has been performed.** SQL correctness and concurrent transactions require a staging deployment before production.
- This upgrade does **not** introduce a bonus reversal/delete action. Named awards and approved conversions are append-only historical entries. To correct a mistake, contact the administrator responsible for database maintenance rather than editing raw exam marks or wallet chips manually.
- This portal uses a **shared recitation wallet** across subjects; a manual conversion for one subject reduces chips available for another.

This guide supersedes the earlier October 18 Exam Incentives setup instructions where they describe capped bonus scores or an administrator-only access trail.
