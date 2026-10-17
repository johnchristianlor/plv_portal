// Incentives are stored separately from raw marks. Never mutate the original score.
export function examBonusKey(activityId, studentNo) {
  return `${String(activityId)}||${String(studentNo).trim()}`;
}
export function bonusMapFromRows(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const value = Number(row.bonus_points);
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = examBonusKey(row.activity_id, row.student_no);
    map.set(key, (map.get(key) || 0) + value);
  }
  return map;
}
export function effectiveExamScore(activity, rawScore, bonus = 0) {
  // A pending raw score stays pending even if an incentive has already been earned.
  if (rawScore === null || rawScore === undefined || rawScore === '') return null;
  const raw = Number(rawScore);
  if (!Number.isFinite(raw)) return null;
  if (activity?.category !== 'exam') return raw;
  const maximum = Number(activity.perfectScore);
  const extra = Math.max(0, Number(bonus) || 0);
  return Number.isFinite(maximum) && maximum >= 0
    ? Math.min(maximum, Math.max(0, raw + extra))
    : raw + extra;
}

// Supabase/PostgREST commonly limits a single response to 1,000 rows.
// Page deterministically so large classes do not silently lose incentive credits.
export async function fetchExamIncentiveTotals(supabase, params) {
  const rows = [];
  const pageSize = 1000;
  for (let start = 0; start < 100000; start += pageSize) {
    const { data, error } = await supabase.rpc('get_exam_incentive_totals', params)
      .range(start, start + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
  throw new Error('Incentive totals exceed the maximum supported page count. Narrow the report.');
}
