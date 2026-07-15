import { supabase } from './supabase-adapter.js';
import { startStudentSessionGuard } from './student-session.js';
import { createAssessmentApiClient } from './exam-session-client.js';
import { ExamOfflineStore } from './exam-offline-store.js';
import { ExamSecurityManager } from './exam-security-manager.js';
import { normalizeSecurityConfig, SECURITY_MODE_LABELS } from './exam-security-config.js';
import { canonicalIncidentCode, incidentLabel } from './exam-incident-codes.js';
import { createSecureBrowserVerifier } from './exam-secure-browser-verifier.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const makeId = prefix => crypto.randomUUID ? `${prefix}_${crypto.randomUUID()}` : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'student') location.replace('index.html');

const guard = startStudentSessionGuard(supabase, user);
const apiClient = createAssessmentApiClient({ supabase, user });
const params = new URLSearchParams(location.search);
const assessmentId = String(params.get('assessment_id') || '').trim();
const offlineStore = new ExamOfflineStore(assessmentId);
const sessionStorageKey = `plvSecureExamSession:${assessmentId}`;
const leaseKey = `plvExamLease:${assessmentId}`;
const deviceIdKey = `plvExamPrivacyDeviceId:${assessmentId}`;
const clientSessionId = sessionStorage.getItem(`plvExamClientSession:${assessmentId}`) || makeId('client');
const tabInstanceId = makeId('tab');
const deviceId = localStorage.getItem(deviceIdKey) || makeId('device');
sessionStorage.setItem(`plvExamClientSession:${assessmentId}`, clientSessionId);
localStorage.setItem(deviceIdKey, deviceId);

let preflight = null;
let assessment = null;
let securityConfig = normalizeSecurityConfig({ mode: 'standard' });
let attempt = null;
let examSession = null;
let questions = [];
let answers = {};
let flagged = new Set();
let currentIndex = 0;
let deadline = 0;
let serverTimeOffset = 0;
let warningCount = 0;
let securityScore = 0;
let saveVersion = 0;
let active = false;
let submitting = false;
let dirty = false;
let syncInProgress = false;
let finalizingAtDeadline = false;
let saveTimer = null;
let autosaveInterval = null;
let timerInterval = null;
let heartbeatInterval = null;
let leaseInterval = null;
let offlineGraceTimer = null;
let requestQueue = Promise.resolve();
let mediaStreams = { camera: null, microphone: null, screen: null };
let mediaCheckGeneration = 0;
let preflightChecks = new Map();
let preflightPassed = false;
let duplicateTabBeforeStart = false;
let secureBrowserProof = '';
let secureBrowserVerifier = createSecureBrowserVerifier({});

const securityManager = new ExamSecurityManager({
    config: securityConfig,
    onIncident: (incident, policy) => reportIncident(incident, policy),
    onPause: (incident, policy) => showSecurityWarning(incident, policy),
    onConnectionState: state => handleConnectionState(state),
    onDuplicateTab: () => {
        if (!active) duplicateTabBeforeStart = true;
        else reportIncident({
            client_event_id: makeId('evt'), type: 'duplicate_exam_tab', event_group: 'duplicate_exam_tab',
            details: 'Another tab attempted to open the same assessment.', client_detected_at: new Date().toISOString()
        }, securityConfig.eventPolicies?.duplicate_exam_tab || {});
    }
});

function queuedApi(path, options = {}) {
    const run = () => apiClient.request(path, options);
    requestQueue = requestQueue.then(run, run);
    return requestQueue;
}

function showOnly(id) {
    ['loadingScreen', 'preflightScreen', 'blockedScreen', 'examShell', 'completedScreen'].forEach(name => $(name)?.classList.toggle('hidden', name !== id));
}

function setTheme() {
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-theme');
    const update = () => {
        const dark = document.body.classList.contains('dark-theme');
        if ($('themeIcon')) $('themeIcon').className = dark ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
    };
    update();
    if ($('themeToggle')) $('themeToggle').onclick = () => {
        document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
        update();
    };
}

function block(title, message, retry = true) {
    active = false;
    showOnly('blockedScreen');
    $('blockedTitle').textContent = title;
    $('blockedMessage').textContent = message;
    $('blockedRetry').classList.toggle('hidden', !retry);
}

function loadSavedSession() {
    try { return JSON.parse(sessionStorage.getItem(sessionStorageKey) || 'null'); } catch { return null; }
}
function persistSession() {
    if (!attempt || !examSession) return;
    sessionStorage.setItem(sessionStorageKey, JSON.stringify({
        attemptId: attempt.id,
        sessionId: examSession.id,
        sessionToken: examSession.token,
        clientSessionId,
        deviceId,
        savedAt: Date.now()
    }));
}
function clearSavedSession() { sessionStorage.removeItem(sessionStorageKey); }

function deviceSummary() {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    let browser = 'Browser';
    if (/Edg\//.test(ua)) browser = 'Microsoft Edge';
    else if (/Chrome\//.test(ua)) browser = 'Google Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Mozilla Firefox';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    let os = 'Unknown OS';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS/iPadOS';
    else if (/Mac OS/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    return { device_id: deviceId, device_type: mobile ? 'mobile' : 'desktop', browser_name: browser, operating_system: os, user_agent_summary: `${browser} on ${os}` };
}

function setCheck(key, label, status, message = '') {
    preflightChecks.set(key, { key, label, status, message });
    renderPreflightChecks();
}

function statusIcon(status) {
    return {
        checking: 'ph-spinner-gap', passed: 'ph-check-circle', warning: 'ph-warning-circle',
        failed: 'ph-x-circle', not_required: 'ph-minus-circle'
    }[status] || 'ph-info';
}

function renderPreflightChecks() {
    const container = $('preflightChecks');
    if (!container) return;
    const order = ['identity', 'assignment', 'availability', 'attempt', 'server_time', 'internet', 'fullscreen', 'camera', 'microphone', 'screen_share', 'active_session', 'secure_browser'];
    const items = order.map(key => preflightChecks.get(key)).filter(Boolean);
    container.innerHTML = items.map(item => `
        <div class="preflight-check ${esc(item.status)}">
            <i class="ph-fill ${statusIcon(item.status)}"></i>
            <span><b>${esc(item.label)}</b><small>${esc(item.message || item.status.replace('_', ' '))}</small></span>
            <em>${esc(item.status.replace('_', ' '))}</em>
        </div>`).join('');
    const requiredFailure = items.some(item => item.status === 'failed');
    const stillChecking = items.some(item => item.status === 'checking');
    const requiredMediaKeys = [
        securityConfig.media?.cameraRequired ? 'camera' : '',
        securityConfig.media?.microphoneRequired ? 'microphone' : '',
        securityConfig.media?.screenShareRequired ? 'screen_share' : ''
    ].filter(Boolean);
    const requiredMediaIncomplete = requiredMediaKeys.some(key => preflightChecks.get(key)?.status !== 'passed');
    const secureBrowserFailure = securityConfig.requireSecureBrowser && preflight?.secure_browser?.passed !== true;
    const serverEligibilityFailure = preflight?.eligible === false;
    preflightPassed = !requiredFailure && !stillChecking && !requiredMediaIncomplete && !secureBrowserFailure && !serverEligibilityFailure && navigator.onLine && !duplicateTabBeforeStart;
    const checkButton = $('runDeviceChecks');
    if (checkButton) {
        checkButton.classList.toggle('hidden', requiredMediaKeys.length === 0);
        checkButton.disabled = requiredMediaKeys.length === 0 || requiredMediaKeys.every(key => preflightChecks.get(key)?.status === 'passed');
    }
    updateStartButton();
}

function updateStartButton() {
    if (!$('startExam')) return;
    const accepted = $('confirmReady')?.checked === true;
    $('startExam').disabled = !preflightPassed || !accepted;
    if (duplicateTabBeforeStart) $('preflightIssue').textContent = 'Close the other exam tab before continuing.';
    else if (!navigator.onLine) $('preflightIssue').textContent = 'Reconnect to the internet before starting.';
    else if (!preflightPassed) {
        const mediaRequired = securityConfig.media?.cameraRequired || securityConfig.media?.microphoneRequired || securityConfig.media?.screenShareRequired;
        $('preflightIssue').textContent = mediaRequired ? 'Run the required device checks, then review and accept the rules.' : 'Complete all required checks before starting.';
    }
    else if (!accepted) $('preflightIssue').textContent = 'Read and accept the assessment rules.';
    else $('preflightIssue').textContent = 'All required checks passed. You may start the assessment.';
}

function applyServerTime(serverTime) {
    const parsed = Date.parse(serverTime || '');
    if (Number.isFinite(parsed)) serverTimeOffset = parsed - Date.now();
}
function serverNow() { return Date.now() + serverTimeOffset; }

async function runPreflight() {
    if (!assessmentId) return block('Missing assessment', 'The secure exam link does not contain an assessment ID.', false);
    showOnly('loadingScreen');
    try {
        const savedSession = loadSavedSession();
        const preflightPayload = {
            assessment_id: assessmentId,
            device: deviceSummary(),
            client_session_id: clientSessionId,
            session_id: savedSession?.attemptId ? savedSession.sessionId : '',
            session_token: savedSession?.attemptId ? savedSession.sessionToken : ''
        };
        preflight = await apiClient.request('student/preflight', {
            method: 'POST',
            body: JSON.stringify(preflightPayload)
        });
        assessment = preflight.assessment;
        securityConfig = normalizeSecurityConfig(assessment?.settings?.security || assessment?.settings || {});
        secureBrowserVerifier = createSecureBrowserVerifier({ ...securityConfig, assessmentId });
        if (securityConfig.requireSecureBrowser && preflight?.secure_browser?.passed !== true) {
            const proofResult = await secureBrowserVerifier.collectProof();
            secureBrowserProof = proofResult.proof || '';
            if (secureBrowserProof) {
                preflight = await apiClient.request('student/preflight', {
                    method: 'POST',
                    body: JSON.stringify({ ...preflightPayload, secure_browser_proof: secureBrowserProof })
                });
                assessment = preflight.assessment;
                securityConfig = normalizeSecurityConfig(assessment?.settings?.security || assessment?.settings || {});
            }
        }
        securityManager.setConfig(securityConfig);
        applyServerTime(preflight.server_time);
        renderPreflight();
        setupPreflightDuplicateCheck();
    } catch (error) {
        const title = error.code === 'MAX_ATTEMPTS_REACHED' ? 'Maximum attempts reached' : 'Unable to prepare assessment';
        block(title, error.message, error.status >= 500);
    }
}

function renderPreflight() {
    $('preflightTitle').textContent = assessment?.title || 'Assessment';
    $('preflightInstructions').textContent = assessment?.instructions || 'Read each question carefully and submit your work before the timer ends.';
    $('preflightMeta').innerHTML = `
        <span class="badge">${esc(assessment?.subject_code || 'Subject')}</span>
        <span class="badge">${esc(assessment?.section || 'Section')}</span>
        <span class="badge amber">${Number(assessment?.duration_minutes || 30)} minutes</span>
        <span class="badge green">Attempt ${Number(preflight?.attempt_no || 1)}</span>
        <span class="badge red">${esc(SECURITY_MODE_LABELS[securityConfig.mode] || 'Standard')} mode</span>`;
    $('securityModeSummary').textContent = `${SECURITY_MODE_LABELS[securityConfig.mode] || 'Standard'} mode`;
    $('securityRulesText').textContent = studentRulesSummary();
    const setup = assessment?.settings?.secureBrowserInstructions || '';
    const launch = assessment?.settings?.secureBrowserLaunchUrl || '';
    if ($('secureBrowserSetup')) {
        $('secureBrowserSetup').classList.toggle('hidden', !securityConfig.requireSecureBrowser);
        $('secureBrowserSetupText').textContent = setup || 'Use the secure-browser setup instructions supplied by your instructor.';
        $('secureBrowserLaunch').classList.toggle('hidden', !launch);
        if (launch) $('secureBrowserLaunch').href = launch;
    }
    preflightChecks.clear();
    for (const item of preflight?.statuses || []) setCheck(item.key, item.label, item.status, item.message);
    setCheck('internet', 'Internet connection', navigator.onLine ? 'passed' : 'failed', navigator.onLine ? 'Online' : 'Offline');
    const fullscreenSupported = !!document.documentElement.requestFullscreen;
    setCheck('fullscreen', 'Fullscreen availability', !securityConfig.requireFullscreen ? 'not_required' : fullscreenSupported ? 'passed' : 'failed', !securityConfig.requireFullscreen ? 'Not required' : fullscreenSupported ? 'Supported' : 'Not supported by this browser');
    const media = securityConfig.media || {};
    setCheck('camera', 'Camera availability', media.cameraRequired ? (navigator.mediaDevices?.getUserMedia ? 'warning' : 'failed') : 'not_required', media.cameraRequired ? 'Select Run Device Checks to request permission' : 'Not required');
    setCheck('microphone', 'Microphone availability', media.microphoneRequired ? (navigator.mediaDevices?.getUserMedia ? 'warning' : 'failed') : 'not_required', media.microphoneRequired ? 'Select Run Device Checks to request permission' : 'Not required');
    setCheck('screen_share', 'Screen-sharing availability', media.screenShareRequired ? (navigator.mediaDevices?.getDisplayMedia ? 'warning' : 'failed') : 'not_required', media.screenShareRequired ? 'Select Run Device Checks to choose a screen' : 'Not required');
    if (!preflightChecks.has('active_session')) {
        setCheck('active_session', 'Active exam session', preflight?.resume_available ? 'warning' : 'passed', preflight?.resume_available ? 'An interrupted attempt can be resumed' : 'No conflicting active session');
    }
    $('confirmReady').checked = false;
    showOnly('preflightScreen');
    updateStartButton();
}

function studentRulesSummary() {
    const monitored = [];
    const m = securityConfig.monitoring || {};
    if (m.tabSwitch || m.windowFocus) monitored.push('leaving the assessment, app switching, or supported mobile system overlays');
    if (m.fullscreenExit && securityConfig.requireFullscreen) monitored.push('exiting fullscreen');
    if (m.clipboard) monitored.push('copying or pasting');
    if (m.print) monitored.push('printing');
    if (m.restrictedShortcut) monitored.push('restricted shortcuts');
    if (m.duplicateSession) monitored.push('duplicate exam sessions');
    if (!monitored.length) return 'This assessment uses server-controlled timing, randomized questions, autosaving, and server-side scoring.';
    return `This assessment records ${monitored.join(', ')}. One browser event is treated as a review signal, not automatic proof of cheating. Some phone screenshot and floating-panel actions can only be blocked by a secure exam browser or managed device.`;
}

function setupPreflightDuplicateCheck() {
    if (!('BroadcastChannel' in window)) return;
    const probe = new BroadcastChannel(`plv-secure-exam:${assessmentId}`);
    const closeProbe = () => { try { probe.close(); } catch {} };
    probe.onmessage = event => {
        if (event.data?.tabId === tabInstanceId) return;
        if (event.data?.type === 'active' || event.data?.type === 'starting') {
            duplicateTabBeforeStart = true;
            setCheck('active_session', 'Active exam session', 'failed', 'The same assessment is open in another tab');
        }
    };
    probe.postMessage({ type: 'probe', tabId: tabInstanceId });
    setTimeout(closeProbe, 1800);
}

async function requestPreflightMedia() {
    const media = securityConfig.media || {};
    const generation = ++mediaCheckGeneration;
    stopMediaStreams();
    if (media.cameraRequired || media.microphoneRequired) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot provide the required camera or microphone check.');
        const stream = await navigator.mediaDevices.getUserMedia({ video: !!media.cameraRequired, audio: !!media.microphoneRequired });
        if (media.cameraRequired) {
            mediaStreams.camera = stream;
            setCheck('camera', 'Camera availability', 'passed', 'Permission granted; no video is recorded or uploaded');
            stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
                if (!active && generation === mediaCheckGeneration) setCheck('camera', 'Camera availability', 'failed', 'The camera stream stopped before the assessment started');
            }, { once: true }));
        }
        if (media.microphoneRequired) {
            mediaStreams.microphone = stream;
            setCheck('microphone', 'Microphone availability', 'passed', 'Permission granted; no audio is recorded or uploaded');
            stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
                if (!active && generation === mediaCheckGeneration) setCheck('microphone', 'Microphone availability', 'failed', 'The microphone stream stopped before the assessment started');
            }, { once: true }));
        }
    }
    if (media.screenShareRequired) {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser does not support the required screen-sharing check.');
        mediaStreams.screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        setCheck('screen_share', 'Screen-sharing availability', 'passed', 'Screen sharing active; content is not recorded by this portal');
        mediaStreams.screen.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
            if (!active && generation === mediaCheckGeneration) setCheck('screen_share', 'Screen-sharing availability', 'failed', 'Screen sharing stopped before the assessment started');
        }, { once: true }));
    }
}

async function runRequiredDeviceChecks() {
    const button = $('runDeviceChecks');
    if (!button) return;
    button.disabled = true;
    button.innerHTML = '<i class="ph-bold ph-spinner-gap spin"></i> Checking…';
    securityManager.suppress(5000);
    try {
        await requestPreflightMedia();
        button.innerHTML = '<i class="ph-bold ph-check-circle"></i> Device Checks Passed';
    } catch (error) {
        stopMediaStreams();
        const message = error?.name === 'NotAllowedError'
            ? 'Permission was denied. Allow the required device access and run the checks again.'
            : String(error?.message || 'The required device check failed.');
        if (securityConfig.media?.cameraRequired) setCheck('camera', 'Camera availability', 'failed', message);
        if (securityConfig.media?.microphoneRequired) setCheck('microphone', 'Microphone availability', 'failed', message);
        if (securityConfig.media?.screenShareRequired) setCheck('screen_share', 'Screen-sharing availability', 'failed', message);
        button.disabled = false;
        button.innerHTML = '<i class="ph-bold ph-webcam"></i> Retry Device Checks';
    }
    renderPreflightChecks();
}

async function requestFullscreen() {
    if (!securityConfig.requireFullscreen) return true;
    if (!document.documentElement.requestFullscreen) return false;
    securityManager.suppress(2500);
    try {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        return true;
    } catch { return false; }
}

async function startExam() {
    if (!$('confirmReady').checked || !preflightPassed) return updateStartButton();
    if (duplicateTabBeforeStart) return block('Exam already open', 'Close the other exam tab before starting.', true);
    $('startExam').disabled = true;
    $('startExam').innerHTML = '<i class="ph-bold ph-spinner-gap spin"></i> Starting…';
    try {
        const fullscreenEntered = await requestFullscreen();
        if (securityConfig.requireFullscreen && !fullscreenEntered) throw new Error('Fullscreen permission is required for this assessment.');
        const saved = loadSavedSession();
        const data = await apiClient.request('student/start', {
            method: 'POST',
            body: JSON.stringify({
                assessment_id: assessmentId,
                accept_rules: true,
                client_session_id: clientSessionId,
                tab_instance_id: tabInstanceId,
                device_id: deviceId,
                device: deviceSummary(),
                secure_browser_proof: secureBrowserProof,
                session_id: saved?.attemptId ? saved.sessionId : '',
                session_token: saved?.attemptId ? saved.sessionToken : ''
            })
        });
        initializeAttempt(data);
    } catch (error) {
        stopMediaStreams();
        if (securityConfig.media?.cameraRequired) setCheck('camera', 'Camera availability', 'warning', 'Run the device checks again before retrying');
        if (securityConfig.media?.microphoneRequired) setCheck('microphone', 'Microphone availability', 'warning', 'Run the device checks again before retrying');
        if (securityConfig.media?.screenShareRequired) setCheck('screen_share', 'Screen-sharing availability', 'warning', 'Run the device checks again before retrying');
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        $('startExam').disabled = false;
        $('startExam').innerHTML = '<i class="ph-bold ph-shield-check"></i> Start Assessment';
        if (error.code === 'EXAM_ALREADY_ACTIVE' || error.code === 'DUPLICATE_DEVICE_SESSION') {
            block('Assessment already active', error.message, true);
        } else {
            $('preflightIssue').textContent = error.message;
            if (/camera/i.test(error.message)) setCheck('camera', 'Camera availability', 'failed', error.message);
            if (/microphone/i.test(error.message)) setCheck('microphone', 'Microphone availability', 'failed', error.message);
            if (/screen/i.test(error.message)) setCheck('screen_share', 'Screen-sharing availability', 'failed', error.message);
            updateStartButton();
        }
    }
}

function initializeAttempt(data) {
    assessment = data.assessment;
    securityConfig = normalizeSecurityConfig(assessment?.settings?.security || assessment?.settings || {});
    securityManager.setConfig(securityConfig);
    attempt = data.attempt;
    examSession = data.session;
    questions = Array.isArray(data.questions) ? data.questions : [];
    answers = data.answers && typeof data.answers === 'object' ? data.answers : {};
    flagged = new Set(Array.isArray(attempt.flagged_questions) ? attempt.flagged_questions : []);
    currentIndex = Math.max(0, Math.min(questions.length - 1, Number(attempt.last_question_index || 0)));
    deadline = Date.parse(attempt.deadline_at);
    warningCount = Number(attempt.warning_count || attempt.violations || 0);
    securityScore = Number(attempt.security_score || 0);
    saveVersion = Number(attempt.save_version || 0);
    applyServerTime(data.server_time);
    if (!questions.length) throw new Error('This assessment has no available questions.');
    active = true;
    submitting = false;
    dirty = false;
    persistSession();
    showOnly('examShell');
    $('examTitle').textContent = assessment.title || 'Assessment';
    $('examMeta').textContent = `${assessment.subject_code || ''} • Attempt ${attempt.attempt_no || 1} • ${questions.length} questions`;
    document.body.classList.toggle('hide-exam-navigator', securityConfig.showNavigator === false);
    updateWarningUi();
    renderQuestion();
    renderNavigator();
    tickTimer();
    clearIntervals();
    timerInterval = setInterval(tickTimer, 1000);
    autosaveInterval = setInterval(() => autosave(false), 12000);
    heartbeatInterval = setInterval(sendHeartbeat, Math.max(15000, Math.min(30000, Number(examSession.heartbeat_seconds || 20) * 1000)));
    leaseInterval = setInterval(writeLease, 10000);
    writeLease();
    history.pushState({ exam: true }, '', location.href);
    securityManager.suppress(2200);
    securityManager.bind({ assessmentId, tabId: tabInstanceId });
    const channel = securityManager.attachDuplicateChannel(assessmentId, tabInstanceId);
    channel?.postMessage({ type: 'active', tabId: tabInstanceId });
    attachMediaMonitoring();
    if (navigationWasReload() && data.recovered) setTimeout(() => emitSimpleIncident('refresh_attempt', 'The assessment page was refreshed and the active attempt was restored.'), 2600);
    if (data.recovered) setSaveState('Previous answers restored', 'saved');
    syncOffline().finally(() => autosave(false));
}

function navigationWasReload() {
    return performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
}

function attachMediaMonitoring() {
    if (mediaStreams.camera) securityManager.trackMediaStream(mediaStreams.camera, 'camera', !!securityConfig.media?.cameraRequired);
    if (mediaStreams.microphone) securityManager.trackMediaStream(mediaStreams.microphone, 'microphone', !!securityConfig.media?.microphoneRequired);
    if (mediaStreams.screen) securityManager.trackMediaStream(mediaStreams.screen, 'screen_share', !!securityConfig.media?.screenShareRequired);
}

function stopMediaStreams() {
    const unique = new Set(Object.values(mediaStreams).filter(Boolean));
    unique.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    mediaStreams = { camera: null, microphone: null, screen: null };
}

function currentQuestion() { return questions[currentIndex] || null; }
function answerIsFilled(question) { return String(answers[question.id] || '').trim().length > 0; }

function renderNavigator() {
    const navigator = $('questionNavigator');
    if (!navigator) return;
    if (securityConfig.showNavigator === false) {
        navigator.innerHTML = '<p class="progress-text">Question navigator is disabled for this assessment.</p>';
        updateProgress();
        return;
    }
    const grouped = [];
    for (const question of questions) {
        const sectionId = question.section_id || question.category || 'default';
        let group = grouped.find(item => item.id === sectionId);
        if (!group) { group = { id: sectionId, title: question.section_title || 'Section 1', questions: [] }; grouped.push(group); }
        group.questions.push(question);
    }
    let globalIndex = 0;
    navigator.innerHTML = grouped.map(group => {
        const buttons = group.questions.map(question => {
            const index = globalIndex++;
            const locked = securityConfig.allowBacktracking === false && index < currentIndex;
            return `<button class="qnav-btn ${index === currentIndex ? 'active' : ''} ${answerIsFilled(question) ? 'answered' : ''} ${flagged.has(question.id) ? 'flagged' : ''}" data-question-index="${index}" ${locked ? 'disabled' : ''} title="Question ${index + 1}">${index + 1}</button>`;
        }).join('');
        return `<section class="section-nav"><div class="section-nav-title">${esc(group.title)}</div><div class="question-grid">${buttons}</div></section>`;
    }).join('');
    navigator.querySelectorAll('[data-question-index]').forEach(button => { button.onclick = () => goToQuestion(Number(button.dataset.questionIndex)); });
    updateProgress();
}

function answerControlHtml(question, index) {
    if (question.type === 'essay' || question.type === 'short_answer') {
        const rows = question.type === 'essay' ? 8 : 3;
        return `<textarea class="text-answer" data-all-text="${esc(question.id)}" rows="${rows}" placeholder="${question.type === 'essay' ? 'Write your answer here…' : 'Type your answer here…'}">${esc(answers[question.id] || '')}</textarea>`;
    }
    return `<div class="choices">${(question.choices || []).map((choice, choiceIndex) => `<label class="choice ${answers[question.id] === choice ? 'selected' : ''}"><input type="radio" name="allChoice_${esc(question.id)}" data-all-choice="${esc(question.id)}" value="${esc(choice)}" ${answers[question.id] === choice ? 'checked' : ''}><span class="choice-letter">${String.fromCharCode(65 + choiceIndex)}</span><span class="choice-text">${esc(choice)}</span></label>`).join('')}</div>`;
}

function renderAllQuestions() {
    $('questionMeta').innerHTML = `<span class="badge green">All questions</span><span class="badge amber">${questions.length} total</span>`;
    $('questionPrompt').textContent = 'Answer the questions below. Your work is saved automatically.';
    $('answerArea').innerHTML = `<div class="all-question-list">${questions.map((question, index) => `<section class="all-question-card" id="allQuestion_${esc(question.id)}" data-all-index="${index}"><div class="all-question-head"><div><span class="badge">${esc(question.section_title || 'Section 1')}</span><b>Question ${index + 1}</b><small>${Number(question.points || 1)} point${Number(question.points || 1) === 1 ? '' : 's'}</small></div><button class="btn btn-ghost btn-sm" type="button" data-all-flag="${esc(question.id)}"><i class="ph-${flagged.has(question.id) ? 'fill' : 'bold'} ph-flag"></i>${flagged.has(question.id) ? 'Flagged' : 'Flag'}</button></div><h3>${esc(question.prompt || '')}</h3>${answerControlHtml(question, index)}</section>`).join('')}</div>`;
    document.querySelectorAll('[data-all-text]').forEach(input => input.addEventListener('input', event => {
        answers[event.target.dataset.allText] = event.target.value; markDirty(); updateProgress();
    }));
    document.querySelectorAll('[data-all-choice]').forEach(input => input.addEventListener('change', event => {
        const questionId = event.target.dataset.allChoice;
        answers[questionId] = event.target.value;
        event.target.closest('.choices')?.querySelectorAll('.choice').forEach(item => item.classList.toggle('selected', item.contains(event.target) && event.target.checked));
        markDirty(); updateProgress(); renderNavigator();
    }));
    document.querySelectorAll('[data-all-flag]').forEach(button => button.onclick = () => {
        const id = button.dataset.allFlag;
        if (flagged.has(id)) flagged.delete(id); else flagged.add(id);
        button.innerHTML = `<i class="ph-${flagged.has(id) ? 'fill' : 'bold'} ph-flag"></i>${flagged.has(id) ? 'Flagged' : 'Flag'}`;
        renderNavigator(); markDirty();
    });
    $('flagQuestion').classList.add('hidden');
    $('prevQuestion').classList.add('hidden');
    $('nextQuestion').classList.add('hidden');
    $('mobileProgress').textContent = `${questions.length} questions`;
    updateProgress();
}

function renderQuestion() {
    if (securityConfig.oneQuestionPerPage === false) { renderAllQuestions(); return; }
    $('flagQuestion').classList.remove('hidden');
    $('prevQuestion').classList.remove('hidden');
    $('nextQuestion').classList.remove('hidden');
    const question = currentQuestion();
    if (!question) return;
    const sameSection = questions.filter(item => (item.section_id || item.category || 'default') === (question.section_id || question.category || 'default'));
    const sectionNo = sameSection.findIndex(item => item.id === question.id) + 1;
    $('questionMeta').innerHTML = `<span class="badge">${esc(question.section_title || 'Section 1')}</span><span class="badge green">Question ${sectionNo} of ${sameSection.length}</span><span class="badge amber">${Number(question.points || 1)} point${Number(question.points || 1) === 1 ? '' : 's'}</span>`;
    $('questionPrompt').textContent = question.prompt || '';
    if (question.type === 'essay' || question.type === 'short_answer') {
        $('answerArea').innerHTML = `<textarea class="answer-text" id="textAnswer" autocomplete="off" spellcheck="false" placeholder="Type your answer here…">${esc(answers[question.id] || '')}</textarea>`;
        $('textAnswer').addEventListener('input', event => { answers[question.id] = event.target.value; markDirty(); updateProgress(); });
    } else {
        $('answerArea').innerHTML = `<div class="choices">${(question.choices || []).map((choice, index) => `<label class="choice ${answers[question.id] === choice ? 'selected' : ''}"><input type="radio" name="examChoice" value="${esc(choice)}" ${answers[question.id] === choice ? 'checked' : ''}><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span class="choice-text">${esc(choice)}</span></label>`).join('')}</div>`;
        document.querySelectorAll('input[name="examChoice"]').forEach(input => {
            input.onchange = () => {
                answers[question.id] = input.value;
                document.querySelectorAll('.choice').forEach(item => item.classList.toggle('selected', item.contains(input) && input.checked));
                markDirty(); renderNavigator();
            };
        });
    }
    $('flagQuestion').innerHTML = flagged.has(question.id) ? '<i class="ph-fill ph-flag"></i> Flagged for review' : '<i class="ph-bold ph-flag"></i> Flag for review';
    $('flagQuestion').classList.toggle('btn-secondary', flagged.has(question.id));
    $('prevQuestion').disabled = currentIndex === 0 || securityConfig.allowBacktracking === false;
    $('nextQuestion').disabled = currentIndex === questions.length - 1;
    $('mobileProgress').textContent = `Question ${currentIndex + 1} of ${questions.length}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToQuestion(index) {
    const target = Math.max(0, Math.min(questions.length - 1, index));
    if (securityConfig.allowBacktracking === false && target < currentIndex) return;
    if (securityConfig.oneQuestionPerPage === false) {
        currentIndex = target;
        renderNavigator();
        document.getElementById(`allQuestion_${questions[target]?.id}`)?.scrollIntoView({ behavior:'smooth', block:'start' });
        persistOfflineState();
        return;
    }
    if (target === currentIndex) return;
    if (dirty) autosave(true).catch(() => {});
    currentIndex = target;
    renderQuestion(); renderNavigator();
    persistOfflineState();
}

function updateProgress() {
    const answered = questions.filter(answerIsFilled).length;
    const percent = questions.length ? Math.round(answered / questions.length * 100) : 0;
    $('progressFill').style.width = `${percent}%`;
    $('progressText').textContent = `${answered} answered • ${questions.length - answered} remaining`;
    $('navCount').textContent = `${answered}/${questions.length}`;
}

function setSaveState(text, state = '') {
    $('saveState').textContent = text;
    $('saveState').dataset.state = state;
    $('saveState').classList.toggle('saved', state === 'saved');
}

function markDirty(schedule = true) {
    dirty = true;
    setSaveState(navigator.onLine ? 'Unsaved changes' : 'Offline — pending synchronization', navigator.onLine ? 'pending' : 'offline');
    persistOfflineState();
    if (!schedule) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => autosave(true), 900);
}

async function persistOfflineState() {
    await offlineStore.saveState({
        attemptId: attempt?.id || '', sessionId: examSession?.id || '', answers,
        currentIndex, flagged: [...flagged], saveVersion, updatedAt: Date.now()
    }).catch(() => {});
}

function sessionPayload(extra = {}) {
    return {
        attempt_id: attempt?.id || '', session_id: examSession?.id || '', session_token: examSession?.token || '',
        client_session_id: clientSessionId, ...extra
    };
}

async function autosave(force = false) {
    if (!active || submitting || !attempt || syncInProgress) return;
    if (!navigator.onLine) {
        setSaveState('Offline — pending synchronization', 'offline');
        await persistOfflineState();
        return;
    }
    if (!dirty && !force) return;
    clearTimeout(saveTimer);
    setSaveState('Saving…', 'saving');
    const nextVersion = saveVersion + 1;
    try {
        const data = await queuedApi('student/autosave', {
            method: 'POST',
            body: JSON.stringify(sessionPayload({ answers, question_index: currentIndex, flagged_questions: [...flagged], save_version: nextVersion }))
        });
        if (data.submitted) return handleServerFinalized(data);
        saveVersion = Number(data.save_version ?? nextVersion);
        dirty = false;
        warningCount = Number(data.warning_count ?? warningCount);
        if (data.deadline_at) deadline = Date.parse(data.deadline_at);
        applyServerTime(data.server_time);
        updateWarningUi();
        setSaveState(`Saved ${new Date(data.saved_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'saved');
        writeLease();
        await persistOfflineState();
    } catch (error) {
        if (error.code === 'SESSION_MISMATCH' || error.code === 'SESSION_REPLACED') {
            setSaveState('Session conflict', 'conflict');
            showSecurityWarning({ type: 'session_replaced', details: error.message }, securityConfig.eventPolicies?.session_replaced || { severity: 'high', pausesExam: true });
        } else {
            setSaveState('Save failed — pending synchronization', 'failed');
            await persistOfflineState();
        }
    }
}

async function sendHeartbeat() {
    if (!active || submitting || !attempt || !navigator.onLine) return;
    try {
        const data = await apiClient.request('student/heartbeat', {
            method: 'POST',
            body: JSON.stringify(sessionPayload({
                client_event_timestamp: new Date().toISOString(), question_index: currentIndex,
                save_version: saveVersion, visibility_status: document.visibilityState,
                fullscreen_status: !!document.fullscreenElement, connection_state: navigator.onLine ? 'online' : 'offline'
            }))
        });
        applyServerTime(data.server_time);
        if (data.deadline_at) deadline = Date.parse(data.deadline_at);
        warningCount = Number(data.warning_count ?? warningCount);
        securityScore = Number(data.security_score ?? securityScore);
        updateWarningUi();
        if (data.required_action === 'finalize' || data.attempt_status === 'submitted') handleServerFinalized(data);
        if (data.required_action === 'pause') showSecurityWarning({ type: 'anomaly_limit_reached', details: 'The server requires this assessment to remain paused for review.' }, { severity: 'high', pausesExam: true });
    } catch (error) {
        if (error.code === 'SESSION_MISMATCH' || error.code === 'SESSION_REPLACED') {
            showSecurityWarning({ type: 'session_replaced', details: error.message }, { severity: 'high', pausesExam: true });
        }
    }
}

async function syncOffline() {
    if (!active || submitting || !navigator.onLine || syncInProgress) return;
    syncInProgress = true;
    setSaveState('Synchronizing…', 'syncing');
    try {
        const saved = await offlineStore.loadState();
        if (saved?.attemptId === attempt.id) {
            answers = { ...answers, ...(saved.answers || {}) };
            flagged = new Set(Array.isArray(saved.flagged) ? saved.flagged : [...flagged]);
            currentIndex = Math.max(0, Math.min(questions.length - 1, Number(saved.currentIndex ?? currentIndex)));
            saveVersion = Math.max(saveVersion, Number(saved.saveVersion || 0));
            dirty = true;
        }
        const queue = (await offlineStore.listQueue()).filter(item => item.type === 'incident');
        for (let index = 0; index < queue.length; index += 8) {
            const batch = queue.slice(index, index + 8);
            try {
                const data = await apiClient.request('student/incidents-batch', {
                    method: 'POST',
                    body: JSON.stringify(sessionPayload({ events: batch.map(item => item.payload) }))
                });
                for (const result of data.results || []) {
                    const item = batch.find(entry => entry.payload?.client_event_id === result.client_event_id);
                    if (item && Number(result.status || 200) < 400) await offlineStore.removeQueueItem(item.id);
                }
                const lastResult = (data.results || []).at(-1);
                if (lastResult) processIncidentResponse(lastResult, batch.at(-1)?.payload || {});
                if (data.submitted || data.auto_submit) break;
            } catch (error) {
                for (const result of error.data?.results || []) {
                    const item = batch.find(entry => entry.payload?.client_event_id === result.client_event_id);
                    if (item && Number(result.status || 500) < 400) await offlineStore.removeQueueItem(item.id);
                }
                if (error.status === 429) break;
                if (error.code === 'SESSION_MISMATCH' || error.code === 'SESSION_REPLACED') throw error;
                break;
            }
        }
        syncInProgress = false;
        if (active && dirty) await autosave(true);
        if (active && !dirty) setSaveState('Saved', 'saved');
    } catch (error) {
        setSaveState(error.code === 'SESSION_MISMATCH' ? 'Session conflict' : 'Pending synchronization', error.code === 'SESSION_MISMATCH' ? 'conflict' : 'pending');
    } finally {
        syncInProgress = false;
    }
}

function tickTimer() {
    if (!active || submitting) return;
    const left = Math.max(0, deadline - serverNow());
    const hours = Math.floor(left / 3600000), minutes = Math.floor((left % 3600000) / 60000), seconds = Math.floor((left % 60000) / 1000);
    $('timer').textContent = hours > 0 ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (left <= 0 && !finalizingAtDeadline) finalizeExpiredAttempt();
}

async function finalizeExpiredAttempt() {
    if (finalizingAtDeadline || !attempt) return;
    finalizingAtDeadline = true;
    setSaveState('Time expired — finalizing saved answers', 'saving');
    try {
        const data = await apiClient.request('student/finalize-expired', { method: 'POST', body: JSON.stringify(sessionPayload()) });
        if (!data.finalized) await submitAssessment(true, 'Time limit reached.', 'time_expired');
        else handleServerFinalized(data, 'Time limit reached.');
    } catch {
        await submitAssessment(true, 'Time limit reached.', 'time_expired');
    }
}

function updateWarningUi() {
    $('violationCount').textContent = `${formatWarning(warningCount)}/${formatWarning(securityConfig.warningLimit || 5)}`;
}
function formatWarning(value) { return Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0); }

async function reportIncident(incident, policy = {}) {
    if (!active || submitting || !attempt) return;
    const payload = {
        type: canonicalIncidentCode(incident.type), client_event_id: incident.client_event_id || makeId('evt'),
        event_group: incident.event_group || canonicalIncidentCode(incident.type), details: incident.details || '',
        first_detected_at: incident.first_detected_at || incident.client_detected_at || new Date().toISOString(),
        last_detected_at: incident.last_detected_at || new Date().toISOString(), duration_seconds: Number(incident.duration_seconds || 0),
        metadata: incident.metadata || {}
    };
    if (!navigator.onLine) {
        await offlineStore.enqueue('incident', payload);
        setSaveState('Offline — incident pending synchronization', 'offline');
        return;
    }
    try {
        const data = await apiClient.request('student/incident', { method: 'POST', body: JSON.stringify(sessionPayload(payload)) });
        processIncidentResponse(data, payload, policy);
    } catch (error) {
        if (error.code === 'SESSION_MISMATCH' || error.code === 'SESSION_REPLACED') {
            showSecurityWarning({ type: 'session_replaced', details: error.message }, securityConfig.eventPolicies?.session_replaced || { severity: 'high', pausesExam: true });
        } else {
            await offlineStore.enqueue('incident', payload);
        }
    }
}

function processIncidentResponse(data, incident, policy = {}) {
    warningCount = Number(data.warning_count ?? data.violations ?? warningCount);
    securityScore = Number(data.security_score ?? securityScore);
    if (data.warning_limit) securityConfig.warningLimit = Number(data.warning_limit);
    updateWarningUi();
    const effectivePolicy = { ...policy, severity: data.severity || policy.severity };
    if (data.auto_submit || data.submitted) {
        handleServerFinalized(data, 'The configured warning limit was reached.');
        return;
    }
    if (data.pause || data.required_action === 'pause' || data.required_action === 'final_warning') {
        showSecurityWarning(incident, effectivePolicy, data);
    } else if (data.required_action === 'final_warning') {
        showSecurityWarning(incident, effectivePolicy, data);
    }
}

function emitSimpleIncident(type, details, options = {}) {
    return reportIncident({
        client_event_id: makeId('evt'), type, event_group: options.group || type, details,
        client_detected_at: new Date().toISOString(), duration_seconds: Number(options.durationSeconds || 0), metadata: options.metadata || {}
    }, securityConfig.eventPolicies?.[canonicalIncidentCode(type)] || {});
}

function showSecurityWarning(incident, policy = {}, serverData = {}) {
    if (!active || submitting) return;
    const code = canonicalIncidentCode(incident.type);
    $('lockEvent').textContent = incidentLabel(code);
    $('lockReason').textContent = incident.details || 'The protected assessment view was interrupted.';
    $('lockSeverity').textContent = String(serverData.severity || policy.severity || 'medium').toUpperCase();
    $('lockWarningScore').textContent = `${formatWarning(warningCount)} / ${formatWarning(securityConfig.warningLimit || 5)}`;
    $('lockRequiredAction').textContent = policy.requireFullscreenRestore || serverData.requires_fullscreen_restore ? 'Return to fullscreen before continuing.' : serverData.administrator_review ? 'Your instructor must review this attempt.' : 'Review the message, then restore the assessment view.';
    $('lockReviewNote').classList.toggle('hidden', !serverData.administrator_review);
    $('restoreExam').classList.toggle('hidden', !!serverData.administrator_review);
    $('securityLock').classList.add('show');
    if (policy.pausesExam !== false || serverData.pause) document.body.classList.add('exam-paused');
    autosave(false).catch(() => {});
}

async function restoreSecureView() {
    if (!active || submitting) return;
    if (securityConfig.requireFullscreen && !document.fullscreenElement) {
        const entered = await requestFullscreen();
        if (!entered) {
            $('lockRequiredAction').textContent = 'Fullscreen is required. Use the Restore button and allow fullscreen access.';
            return;
        }
    }
    securityManager.suppress(1600);
    $('securityLock').classList.remove('show');
    document.body.classList.remove('exam-paused');
}

function handleConnectionState(state) {
    clearTimeout(offlineGraceTimer);
    offlineGraceTimer = null;
    if (state === 'offline') {
        setCheck('internet', 'Internet connection', 'failed', 'Offline');
        setSaveState('Offline — pending synchronization', 'offline');
        persistOfflineState();
        const graceMs = Math.max(5, Number(securityConfig.connectionGraceSeconds || 60)) * 1000;
        offlineGraceTimer = setTimeout(() => {
            if (!active || submitting || navigator.onLine) return;
            showSecurityWarning({
                type: 'network_disconnected',
                details: `The internet connection has been unavailable longer than the ${Math.round(graceMs / 1000)}-second grace period.`
            }, { ...(securityConfig.eventPolicies?.network_disconnected || {}), severity: 'low', pausesExam: true }, { pause: true, severity: 'low' });
        }, graceMs);
    } else {
        setCheck('internet', 'Internet connection', 'passed', 'Online');
        document.body.classList.remove('exam-paused');
        if ($('securityLock')?.classList.contains('show') && $('lockEvent')?.textContent === incidentLabel('network_disconnected')) $('securityLock').classList.remove('show');
        syncOffline();
    }
}

function openReview() {
    if (!active || submitting) return;
    const answered = questions.filter(answerIsFilled).length;
    $('reviewAnswered').textContent = String(answered);
    $('reviewUnanswered').textContent = String(questions.length - answered);
    $('reviewFlagged').textContent = String(flagged.size);
    $('submitModal').classList.add('show');
}
function closeReview() { $('submitModal').classList.remove('show'); }

async function submitAssessment(auto = false, reason = '', submissionReason = 'student_submitted') {
    if (!active || submitting || !attempt) return;
    if (!auto) closeReview();
    submitting = true;
    securityManager.setSubmitting(true);
    setSaveState('Submitting…', 'saving');
    clearIntervals();
    try {
        if (navigator.onLine && dirty) await autosave(false);
        const data = await queuedApi('student/submit', {
            method: 'POST',
            body: JSON.stringify(sessionPayload({ answers, submission_reason: submissionReason }))
        });
        handleServerFinalized(data, reason);
    } catch (error) {
        submitting = false;
        securityManager.setSubmitting(false);
        setSaveState('Submission failed — try again', 'failed');
        timerInterval = setInterval(tickTimer, 1000);
        autosaveInterval = setInterval(() => autosave(false), 12000);
        heartbeatInterval = setInterval(sendHeartbeat, 20000);
        showSecurityWarning({ type: 'page_exit', details: error.message }, { severity: 'medium', pausesExam: true });
    }
}

function handleServerFinalized(data, reason = '') {
    active = false;
    submitting = false;
    clearIntervals();
    clearLease();
    securityManager.setSubmitting(true);
    securityManager.cleanup();
    stopMediaStreams();
    clearSavedSession();
    localStorage.removeItem(deviceIdKey);
    offlineStore.clearState().catch(() => {});
    offlineStore.clearQueue().catch(() => {});
    $('securityLock').classList.remove('show');
    $('submitModal').classList.remove('show');
    document.body.classList.remove('exam-paused');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    showCompleted(data.score, data.total_points ?? data.total, false, reason || submissionReasonMessage(data.submission_reason));
}

function submissionReasonMessage(reason) {
    const messages = {
        time_expired: 'The time limit ended and the server finalized your latest saved answers.',
        anomaly_limit_reached: 'The configured warning limit was reached and the server finalized your latest saved answers.',
        administrator_invalidated: 'This attempt was invalidated by an administrator.'
    };
    return messages[reason] || '';
}

function showCompleted(score, total, previous = false, reason = '') {
    showOnly('completedScreen');
    $('completeScore').textContent = `${Number(score || 0)} / ${Number(total || 0)}`;
    $('completeMessage').textContent = previous ? 'This assessment was already submitted. The recorded result is shown below.' : (reason || 'Your answers were submitted and recorded successfully.');
}

function writeLease() {
    if (!active) return;
    localStorage.setItem(leaseKey, JSON.stringify({ tabId: tabInstanceId, clientSessionId, updatedAt: Date.now() }));
}
function clearLease() {
    try {
        const lease = JSON.parse(localStorage.getItem(leaseKey) || 'null');
        if (!lease || lease.tabId === tabInstanceId) localStorage.removeItem(leaseKey);
    } catch { localStorage.removeItem(leaseKey); }
}
function clearIntervals() {
    clearInterval(timerInterval); clearInterval(autosaveInterval); clearInterval(heartbeatInterval); clearInterval(leaseInterval); clearTimeout(saveTimer); clearTimeout(offlineGraceTimer);
    timerInterval = autosaveInterval = heartbeatInterval = leaseInterval = saveTimer = offlineGraceTimer = null;
}

function leaveExamPage() {
    cleanup();
    guard.stop();
    if (window.opener && !window.opener.closed) {
        window.opener.focus(); window.close(); setTimeout(() => location.replace('student-assessments.html'), 250);
    } else location.replace('student-assessments.html');
}

function cleanup() {
    clearIntervals(); clearLease(); securityManager.cleanup(); stopMediaStreams();
}

$('startExam').onclick = startExam;
$('runDeviceChecks').onclick = runRequiredDeviceChecks;
$('confirmReady').onchange = updateStartButton;
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
    const question = currentQuestion(); if (!question) return;
    if (flagged.has(question.id)) flagged.delete(question.id); else flagged.add(question.id);
    renderQuestion(); renderNavigator(); markDirty();
};
$('restoreExam').onclick = restoreSecureView;
$('lockSubmit').onclick = () => submitAssessment(false, 'Submitted from the security warning screen.');
$('returnAssessments').onclick = leaveExamPage;
$('closeExamTab').onclick = leaveExamPage;
window.addEventListener('online', () => { setCheck('internet', 'Internet connection', 'passed', 'Online'); updateStartButton(); });
window.addEventListener('offline', () => { setCheck('internet', 'Internet connection', 'failed', 'Offline'); updateStartButton(); });
window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    securityManager.suppress(3000);
    if (active) {
        setSaveState(navigator.onLine ? 'Synchronizing…' : 'Offline — pending synchronization', navigator.onLine ? 'syncing' : 'offline');
        if (navigator.onLine) syncOffline();
    }
});
window.addEventListener('pagehide', event => {
    if (event.persisted) return; // Back-forward cache restoration is not treated as an exit.
    persistOfflineState(); clearLease();
    if (!active || submitting || !attempt || !examSession) return;
    apiClient.keepalive('student/incident', sessionPayload({
        type: 'page_exit', client_event_id: makeId('evt'), event_group: 'page_exit',
        details: 'The secure assessment page was closed or unloaded.', first_detected_at: new Date().toISOString(),
        last_detected_at: new Date().toISOString(), duration_seconds: 0, metadata: { pagehide: true }
    }));
});

setTheme();
await runPreflight();
