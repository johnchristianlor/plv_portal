import { json, safeError } from '../../../_shared/http.js';
import { requireAdmin } from '../../../_shared/auth.js';
import { turso, rows } from '../../../_shared/turso.js';

export async function onRequest(context) {
  try {
    await requireAdmin(context.request, context.env);
    const db = turso(context.env);
    const assessmentId = new URL(context.request.url).searchParams.get('assessmentId');
    const attempts = rows(await db.execute({ sql: 'select id,student_id,status,started_at,submitted_at,score,total_points,percentage from attempts where assessment_id=? order by submitted_at desc', args: [assessmentId] }));
    const incidents = rows(await db.execute({ sql: 'select incident_type,count(*) as count from assessment_incidents where attempt_id in (select id from attempts where assessment_id=?) group by incident_type', args: [assessmentId] }));
    return json({ attempts, incidents });
  } catch (error) { return safeError(error); }
}
