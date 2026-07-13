# Assessment Builder Update

The assessment module now supports:

- Multiple named sections inside one assessment.
- A question bank control for each section.
- Random selection, such as choosing 30 questions from a bank of 50.
- Independent question-order and choice-order shuffling for each section.
- Dynamic multiple-choice options with Add Option, remove, and correct-answer selection.
- Fixed True/False choices.
- Stable server-side randomization: the selected questions and their order are stored for the student's attempt, so refreshing or submitting does not generate a different set.
- Section labels in the student exam screen.

## How random picking works

Open **Questions Manager**, select **Question Bank**, and enter a pick count for each section.

- `0` means use every question in that section.
- A number smaller than the available question count randomly selects that many questions.
- **Shuffle questions** changes the order of the selected questions.
- **Shuffle choices** changes the displayed choice order while keeping grading correct.

## Deployment

No new database table is required. Section definitions and shuffle settings are saved in the assessment `settings_json`, while each question's existing `category` field stores its section ID.

Deploy both of these parts together:

- `public/` for the updated admin and student interface.
- `functions/api/assessments/[[path]].js` for server-side saving, random selection, stable attempts, and grading.

## Basic verification

1. Create an assessment and save its details.
2. Open **Questions Manager**.
3. Add two sections.
4. Add several questions to each section.
5. Open **Question Bank** and set a pick count smaller than the available count.
6. Enable question and/or choice shuffling.
7. Publish the assessment and start it with a student account.
8. Refresh the exam and confirm that the same selected question set remains.
