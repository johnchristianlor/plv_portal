import { supabase } from './supabase-adapter.js';
import { startStudentPresence } from './student-presence.js';
import { startStudentSessionGuard } from './student-session.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'student') location.replace('index.html');

const presence = startStudentPresence(supabase, user);
const guard = startStudentSessionGuard(supabase, user);
let assessments = [];
let attempts = [];
let filter = 'active';
let loading = false;
let lastLoadedAt = 0;

window.logout = async () => {
    guard.stop();
    await presence.stop();
    localStorage.removeItem('loggedInUser');
    location.replace('index.html');
};

function toast(message) {
    const element = $('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2800);
}

async function getHeaders() {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) return { authorization: `Bearer ${data.session.access_token}` };
    return {
        'x-student-no': user.studentNo || '',
        'x-student-session': user.activeSessionToken || user.sessionToken || ''
    };
}

async function api(path) {
    const response = await fetch(`/api/assessments/${path}`, {
        headers: { 'content-type': 'application/json', ...(await getHeaders()) },
        cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Assessment request failed.');
    return data;
}

function setupTheme() {
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-theme');
    const updateIcon = () => {
        $('themeIcon').className = document.body.classList.contains('dark-theme') ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
    };
    updateIcon();
    $('themeToggle').onclick = () => {
        document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
        updateIcon();
        $('themeToggle').classList.add('theme-spin');
        setTimeout(() => $('themeToggle').classList.remove('theme-spin'), 480);
    };
}

function stateOf(assessment) {
    const now = Date.now();
    const opensAt = assessment.opens_at ? Date.parse(assessment.opens_at) : 0;
    const closesAt = assessment.closes_at ? Date.parse(assessment.closes_at) : Infinity;
    if (attempts.some(item => item.assessment_id === assessment.id && item.status === 'submitted')) return 'completed';
    if (assessment.status !== 'published' || (opensAt && now < opensAt)) return 'upcoming';
    if (closesAt && now > closesAt) return 'closed';
    return 'active';
}

function formatDate(value, fallback) {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toLocaleString();
}

function securitySummary(assessment) {
    const settings = assessment.settings || {};
    const mode = String(settings.mode || settings.securityMode || 'standard');
    const labels = { standard: 'Standard', monitored: 'Monitored', strict: 'Strict', secure_browser_ready: 'Secure Browser Ready' };
    const attempts = Math.max(1, Number(settings.maxAttempts || 1));
    const fullscreen = settings.requireFullscreen ?? settings.fullscreen;
    return `${labels[mode] || 'Standard'} • ${attempts} attempt${attempts === 1 ? '' : 's'}${fullscreen ? ' • Fullscreen' : ''}`;
}

function render() {
    const visible = assessments.filter(item => filter === 'all' || stateOf(item) === filter);
    $('list').innerHTML = visible.length ? visible.map(assessment => {
        const state = stateOf(assessment);
        const submitted = attempts.find(item => item.assessment_id === assessment.id && item.status === 'submitted');
        const started = attempts.find(item => item.assessment_id === assessment.id && item.status === 'started');
        const buttonLabel = submitted
            ? 'Submitted'
            : started
                ? '<i class="ph-bold ph-arrows-clockwise"></i> Resume Secure Exam'
                : '<i class="ph-bold ph-shield-check"></i> Open Secure Exam';
        return `<article class="glass assessment-card">
            <div class="row"><div><h3>${esc(assessment.title)}</h3><p style="color:var(--text-muted);font-weight:700">${esc(assessment.instructions || 'No instructions provided.')}</p></div><span class="badge">${esc(state)}</span></div>
            <div class="meta">
                <span class="badge">${esc(assessment.subject_code)}</span>
                <span class="badge">${esc(assessment.section)}</span>
                <span class="badge">${Number(assessment.duration_minutes || 0)} min</span>
                <span class="badge"><i class="ph-fill ph-shield-check"></i>${esc(securitySummary(assessment))}</span>
            </div>
            <p style="color:var(--text-muted);font-weight:700;line-height:1.7">Open: ${esc(formatDate(assessment.opens_at, 'Anytime'))}<br>Close: ${esc(formatDate(assessment.closes_at, 'No close date'))}</p>
            ${submitted ? `<p><b>Score:</b> ${Number(submitted.score || 0)} / ${Number(submitted.total_points || 0)} &bull; <b>Warning score:</b> ${Number(submitted.warning_count ?? submitted.violations ?? 0)}</p>` : ''}
            <button class="btn" data-open-exam="${esc(assessment.id)}" ${state !== 'active' || submitted ? 'disabled' : ''}>${buttonLabel}</button>
        </article>`;
    }).join('') : '<article class="glass assessment-card"><b>No assessments here.</b><p style="color:var(--text-muted);font-weight:700">Nothing matches this tab.</p></article>';

    document.querySelectorAll('[data-open-exam]').forEach(button => {
        button.onclick = () => openSecureExam(button.dataset.openExam);
    });
}

function openSecureExam(id) {
    const assessment = assessments.find(item => String(item.id) === String(id));
    if (!assessment || stateOf(assessment) !== 'active') return toast('This assessment is not active.');
    const url = `student-exam.html?assessment_id=${encodeURIComponent(id)}`;
    const name = `plv_secure_exam_${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const examWindow = window.open(url, name);
    if (!examWindow) return toast('Allow pop-ups for this site to open the secure exam tab.');
    examWindow.focus();
}

async function load(force = false) {
    if (loading || (!force && Date.now() - lastLoadedAt < 2500)) return;
    loading = true;
    try {
        const data = await api('student/list');
        assessments = data.assessments || [];
        attempts = data.attempts || [];
        lastLoadedAt = Date.now();
        render();
    } catch (error) {
        $('list').innerHTML = `<article class="glass assessment-card"><b>Assessments are not ready.</b><p style="color:var(--text-muted);font-weight:700">${esc(error.message)}</p></article>`;
    } finally {
        loading = false;
    }
}

document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
        document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
        tab.classList.add('active');
        filter = tab.dataset.filter;
        render();
    };
});
window.addEventListener('storage', event => {
    if (event.key === 'plvAssessmentSubmittedAt') load(true);
});
window.addEventListener('focus', () => load());

setupTheme();
await load(true);
