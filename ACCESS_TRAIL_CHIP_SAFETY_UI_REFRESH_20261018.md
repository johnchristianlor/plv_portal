# PLV Portal — Access Trail and Safe Manual Conversion Refresh (October 18, 2026)

## What's changed

- **Administrator Dashboard / Access Trail:** Uses the portal's established blue/gold glass-card visual language, consistent heading, icon, statistics for the most recent 50 events, aligned table, administrator avatar initials, sign-in/sign-out pills, and separate PHT date/time. Scrollable on phones, responsive at desktop/mobile widths, and dark-mode support. Count cards reflect *the last 50 displayed events*, not lifetime totals.
- **Exam Incentives:** Conversion actions now keep their labels legible at narrow widths ("Convert chips", "Convert section", row "Convert"). The selected student's preview explicitly shows how many chips are eligible and how many stay in the wallet. Individual approval confirmation also shows proposed cost and remainder.
- **Student Recitation:** The old horizontal status sheet is now a grid of high-contrast **exam cards**. Each card shows a yellow pending or green converted badge, a prominent chip counter, saved conversion rate, previously converted points, chips previously spent, eligible points, and expected retained wallet chips. Cards stack cleanly on phones. Shared wallet semantics are kept.
- **Database:** `20261018_chip_preservation_manual_only.sql` redefines the *manual-only* atomic wallet redemption function to make conservation rules explicit: incomplete chip groups remain untouched; a full exam keeps all chips; an exact group converts at the configured rate; unused chips remain in the wallet; an invalid or obsolete automatic route is rejected. A wallet row is locked before calculating debit; both debit and ledger credit are in one transaction.

## How to install

1. **Back up the live Supabase database.** Test in a staging project with sample students before production.
2. If the existing Exam Incentives and Manual Recitation Conversion migrations are already installed, open **Supabase > SQL Editor** and run only:
   `supabase_migrations/20261018_chip_preservation_manual_only.sql`
3. On a fresh installation, run these three SQL scripts **in order**, after installing the recitation wallet and administrator session schemas:
   - `20261018_exam_incentives_and_admin_audit.sql`
   - `20261018_manual_recitation_conversion.sql`
   - `20261018_chip_preservation_manual_only.sql`
4. Deploy the **complete updated `public/` directory** (and corresponding Cloudflare project functions/config if appropriate), or copy the files in the smaller patch ZIP to the corresponding paths in your deployed project.
5. Hard-refresh the browser (Ctrl+Shift+R). Verify admin login/out records, an eligible single-student conversion, a below-rate student, a section conversion, and the student's recitation card.

## Point conservation examples (rate = 3 chips per 1 exam point)

| Balance before | Exam headroom | Exam points earned | Chips deducted | Chips left |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 10 | 0 | 0 | 2 |
| 3 | 10 | 1 | 3 | 0 |
| 8 | 10 | 2 | 6 | 2 |
| 8 | 1 | 1 | 3 | 5 |
| 8 | 0 | 0 | 0 | 8 |

**Note:** An exact threshold of 3 is valid for one point, so all 3 chips are deducted **only when the administrator approves**. "Keep the chips" applies when below the threshold, already at the exam cap, or to any partial chip remainder. Nothing happens automatically.

**Important caveat:** Recitation points are stored in the portal's existing **shared wallet**. The UI uses the same available balance when previewing different exam rules; once one exam is manually converted, that shared balance decreases for the other exams. The database performs the authoritative calculation when the admin confirms, so previews may change if another admin awards/spends chips.

## Validation

- `node --test tests/*.mjs`: **83 tests passed**, including new conservation rules and UI presence checks.
- Browser render inspected at **1440px desktop and 390px mobile** across Dashboard, Exam Incentives and Student Recitation; no document-level horizontal overflow in the samples.
- **Not tested on the live Supabase database** or deployed site. SQL file contains no destructive ledger deletion, but migration should be tested with a backup first.
