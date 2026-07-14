# Assessment Builder and Secure Exam Update

The assessment module now supports:

- Multiple named sections inside one assessment.
- A question-bank control for each section.
- Random selection, such as choosing 30 questions from a bank of 50.
- Independent question-order and choice-order shuffling for each section.
- Dynamic multiple-choice options with **Add Option**, remove, and correct-answer selection.
- Fixed True/False choices.
- Stable server-side randomization: the selected questions and their order are stored for the student's attempt, so refreshing or submitting does not generate a different set.
- Dedicated administrator tabs for assessment details and question creation.
- A dedicated student secure-exam tab with preflight checks, autosave, resume, navigation, review, and anomaly logging.
- Per-assessment security controls for fullscreen, anomaly limit, and automatic submission.
- Server-side submission when the anomaly limit is reached.

## How random picking works

Open **Questions Manager**, select **Question Bank**, and enter a pick count for each section.

- `0` means use every question in that section.
- A number smaller than the available question count randomly selects that many questions.
- **Shuffle questions** changes the order of the selected questions.
- **Shuffle choices** changes the displayed choice order while keeping grading correct.

## Deployment

No new assessment database table is required. Section definitions, randomization, and security settings are saved in the assessment `settings_json`, while each question's existing `category` field stores its section ID.

Deploy both of these parts together:

- `public/` for the updated administrator and student interfaces.
- `functions/api/assessments/[[path]].js` for server-side saving, stable attempts, autosave, anomaly logging, automatic submission, and grading.

Read `SECURE_ASSESSMENT_INTEGRATION.md` for the complete workflow and verification checklist.
