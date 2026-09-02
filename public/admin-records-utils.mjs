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
