const PRECISION = 2;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value) {
  const factor = 10 ** PRECISION;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'en', {
    sensitivity: 'base',
    numeric: true,
  });
}

function cohortKey(row) {
  return `${String(row.section ?? '').trim().toLowerCase()}||${String(row.subjectCode ?? '').trim().toLowerCase()}`;
}

function rawGrade(row, term) {
  const raw = finiteNumber(term === 'midterm' ? row.midtermRawGrade : row.finalTermRawGrade);
  if (raw !== null) return raw;
  const legacy = finiteNumber(term === 'midterm' ? row.midtermGrade : row.finalTermGrade);
  return legacy !== null && legacy > 5 ? legacy : null;
}

function transmutedGrade(row, term) {
  const value = finiteNumber(term === 'midterm' ? row.midtermGrade : row.finalTermGrade);
  return value !== null && value <= 5 ? value : null;
}

function average(left, right) {
  const first = left();
  const second = right();
  return first === null || second === null ? null : (first + second) / 2;
}

function candidatesFor(term) {
  if (term === 'midterm') {
    return [
      { id: 'midterm-grade', label: 'Midterm grade', source: 'grade', unit: 'grade', direction: 'desc', value: row => rawGrade(row, 'midterm') },
      { id: 'midterm-transmuted', label: 'Midterm grade', source: 'grade', unit: 'transmuted', direction: 'asc', value: row => transmutedGrade(row, 'midterm') },
    ];
  }
  if (term === 'final') {
    return [
      { id: 'final-term-grade', label: 'Final term grade', source: 'grade', unit: 'grade', direction: 'desc', value: row => rawGrade(row, 'final') },
      { id: 'final-term-transmuted', label: 'Final term grade', source: 'grade', unit: 'transmuted', direction: 'asc', value: row => transmutedGrade(row, 'final') },
    ];
  }
  return [
    { id: 'final-average', label: 'Final average', source: 'grade', unit: 'grade', direction: 'desc', value: row => average(() => rawGrade(row, 'midterm'), () => rawGrade(row, 'final')) },
    { id: 'final-term-grade', label: 'Final term grade', source: 'grade', unit: 'grade', direction: 'desc', value: row => rawGrade(row, 'final') },
    { id: 'midterm-grade', label: 'Midterm grade', source: 'grade', unit: 'grade', direction: 'desc', value: row => rawGrade(row, 'midterm') },
    { id: 'final-average-transmuted', label: 'Final average', source: 'grade', unit: 'transmuted', direction: 'asc', value: row => average(() => transmutedGrade(row, 'midterm'), () => transmutedGrade(row, 'final')) },
    { id: 'final-term-transmuted', label: 'Final term grade', source: 'grade', unit: 'transmuted', direction: 'asc', value: row => transmutedGrade(row, 'final') },
    { id: 'midterm-transmuted', label: 'Midterm grade', source: 'grade', unit: 'transmuted', direction: 'asc', value: row => transmutedGrade(row, 'midterm') },
  ];
}

function selectBasis(rows, term) {
  const officialBasis = candidatesFor(term).find(candidate => rows.every(row => candidate.value(row) !== null));
  if (officialBasis) return officialBasis;
  if (rows.every(row => finiteNumber(row.totalMax) > 0 && finiteNumber(row.scorePercent) !== null)) {
    return {
      id: 'activity-score',
      label: 'Activity score fallback',
      source: 'score',
      unit: 'percent',
      direction: 'desc',
      value: row => finiteNumber(row.scorePercent),
    };
  }
  return null;
}

export function assignClassStanding(rows, options = {}) {
  const term = options.term === 'midterm' || options.term === 'final' ? options.term : '';
  const result = rows.map(row => ({
    ...row,
    rank: null,
    standingValue: null,
    standingBasis: 'pending',
    standingLabel: 'Ranking pending',
    standingSource: 'pending',
    standingUnit: '',
  }));
  const cohorts = new Map();
  result.forEach(row => {
    const key = cohortKey(row);
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(row);
  });

  cohorts.forEach(cohort => {
    const basis = selectBasis(cohort, term);
    if (!basis) return;
    const ordered = cohort.map(row => ({ row, metric: rounded(basis.value(row)) }))
      .sort((left, right) => {
        const metricOrder = basis.direction === 'asc'
          ? left.metric - right.metric
          : right.metric - left.metric;
        return metricOrder
          || compareText(left.row.studentName, right.row.studentName)
          || compareText(left.row.studentNo, right.row.studentNo);
      });

    ordered.forEach((entry, index) => {
      const tied = index > 0 && entry.metric === ordered[index - 1].metric;
      entry.row.rank = tied ? ordered[index - 1].row.rank : index + 1;
      entry.row.standingValue = entry.metric;
      entry.row.standingBasis = basis.id;
      entry.row.standingLabel = basis.label;
      entry.row.standingSource = basis.source;
      entry.row.standingUnit = basis.unit;
    });
  });

  return result;
}

export function sortClassStanding(rows) {
  return [...rows].sort((left, right) => compareText(left.section, right.section)
    || compareText(left.subjectCode, right.subjectCode)
    || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.studentName, right.studentName)
    || compareText(left.studentNo, right.studentNo));
}
