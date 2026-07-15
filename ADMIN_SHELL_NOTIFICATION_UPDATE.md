# Admin Shell and Student Notification Update

## Create Assessments
- Standardized the sidebar scrollbar, dimensions, header typography, glass radius, and spacing to match the other admin pages.
- Replaced the oversized sticky assessment navigation with the same compact segmented-tab style used elsewhere in the admin portal.
- Tabs remain horizontally scrollable on smaller screens without showing a distracting scrollbar.

## Student notifications
- Added a shared notification bell to every normal student portal page:
  - Dashboard
  - Assessments
  - Scores / Activity
  - Grades
  - Attendance
  - Settings
- The secure exam page intentionally does not show notifications so students are not distracted during an active assessment.
- Notifications include:
  - Admin announcements
  - Published assessments assigned to the student's section
  - Posted midterm and final-term grades
- Includes unread badge, mark-all-read, refresh, keyboard support, mobile layout, and periodic refresh.
- Read state is stored per student in local storage. Grade changes create a new notification automatically.

## Database
No database migration is required. The notification panel reads from the existing announcements, enrollments, and assessment API data.
