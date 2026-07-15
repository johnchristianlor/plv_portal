# Assessment Library, Duplication, and Audit Trail Update

## Added

- A **Duplicate** action on every test card.
- A guided duplication dialog where the teacher can:
  - rename the copied test;
  - assign it to a different class section;
  - optionally retain the original open and close dates.
- Every duplicate is created as a **Draft** to prevent accidental student access.
- All internal exam sections, questions, choices, correct answers, points, random-pick settings, shuffle settings, and security settings are copied.

## Improved My Tests

- Redesigned professional test cards with clearer status, subject, class section, duration, question count, submission count, anomaly count, and schedule information.
- Added search, status filtering, and class-section filtering.
- Organized primary actions separately from results, duplication, audit, and deletion actions.

## Improved Anomaly Log

- Added a test/exam filter, event-type filter, and search field.
- Added summary counters for visible events, affected students, high-priority events, and the latest event.
- Each audit row now displays the assessment title, class section, student number, readable event name, severity, date, time, and details.
- Added server-side filtering and assessment information to anomaly-log results.

## Database

No new table or manual migration is required. The assessment API automatically creates two supporting indexes for faster test-based attempt and anomaly queries.
