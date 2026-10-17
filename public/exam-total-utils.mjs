import { bonusMapFromRows, effectiveExamScore, examBonusKey } from './exam-incentive-utils.mjs';
// Exam components (e.g. laboratory and written) add points, not averaged percentages.
// Blank scores remain pending; zero is a real grade. Data must be scoped to one
// subject + section + grading period by the caller.
export function aggregateExamTotals(exams, scores, students, bonusRows = []) {
  const bonuses = bonusMapFromRows(bonusRows);
  const activities = (exams || []).filter(a => a.category === 'exam' && Number(a.perfectScore) > 0);
  const maxScore = activities.reduce((sum, a) => sum + Number(a.perfectScore), 0);
  const keyed = new Map();
  for (const score of scores || []) {
    if (score.score === null || score.score === undefined || score.score === '') continue;
    const number = Number(score.score);
    if (Number.isFinite(number)) keyed.set(`${score.activityId}|${String(score.studentNo).trim()}`, number);
  }
  return {
    examCount: activities.length,
    maxScore,
    activities,
    rows: (students || []).map(student => {
      const studentNo = String(student.studentNo || '').trim();
      let earned = 0, pending = 0;
      const components = activities.map(activity => {
        const raw = keyed.get(`${activity.id}|${studentNo}`);
        const bonus = bonuses.get(examBonusKey(activity.id, studentNo)) || 0;
        const score = effectiveExamScore(activity, raw, bonus);
        if (score === null) pending++;
        else earned += score;
        return { id: activity.id, title: activity.title, score, rawScore: raw ?? null, bonus, maximum: Number(activity.perfectScore) };
      });
      return { studentNo, studentName: student.studentName || '', earned, maxScore, pending, percentage: maxScore ? earned / maxScore * 100 : null, components };
    })
  };
}
