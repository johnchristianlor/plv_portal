export const ATTENDANCE_STATUS = Object.freeze({
  present: 'P',
  absent: 'A',
  late: 'L',
  excused: 'E',
  pending: '',
});

export function formatLocalDateInput(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeAttendanceStatus(value) {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (normalized === 'P' || normalized === 'PRESENT' || normalized === 'ON TIME' || normalized.startsWith('PRESENT ')) return ATTENDANCE_STATUS.present;
  if (normalized === 'L' || normalized === 'LATE' || normalized === 'TARDY' || normalized.startsWith('LATE ')) return ATTENDANCE_STATUS.late;
  if (normalized === 'A' || normalized === 'ABSENT' || normalized.startsWith('ABSENT ')) return ATTENDANCE_STATUS.absent;
  if (normalized === 'E' || normalized === 'EXCUSED' || normalized.startsWith('EXCUSED ')) return ATTENDANCE_STATUS.excused;
  return ATTENDANCE_STATUS.pending;
}

export function normalizeDateKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const datePrefix = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefix) return datePrefix[1];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

export function nextDateKey(value) {
  const dateKey = normalizeDateKey(value);
  if (!dateKey) return '';
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

export function getAbsentStudentNumbers(records, targetDate = '') {
  const dateKey = normalizeDateKey(targetDate);
  return new Set((records || [])
    .filter(record => normalizeAttendanceStatus(record?.status) === ATTENDANCE_STATUS.absent)
    .filter(record => !dateKey || normalizeDateKey(record?.date) === dateKey)
    .map(record => String(record?.studentNo ?? '').trim())
    .filter(Boolean));
}

export function getAbsentDateKeys(records) {
  return new Set((records || [])
    .filter(record => normalizeAttendanceStatus(record?.status) === ATTENDANCE_STATUS.absent)
    .map(record => normalizeDateKey(record?.date))
    .filter(Boolean));
}

export function summarizeAttendance(records) {
  const summary = {
    totalRecords: records.length,
    present: 0,
    absent: 0,
    late: 0,
    excused: 0,
    pending: 0,
    attended: 0,
    rateDenominator: 0,
    rate: 0,
  };
  for (const record of records) {
    const status = normalizeAttendanceStatus(record?.status);
    if (status === ATTENDANCE_STATUS.present) summary.present += 1;
    else if (status === ATTENDANCE_STATUS.absent) summary.absent += 1;
    else if (status === ATTENDANCE_STATUS.late) summary.late += 1;
    else if (status === ATTENDANCE_STATUS.excused) summary.excused += 1;
    else summary.pending += 1;
  }
  summary.attended = summary.present + summary.late;
  summary.rateDenominator = summary.present + summary.late + summary.absent;
  summary.rate = summary.rateDenominator > 0
    ? Math.round((summary.attended / summary.rateDenominator) * 100)
    : 0;
  return summary;
}
