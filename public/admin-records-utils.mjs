function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'en', {
    sensitivity: 'base',
    numeric: true,
  });
}

function compareName(left, right) {
  return compareText(left.studentName, right.studentName)
    || compareText(left.studentNo, right.studentNo)
    || compareText(left.subjectCode, right.subjectCode);
}

export function sortRecordRows(rows, order = 'rank') {
  const sorted = [...rows];
  const comparators = {
    rank: (left, right) => compareText(left.section, right.section)
      || compareText(left.subjectCode, right.subjectCode)
      || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
      || compareName(left, right),
    name_asc: compareName,
    name_desc: (left, right) => compareName(right, left),
    student_no: (left, right) => compareText(left.studentNo, right.studentNo)
      || compareName(left, right),
    section_name: (left, right) => compareText(left.section, right.section)
      || compareText(left.subjectCode, right.subjectCode)
      || compareName(left, right),
  };
  return sorted.sort(comparators[order] || comparators.rank);
}

export function escapeCsvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Computes major-exam raw points independently from grades, weights, and
// other activity categories. Section and subject are mandatory so unrelated
// cohorts are never added together (including matching activity titles).
// Missing scores contribute 0 earned points but remain explicitly pending;
// a saved score of 0 counts as graded.
export function summarizeExamPoints(activities, scoreMap, studentNo, section, subjectCode) {
  const result = {
    midterm: { earned: 0, max: 0, graded: 0, pending: 0 },
    final: { earned: 0, max: 0, graded: 0, pending: 0 },
    combined: { earned: 0, max: 0, graded: 0, pending: 0, percentage: null },
  };
  for (const activity of activities || []) {
    if (activity.category !== 'exam' || activity.section !== section || activity.subjectCode !== subjectCode) continue;
    const max = Number(activity.perfectScore);
    if (!Number.isFinite(max) || max <= 0) continue;
    const term = activity.term === 'midterm' ? result.midterm : activity.term === 'final' ? result.final : null;
    const raw = scoreMap?.[activity.id + '||' + studentNo]?.score;
    const value = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    const scored = value !== null && Number.isFinite(value);
    for (const bucket of [result.combined, term].filter(Boolean)) {
      bucket.max += max;
      if (scored) {
        bucket.earned += value;
        bucket.graded++;
      } else {
        bucket.pending++;
      }
    }
  }
  result.combined.percentage = result.combined.max > 0
    ? result.combined.earned / result.combined.max * 100 : null;
  return result;
}

// Excel sheet names cannot exceed 31 characters or contain \ / ? * [ ] : .
// Guarantee distinct sheet names when subject/section names are truncated.
export function uniqueSheetName(label, usedNames) {
  const base = (String(label ?? '').replace(/[\\/?*\[\]:]/g, '-').trim() || 'Records').slice(0, 31);
  let name = base;
  let index = 2;
  while (usedNames.has(name.toLowerCase())) {
    const suffix = ' (' + index++ + ')';
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

// Scores are numeric cells. Their maximum is part of the activity heading,
// e.g. "[MID] L-EXAM (/40)"; no extra maximum column is necessary.
export function formatExportMaximum(maximum) {
  const number = Number(maximum);
  return Number.isFinite(number) && number >= 0 ? String(number) : '0';
}

export function buildActivityExportHeader(activity) {
  const term = activity?.term === 'midterm' ? 'MID' : 'FIN';
  const name = String(activity?.title || 'Activity').trim();
  return '[' + term + '] ' + name + ' (/' + formatExportMaximum(activity?.perfectScore) + ')';
}

export function buildExamTotalHeader(maximum) {
  return 'EXAMS TOTAL (/' + formatExportMaximum(maximum) + ')';
}

// Excel column number (1-based) => A, O, AA. Needed for sum formulas.
export function excelColumnName(column) {
  if (!Number.isInteger(column) || column < 1) throw new RangeError('Excel columns start at 1');
  let name = '';
  while (column > 0) {
    column -= 1;
    name = String.fromCharCode(65 + column % 26) + name;
    column = Math.floor(column / 26);
  }
  return name;
}
