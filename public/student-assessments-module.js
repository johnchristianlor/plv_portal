import { supabase } from './supabase-adapter.js';
import { startStudentPresence } from './student-presence.js';
import { startStudentSessionGuard } from './student-session.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'student') location.href = 'index.html';

const presence = startStudentPresence(supabase, user);
const guard = startStudentSessionGuard(supabase, user);
window.logout = async () => {
    guard.stop();
    await presence.stop();
    localStorage.removeItem('loggedInUser');
    location.href = 'index.html';
};

let assessments = [];
let attempts = [];
let filter = 'active';
let current = null;
let attempt = null;
let questions = [];
let answers = {};
let idx = 0;
let deadline = 0;
let timerId = null;
let violations = 0;
let maxViolations = 5;
let fullscreenRequired = true;
let securityHandlers = [];
let submitting = false;
let securityUiReady = false;
let examUiLocked = false;
let isMobileExam = false;

function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    setTimeout(() => $('toast').classList.remove('show'), 2600);
}

async function getToken() {
    const { data } = await supabase.auth.getSession();
    if (data.session && data.session.access_token) return data.session.access_token;
    return '';
}

function getStudentSessionHeaders() {
    const headers = {};
    const sessionToken = user && (user.activeSessionToken || user.sessionToken);
    const studentNo = user && user.studentNo;
    if (studentNo && sessionToken) {
        headers['x-student-no'] = studentNo;
        headers['x-student-session'] = sessionToken;
    }
    return headers;
}

async function api(path, options = {}) {
    const token = await getToken();
    const response = await fetch('/api/assessments/' + path, {
        ...options,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: 'Bearer ' + token } : getStudentSessionHeaders()),
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Assessment request failed.');
    return data;
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
        $('themeToggle').classList.add('theme-spin');
        setTimeout(() => $('themeToggle').classList.remove('theme-spin'), 480);
    };
}

function ensureSecurityUi() {
    if (securityUiReady) return;
    const exam = $('exam');
    if (!exam) return;
    const status = exam.querySelector('.exam-status');
    if (status && !status.querySelector('.proctor-pill')) {
        const pill = document.createElement('div');
        pill.className = 'proctor-pill';
        pill.innerHTML = '<i class="ph-fill ph-shield-check"></i> Proctoring active';
        status.prepend(pill);
    }
    if (!$('examLock')) {
        const lock = document.createElement('div');
        lock.id = 'examLock';
        lock.style.cssText = 'position:fixed;inset:0;z-index:900;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(2,6,23,.76);backdrop-filter:blur(12px)';
        lock.innerHTML = '<section class="glass exam-lock-card" style="width:min(680px,100%);padding:30px"><h2 style="font-size:28px;font-weight:900;margin-bottom:8px"><i class="ph-fill ph-shield-warning"></i> Fullscreen Required</h2><p style="color:var(--text-muted);font-weight:700;line-height:1.7">You left the protected exam view. Return to fullscreen to continue, or submit now if this was intentional. The assessment timer keeps running.</p><div class="actions" style="margin-top:20px"><button class="btn secondary" id="examLockReturn" type="button"><i class="ph-bold ph-arrows-clockwise"></i>Return to Fullscreen</button><button class="btn primary" id="examLockSubmit" type="button"><i class="ph-bold ph-paper-plane-tilt"></i>Submit Assessment</button></div></section>';
        document.body.appendChild(lock);
    }
    securityUiReady = true;
    $('examLockReturn').onclick = async () => {
        if (fullscreenRequired && document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen().catch(() => {});
        }
        hideExamLock();
    };
    $('examLockSubmit').onclick = () => submit(false);
}

function showExamLock() {
    ensureSecurityUi();
    const lock = $('examLock');
    if (lock) lock.style.display = 'flex';
    if (examUiLocked) return;
    examUiLocked = true;
    const qBox = $('qBox');
    const actions = document.querySelectorAll('#exam .actions button');
    const examMeta = $('examMeta');
    if (qBox) qBox.style.display = 'none';
    actions.forEach(button => { button.disabled = true; });
    if (examMeta) examMeta.textContent = `${current?.subject_code || ''} • Locked until fullscreen is restored`;
}

function lockForSecurity(type, details) {
    if (!attempt || submitting) return;
    addIncident(type, details).finally(() => {
        showExamLock();
        if (isMobileExam && violations >= 1) {
            submit(true);
        }
    });
}

function hideExamLock() {
    const lock = $('examLock');
    if (lock) lock.style.display = 'none';
    if (!examUiLocked) return;
    examUiLocked = false;
    const qBox = $('qBox');
    const actions = document.querySelectorAll('#exam .actions button');
    const examMeta = $('examMeta');
    if (qBox) qBox.style.display = '';
    actions.forEach(button => { button.disabled = false; });
    if (examMeta && current) examMeta.textContent = `${current.subject_code} • ${questions.length} questions`;
}

function stateOf(assessment) {
    const now = Date.now();
    const open = assessment.opens_at ? Date.parse(assessment.opens_at) : 0;
    const close = assessment.closes_at ? Date.parse(assessment.closes_at) : Infinity;
    if (attempts.some(x => x.assessment_id === assessment.id && x.status === 'submitted')) return 'completed';
    if (assessment.status !== 'published' || (open && now < open)) return 'upcoming';
    if (close && now > close) return 'closed';
    return 'active';
}

function securitySettings(assessment) {
    const settings = assessment && typeof assessment.settings === 'object' ? assessment.settings : {};
    return {
        fullscreen: settings.fullscreen !== false,
        maxViolations: Number.isFinite(Number(settings.maxViolations)) ? Math.max(1, Number(settings.maxViolations)) : 5
    };
}

function detectMobileExam() {
    return window.matchMedia('(max-width: 768px)').matches || navigator.maxTouchPoints > 1 || /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
}

function shouldBlockKey(event) {
    const key = String(event.key || '').toLowerCase();
    const blockedKeys = ['escape', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];
    if (blockedKeys.includes(key)) return true;
    if (event.altKey || event.metaKey) return true;
    if (event.ctrlKey && ['r', 'w', 't', 'n', 'l', 'u', 'p', 's', 'i', 'j', 'k', 'c', 'x', 'v'].includes(key)) return true;
    return false;
}

function tryLockOrientation() {
    if (!isMobileExam || !screen.orientation || !screen.orientation.lock) return;
    screen.orientation.lock('portrait').catch(() => {});
}

async function load() {
    try {
        const data = await api('student/list');
        assessments = data.assessments || [];
        attempts = data.attempts || [];
        render();
    } catch (error) {
        $('list').innerHTML = `<article class="glass assessment-card"><b>Assessments are not ready.</b><p>${esc(error.message)}</p></article>`;
    }
}

function render() {
    const items = assessments.filter(a => filter === 'all' || stateOf(a) === filter);
    $('list').innerHTML = items.length ? items.map(a => {
        const state = stateOf(a);
        const done = attempts.find(x => x.assessment_id === a.id && x.status === 'submitted');
        return `<article class="glass assessment-card">
            <h3>${esc(a.title)}</h3>
            <p style="color:var(--text-muted);font-weight:700">${esc(a.instructions || 'No instructions provided.')}</p>
            <div class="meta">
                <span class="badge">${esc(a.subject_code)}</span>
                <span class="badge">${esc(a.section)}</span>
                <span class="badge">${esc(state)}</span>
                <span class="badge">${a.duration_minutes || 0} min</span>
            </div>
            <p style="color:var(--text-muted);font-weight:700">Open: ${a.opens_at ? new Date(a.opens_at).toLocaleString() : 'Anytime'}<br>Close: ${a.closes_at ? new Date(a.closes_at).toLocaleString() : 'No close date'}</p>
            ${done ? `<p><b>Score:</b> ${Number(done.score || 0)} / ${Number(done.total_points || 0)} &bull; <b>Anomalies:</b> ${Number(done.violations || 0)}</p>` : ''}
            <button class="btn" data-ready="${esc(a.id)}" ${state !== 'active' || done ? 'disabled' : ''}>${done ? 'Submitted' : 'Start Assessment'}</button>
        </article>`;
    }).join('') : '<article class="glass assessment-card"><b>No assessments here.</b><p style="color:var(--text-muted);font-weight:700">Nothing matches this tab.</p></article>';
    document.querySelectorAll('[data-ready]').forEach(btn => btn.onclick = () => showReady(btn.dataset.ready));
}

function showReady(id) {
    ensureSecurityUi();
    current = assessments.find(a => a.id === id);
    if (!current || stateOf(current) !== 'active') return toast('This assessment is not active.');
    const security = securitySettings(current);
    isMobileExam = detectMobileExam();
    fullscreenRequired = security.fullscreen;
    maxViolations = isMobileExam ? Math.min(security.maxViolations, 2) : security.maxViolations;
    $('readyTitle').textContent = current.title;
    $('readyInfo').innerHTML = `
        <span class="badge">${esc(current.subject_code)}</span>
        <span class="badge">${esc(current.duration_minutes)} min</span>
        <span class="badge">${fullscreenRequired ? 'Fullscreen required' : 'Fullscreen optional'}</span>
        <span class="badge">${maxViolations} violation limit</span>
        <span class="badge">${isMobileExam ? 'Mobile lock mode' : 'Desktop mode'}</span>`;
    $('readyInstructions').textContent = current.instructions || 'Read every item carefully before submitting.';
    $('readyCheck').checked = false;
    $('readyModal').classList.add('show');
}

function closeReady() {
    $('readyModal').classList.remove('show');
}

async function startAssessment() {
    if (!$('readyCheck').checked) return toast('Please confirm the assessment notice.');
    try {
        isMobileExam = detectMobileExam();
        tryLockOrientation();
        if (fullscreenRequired && document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen().catch(() => {});
        }
        const data = await api('student/start', { method: 'POST', body: JSON.stringify({ assessment_id: current.id }) });
        attempt = data.attempt;
        current = data.assessment;
        const security = securitySettings(current);
        fullscreenRequired = security.fullscreen;
        maxViolations = isMobileExam ? Math.min(security.maxViolations, 2) : security.maxViolations;
        tryLockOrientation();
        questions = data.questions || [];
        answers = {};
        idx = 0;
        violations = 0;
        deadline = Date.parse(attempt.deadline_at);
        closeReady();
        $('portal').style.display = 'none';
        $('exam').classList.add('show');
        document.body.classList.add('exam-active');
        hideExamLock();
        $('examTitle').textContent = current.title;
        $('examMeta').textContent = `${current.subject_code} • ${questions.length} questions`;
        $('violN').textContent = '0';
        bindSecurity();
        renderQ();
        tick();
        timerId = setInterval(tick, 1000);
    } catch (error) {
        toast(error.message);
    }
}

function renderQ() {
    const q = questions[idx];
    if (!q) {
        $('qBox').innerHTML = '<p>No questions found.</p>';
        return;
    }
    let body = '';
    if (q.type === 'essay' || q.type === 'short_answer') {
        body = `<textarea id="answerText" class="textarea" placeholder="Type your answer here.">${esc(answers[q.id] || '')}</textarea>`;
    } else {
        body = (q.choices || []).map(choice => `<label class="choice"><input type="radio" name="choice" value="${esc(choice)}" ${answers[q.id] === choice ? 'checked' : ''}> <span>${esc(choice)}</span></label>`).join('');
    }
    $('qBox').innerHTML = `
        <p style="color:var(--text-muted);font-weight:900">Question ${idx + 1} of ${questions.length} • ${q.points} pt</p>
        <h2>${esc(q.prompt)}</h2>
        <div>${body}</div>
        <div class="qnav">${questions.map((item, i) => `<button class="qnav-btn ${i === idx ? 'active' : ''} ${answers[item.id] ? 'answered' : ''}" data-jump="${i}">${i + 1}</button>`).join('')}</div>`;
    $('prev').disabled = idx === 0;
    $('next').disabled = idx === questions.length - 1;
    document.querySelectorAll('[data-jump]').forEach(btn => btn.onclick = () => {
        saveAnswer();
        idx = Number(btn.dataset.jump);
        renderQ();
    });
}

function saveAnswer() {
    const q = questions[idx];
    if (!q) return;
    if (q.type === 'essay' || q.type === 'short_answer') answers[q.id] = $('answerText')?.value || '';
    else answers[q.id] = document.querySelector('input[name="choice"]:checked')?.value || '';
}

function tick() {
    const left = Math.max(0, deadline - Date.now());
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    $('timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (left <= 0) submit(true);
}

async function addIncident(type, details) {
    if (!attempt || submitting) return;
    violations += 1;
    $('violN').textContent = String(violations);
    toast(`${details} (${violations})`);
    try {
        const data = await api('student/incident', { method: 'POST', body: JSON.stringify({ attempt_id: attempt.id, type, details }) });
        if (typeof data.violations === 'number') {
            violations = data.violations;
            $('violN').textContent = String(violations);
        }
        if (violations >= maxViolations) {
            toast('Violation limit reached. Submitting assessment.');
            await submit(true);
        }
    } catch (_) {}
}

function bindSecurity() {
    clearSecurity();
    const listen = (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        securityHandlers.push(() => target.removeEventListener(event, handler, options));
    };
    listen(document, 'visibilitychange', () => { if (document.hidden) lockForSecurity('tab_hidden', 'Assessment tab was hidden.'); });
    listen(window, 'blur', () => lockForSecurity('window_blur', 'Browser window lost focus.'));
    listen(window, 'pagehide', () => lockForSecurity('pagehide', 'Assessment page was hidden.'));
    listen(document, 'fullscreenchange', () => {
        if (fullscreenRequired && !document.fullscreenElement) {
            lockForSecurity('fullscreen_exit', 'Fullscreen mode was exited.');
            showExamLock();
        }
    });
    listen(window, 'orientationchange', () => { if (isMobileExam) lockForSecurity('orientation_change', 'Device orientation changed during the assessment.'); });
    listen(window, 'resize', () => {
        if (!isMobileExam || !attempt || submitting) return;
        if (document.hidden) return;
        if (window.innerWidth < 768 && !document.fullscreenElement) lockForSecurity('viewport_change', 'Mobile viewport changed during the assessment.');
    });
    listen(document, 'gesturestart', event => { event.preventDefault(); lockForSecurity('gesture', 'Zoom gesture was blocked.'); }, { passive: false });
    listen(document, 'touchmove', event => {
        if (!isMobileExam || !attempt || submitting) return;
        const target = event.target;
        const allowTyping = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
        if (allowTyping) return;
        event.preventDefault();
        lockForSecurity('touch_move', 'Touch gesture was blocked during the assessment.');
    }, { passive: false });
    listen(document, 'selectstart', event => {
        if (!isMobileExam || !attempt || submitting) return;
        const target = event.target;
        const allowTyping = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
        if (allowTyping) return;
        event.preventDefault();
    });
    listen(document, 'keydown', event => {
        if (!attempt || submitting) return;
        const target = event.target;
        const allowTyping = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
        if (allowTyping && !shouldBlockKey(event)) return;
        if (!shouldBlockKey(event)) return;
        event.preventDefault();
        lockForSecurity('hotkey', 'A restricted key or shortcut was pressed.');
    });
    listen(document, 'copy', event => { event.preventDefault(); addIncident('copy', 'Copy action was blocked.'); });
    listen(document, 'cut', event => { event.preventDefault(); addIncident('cut', 'Cut action was blocked.'); });
    listen(document, 'paste', event => { event.preventDefault(); addIncident('paste', 'Paste action was blocked.'); });
    listen(document, 'contextmenu', event => { event.preventDefault(); addIncident('context_menu', 'Right click/context menu was blocked.'); });
    listen(window, 'offline', () => addIncident('offline', 'Network connection was lost.'));
    listen(window, 'beforeprint', event => { event.preventDefault(); addIncident('print', 'Print attempt was detected.'); });
}

function clearSecurity() {
    securityHandlers.forEach(remove => remove());
    securityHandlers = [];
}

async function submit(auto = false) {
    if (submitting) return;
    saveAnswer();
    if (!auto && !confirm('Submit this assessment now?')) return;
    submitting = true;
    clearInterval(timerId);
    clearSecurity();
    hideExamLock();
    try {
        const data = await api('student/submit', { method: 'POST', body: JSON.stringify({ attempt_id: attempt.id, answers }) });
        toast(`Assessment submitted. Score: ${Number(data.score || 0)} / ${Number(data.total_points || 0)}`);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        $('exam').classList.remove('show');
        document.body.classList.remove('exam-active');
        $('portal').style.display = 'flex';
        await load();
    } catch (error) {
        submitting = false;
        bindSecurity();
        tick();
        timerId = setInterval(tick, 1000);
        toast(error.message);
    }
}

$('prev').onclick = () => {
    saveAnswer();
    idx = Math.max(0, idx - 1);
    renderQ();
};
$('next').onclick = () => {
    saveAnswer();
    idx = Math.min(questions.length - 1, idx + 1);
    renderQ();
};
$('submit').onclick = () => submit(false);
$('readyCancel').onclick = closeReady;
$('readyStart').onclick = startAssessment;
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    filter = tab.dataset.filter;
    render();
});

theme();
ensureSecurityUi();
await load();
