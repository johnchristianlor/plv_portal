import { supabase } from './supabase-adapter.js';
import { startStudentSessionGuard } from './student-session.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'student') location.replace('index.html');

const guard = startStudentSessionGuard(supabase, user);
const params = new URLSearchParams(location.search);
const assessmentId = String(params.get('assessment_id') || '').trim();
const sessionKey = `plvExamClientSession:${assessmentId}`;
const leaseKey = `plvExamLease:${assessmentId}`;
const makeId = prefix => crypto.randomUUID ? `${prefix}_${crypto.randomUUID()}` : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const clientSessionId = sessionStorage.getItem(sessionKey) || makeId('exam');
const tabInstanceId = makeId('tab');
sessionStorage.setItem(sessionKey, clientSessionId);

let assessment = null;
let attempt = null;
let questions = [];
let answers = {};
let flagged = new Set();
let currentIndex = 0;
let deadline = 0;
let violations = 0;
let maxViolations = 5;
let fullscreenRequired = true;
let active = false;
let submitting = false;
let securityBound = false;
let dirty = false;
let saveTimer = null;
let autosaveInterval = null;
let timerInterval = null;
let leaseInterval = null;
let channel = null;
let otherTabDetected = false;
let authHeadersCache = null;
let pendingIncidents = [];
let requestQueue = Promise.resolve();
const securityRemovers = [];
const incidentCooldown = new Map();

function showOnly(id) {
    ['loadingScreen', 'preflightScreen', 'blockedScreen', 'examShell', 'completedScreen'].forEach(name => $(name)?.classList.toggle('hidden', name !== id));
}

function setTheme() {
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-theme');
    const update = () => {
        const dark = document.body.classList.contains('dark-theme');
        $('themeIcon').className = dark ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
    };
    update();
    $('themeToggle').onclick = () => {
        document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
        update();
    };
}

async function authHeaders() {
    if (authHeadersCache) return authHeadersCache;
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token || '';
    const sessionToken = user.activeSessionToken || user.sessionToken || '';
    authHeadersCache = accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : { 'x-student-no': user.studentNo || '', 'x-student-session': sessionToken };
    return authHeadersCache;
}

async function api(path, options = {}) {
    const response = await fetch(`/api/assessments/${path}`, {
        ...options,
        headers: {
            'content-type': 'application/json',
            ...(await authHeaders()),
            ...(options.headers || {})
        },
        cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || 'Assessment request failed.');
        error.code = data.code || '';
        error.status = response.status;
        throw error;
    }
    return data;
}

function queuedApi(path, options) {
    const run = () => api(path, options);
    requestQueue = requestQueue.then(run, run);
    return requestQueue;
}

function securitySettings(item) {
    const settings = item?.settings && typeof item.settings === 'object' ? item.settings : {};
    return {
        fullscreen: settings.fullscreen !== false,
        maxViolations: Math.max(1, Number(settings.maxViolations || settings.maxViol || 5))
    };
}

function stateOf(item, attempts) {
    const now = Date.now();
    const open = item.opens_at ? Date.parse(item.opens_at) : 0;
    const close = item.closes_at ? Date.parse(item.closes_at) : Infinity;
    if (attempts.some(entry => entry.assessment_id === item.id && entry.status === 'submitted')) return 'completed';
    if (item.status !== 'published' || (open && now < open)) return 'upcoming';
    if (close && now > close) return 'closed';
    return 'active';
}

function block(title, message, retry = true) {
    active = false;
    showOnly('blockedScreen');
    $('blockedTitle').textContent = title;
    $('blockedMessage').textContent = message;
    $('blockedRetry').classList.toggle('hidden', !retry);
}

function updateSystemChecks() {
    $('checkStudent').textContent = user.studentName || user.fullName || user.name || user.studentNo || 'Verified';
    $('checkSecure').textContent = location.protocol === 'https:' || location.hostname === 'localhost' ? 'Secure' : 'Not secure';
    $('checkSecure').style.color = location.protocol === 'https:' || location.hostname === 'localhost' ? 'var(--green)' : 'var(--red)';
    const fs = !!document.documentElement.requestFullscreen;
    $('checkFullscreen').textContent = fs ? 'Supported' : 'Limited mode';
    $('checkFullscreen').style.color = fs ? 'var(--green)' : 'var(--amber)';
    $('checkNetwork').textContent = navigator.onLine ? 'Online' : 'Offline';
    $('checkNetwork').style.color = navigator.onLine ? 'var(--green)' : 'var(--red)';
}

function renderPreflight() {
    const security = securitySettings(assessment);
    fullscreenRequired = security.fullscreen;
    maxViolations = security.maxViolations;
    $('preflightTitle').textContent = assessment.title || 'Assessment';
    $('preflightInstructions').textContent = assessment.instructions || 'Read each question carefully and submit your work before the timer ends.';
    $('preflightMeta').innerHTML = `
        <span class="badge">${esc(assessment.subject_code || 'Subject')}</span>
        <span class="badge">${esc(assessment.section || 'Section')}</span>
        <span class="badge amber">${Number(assessment.duration_minutes || 30)} minutes</span>
        <span class="badge green">${fullscreenRequired ? 'Fullscreen monitored' : 'Dedicated exam view'}</span>
        <span class="badge red">${maxViolations} anomaly limit</span>`;
    updateSystemChecks();
    $('confirmReady').checked = false;
    showOnly('preflightScreen');
}

async function loadAssessment() {
    if (!assessmentId) return block('Missing assessment', 'The secure exam link does not contain an assessment ID.', false);
    showOnly('loadingScreen');
    try {
        const data = await api('student/list');
        assessment = (data.assessments || []).find(item => String(item.id) === assessmentId);
        if (!assessment) return block('Assessment not found', 'This assessment is not assigned to your account or is no longer available.', false);
        const state = stateOf(assessment, data.attempts || []);
        const submittedAttempt = (data.attempts || []).find(item => item.assessment_id === assessmentId && item.status === 'submitted');
        if (submittedAttempt) {
            showCompleted(submittedAttempt.score, submittedAttempt.total_points, true);
            return;
        }
        if (state !== 'active') {
            const messages = {
                upcoming: 'This assessment has not opened yet.',
                closed: 'This assessment is already closed.'
            };
            return block('Assessment unavailable', messages[state] || 'This assessment is not active.', true);
        }
        renderPreflight();
        probeOtherTabs();
    } catch (error) {
        block('Unable to prepare assessment', error.message, true);
    }
}

function getLease() {
    try { return JSON.parse(localStorage.getItem(leaseKey) || 'null'); } catch { return null; }
}

function leaseBelongsToOtherTab() {
    const lease = getLease();
    return !!(lease && lease.tabId !== tabInstanceId && Date.now() - Number(lease.updatedAt || 0) < 35000);
}

function writeLease() {
    if (!active) return;
    localStorage.setItem(leaseKey, JSON.stringify({ sessionId: clientSessionId, tabId: tabInstanceId, updatedAt: Date.now() }));
}

function clearLease() {
    const lease = getLease();
    if (!lease || lease.tabId === tabInstanceId) localStorage.removeItem(leaseKey);
    clearInterval(leaseInterval);
}

function setupTabChannel() {
    if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel(`plv-secure-exam:${assessmentId}`);
        channel.onmessage = event => {
            const message = event.data || {};
            if (message.tabId === tabInstanceId) return;
            if (message.type === 'probe' && active) channel.postMessage({ type: 'active', sessionId: clientSessionId, tabId: tabInstanceId });
            if (message.type === 'active' || message.type === 'starting') {
                otherTabDetected = true;
                if (active) {
                    reportIncident('duplicate_exam_tab', 'Another tab attempted to open the same assessment.', { lock: true });
                }
            }
            if (message.type === 'submitted') {
                if (!active) loadAssessment();
            }
        };
    }
    window.addEventListener('storage', event => {
        if (event.key !== leaseKey || !event.newValue) return;
        const lease = getLease();
        if (lease && lease.tabId !== tabInstanceId && Date.now() - lease.updatedAt < 35000) {
            otherTabDetected = true;
            if (active) reportIncident('duplicate_exam_tab', 'Another browser tab claimed this assessment session.', { lock: true });
        }
    });
}

function probeOtherTabs() {
    otherTabDetected = leaseBelongsToOtherTab();
    channel?.postMessage({ type: 'probe', sessionId: clientSessionId, tabId: tabInstanceId });
}

function requestFullscreen() {
    if (!fullscreenRequired || !document.documentElement.requestFullscreen) return Promise.resolve(false);
    return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => true).catch(() => false);
}

async function startExam() {
    if (!$('confirmReady').checked) {
        $('confirmReady').focus();
        return;
    }
    probeOtherTabs();
    if (otherTabDetected || leaseBelongsToOtherTab()) {
        return block('Exam already open', 'This assessment appears to be open in another tab. Return to that tab, or close it and wait about one minute before trying again.', true);
    }
    if (!navigator.onLine) return block('No internet connection', 'Reconnect to the internet before starting the assessment.', true);

    $('startExam').disabled = true;
    $('startExam').innerHTML = '<i class="ph-bold ph-spinner-gap"></i> Starting…';
    channel?.postMessage({ type: 'starting', sessionId: clientSessionId, tabId: tabInstanceId });
    try {
        const fsEntered = await requestFullscreen();
        if (fullscreenRequired && document.documentElement.requestFullscreen && !fsEntered) {
            $('startExam').disabled = false;
            $('startExam').innerHTML = '<i class="ph-bold ph-shield-check"></i> Start Secure Exam';
            return block('Fullscreen permission required', 'Allow fullscreen mode, then try starting the assessment again.', true);
        }
        const data = await api('student/start', {
            method: 'POST',
            body: JSON.stringify({ assessment_id: assessmentId, client_session_id: clientSessionId })
        });
        assessment = data.assessment;
        attempt = data.attempt;
        questions = Array.isArray(data.questions) ? data.questions : [];
        answers = data.answers && typeof data.answers === 'object' ? data.answers : {};
        currentIndex = Math.max(0, Math.min(questions.length - 1, Number(attempt.last_question_index || 0)));
        deadline = Date.parse(attempt.deadline_at);
        violations = Number(attempt.violations || 0);
        const security = securitySettings(assessment);
        fullscreenRequired = security.fullscreen && !!document.documentElement.requestFullscreen;
        maxViolations = security.maxViolations;
        if (!questions.length) throw new Error('This assessment has no available questions.');

        active = true;
        submitting = false;
        showOnly('examShell');
        $('examTitle').textContent = assessment.title || 'Assessment';
        $('examMeta').textContent = `${assessment.subject_code || ''} • ${questions.length} questions • autosave enabled`;
        updateViolationUi();
        renderQuestion();
        renderNavigator();
        tickTimer();
        timerInterval = setInterval(tickTimer, 1000);
        autosaveInterval = setInterval(() => autosave(false), 12000);
        leaseInterval = setInterval(writeLease, 10000);
        writeLease();
        channel?.postMessage({ type: 'active', sessionId: clientSessionId, tabId: tabInstanceId });
        history.pushState({ exam: true }, '', location.href);
        setTimeout(bindSecurity, 450);
        if (data.recovered) setSaveState('Previous answers restored', true);
        await autosave(false);
    } catch (error) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        $('startExam').disabled = false;
        $('startExam').innerHTML = '<i class="ph-bold ph-shield-check"></i> Start Secure Exam';
        const title = error.code === 'EXAM_ALREADY_ACTIVE' ? 'Exam already active' : 'Unable to start assessment';
        block(title, error.message, true);
    }
}

function currentQuestion() {
    return questions[currentIndex] || null;
}

function answerIsFilled(question) {
    return String(answers[question.id] || '').trim().length > 0;
}

function renderNavigator() {
    const grouped = [];
    for (const question of questions) {
        const id = question.section_id || question.category || 'default';
        let group = grouped.find(item => item.id === id);
        if (!group) {
            group = { id, title: question.section_title || 'Section 1', questions: [] };
            grouped.push(group);
        }
        group.questions.push(question);
    }
    let globalIndex = 0;
    $('questionNavigator').innerHTML = grouped.map(group => {
        const buttons = group.questions.map(question => {
            const index = globalIndex++;
            return `<button class="qnav-btn ${index === currentIndex ? 'active' : ''} ${answerIsFilled(question) ? 'answered' : ''} ${flagged.has(question.id) ? 'flagged' : ''}" data-question-index="${index}" title="Question ${index + 1}">${index + 1}</button>`;
        }).join('');
        return `<section class="section-nav"><div class="section-nav-title">${esc(group.title)}</div><div class="question-grid">${buttons}</div></section>`;
    }).join('');
    document.querySelectorAll('[data-question-index]').forEach(button => {
        button.onclick = () => goToQuestion(Number(button.dataset.questionIndex));
    });
    updateProgress();
}

function renderQuestion() {
    const question = currentQuestion();
    if (!question) return;
    const sectionItems = questions.filter(item => (item.section_id || item.category || 'default') === (question.section_id || question.category || 'default'));
    const sectionNo = sectionItems.findIndex(item => item.id === question.id) + 1;
    $('questionMeta').innerHTML = `
        <span class="badge">${esc(question.section_title || 'Section 1')}</span>
        <span class="badge green">Question ${sectionNo} of ${sectionItems.length}</span>
        <span class="badge amber">${Number(question.points || 1)} point${Number(question.points || 1) === 1 ? '' : 's'}</span>`;
    $('questionPrompt').textContent = question.prompt || '';

    if (question.type === 'essay' || question.type === 'short_answer') {
        $('answerArea').innerHTML = `<textarea class="answer-text" id="textAnswer" autocomplete="off" spellcheck="false" placeholder="Type your answer here…">${esc(answers[question.id] || '')}</textarea>`;
        $('textAnswer').addEventListener('input', event => {
            answers[question.id] = event.target.value;
            markDirty();
            updateProgress();
        });
    } else {
        $('answerArea').innerHTML = `<div class="choices">${(question.choices || []).map((choice, index) => `
            <label class="choice ${answers[question.id] === choice ? 'selected' : ''}">
                <input type="radio" name="examChoice" value="${esc(choice)}" ${answers[question.id] === choice ? 'checked' : ''}>
                <span class="choice-letter">${String.fromCharCode(65 + index)}</span>
                <span class="choice-text">${esc(choice)}</span>
            </label>`).join('')}</div>`;
        document.querySelectorAll('input[name="examChoice"]').forEach(input => {
            input.onchange = () => {
                answers[question.id] = input.value;
                document.querySelectorAll('.choice').forEach(item => item.classList.toggle('selected', item.contains(input) && input.checked));
                markDirty();
                renderNavigator();
            };
        });
    }

    $('flagQuestion').innerHTML = flagged.has(question.id)
        ? '<i class="ph-fill ph-flag"></i> Flagged for review'
        : '<i class="ph-bold ph-flag"></i> Flag for review';
    $('flagQuestion').classList.toggle('btn-secondary', flagged.has(question.id));
    $('prevQuestion').disabled = currentIndex === 0;
    $('nextQuestion').disabled = currentIndex === questions.length - 1;
    $('mobileProgress').textContent = `Question ${currentIndex + 1} of ${questions.length}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToQuestion(index) {
    currentIndex = Math.max(0, Math.min(questions.length - 1, index));
    renderQuestion();
    renderNavigator();
    markDirty(false);
}

function updateProgress() {
    const answered = questions.filter(answerIsFilled).length;
    const percent = questions.length ? Math.round(answered / questions.length * 100) : 0;
    $('progressFill').style.width = `${percent}%`;
    $('progressText').textContent = `${answered} answered • ${questions.length - answered} remaining`;
    $('navCount').textContent = `${answered}/${questions.length}`;
}

function setSaveState(text, saved = false) {
    $('saveState').textContent = text;
    $('saveState').classList.toggle('saved', saved);
}

function markDirty(schedule = true) {
    dirty = true;
    setSaveState('Unsaved changes…', false);
    if (!schedule) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => autosave(true), 900);
}

async function autosave(force = false) {
    if (!active || submitting || !attempt) return;
    if (!navigator.onLine) {
        setSaveState('Offline — waiting to save', false);
        return;
    }
    if (!dirty && force) return;
    clearTimeout(saveTimer);
    setSaveState('Saving…', false);
    try {
        const data = await queuedApi('student/autosave', {
            method: 'POST',
            body: JSON.stringify({
                attempt_id: attempt.id,
                client_session_id: clientSessionId,
                answers,
                question_index: currentIndex
            })
        });
        dirty = false;
        if (Number.isFinite(Number(data.violations))) violations = Number(data.violations);
        if (data.deadline_at) deadline = Date.parse(data.deadline_at);
        updateViolationUi();
        setSaveState(`Saved ${new Date(data.saved_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, true);
        writeLease();
    } catch (error) {
        setSaveState(error.code === 'SESSION_MISMATCH' ? 'Session conflict detected' : 'Save failed — retrying', false);
        if (error.code === 'SESSION_MISMATCH') lockExam(error.message);
    }
}

function tickTimer() {
    if (!active || submitting) return;
    const left = Math.max(0, deadline - Date.now());
    const hours = Math.floor(left / 3600000);
    const minutes = Math.floor((left % 3600000) / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    $('timer').textContent = hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (left <= 0) submitAssessment(true, 'Time limit reached.');
}

function updateViolationUi() {
    $('violationCount').textContent = `${violations}/${maxViolations}`;
}

function lockExam(reason) {
    if (!active || submitting) return;
    $('lockReason').textContent = reason || 'The protected exam view was interrupted.';
    $('securityLock').classList.add('show');
}

function unlockExam() {
    if (!navigator.onLine) return;
    $('securityLock').classList.remove('show');
}

async function restoreSecureView() {
    if (!navigator.onLine) return;
    if (fullscreenRequired && !document.fullscreenElement) {
        const entered = await requestFullscreen();
        if (!entered) return;
    }
    unlockExam();
}

async function reportIncident(type, details, options = {}) {
    if (!active || submitting || !attempt) return;
    const group = options.group || type;
    const now = Date.now();
    if (now - Number(incidentCooldown.get(group) || 0) < Number(options.cooldown || 2500)) {
        if (options.lock) lockExam(details);
        return;
    }
    incidentCooldown.set(group, now);
    if (options.lock) lockExam(details);
    violations += 1;
    updateViolationUi();
    if (!navigator.onLine) {
        pendingIncidents.push({ type, details });
        return;
    }
    try {
        const data = await queuedApi('student/incident', {
            method: 'POST',
            body: JSON.stringify({ attempt_id: attempt.id, client_session_id: clientSessionId, type, details })
        });
        violations = Number(data.violations || violations);
        maxViolations = Number(data.max_violations || maxViolations);
        updateViolationUi();
        if (data.auto_submit) {
            await submitAssessment(true, 'Anomaly limit reached.');
        }
    } catch (error) {
        if (error.code === 'SESSION_MISMATCH') lockExam(error.message);
        else pendingIncidents.push({ type, details });
    }
}

async function flushPendingIncidents() {
    if (!active || submitting || !attempt || !navigator.onLine || !pendingIncidents.length) return;
    const queued = pendingIncidents.splice(0);
    for (const incident of queued) {
        try {
            const data = await queuedApi('student/incident', {
                method: 'POST',
                body: JSON.stringify({ attempt_id: attempt.id, client_session_id: clientSessionId, type: incident.type, details: incident.details })
            });
            violations = Number(data.violations || violations);
            maxViolations = Number(data.max_violations || maxViolations);
            updateViolationUi();
            if (data.auto_submit) {
                await submitAssessment(true, 'Anomaly limit reached.');
                break;
            }
        } catch (error) {
            pendingIncidents.unshift(incident);
            if (error.code === 'SESSION_MISMATCH') lockExam(error.message);
            break;
        }
    }
}

function restrictedShortcut(event) {
    const key = String(event.key || '').toLowerCase();
    if (key === 'printscreen' || key === 'f12') return true;
    if ((event.ctrlKey || event.metaKey) && ['p', 's', 'u', 'r', 't', 'n', 'w', 'l'].includes(key)) return true;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && ['i', 'j', 'c'].includes(key)) return true;
    return false;
}

function bindSecurity() {
    if (securityBound) return;
    securityBound = true;
    const listen = (target, eventName, handler, options) => {
        target.addEventListener(eventName, handler, options);
        securityRemovers.push(() => target.removeEventListener(eventName, handler, options));
    };

    listen(document, 'visibilitychange', () => {
        if (document.hidden) reportIncident('tab_hidden', 'The assessment tab was hidden or another tab became active.', { lock: true, group: 'focus_loss', cooldown: 4000 });
    });
    listen(window, 'blur', () => reportIncident('window_blur', 'The browser window lost focus.', { lock: true, group: 'focus_loss', cooldown: 4000 }));
    listen(document, 'fullscreenchange', () => {
        if (fullscreenRequired && !document.fullscreenElement) reportIncident('fullscreen_exit', 'Fullscreen mode was exited.', { lock: true, cooldown: 3000 });
    });
    listen(document, 'copy', event => { event.preventDefault(); reportIncident('copy_attempt', 'Copying assessment content was blocked.'); });
    listen(document, 'cut', event => { event.preventDefault(); reportIncident('cut_attempt', 'Cutting assessment content was blocked.'); });
    listen(document, 'paste', event => { event.preventDefault(); reportIncident('paste_attempt', 'Pasting external content was blocked.'); });
    listen(document, 'contextmenu', event => { event.preventDefault(); reportIncident('context_menu', 'Right-click or the context menu was blocked.'); });
    listen(document, 'dragstart', event => event.preventDefault());
    listen(document, 'drop', event => { event.preventDefault(); reportIncident('drop_attempt', 'Dropping external content into the exam was blocked.'); });
    listen(document, 'keydown', event => {
        if (!restrictedShortcut(event)) return;
        event.preventDefault();
        if (String(event.key).toLowerCase() === 'printscreen') {
            $('screenshotShield').classList.add('show');
            setTimeout(() => $('screenshotShield').classList.remove('show'), 1200);
            reportIncident('screenshot_key', 'A Print Screen or screenshot key was detected.', { lock: true });
            return;
        }
        reportIncident('restricted_shortcut', `Restricted shortcut detected: ${event.key}.`, { lock: true, cooldown: 1800 });
    }, true);
    listen(window, 'offline', () => {
        updateSystemChecks();
        reportIncident('network_offline', 'The internet connection was lost.', { lock: true, cooldown: 10000 });
    });
    listen(window, 'online', () => {
        updateSystemChecks();
        flushPendingIncidents().finally(() => autosave(false));
    });
    listen(window, 'beforeprint', () => reportIncident('print_attempt', 'A print action was detected.', { lock: true }));
    listen(window, 'popstate', () => {
        history.pushState({ exam: true }, '', location.href);
        reportIncident('back_navigation', 'Browser back navigation was blocked.', { lock: true });
    });
    listen(window, 'beforeunload', event => {
        if (!active || submitting) return;
        event.preventDefault();
        event.returnValue = '';
    });
    listen(window, 'pagehide', () => {
        clearLease();
        if (!active || submitting || !attempt || !authHeadersCache) return;
        fetch('/api/assessments/student/incident', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeadersCache },
            body: JSON.stringify({ attempt_id: attempt.id, client_session_id: clientSessionId, type: 'page_exit', details: 'The secure exam page was closed or unloaded.' }),
            keepalive: true
        }).catch(() => {});
    });
}

function clearSecurity() {
    securityRemovers.splice(0).forEach(remove => remove());
    securityBound = false;
}

function openReview() {
    if (!active || submitting) return;
    const answered = questions.filter(answerIsFilled).length;
    $('reviewAnswered').textContent = String(answered);
    $('reviewUnanswered').textContent = String(questions.length - answered);
    $('reviewFlagged').textContent = String(flagged.size);
    $('submitModal').classList.add('show');
}

function closeReview() {
    $('submitModal').classList.remove('show');
}

async function submitAssessment(auto = false, reason = '') {
    if (!active || submitting || !attempt) return;
    if (!auto) closeReview();
    submitting = true;
    setSaveState('Submitting…', false);
    clearInterval(timerInterval);
    clearInterval(autosaveInterval);
    clearTimeout(saveTimer);
    try {
        const data = await queuedApi('student/submit', {
            method: 'POST',
            body: JSON.stringify({ attempt_id: attempt.id, client_session_id: clientSessionId, answers })
        });
        active = false;
        clearSecurity();
        clearLease();
        channel?.postMessage({ type: 'submitted', sessionId: clientSessionId, tabId: tabInstanceId });
        localStorage.setItem('plvAssessmentSubmittedAt', String(Date.now()));
        $('securityLock').classList.remove('show');
        $('submitModal').classList.remove('show');
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        showCompleted(data.score, data.total_points, false, reason);
    } catch (error) {
        submitting = false;
        timerInterval = setInterval(tickTimer, 1000);
        autosaveInterval = setInterval(() => autosave(false), 12000);
        setSaveState('Submission failed — try again', false);
        lockExam(error.message);
    }
}

function showCompleted(score, total, previous = false, reason = '') {
    active = false;
    showOnly('completedScreen');
    $('completeScore').textContent = `${Number(score || 0)} / ${Number(total || 0)}`;
    $('completeMessage').textContent = previous
        ? 'This assessment was already submitted. The recorded result is shown below.'
        : (reason ? `${reason} Your answers were submitted successfully.` : 'Your answers were submitted and recorded successfully.');
}

function leaveExamPage() {
    guard.stop();
    if (window.opener && !window.opener.closed) {
        window.opener.focus();
        window.close();
        setTimeout(() => location.replace('student-assessments.html'), 250);
    } else {
        location.replace('student-assessments.html');
    }
}

$('startExam').onclick = startExam;
$('cancelExam').onclick = leaveExamPage;
$('blockedBack').onclick = leaveExamPage;
$('blockedRetry').onclick = () => location.reload();
$('prevQuestion').onclick = () => goToQuestion(currentIndex - 1);
$('nextQuestion').onclick = () => goToQuestion(currentIndex + 1);
$('reviewExam').onclick = openReview;
$('submitExam').onclick = openReview;
$('continueExam').onclick = closeReview;
$('confirmSubmit').onclick = () => submitAssessment(false);
$('flagQuestion').onclick = () => {
    const question = currentQuestion();
    if (!question) return;
    if (flagged.has(question.id)) flagged.delete(question.id); else flagged.add(question.id);
    renderQuestion();
    renderNavigator();
};
$('restoreExam').onclick = restoreSecureView;
$('lockSubmit').onclick = () => submitAssessment(false, 'Submitted from the security pause screen.');
$('returnAssessments').onclick = leaveExamPage;
$('closeExamTab').onclick = leaveExamPage;
window.addEventListener('online', updateSystemChecks);
window.addEventListener('offline', updateSystemChecks);

setTheme();
setupTabChannel();
await authHeaders().catch(() => {});
await loadAssessment();
