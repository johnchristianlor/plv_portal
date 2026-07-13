import { json, readJson, routePath, methodNotAllowed, safeError } from '../../../_shared/http.js';
import { requireStudent } from '../../../_shared/auth.js';
import { turso, uuid, rows, audit } from '../../../_shared/turso.js';
import { getProfile, syncAssessmentScore } from '../../../_shared/supabase.js';
import { cleanString } from '../../../_shared/validation.js';

function action(context) { return routePath(context) || 'list'; }
function shuffle(arr) { const copy = [...arr]; for (let i = copy.length - 1; i > 0; i--) { const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2**32; const j = Math.floor(r * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; }
function publicAssessment(a) { return { id:a.id, title:a.title, description:a.description, instructions:a.instructions, subjectCode:a.subject_code, type:a.type, totalPoints:a.total_points, status:a.status, openAt:a.open_at, closeAt:a.close_at, durationMinutes:a.duration_minutes, attemptLimit:a.attempt_limit, reviewPolicy:a.review_policy, activeAttemptId:a.active_attempt_id || null, attemptCount:a.attempt_count || 0 }; }
async function profileFor(env, auth) { const p = await getProfile(env, auth.userId); if (!p) throw Object.assign(new Error('Profile not found.'), { status:403, code:'profile_missing' }); return p; }

async function assignedAssessments(db, profile, auth) {
  const sid = String(profile.section_id || profile.section || '').trim();
  const result = await db.execute({ sql: `select distinct a.*, at.id as active_attempt_id,
    (select count(*) from attempts x where x.assessment_id=a.id and x.student_id=?) as attempt_count
    from assessments a join assessment_assignments aa on aa.assessment_id=a.id
    left join attempts at on at.assessment_id=a.id and at.student_id=? and at.status='in_progress'
    where a.status in ('scheduled','active','closed') and (aa.student_id=? or aa.section_id=?)
    order by coalesce(a.open_at, a.created_at) desc`, args: [auth.userId, auth.userId, auth.userId, sid] });
  return rows(result).map(publicAssessment);
}

async function assertAssigned(db, profile, auth, assessmentId) {
  const sid = String(profile.section_id || profile.section || '').trim();
  const found = rows(await db.execute({ sql: 'select 1 from assessment_assignments where assessment_id=? and (student_id=? or section_id=?) limit 1', args: [assessmentId, auth.userId, sid] }))[0];
  if (!found) throw Object.assign(new Error('Assessment not found.'), { status:404, code:'not_found' });
}

async function attemptQuestions(db, attemptId) {
  const maps = rows(await db.execute({ sql: 'select * from attempt_question_map where attempt_id=? order by order_index', args: [attemptId] }));
  const output = [];
  for (const m of maps) {
    const q = rows(await db.execute({ sql: 'select id,type,prompt,points,required,media_object from questions where id=?', args: [m.question_id] }))[0];
    if (!q) continue;
    const order = JSON.parse(m.choice_order_json || '[]');
    let choices = rows(await db.execute({ sql: 'select id,choice_text from question_choices where question_id=?', args: [q.id] }));
    if (order.length) choices.sort((a,b) => order.indexOf(a.id) - order.indexOf(b.id));
    const ans = rows(await db.execute({ sql: 'select answer_json,marked_for_review,updated_at from student_answers where attempt_id=? and question_id=?', args: [attemptId, q.id] }))[0];
    output.push({ ...q, orderIndex:m.order_index, choices, answer: ans ? JSON.parse(ans.answer_json || 'null') : null, markedForReview: !!ans?.marked_for_review, savedAt: ans?.updated_at || null });
  }
  return output;
}

async function startAttempt(db, auth, profile, assessmentId) {
  await assertAssigned(db, profile, auth, assessmentId);
  const active = rows(await db.execute({ sql: 'select * from attempts where assessment_id=? and student_id=? and status=? limit 1', args: [assessmentId, auth.userId, 'in_progress'] }))[0];
  if (active) return active;
  const a = rows(await db.execute({ sql: 'select * from assessments where id=?', args: [assessmentId] }))[0];
  if (!a || !['active','scheduled'].includes(a.status)) throw Object.assign(new Error('Assessment is not available.'), { status:404, code:'not_available' });
  const version = rows(await db.execute({ sql: 'select * from assessment_versions where id=?', args: [a.current_version_id] }))[0];
  if (!version) throw Object.assign(new Error('Assessment version not found.'), { status:404, code:'not_found' });
  let qmaps = rows(await db.execute({ sql: 'select q.id from questions q join assessment_question_map aqm on aqm.question_id=q.id where aqm.version_id=? order by aqm.order_index', args: [version.id] }));
  if (a.shuffle_questions) qmaps = shuffle(qmaps);
  if (a.random_draw_count && Number(a.random_draw_count) > 0) qmaps = qmaps.slice(0, Number(a.random_draw_count));
  const attemptId = uuid();
  const deadline = new Date(Date.now() + Number(a.duration_minutes || 60) * 60000).toISOString();
  await db.execute({ sql: 'insert into attempts (id,assessment_id,version_id,student_id,status,started_at,server_deadline_at,created_at,updated_at) values (?, ?, ?, ?, ?, datetime(\'now\'), ?, datetime(\'now\'), datetime(\'now\'))', args: [attemptId, assessmentId, version.id, auth.userId, 'in_progress', deadline] });
  for (let i = 0; i < qmaps.length; i++) {
    let choices = rows(await db.execute({ sql: 'select id from question_choices where question_id=? order by order_index', args: [qmaps[i].id] })).map(c => c.id);
    if (a.shuffle_choices) choices = shuffle(choices);
    await db.execute({ sql: 'insert into attempt_question_map (id,attempt_id,question_id,order_index,choice_order_json) values (?, ?, ?, ?, ?)', args: [uuid(), attemptId, qmaps[i].id, i, JSON.stringify(choices)] });
  }
  await audit(db, auth.userId, 'student', 'attempt.start', 'attempt', attemptId, { assessmentId });
  return rows(await db.execute({ sql: 'select * from attempts where id=?', args: [attemptId] }))[0];
}

async function gradeAndSubmit(db, env, auth, attemptId) {
  const attempt = rows(await db.execute({ sql: 'select * from attempts where id=? and student_id=?', args: [attemptId, auth.userId] }))[0];
  if (!attempt) throw Object.assign(new Error('Attempt not found.'), { status:404, code:'not_found' });
  if (attempt.status === 'submitted') return { ok:true, alreadySubmitted:true, score:attempt.score, totalPoints:attempt.total_points, percentage:attempt.percentage };
  const maps = rows(await db.execute({ sql: 'select * from attempt_question_map where attempt_id=?', args: [attemptId] }));
  let earned = 0, total = 0;
  for (const m of maps) {
    const q = rows(await db.execute({ sql: 'select * from questions where id=?', args: [m.question_id] }))[0];
    if (!q) continue;
    total += Number(q.points || 0);
    const ans = rows(await db.execute({ sql: 'select * from student_answers where attempt_id=? and question_id=?', args: [attemptId, q.id] }))[0];
    const val = ans ? JSON.parse(ans.answer_json || 'null') : null;
    let correct = null, points = 0;
    if (['single','true_false','multiple'].includes(q.type)) {
      const correctChoices = rows(await db.execute({ sql: 'select id from question_choices where question_id=? and is_correct=1', args: [q.id] })).map(c => c.id).sort();
      const selected = (Array.isArray(val) ? val : [val]).filter(Boolean).sort();
      correct = JSON.stringify(correctChoices) === JSON.stringify(selected) ? 1 : 0;
      points = correct ? Number(q.points || 0) : 0;
    } else if (q.type === 'short') {
      const accepted = JSON.parse(q.accepted_answers_json || '[]').map(x => q.case_sensitive ? String(x) : String(x).toLowerCase());
      const answer = q.case_sensitive ? String(val || '').trim() : String(val || '').trim().toLowerCase();
      correct = accepted.includes(answer) ? 1 : 0;
      points = correct ? Number(q.points || 0) : 0;
    }
    if (ans) await db.execute({ sql: 'update student_answers set is_correct=?, awarded_points=? where id=?', args: [correct, points, ans.id] });
    earned += points;
  }
  const pct = total > 0 ? earned / total * 100 : 0;
  await db.execute({ sql: 'update attempts set status=?,submitted_at=datetime(\'now\'),score=?,total_points=?,percentage=?,updated_at=datetime(\'now\') where id=?', args: ['submitted', earned, total, pct, attemptId] });
  const a = rows(await db.execute({ sql: 'select * from assessments where id=?', args: [attempt.assessment_id] }))[0];
  const payload = { id:attemptId, student_id:auth.userId, assessment_id:attempt.assessment_id, title:a?.title || '', subject_code:a?.subject_code || '', score:earned, total_points:total, percentage:pct, status:'submitted', submitted_at:new Date().toISOString() };
  await db.execute({ sql: 'insert into score_sync_outbox (id,attempt_id,assessment_id,student_id,payload_json,status,created_at) values (?, ?, ?, ?, ?, ?, datetime(\'now\'))', args: [uuid(), attemptId, attempt.assessment_id, auth.userId, JSON.stringify(payload), 'pending'] });
  await syncAssessmentScore(env, payload);
  await audit(db, auth.userId, 'student', 'attempt.submit', 'attempt', attemptId, { earned, total });
  return { ok:true, score:earned, totalPoints:total, percentage:pct };
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204 });
  try {
    const auth = await requireStudent(context.request, context.env);
    const profile = await profileFor(context.env, auth);
    const db = turso(context.env);
    const a = action(context);
    if (context.request.method === 'GET' && a === 'list') return json({ assessments: await assignedAssessments(db, profile, auth), serverTime:new Date().toISOString() });
    if (context.request.method === 'GET' && a === 'attempt') {
      const id = new URL(context.request.url).searchParams.get('id');
      const attempt = rows(await db.execute({ sql: 'select * from attempts where id=? and student_id=?', args: [id, auth.userId] }))[0];
      if (!attempt) return json({ error:'Not found' }, 404);
      return json({ attempt, questions: await attemptQuestions(db, id), serverTime:new Date().toISOString() });
    }
    if (context.request.method === 'POST' && a === 'start') {
      const body = await readJson(context.request);
      const attempt = await startAttempt(db, auth, profile, String(body.assessmentId || ''));
      return json({ attempt, questions: await attemptQuestions(db, attempt.id), serverTime:new Date().toISOString() });
    }
    if (context.request.method === 'POST' && a === 'answer') {
      const body = await readJson(context.request);
      const attempt = rows(await db.execute({ sql: 'select * from attempts where id=? and student_id=? and status=?', args: [body.attemptId, auth.userId, 'in_progress'] }))[0];
      if (!attempt) return json({ error:'Attempt not available' }, 404);
      await db.execute({ sql: `insert into student_answers (id,attempt_id,question_id,student_id,answer_json,marked_for_review,idempotency_key,updated_at) values (?, ?, ?, ?, ?, ?, ?, datetime('now')) on conflict(attempt_id, question_id) do update set answer_json=excluded.answer_json, marked_for_review=excluded.marked_for_review, updated_at=datetime('now')`, args: [uuid(), attempt.id, cleanString(body.questionId,80,true), auth.userId, JSON.stringify(body.answer ?? null).slice(0,12000), body.markedForReview?1:0, cleanString(body.idempotencyKey,120,false)] });
      return json({ ok:true, savedAt:new Date().toISOString() });
    }
    if (context.request.method === 'POST' && a === 'incident') {
      const body = await readJson(context.request);
      const attempt = rows(await db.execute({ sql: 'select * from attempts where id=? and student_id=?', args: [body.attemptId, auth.userId] }))[0];
      if (!attempt) return json({ error:'Attempt not found' }, 404);
      const type = cleanString(body.type,80,true);
      const count = Number(rows(await db.execute({ sql:'select count(*) as c from assessment_incidents where attempt_id=? and incident_type=?', args:[attempt.id,type] }))[0]?.c || 0) + 1;
      await db.execute({ sql: 'insert into assessment_incidents (id,attempt_id,student_id,incident_type,question_id,incident_count,details_json,created_at) values (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))', args: [uuid(), attempt.id, auth.userId, type, cleanString(body.questionId,80,false), count, JSON.stringify(body.details || {}).slice(0,1000)] });
      return json({ ok:true, count });
    }
    if (context.request.method === 'POST' && a === 'heartbeat') {
      const body = await readJson(context.request);
      await db.execute({ sql: 'update attempts set last_heartbeat_at=datetime(\'now\'),updated_at=datetime(\'now\') where id=? and student_id=? and status=?', args: [body.attemptId, auth.userId, 'in_progress'] });
      return json({ ok:true, serverTime:new Date().toISOString() });
    }
    if (context.request.method === 'POST' && a === 'submit') return json(await gradeAndSubmit(db, context.env, auth, String((await readJson(context.request)).attemptId || '')));
    return methodNotAllowed();
  } catch (error) { console.error(error); return safeError(error); }
}
