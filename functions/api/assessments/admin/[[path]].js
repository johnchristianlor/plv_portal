import { json, readJson, routePath, methodNotAllowed, safeError } from '../../../_shared/http.js';
import { requireAdmin } from '../../../_shared/auth.js';
import { turso, uuid, rows, audit } from '../../../_shared/turso.js';
import { listSectionsAndSubjects } from '../../../_shared/supabase.js';
import { cleanString, oneOf, numberIn, jsonText } from '../../../_shared/validation.js';

function action(context) { return routePath(context) || 'list'; }

async function listAssessments(db) {
  const result = await db.execute(`select a.*, v.version_no,
    (select count(*) from assessment_assignments aa where aa.assessment_id = a.id) as assignment_count,
    (select count(*) from assessment_question_map aqm where aqm.version_id = a.current_version_id) as question_count,
    (select count(*) from attempts t where t.assessment_id = a.id) as attempt_count
    from assessments a left join assessment_versions v on v.id = a.current_version_id
    order by a.updated_at desc limit 200`);
  return rows(result);
}

function normalizeQuestion(q, index) {
  const type = oneOf(String(q.type || 'single'), ['single','multiple','true_false','short','essay'], 'single');
  return {
    id: String(q.id || uuid()),
    type,
    prompt: cleanString(q.prompt, 5000, true),
    points: numberIn(q.points, 0.1, 1000, 1),
    explanation: cleanString(q.explanation, 4000, false),
    category: cleanString(q.category, 120, false),
    difficulty: oneOf(String(q.difficulty || 'medium'), ['easy','medium','hard'], 'medium'),
    required: q.required !== false,
    caseSensitive: !!q.caseSensitive,
    acceptedAnswers: Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers.map(v => cleanString(v, 200, false)).filter(Boolean).slice(0, 25) : [],
    mediaObject: cleanString(q.mediaObject, 500, false),
    orderIndex: index,
    choices: Array.isArray(q.choices) ? q.choices.map((c, i) => ({
      id: String(c.id || uuid()),
      choiceText: cleanString(c.choiceText ?? c.text, 1000, true),
      isCorrect: !!c.isCorrect,
      orderIndex: i
    })).slice(0, 12) : []
  };
}

async function saveAssessment(db, auth, body) {
  const assessmentId = String(body.id || uuid());
  const status = oneOf(String(body.status || 'draft'), ['draft','scheduled','active','closed','archived','paused'], 'draft');
  const questions = (Array.isArray(body.questions) ? body.questions : []).map(normalizeQuestion);
  if (!questions.length) throw Object.assign(new Error('Add at least one question before saving.'), { status: 422, code: 'missing_questions' });
  const totalPoints = numberIn(body.totalPoints, 0, 100000, 0) || questions.reduce((sum, q) => sum + Number(q.points || 0), 0);
  const versionId = uuid();
  const versionNo = Number(rows(await db.execute({ sql: 'select coalesce(max(version_no), 0) + 1 as n from assessment_versions where assessment_id = ?', args: [assessmentId] }))[0]?.n || 1);

  await db.batch([
    { sql: `insert into assessments (id,title,description,instructions,subject_id,subject_code,type,total_points,passing_score,passing_percent,status,open_at,close_at,duration_minutes,per_question_seconds,attempt_limit,grace_minutes,late_policy,shuffle_questions,shuffle_choices,random_draw_count,allow_backtracking,one_question_per_page,require_answer_before_next,review_policy,incident_policy,incident_limit,created_by,created_at,updated_at,current_version_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
      on conflict(id) do update set title=excluded.title,description=excluded.description,instructions=excluded.instructions,subject_id=excluded.subject_id,subject_code=excluded.subject_code,type=excluded.type,total_points=excluded.total_points,passing_score=excluded.passing_score,passing_percent=excluded.passing_percent,status=excluded.status,open_at=excluded.open_at,close_at=excluded.close_at,duration_minutes=excluded.duration_minutes,per_question_seconds=excluded.per_question_seconds,attempt_limit=excluded.attempt_limit,grace_minutes=excluded.grace_minutes,late_policy=excluded.late_policy,shuffle_questions=excluded.shuffle_questions,shuffle_choices=excluded.shuffle_choices,random_draw_count=excluded.random_draw_count,allow_backtracking=excluded.allow_backtracking,one_question_per_page=excluded.one_question_per_page,require_answer_before_next=excluded.require_answer_before_next,review_policy=excluded.review_policy,incident_policy=excluded.incident_policy,incident_limit=excluded.incident_limit,updated_at=datetime('now'),current_version_id=excluded.current_version_id`,
      args: [assessmentId, cleanString(body.title,180,true), cleanString(body.description,2000), cleanString(body.instructions,8000), cleanString(body.subjectId,80), cleanString(body.subjectCode,80), oneOf(String(body.type||'quiz'), ['quiz','examination','practice','diagnostic'], 'quiz'), totalPoints, numberIn(body.passingScore,0,100000,0), numberIn(body.passingPercent,0,100,0), status, cleanString(body.openAt,80), cleanString(body.closeAt,80), numberIn(body.durationMinutes,1,1440,60), numberIn(body.perQuestionSeconds,0,86400,0), numberIn(body.attemptLimit,1,10,1), numberIn(body.graceMinutes,0,120,0), oneOf(String(body.latePolicy||'auto_submit'), ['auto_submit','reject','mark_late'], 'auto_submit'), body.shuffleQuestions?1:0, body.shuffleChoices?1:0, numberIn(body.randomDrawCount,0,1000,0), body.allowBacktracking!==false?1:0, body.oneQuestionPerPage?1:0, body.requireAnswerBeforeNext?1:0, oneOf(String(body.reviewPolicy||'after_release'), ['none','immediate','after_close','after_release','window'], 'after_release'), oneOf(String(body.incidentPolicy||'warn'), ['log','warn','auto_submit','lock'], 'warn'), numberIn(body.incidentLimit,0,100,3), auth.userId, versionId] },
    { sql: 'insert into assessment_versions (id,assessment_id,version_no,status,snapshot_json,created_by,created_at) values (?, ?, ?, ?, ?, ?, datetime(\'now\'))', args: [versionId, assessmentId, versionNo, status === 'draft' ? 'draft' : 'published', jsonText({ assessment: body, questions }, 120000), auth.userId] },
    { sql: 'delete from assessment_assignments where assessment_id = ?', args: [assessmentId] }
  ]);

  for (const sid of (Array.isArray(body.sectionIds) ? body.sectionIds : [])) {
    await db.execute({ sql: 'insert into assessment_assignments (id,assessment_id,version_id,section_id,assigned_by,assigned_at) values (?, ?, ?, ?, ?, datetime(\'now\'))', args: [uuid(), assessmentId, versionId, cleanString(sid,120), auth.userId] });
  }
  for (const studentId of (Array.isArray(body.studentIds) ? body.studentIds : [])) {
    await db.execute({ sql: 'insert into assessment_assignments (id,assessment_id,version_id,student_id,assigned_by,assigned_at) values (?, ?, ?, ?, ?, datetime(\'now\'))', args: [uuid(), assessmentId, versionId, cleanString(studentId,120), auth.userId] });
  }
  for (const q of questions) {
    await db.execute({ sql: 'insert into questions (id,version_id,type,prompt,points,explanation,category,difficulty,required,case_sensitive,accepted_answers_json,media_object,created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))', args: [q.id, versionId, q.type, q.prompt, q.points, q.explanation, q.category, q.difficulty, q.required?1:0, q.caseSensitive?1:0, JSON.stringify(q.acceptedAnswers), q.mediaObject] });
    await db.execute({ sql: 'insert into assessment_question_map (id,assessment_id,version_id,question_id,order_index,points) values (?, ?, ?, ?, ?, ?)', args: [uuid(), assessmentId, versionId, q.id, q.orderIndex, q.points] });
    for (const c of q.choices) await db.execute({ sql: 'insert into question_choices (id,question_id,choice_text,is_correct,order_index) values (?, ?, ?, ?, ?)', args: [c.id, q.id, c.choiceText, c.isCorrect?1:0, c.orderIndex] });
  }
  await audit(db, auth.userId, 'admin', 'assessment.save', 'assessment', assessmentId, { versionId, status });
  return { assessmentId, versionId };
}

async function detail(db, id) {
  const assessment = rows(await db.execute({ sql: 'select * from assessments where id = ?', args: [id] }))[0];
  if (!assessment) throw Object.assign(new Error('Assessment not found.'), { status: 404, code: 'not_found' });
  const version = rows(await db.execute({ sql: 'select * from assessment_versions where id = ?', args: [assessment.current_version_id] }))[0];
  const questions = version ? rows(await db.execute({ sql: 'select * from questions where version_id = ? order by rowid', args: [version.id] })) : [];
  for (const q of questions) q.choices = rows(await db.execute({ sql: 'select id,choice_text,is_correct,order_index from question_choices where question_id=? order by order_index', args: [q.id] }));
  const assignments = rows(await db.execute({ sql: 'select * from assessment_assignments where assessment_id=?', args: [id] }));
  return { assessment, version, questions, assignments };
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204 });
  try {
    const auth = await requireAdmin(context.request, context.env);
    const db = turso(context.env);
    const a = action(context);
    if (context.request.method === 'GET' && a === 'list') return json({ assessments: await listAssessments(db) });
    if (context.request.method === 'GET' && a === 'bootstrap') return json(await listSectionsAndSubjects(context.env));
    if (context.request.method === 'GET' && a === 'detail') return json(await detail(db, new URL(context.request.url).searchParams.get('id')));
    if (context.request.method === 'POST' && a === 'save') return json(await saveAssessment(db, auth, await readJson(context.request, 256 * 1024)));
    if (context.request.method === 'POST' && a === 'status') {
      const body = await readJson(context.request);
      const status = oneOf(String(body.status || ''), ['draft','scheduled','active','paused','closed','archived'], 'draft');
      await db.execute({ sql: 'update assessments set status=?, updated_at=datetime(\'now\') where id=?', args: [status, String(body.id || '')] });
      await audit(db, auth.userId, 'admin', 'assessment.status', 'assessment', String(body.id || ''), { status });
      return json({ ok: true });
    }
    return methodNotAllowed();
  } catch (error) { console.error(error); return safeError(error); }
}
