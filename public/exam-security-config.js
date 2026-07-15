import { INCIDENT_CODES } from './exam-incident-codes.js';

const deepClone = value => JSON.parse(JSON.stringify(value));

export const SECURITY_MODE_LABELS = Object.freeze({
  standard: 'Standard',
  monitored: 'Monitored',
  strict: 'Strict',
  secure_browser_ready: 'Secure Browser Ready'
});

const BASE_MONITORING = Object.freeze({
  tabSwitch: false,
  windowFocus: false,
  fullscreenExit: false,
  clipboard: false,
  contextMenu: false,
  dragDrop: false,
  print: false,
  restrictedShortcut: false,
  browserNavigation: false,
  connection: true,
  duplicateSession: true,
  cameraState: false,
  microphoneState: false,
  screenSharing: false,
  secureBrowserVerification: false
});

const DEFAULT_POLICIES = Object.freeze({
  tab_switch: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 4000, maxToleratedCount: 6 },
  window_focus_lost: { enabled: true, severity: 'low', countsWarning: true, warningWeight: 0.5, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 4000, maxToleratedCount: 8 },
  fullscreen_exit: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: true, mayAutoSubmit: true, cooldownMs: 3500, maxToleratedCount: 3 },
  duplicate_exam_tab: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 10000, maxToleratedCount: 2 },
  duplicate_device_session: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  session_replaced: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  copy_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
  cut_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
  paste_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
  context_menu_attempt: { enabled: true, severity: 'low', countsWarning: true, warningWeight: 0.5, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 1800, maxToleratedCount: 8 },
  drop_attempt: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
  print_attempt: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 5000, maxToleratedCount: 2 },
  screenshot_shortcut: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 2500, maxToleratedCount: 5 },
  restricted_shortcut: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 1800, maxToleratedCount: 5 },
  back_navigation: { enabled: true, severity: 'medium', countsWarning: true, warningWeight: 1, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 3000, maxToleratedCount: 4 },
  refresh_attempt: { enabled: true, severity: 'low', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 10 },
  network_disconnected: { enabled: true, severity: 'low', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 20 },
  network_reconnected: { enabled: true, severity: 'info', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 1000, maxToleratedCount: 50 },
  heartbeat_timeout: { enabled: true, severity: 'medium', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 30000, maxToleratedCount: 10 },
  camera_unavailable: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  camera_stopped: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  microphone_unavailable: { enabled: true, severity: 'high', countsWarning: true, warningWeight: 2, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  microphone_stopped: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  screen_share_unavailable: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 3, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  screen_share_stopped: { enabled: true, severity: 'critical', countsWarning: true, warningWeight: 4, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: true, cooldownMs: 30000, maxToleratedCount: 1 },
  secure_browser_failed: { enabled: true, severity: 'critical', countsWarning: false, warningWeight: 0, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 60000, maxToleratedCount: 1 },
  page_exit: { enabled: true, severity: 'medium', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 10 },
  session_recovered: { enabled: true, severity: 'info', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 10000, maxToleratedCount: 20 },
  time_expired: { enabled: true, severity: 'info', countsWarning: false, warningWeight: 0, pausesExam: false, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 60000, maxToleratedCount: 1 },
  anomaly_limit_reached: { enabled: true, severity: 'critical', countsWarning: false, warningWeight: 0, pausesExam: true, requireFullscreenRestore: false, mayAutoSubmit: false, cooldownMs: 60000, maxToleratedCount: 1 }
});

export const MODE_DEFAULTS = Object.freeze({
  standard: {
    mode: 'standard', requireFullscreen: false, maxAttempts: 1, allowBacktracking: true,
    oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
    allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 60, maxSimultaneousSessions: 1,
    warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 0,
    autoSubmitAfterFinalViolation: false, autoSubmitHighRiskOnly: true,
    adminReviewInsteadOfAutoSubmit: true, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
    monitoring: { ...BASE_MONITORING },
    media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
    requireSecureBrowser: false, secureBrowserProvider: 'none', secureBrowserConfigId: '',
    secureBrowserVerificationEnabled: false
  },
  monitored: {
    mode: 'monitored', requireFullscreen: false, maxAttempts: 1, allowBacktracking: true,
    oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
    allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 60, maxSimultaneousSessions: 1,
    warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 0,
    autoSubmitAfterFinalViolation: false, autoSubmitHighRiskOnly: true,
    adminReviewInsteadOfAutoSubmit: true, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
    monitoring: {
      ...BASE_MONITORING, tabSwitch: true, windowFocus: true, fullscreenExit: true,
      clipboard: true, contextMenu: true, dragDrop: true, print: true,
      restrictedShortcut: true, browserNavigation: true, connection: true, duplicateSession: true
    },
    media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
    requireSecureBrowser: false, secureBrowserProvider: 'none', secureBrowserConfigId: '',
    secureBrowserVerificationEnabled: false
  },
  strict: {
    mode: 'strict', requireFullscreen: true, maxAttempts: 1, allowBacktracking: true,
    oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
    allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 45, maxSimultaneousSessions: 1,
    warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 3,
    autoSubmitAfterFinalViolation: true, autoSubmitHighRiskOnly: false,
    adminReviewInsteadOfAutoSubmit: false, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
    monitoring: {
      ...BASE_MONITORING, tabSwitch: true, windowFocus: true, fullscreenExit: true,
      clipboard: true, contextMenu: true, dragDrop: true, print: true,
      restrictedShortcut: true, browserNavigation: true, connection: true, duplicateSession: true
    },
    media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
    requireSecureBrowser: false, secureBrowserProvider: 'none', secureBrowserConfigId: '',
    secureBrowserVerificationEnabled: false
  },
  secure_browser_ready: {
    mode: 'secure_browser_ready', requireFullscreen: true, maxAttempts: 1, allowBacktracking: true,
    oneQuestionPerPage: true, showNavigator: true, allowResumeAfterRefresh: true,
    allowResumeAfterConnectionLoss: true, connectionGraceSeconds: 45, maxSimultaneousSessions: 1,
    warningLimit: 5, finalWarningThreshold: 4, pauseAfterWarningCount: 3,
    autoSubmitAfterFinalViolation: true, autoSubmitHighRiskOnly: false,
    adminReviewInsteadOfAutoSubmit: false, resetWarningOnApprovedResume: false, warningCalculation: 'weighted',
    monitoring: {
      ...BASE_MONITORING, tabSwitch: true, windowFocus: true, fullscreenExit: true,
      clipboard: true, contextMenu: true, dragDrop: true, print: true,
      restrictedShortcut: true, browserNavigation: true, connection: true,
      duplicateSession: true, secureBrowserVerification: true
    },
    media: { cameraRequired: false, microphoneRequired: false, screenShareRequired: false },
    requireSecureBrowser: true, secureBrowserProvider: 'safe_exam_browser', secureBrowserConfigId: '',
    secureBrowserVerificationEnabled: true
  }
});

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}
function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeSecurityConfig(settings = {}) {
  const raw = settings?.security && typeof settings.security === 'object' ? settings.security : settings;
  const requestedMode = String(raw.mode || raw.securityMode || '').toLowerCase();
  const legacyMonitored = raw.fullscreen !== undefined || raw.maxViolations !== undefined || raw.autoSubmitOnViolation !== undefined;
  const mode = MODE_DEFAULTS[requestedMode] ? requestedMode : (legacyMonitored ? 'monitored' : 'standard');
  const defaults = deepClone(MODE_DEFAULTS[mode]);
  const monitoring = { ...defaults.monitoring, ...(raw.monitoring || {}), cameraState: false, microphoneState: false, screenSharing: false };
  const media = { cameraRequired: false, microphoneRequired: false, screenShareRequired: false };
  const policies = deepClone(DEFAULT_POLICIES);
  const customPolicies = raw.eventPolicies && typeof raw.eventPolicies === 'object' ? raw.eventPolicies : {};
  for (const code of INCIDENT_CODES) {
    if (!customPolicies[code]) continue;
    policies[code] = { ...policies[code], ...customPolicies[code] };
  }

  const warningLimit = number(raw.warningLimit ?? raw.maxViolations ?? raw.maxViol, defaults.warningLimit, 1, 100);
  const config = {
    ...defaults,
    ...raw,
    mode,
    requireFullscreen: bool(raw.requireFullscreen ?? raw.fullscreen, defaults.requireFullscreen),
    maxAttempts: Math.floor(number(raw.maxAttempts, defaults.maxAttempts, 1, 20)),
    allowBacktracking: bool(raw.allowBacktracking, defaults.allowBacktracking),
    oneQuestionPerPage: bool(raw.oneQuestionPerPage, defaults.oneQuestionPerPage),
    showNavigator: bool(raw.showNavigator, defaults.showNavigator),
    allowResumeAfterRefresh: bool(raw.allowResumeAfterRefresh, defaults.allowResumeAfterRefresh),
    allowResumeAfterConnectionLoss: bool(raw.allowResumeAfterConnectionLoss, defaults.allowResumeAfterConnectionLoss),
    connectionGraceSeconds: Math.floor(number(raw.connectionGraceSeconds, defaults.connectionGraceSeconds, 5, 600)),
    maxSimultaneousSessions: Math.floor(number(raw.maxSimultaneousSessions, defaults.maxSimultaneousSessions, 1, 5)),
    warningLimit,
    finalWarningThreshold: number(raw.finalWarningThreshold, Math.min(defaults.finalWarningThreshold, warningLimit), 0, warningLimit),
    pauseAfterWarningCount: number(raw.pauseAfterWarningCount, defaults.pauseAfterWarningCount, 0, warningLimit),
    autoSubmitAfterFinalViolation: bool(raw.autoSubmitAfterFinalViolation ?? raw.autoSubmitOnViolation, defaults.autoSubmitAfterFinalViolation),
    autoSubmitHighRiskOnly: bool(raw.autoSubmitHighRiskOnly, defaults.autoSubmitHighRiskOnly),
    adminReviewInsteadOfAutoSubmit: bool(raw.adminReviewInsteadOfAutoSubmit, defaults.adminReviewInsteadOfAutoSubmit),
    resetWarningOnApprovedResume: bool(raw.resetWarningOnApprovedResume, defaults.resetWarningOnApprovedResume),
    warningCalculation: ['weighted', 'count'].includes(raw.warningCalculation) ? raw.warningCalculation : defaults.warningCalculation,
    monitoring,
    media,
    requireSecureBrowser: bool(raw.requireSecureBrowser, defaults.requireSecureBrowser),
    secureBrowserProvider: String(raw.secureBrowserProvider || defaults.secureBrowserProvider || 'none').slice(0, 80),
    secureBrowserConfigId: String(raw.secureBrowserConfigId || '').slice(0, 120),
    secureBrowserVerificationEnabled: bool(raw.secureBrowserVerificationEnabled, defaults.secureBrowserVerificationEnabled),
    eventPolicies: policies
  };

  // Preserve legacy fields because older clients and assessments still read them.
  config.fullscreen = config.requireFullscreen;
  config.maxViolations = config.warningLimit;
  config.autoSubmitOnViolation = config.autoSubmitAfterFinalViolation;
  return config;
}

export function publicSecurityConfig(settings = {}) {
  const config = normalizeSecurityConfig(settings);
  return {
    mode: config.mode,
    modeLabel: SECURITY_MODE_LABELS[config.mode] || SECURITY_MODE_LABELS.standard,
    requireFullscreen: config.requireFullscreen,
    maxAttempts: config.maxAttempts,
    allowBacktracking: config.allowBacktracking,
    oneQuestionPerPage: config.oneQuestionPerPage,
    showNavigator: config.showNavigator,
    allowResumeAfterRefresh: config.allowResumeAfterRefresh,
    allowResumeAfterConnectionLoss: config.allowResumeAfterConnectionLoss,
    connectionGraceSeconds: config.connectionGraceSeconds,
    maxSimultaneousSessions: config.maxSimultaneousSessions,
    warningLimit: config.warningLimit,
    finalWarningThreshold: config.finalWarningThreshold,
    pauseAfterWarningCount: config.pauseAfterWarningCount,
    autoSubmitAfterFinalViolation: config.autoSubmitAfterFinalViolation,
    autoSubmitHighRiskOnly: config.autoSubmitHighRiskOnly,
    adminReviewInsteadOfAutoSubmit: config.adminReviewInsteadOfAutoSubmit,
    resetWarningOnApprovedResume: config.resetWarningOnApprovedResume,
    warningCalculation: config.warningCalculation,
    monitoring: { ...config.monitoring },
    media: { ...config.media },
    requireSecureBrowser: config.requireSecureBrowser,
    secureBrowserProvider: config.secureBrowserProvider,
    secureBrowserVerificationEnabled: config.secureBrowserVerificationEnabled,
    fullscreen: config.requireFullscreen,
    maxViolations: config.warningLimit,
    autoSubmitOnViolation: config.autoSubmitAfterFinalViolation
  };
}
