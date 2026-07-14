# Secure Assessment Integration

This build integrates the separate admin and student examination flow into the existing PLV Portal assessment module.

## Admin workflow

- **New Test**, **Edit**, and **Questions** open a dedicated assessment workspace in another browser tab.
- The dedicated workspace includes quick navigation for **Details**, **Questions**, and the **Assessment Library**.
- Question creation remains connected to the same assessment record and autosave flow.
- Assessments support named sections, question-bank pick counts, question shuffling, choice shuffling, dynamic multiple-choice options, and correct-answer selection.
- Security settings are configurable per assessment:
  - Require fullscreen
  - Anomaly limit
  - Automatically submit when the anomaly limit is reached

## Student workflow

- **Open Secure Exam** opens `student-exam.html` in a dedicated tab.
- Before starting, the student sees an exam pre-check, system status, rules, duration, and anomaly limit.
- The server assigns and stores a stable randomized question set for the attempt.
- Answers, current question position, timer deadline, and violation count survive refresh and reconnection.
- The secure exam provides section-based navigation, answer progress, flag-for-review, final review, and submission confirmation.

## Security controls

The exam detects or blocks common browser-level anomalies, including:

- Leaving or hiding the assessment tab
- Browser-window focus loss
- Fullscreen exit
- Duplicate assessment tabs or windows
- Copy, cut, paste, drag-and-drop, and right-click
- Printing and common restricted shortcuts
- Browser-back navigation
- Network interruption
- Closing or unloading the exam page

Each incident is recorded on the server. When the configured anomaly limit is reached, the server grades the latest autosaved answers and submits the attempt, even if the client fails before it can send a separate submission request.

## Important limitation

A normal web browser cannot completely prevent cheating, screenshots from another device, external messaging, virtual machines, or operating-system-level actions. These controls reduce common opportunities and create auditable signals for instructor review; they should not be described as absolute prevention.

## Deployment

Deploy these together:

- `public/`
- `functions/api/assessments/[[path]].js`

No additional assessment database migration is required for this update. Existing assessment tables and JSON settings are used.

## Recommended verification

1. Sign in as an administrator and open **Assessments**.
2. Click **New Test** and confirm a dedicated tab opens.
3. Save assessment details, then create sections and questions.
4. Configure random picking, question/choice shuffling, fullscreen, anomaly limit, and auto-submit.
5. Publish the assessment.
6. Sign in as a student and click **Open Secure Exam**.
7. Confirm the pre-check and dedicated exam tab appear.
8. Answer several questions, refresh once, and confirm answers and question order are restored.
9. Trigger a test anomaly and confirm it appears in the administrator anomaly log.
10. In a test assessment with a low limit, confirm the attempt is submitted automatically at the limit.
