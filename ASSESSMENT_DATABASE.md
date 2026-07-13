# Assessment Database

Turso stores immutable assessment details: assessments, versions, questions, choices, attempts, answers, manual grades, incidents, audit logs, and score sync outbox.

Supabase stores only Auth, profiles, academic portal tables, and final assessment score summaries.

Published versions are immutable. Editing an assessment creates a new version so review always shows the exact question version answered.
