import { json, safeError } from '../../../_shared/http.js';
import { requireStudent } from '../../../_shared/auth.js';

export async function onRequest(context) {
  try {
    await requireStudent(context.request, context.env);
    return json({
      error: 'Use /api/assessments/student/start, /api/assessments/student/attempt, /api/assessments/student/answer, or /api/assessments/student/submit for attempt actions.'
    }, 404);
  } catch (error) {
    return safeError(error);
  }
}
