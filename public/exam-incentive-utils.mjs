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
  // Raw examination marks MUST stay independent of named extra credits.
  if (rawScore === null || rawScore === undefined || rawScore === '') return null;
  const raw = Number(rawScore);
  return Number.isFinite(raw) ? raw : null;
}

// A bonus line belongs to an existing exam class, but is not part of the raw exam.
export function namedIncentiveColumns(rows = [], activityIds = []) {
  const allowed = new Set(activityIds.map(String));
  const values = new Map();
  for (const r of rows) {
    if (!allowed.has(String(r.activity_id))) continue;
    const title = String(r.entry_title || 'Exam Incentive').trim();
    const source = String(r.source || 'manual');
    const key = `${r.activity_id}||${source}||${title}`;
    if (!values.has(key)) values.set(key, {key,activityId:String(r.activity_id),title,source});
  }
  return [...values.values()].sort((a,b)=> a.title.localeCompare(b.title)||a.activityId.localeCompare(b.activityId));
}
export function namedIncentiveValue(rows, studentNo, column) {
  return (rows || []).filter(r=>String(r.student_no)===String(studentNo) &&
    String(r.activity_id)===column.activityId && String(r.source)===column.source &&
    String(r.entry_title || 'Exam Incentive').trim()===column.title)
    .reduce((sum,r)=>sum+(Number(r.bonus_points)||0),0);
}
export async function fetchNamedIncentiveEntries(supabase, params) {
  const rows=[];
  for(let start=0;start<100000;start+=1000){
    const {data,error}=await supabase.rpc('get_named_exam_incentive_entries',params).range(start,start+999);
    if(error)throw error;
    rows.push(...(data||[]));
    if(!data||data.length<1000)return rows;
  }
  throw new Error('Named incentive report too large to export safely.');
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
