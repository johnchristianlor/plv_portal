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

function toast(message, duration = 2800) {
    const element = $('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), duration);
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
    return `${labels[mode] || 'Standard'} | ${attempts} attempt${attempts === 1 ? '' : 's'}${fullscreen ? ' | Fullscreen' : ''}`;
}

function secureBrowserInfo(assessment) {
    const settings = assessment?.settings?.security || assessment?.settings || {};
    return {
        required: settings.requireSecureBrowser === true,
        launchUrl: String(settings.secureBrowserLaunchUrl || assessment?.settings?.secureBrowserLaunchUrl || '').trim(),
        active: !!globalThis.SafeExamBrowser?.security,
        android: /Android/i.test(navigator.userAgent || '')
    };
}

function statusMeta(state) {
    return {
        active: { label: 'Open now', icon: 'ph-fill ph-play-circle', tone: 'active' },
        upcoming: { label: 'Upcoming', icon: 'ph-fill ph-clock-countdown', tone: 'upcoming' },
        completed: { label: 'Completed', icon: 'ph-fill ph-check-circle', tone: 'completed' },
        closed: { label: 'Closed', icon: 'ph-fill ph-lock-key', tone: 'closed' }
    }[state] || { label: state || 'Status', icon: 'ph-fill ph-info', tone: 'neutral' };
}

function shortDate(value, fallback) {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return fallback;
    return parsed.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function emptyCard(title, message, icon = 'ph-fill ph-folder-simple-dashed') {
    return `<article class="glass assessment-empty"><div class="assessment-empty-icon"><i class="${icon}"></i></div><b>${esc(title)}</b><p>${esc(message)}</p></article>`;
}

function render() {
    const visible = assessments.filter(item => filter === 'all' || stateOf(item) === filter);
    $('list').innerHTML = visible.length ? visible.map(assessment => {
        const state = stateOf(assessment);
        const status = statusMeta(state);
        const submitted = attempts.find(item => item.assessment_id === assessment.id && item.status === 'submitted');
        const started = attempts.find(item => item.assessment_id === assessment.id && item.status === 'started');
        const scoreText = submitted ? `${Number(submitted.score || 0)} / ${Number(submitted.total_points || 0)}` : '';
        const warningText = submitted ? Number(submitted.warning_count ?? submitted.violations ?? 0) : 0;
        const secureBrowser = secureBrowserInfo(assessment);
        const androidSebBlocked = secureBrowser.required && secureBrowser.android && !secureBrowser.active;
        const buttonLabel = submitted
            ? '<i class="ph-bold ph-check"></i> Submitted'
            : started
                ? '<i class="ph-bold ph-arrows-clockwise"></i> Resume Exam'
                : androidSebBlocked
                    ? '<i class="ph-bold ph-warning-circle"></i> Android device options'
                : secureBrowser.required && !secureBrowser.active
                    ? '<i class="ph-bold ph-shield-check"></i> Open in Safe Exam Browser'
                    : '<i class="ph-bold ph-play"></i> Start Exam';
        const disabled = state !== 'active' || submitted;
        return `<article class="glass assessment-card student-assessment-card ${esc(status.tone)}">
            <div class="assessment-card-accent"></div>
            <div class="student-assessment-head">
                <div class="student-assessment-icon"><i class="ph-fill ph-exam"></i></div>
                <div class="student-assessment-title">
                    <span class="student-status ${esc(status.tone)}"><i class="${esc(status.icon)}"></i>${esc(status.label)}</span>
                    <h3>${esc(assessment.title || 'Untitled assessment')}</h3>
                    <p>${esc(assessment.instructions || 'Read the instructions carefully before starting.')}</p>
                </div>
            </div>
            <div class="student-assessment-meta">
                <div><span>Subject</span><strong>${esc(assessment.subject_code || '-')}</strong></div>
                <div><span>Section</span><strong>${esc(assessment.section || '-')}</strong></div>
                <div><span>Duration</span><strong>${Number(assessment.duration_minutes || 0)} min</strong></div>
                <div><span>Security</span><strong>${esc(securitySummary(assessment))}</strong></div>
            </div>
            <div class="student-assessment-window">
                <div><i class="ph-bold ph-calendar-check"></i><span>Opens</span><strong>${esc(shortDate(assessment.opens_at, 'Anytime'))}</strong></div>
                <div><i class="ph-bold ph-calendar-x"></i><span>Closes</span><strong>${esc(shortDate(assessment.closes_at, 'No close date'))}</strong></div>
            </div>
            ${submitted ? `<div class="student-score-strip"><span><i class="ph-fill ph-medal"></i> Score <strong>${esc(scoreText)}</strong></span><span>Warning score <strong>${warningText}</strong></span></div>` : ''}
            ${androidSebBlocked ? `<div class="android-seb-notice"><i class="ph-fill ph-info"></i><span>This test requires Safe Exam Browser, which is not available on Android. Use an iPhone/iPad or computer, or ask the administrator to use Strict browser mode.</span></div>` : ''}
            <button class="btn student-assessment-action" data-open-exam="${esc(assessment.id)}" ${disabled ? 'disabled' : ''}>${buttonLabel}</button>
        </article>`;
    }).join('') : emptyCard('No assessments here.', 'Nothing matches this tab.');

    document.querySelectorAll('[data-open-exam]').forEach(button => {
        button.onclick = () => openSecureExam(button.dataset.openExam);
    });
}

function openSecureExam(id) {
    const assessment = assessments.find(item => String(item.id) === String(id));
    if (!assessment || stateOf(assessment) !== 'active') return toast('This assessment is not active.');
    const url = `student-exam.html?assessment_id=${encodeURIComponent(id)}`;
    const secureBrowser = secureBrowserInfo(assessment);
    if (secureBrowser.required && !secureBrowser.active && secureBrowser.android) {
        toast('Safe Exam Browser has no official Android app. Ask the administrator to disable the SEB requirement and use Strict mode, or take the test on an iPhone, iPad, Windows PC, or Mac.', 6500);
        return;
    }
    if (secureBrowser.required && !secureBrowser.active && secureBrowser.launchUrl) {
        location.assign(secureBrowser.launchUrl);
        return;
    }
    location.assign(url);
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
        $('list').innerHTML = emptyCard('Assessments are not ready.', error.message, 'ph-fill ph-warning-circle');
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
