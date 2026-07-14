# Question Builder UI/UX Redesign

## What changed

- Added a three-step guided workflow:
  1. Choose the question type.
  2. Type or paste the question.
  3. Review and organize saved questions.
- Added large, plain-language question-type cards for Multiple Choice, True/False, Identification, and Essay.
- The editor now displays only the fields required by the chosen question type.
- Kept single-question Smart Paste. Pasting a full question block automatically fills the question, choices, correct answer, and points when available.
- Added a separate bulk Smart Paste panel with a clear section selector and preview step.
- Added direct question-type buttons inside each section so teachers can add a question to the correct section with one click.
- Kept editable section names, random question selection, question shuffling, choice shuffling, dynamic choices, and question-bank controls.
- Improved mobile responsiveness and added clearer helper text for non-technical users.

## Smart Paste example

```text
What is an iteration structure?

A. A structure used to declare variables
B. A structure used to repeat statements
C. A structure used to create classes
D. A structure used to import packages
Answer: B
```

## Validation performed

- Checked JavaScript syntax for all project JavaScript files.
- Checked the revised HTML for duplicate element IDs.
- Confirmed the guided builder retains the IDs and event hooks required by the existing save, autosave, Smart Paste, section, and question-bank logic.

No database migration is required.
