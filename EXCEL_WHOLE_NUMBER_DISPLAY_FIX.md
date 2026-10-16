# Admin Records — no trailing decimal point in Excel scores

## What changed
- Excel **raw activity points and exam combined points** now display as whole numbers when the underlying values are whole (e.g. `40`, `0`, `169`, never `40.` or `40.00`).
- These are **numeric Excel cells**, not text, so they work with formulas and can be pasted into another workbook.
- Actual fractional point scores are retained (e.g. `19.5`, not silently rounded to `20`), to avoid changing recorded academic scores.
- Optional university grade equivalents deliberately keep the `0.00` format because `1.00`, `1.25`, etc. are meaningful grade values.
- The standalone sample workbook includes the revised formatting.

## Deployment
Deploy the updated `public/` folder or project to Cloudflare Pages. No new Supabase migration is needed.

## Test
`node --test tests/*.mjs` (66 passing tests at packaging time).
