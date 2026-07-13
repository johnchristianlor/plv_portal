import { json, safeError } from '../../../_shared/http.js';
import { requireStudent } from '../../../_shared/auth.js';
import { turso, rows } from '../../../_shared/turso.js';

export async function onRequest(context) {
  try {
    const auth = await requireStudent(context.request, context.env);
    const db = turso(context.env);
    const attemptId = new URL(context.request.url).searchParams.get('attemptId');
    const attempt = rows(await db.execute({ sql: 'select * from attempts where id=? and student_id=? and status=?', args: [attemptId, auth.userId, 'submitted'] }))[0];
    if (!attempt) return json({ error: 'Review is not available.' }, 404);
    const assessment = rows(await db.execute({ sql: 'select * from assessments where id=?', args: [attempt.assessment_id] }))[0];
    if (!assessment || !['immediate','after_release'].includes(assessment.review_policy)) return json({ error: 'Review has not been released.' }, 403);
    const maps = rows(await db.execute({ sql: 'select * from attempt_question_map where attempt_id=? order by order_index', args: [attemptId] }));
    const questions = [];
    for (const m of maps) {
      const q = rows(await db.execute({ sql: 'select id,type,prompt,points,explanation from questions where id=?', args: [m.question_id] }))[0];
      if (!q) continue;
      const choices = rows(await db.execute({ sql: 'select id,choice_text,is_correct from question_choices where question_id=? order by order_index', args: [q.id] }));
      const ans = rows(await db.execute({ sql: 'select answer_json,is_correct,awarded_points,manual_feedback from student_answers where attempt_id=? and question_id=?', args: [attemptId, q.id] }))[0];
      questions.push({ ...q, choices, answer: ans ? JSON.parse(ans.answer_json || 'null') : null, isCorrect: ans?.is_correct, awardedPoints: ans?.awarded_points, manualFeedback: ans?.manual_feedback });
    }
    return json({ attempt, assessment, questions });
  } catch (error) { return safeError(error); }
}
