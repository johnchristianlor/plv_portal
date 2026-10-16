// PLV percentage-to-number conversion. Boundaries are inclusive at the lower end.
// Decimal percentages are NOT rounded into a higher bracket.
export const GRADE_SCALE = Object.freeze([
  { minimum: 97, maximum: 100, grade: 1.00, label: '97–100' },
  { minimum: 94, maximum: 97, grade: 1.25, label: '94 to <97' },
  { minimum: 91, maximum: 94, grade: 1.50, label: '91 to <94' },
  { minimum: 88, maximum: 91, grade: 1.75, label: '88 to <91' },
  { minimum: 85, maximum: 88, grade: 2.00, label: '85 to <88' },
  { minimum: 82, maximum: 85, grade: 2.25, label: '82 to <85' },
  { minimum: 79, maximum: 82, grade: 2.50, label: '79 to <82' },
  { minimum: 76, maximum: 79, grade: 2.75, label: '76 to <79' },
  { minimum: 75, maximum: 76, grade: 3.00, label: '75 to <76' },
  { minimum: 0, maximum: 75, grade: 5.00, label: 'Below 75' },
]);

export function transmutePercentage(rawGrade) {
  if (rawGrade === null || rawGrade === undefined || String(rawGrade).trim() === '') return null;
  const percentage = Number(rawGrade);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null;
  return GRADE_SCALE.find((range) => percentage >= range.minimum)?.grade ?? null;
}
