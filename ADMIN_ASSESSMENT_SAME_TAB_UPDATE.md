# Admin Assessment Same-Page Update

## What changed

- Creating, editing, and managing assessment questions now happens inside `admin-assessments.html`.
- Admin assessment actions no longer call `window.open()` or require popup permissions.
- Added same-page navigation for My Tests, Details, Questions Manager, Results, and Anomaly Log.
- Added a contextual workspace bar with the current assessment title, a back-to-library action, and autosave status.
- Old assessment URLs containing `standalone=1` are automatically normalized to the regular admin layout.

## Performance improvements

- Draft storage is debounced instead of serializing the entire question bank on every keystroke.
- Shuffle settings update without rebuilding the complete question list.
- Section collapse/expand updates only the selected section instead of rerendering the whole builder.
- Off-screen assessment and question cards use `content-visibility` to reduce rendering work on long assessments.
- Duplicate initial question-list rendering was removed.

## Files changed

- `public/admin-assessments.html`
- `public/admin-assessments-module.js`

No database migration is required.
