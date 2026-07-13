import { supabase } from './supabase-adapter.js';
import { startAdminSessionGuard } from './admin-session.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'admin') location.href = 'index.html';

const guard = startAdminSessionGuard(supabase, user);
window.logout = () => {
    guard.stop();
    localStorage.removeItem('loggedInUser');
    supabase.auth.signOut().catch(() => {});
    location.href = 'index.html';
};

let editing = null;
let questions = [];
let assessments = [];
let autosaveTimer = null;
let lastAutosaveSignature = '';
const DRAFT_KEY = 'plv-admin-assessment-draft-v2';

function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    setTimeout(() => $('toast').classList.remove('show'), 2600);
}

async function getToken() {
    const { data } = await supabase.auth.getSession();
    if (!data.session || !data.session.access_token) throw new Error('Please login again.');
    return data.session.access_token;
}

async function api(path, options = {}) {
    const response = await fetch('/api/assessments/' + path, {
        ...options,
        headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + await getToken(),
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Assessment request failed.');
    return data;
}

function iso(value) {
    return value ? new Date(value).toISOString() : null;
}

function theme() {
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-theme');
    const setIcon = () => {
        const icon = $('themeIcon');
        if (icon) icon.className = document.body.classList.contains('dark-theme') ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
    };
    setIcon();
    $('themeToggle').onclick = () => {
        document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
        setIcon();
    };
}

function showWorkspace(name) {
    persistDraft();
    if (name === 'builder' && !editing) {
        toast('Create or select a test first, then open Questions Manager.');
        name = 'details';
    }
    const visible = name === 'builder' ? 'details' : (name === 'security' ? 'results' : name);
    document.querySelectorAll('[data-assessment-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.assessmentView === name));
    document.querySelectorAll('[data-workspace]').forEach(panel => {
        panel.style.display = panel.dataset.workspace === visible ? '' : 'none';
        if (panel.dataset.workspace === 'details') {
            panel.classList.toggle('builder-mode', name === 'builder');
            panel.classList.toggle('details-mode', name !== 'builder');
        }
    });
    if (name === 'results' && editing) attempts(editing);
    if (name === 'security') incidents();
    setBuilderLock();
}

async function loadSelects() {
    const [subs, secs] = await Promise.all([
        supabase.from('subjects').select('*').order('subjectCode'),
        supabase.from('sections').select('*').order('sectionName')
    ]);
    $('subject').innerHTML = '<option value="">Select subject</option>' + (subs.data || []).map(s => `<option value="${esc(s.subjectCode)}">${esc(s.subjectCode)} - ${esc(s.subjectName || '')}</option>`).join('');
    $('section').innerHTML = '<option value="">Select section</option><option value="ALL">All Sections</option>' + (secs.data || []).map(s => `<option value="${esc(s.sectionName)}">${esc(s.sectionName)}</option>`).join('');
}

function setBuilderLock() {
    const btn = document.querySelector('[data-assessment-view="builder"]');
    if (!btn) return;
    btn.disabled = !editing;
    btn.classList.toggle('locked', !editing);
    btn.title = editing ? 'Open Questions Manager' : 'Save the new test first';
}

function draftPayload() {
    return { editing, assessment: currentAssessment(), questions, savedAt: new Date().toISOString() };
}

function autosaveSignature(assessment, questionList) {
    const { id, ...stableAssessment } = assessment;
    return JSON.stringify({ assessment: stableAssessment, questions: questionList });
}

function persistDraft() {
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draftPayload()));
    } catch (_) {}
}

function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
}

function restoreDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw || editing) return;
        const draft = JSON.parse(raw);
        const assessment = draft.assessment || {};
        editing = draft.editing || null;
        $('title').value = assessment.title || '';
        $('instructions').value = assessment.instructions || '';
        $('subject').value = assessment.subject_code || '';
        $('section').value = assessment.section || '';
        $('status').value = assessment.status || 'draft';
        $('duration').value = assessment.duration_minutes || 30;
        $('opensAt').value = assessment.opens_at ? String(assessment.opens_at).slice(0, 16) : '';
        $('closesAt').value = assessment.closes_at ? String(assessment.closes_at).slice(0, 16) : '';
        questions = Array.isArray(draft.questions) ? draft.questions : [];
        if (editing) lastAutosaveSignature = autosaveSignature(assessment, questions);
        renderQ();
        if (assessment.title && assessment.subject_code && assessment.section) scheduleAutosave();
    } catch (_) {}
}

async function runAutosave() {
    const assessment = currentAssessment();
    if (!assessment.title || !assessment.subject_code || !assessment.section) return false;
    const signature = autosaveSignature(assessment, questions);
    if (signature === lastAutosaveSignature) return true;
    const data = await api('admin/save', { method: 'POST', body: JSON.stringify({ assessment, questions }) });
    editing = data.id;
    assessment.id = data.id;
    lastAutosaveSignature = signature;
    persistDraft();
    setBuilderLock();
    return true;
}

function scheduleAutosave() {
    persistDraft();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
        try {
            await runAutosave();
        } catch (_) {}
    }, 900);
}

function renderQ() {
    const totalPoints = questions.reduce((sum, question) => sum + Number(question.points || 0), 0);
    $('qList').innerHTML = questions.length ? `
        <div class="builder-summary">
            <div>
                <span class="builder-summary__label">Questions ready</span>
                <strong>${questions.length} item${questions.length === 1 ? '' : 's'}</strong>
            </div>
            <div>
                <span class="builder-summary__label">Total points</span>
                <strong>${totalPoints}</strong>
            </div>
        </div>
        ${questions.map((q, i) => {
            const typeLabel = q.type.replace('_', ' ');
            const answerLabel = q.answer_key || 'Manual grading';
            const choicesLabel = q.choices.length ? q.choices.map(esc).join(' • ') : '';
            return `
        <article class="question-card">
            <div class="question-card__top">
                <div>
                    <div class="question-card__title">Question ${i + 1}</div>
                    <div class="question-card__meta">
                        <span class="question-chip">${esc(typeLabel)}</span>
                        <span class="question-chip question-chip--points">${Number(q.points || 0)} pt</span>
                    </div>
                </div>
                <button class="btn danger btn-icon" data-delq="${i}" type="button" aria-label="Delete question ${i + 1}"><i class="ph-bold ph-trash"></i></button>
            </div>
            <p class="question-card__prompt">${esc(q.prompt)}</p>
            ${choicesLabel ? `<p class="question-card__choices"><span>Choices</span>${choicesLabel}</p>` : ''}
            <div class="question-card__answer"><span>Answer key</span><strong>${esc(answerLabel)}</strong></div>
        </article>`;
        }).join('')}` : '<article class="question-card builder-empty"><b>No questions yet.</b><p>Pick a type, enter the prompt, and add your first item. Multiple choice and true/false questions automatically reveal the choice field.</p></article>';
    document.querySelectorAll('[data-delq]').forEach(btn => {
        btn.onclick = () => {
            questions.splice(Number(btn.dataset.delq), 1);
            renderQ();
            scheduleAutosave();
        };
    });
}

function reset() {
    editing = null;
    lastAutosaveSignature = '';
    clearTimeout(autosaveTimer);
    $('form').reset();
    $('duration').value = 30;
    questions = [];
    clearDraft();
    renderQ();
    setBuilderLock();
    $('bldSub') && ($('bldSub').textContent = 'Create a new Turso test');
}

function currentAssessment() {
    return {
        id: editing || '',
        title: $('title').value.trim(),
        instructions: $('instructions').value.trim(),
        subject_code: $('subject').value,
        section: $('section').value,
        status: $('status').value,
        duration_minutes: Number($('duration').value || 30),
        opens_at: iso($('opensAt').value),
        closes_at: iso($('closesAt').value),
        settings: { fullscreen: true, maxViolations: 5 }
    };
}

async function save(event) {
    event.preventDefault();
    const assessment = currentAssessment();
    if (!assessment.title || !assessment.subject_code || !assessment.section) return toast('Complete the title, subject, and section first.');
    if (assessment.status === 'published' && !questions.length) return toast('Add at least one question before publishing.');
    try {
        const data = await api('admin/save', { method: 'POST', body: JSON.stringify({ assessment, questions }) });
        editing = data.id;
        assessment.id = data.id;
        lastAutosaveSignature = autosaveSignature(assessment, questions);
        persistDraft();
        setBuilderLock();
        toast('Test saved. Questions Manager is ready.');
        await loadAssessments();
        showWorkspace('builder');
    } catch (error) {
        toast(error.message);
    }
}

async function loadAssessments() {
    try {
        const data = await api('admin/list');
        assessments = data.assessments || [];
        renderAssessments();
    } catch (error) {
        $('list').innerHTML = `<p class="mini">Turso assessment service is not ready: ${esc(error.message)}</p>`;
    }
}

function renderAssessments() {
    $('list').innerHTML = assessments.length ? assessments.map(a => `
        <article class="assessment-card">
            <div class="row">
                <div>
                    <b>${esc(a.title)}</b>
                    <p class="mini">${esc(a.subject_code)} &bull; ${esc(a.section)} &bull; ${a.duration_minutes} min</p>
                </div>
                <span class="badge">${esc(a.status)}</span>
            </div>
            <p class="mini">${esc(a.instructions || 'No instructions')}</p>
            <div class="actions">
                <button class="btn secondary" data-edit="${esc(a.id)}"><i class="ph-bold ph-pencil-simple"></i>Edit</button>
                <button class="btn secondary" data-builder="${esc(a.id)}"><i class="ph-bold ph-list-checks"></i>Questions</button>
                <button class="btn secondary" data-attempts="${esc(a.id)}"><i class="ph-bold ph-chart-bar"></i>Results</button>
                <button class="btn danger" data-delete="${esc(a.id)}"><i class="ph-bold ph-trash"></i>Delete</button>
            </div>
        </article>`).join('') : '<p class="mini">No assessments yet.</p>';
    document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => edit(btn.dataset.edit, 'details'));
    document.querySelectorAll('[data-builder]').forEach(btn => btn.onclick = () => edit(btn.dataset.builder, 'builder'));
    document.querySelectorAll('[data-attempts]').forEach(btn => btn.onclick = () => {
        editing = btn.dataset.attempts;
        showWorkspace('results');
        attempts(editing);
    });
    document.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = () => del(btn.dataset.delete));
}

async function edit(id, workspace = 'details') {
    try {
        const data = await api('admin/get?id=' + encodeURIComponent(id));
        const a = data.assessment;
        editing = id;
        $('title').value = a.title || '';
        $('instructions').value = a.instructions || '';
        $('subject').value = a.subject_code || '';
        $('section').value = a.section || '';
        $('status').value = a.status || 'draft';
        $('duration').value = a.duration_minutes || 30;
        $('opensAt').value = a.opens_at ? String(a.opens_at).slice(0, 16) : '';
        $('closesAt').value = a.closes_at ? String(a.closes_at).slice(0, 16) : '';
        questions = data.questions || [];
        lastAutosaveSignature = autosaveSignature(a, questions);
        persistDraft();
        renderQ();
        setBuilderLock();
        showWorkspace(workspace);
        scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
        toast(error.message);
    }
}

async function del(id) {
    if (!confirm('Delete this Turso assessment?')) return;
    try {
        await api('admin/delete', { method: 'POST', body: JSON.stringify({ id }) });
        if (editing === id) reset();
        toast('Deleted.');
        loadAssessments();
    } catch (error) {
        toast(error.message);
    }
}

async function attempts(id) {
    try {
        const data = await api('admin/attempts?assessment_id=' + encodeURIComponent(id));
        const attempts = data.attempts || [];
        $('attempts').innerHTML = attempts.length ? `
            <div class="table-wrap"><table class="assessment-table">
                <thead><tr><th>Student</th><th>Status</th><th>Score</th><th>Anomalies</th><th>Submitted</th></tr></thead>
                <tbody>${attempts.map(a => `<tr><td>${esc(a.student_name || a.student_no)}</td><td>${esc(a.status)}</td><td>${Number(a.score || 0)} / ${Number(a.total_points || 0)}</td><td>${Number(a.violations || 0)}</td><td>${a.submitted_at ? esc(new Date(a.submitted_at).toLocaleString()) : '-'}</td></tr>`).join('')}</tbody>
            </table></div>` : '<p class="mini">No submissions yet.</p>';
    } catch (error) {
        $('attempts').innerHTML = `<p class="mini">${esc(error.message)}</p>`;
    }
}

async function incidents() {
    try {
        const data = await api('admin/incidents');
        const incidents = data.incidents || [];
        $('attempts').innerHTML = incidents.length ? `
            <div class="table-wrap"><table class="assessment-table">
                <thead><tr><th>Time</th><th>Student</th><th>Type</th><th>Details</th></tr></thead>
                <tbody>${incidents.map(i => `<tr><td>${esc(new Date(i.created_at).toLocaleString())}</td><td>${esc(i.student_no || '')}</td><td>${esc(i.type)}</td><td>${esc(i.details || '')}</td></tr>`).join('')}</tbody>
            </table></div>` : '<p class="mini">No anomalies logged yet.</p>';
    } catch (error) {
        $('attempts').innerHTML = `<p class="mini">${esc(error.message)}</p>`;
    }
}

$('qType').onchange = () => {
    const type = $('qType').value;
    $('choiceWrap').style.display = (type === 'multiple_choice' || type === 'true_false') ? 'flex' : 'none';
    if (type === 'true_false') $('qChoices').value = 'True\nFalse';
};

$('addQ').onclick = () => {
    const type = $('qType').value;
    const prompt = $('qPrompt').value.trim();
    if (!prompt) return toast('Please type the question.');
    const q = { type, prompt, points: Number($('qPoints').value || 1), answer_key: $('qAnswer').value.trim(), choices: [] };
    if (type === 'multiple_choice' || type === 'true_false') q.choices = $('qChoices').value.split('\n').map(x => x.trim()).filter(Boolean);
    if ((type === 'multiple_choice' || type === 'true_false') && q.choices.length < 2) return toast('Add at least two choices.');
    questions.push(q);
    scheduleAutosave();
    $('qPrompt').value = '';
    $('qChoices').value = '';
    $('qAnswer').value = '';
    $('qPoints').value = '1';
    renderQ();
};

$('form').onsubmit = save;
$('newBtn').onclick = () => { reset(); showWorkspace('details'); };
$('refresh').onclick = loadAssessments;
document.querySelectorAll('[data-assessment-view]').forEach(btn => btn.onclick = () => {
    showWorkspace(btn.dataset.assessmentView);
});
document.querySelectorAll('#form input, #form textarea, #form select, #qType, #qPoints, #qPrompt, #qChoices, #qAnswer').forEach(input => {
    input.addEventListener('input', scheduleAutosave);
    input.addEventListener('change', scheduleAutosave);
});
window.addEventListener('beforeunload', persistDraft);

theme();
renderQ();
await loadSelects();
restoreDraft();
setBuilderLock();
await loadAssessments();
showWorkspace('tests');
