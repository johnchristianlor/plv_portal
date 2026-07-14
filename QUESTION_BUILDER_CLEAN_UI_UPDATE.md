# Question Builder Clean UI Update

## What changed

- Removed the large “Need to add many questions?” Smart Paste card from the normal page flow.
- Added a compact **Bulk Smart Paste** button in the Question Builder header.
- Smart Paste now opens in a focused modal window only when needed.
- The modal includes a three-step guide, section selector, paste area, detected-question preview, and import controls.
- Clicking outside the modal, pressing **Escape**, or selecting **Close** returns to the question review screen.
- Importing questions automatically closes the modal so the teacher can immediately review the section list.
- Existing per-section Smart Paste buttons now open the same modal with that section preselected.
- Pasting multiple question blocks into the normal question field also opens the modal automatically.

## Database impact

No database migration is required. This update changes only the admin Question Builder interface and interaction flow.
