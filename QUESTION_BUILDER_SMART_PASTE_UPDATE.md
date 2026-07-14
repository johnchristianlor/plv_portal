# Question Builder Smart Paste Update

## Added

- Editable section names with clear rename controls.
- Roman-numeral default section names: Section I, Section II, Section III, and so on.
- Inline Smart Paste in the Question field.
- Bulk Smart Paste for importing several questions into one selected section.
- Automatic detection of:
  - Multiple-choice questions and lettered choices
  - Correct-answer letters such as `Answer: B`
  - Correct-answer text
  - True or False questions
  - Short-answer / identification questions
  - Essay questions
  - Optional `Points: 2` or `Pts: 2` lines
- Preview before bulk import.
- Warning when a multiple-choice answer cannot be detected.
- Undo for inline Smart Paste.

## Supported example

```text
What is an iteration structure?

A. A structure used to declare variables
B. A structure used to repeat statements
C. A structure used to create classes
D. A structure used to import packages
Answer: B
```

Pasting that block into the Question field fills the question, choices, type, and correct answer automatically.

No database migration is required for this update.
