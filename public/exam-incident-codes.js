export const INCIDENT_ALIASES = Object.freeze({
  tab_hidden: 'tab_switch',
  visibility_hidden: 'tab_switch',
  window_blur: 'window_focus_lost',
  app_switch: 'tab_switch',
  smart_panel: 'window_focus_lost',
  floating_window: 'window_focus_lost',
  split_screen: 'window_focus_lost',
  duplicate_tab: 'duplicate_exam_tab',
  duplicate_window: 'duplicate_exam_tab',
  copy: 'copy_attempt',
  cut: 'cut_attempt',
  paste: 'paste_attempt',
  context_menu: 'context_menu_attempt',
  offline: 'network_disconnected',
  network_offline: 'network_disconnected',
  online: 'network_reconnected',
  network_online: 'network_reconnected',
  unload: 'page_exit',
  screenshot_key: 'screenshot_shortcut',
  print: 'print_attempt',
  anomaly_limit: 'anomaly_limit_reached'
});

export const INCIDENT_CODES = Object.freeze([
  'tab_switch',
  'window_focus_lost',
  'fullscreen_exit',
  'duplicate_exam_tab',
  'duplicate_device_session',
  'session_replaced',
  'copy_attempt',
  'cut_attempt',
  'paste_attempt',
  'context_menu_attempt',
  'drop_attempt',
  'print_attempt',
  'screenshot_shortcut',
  'restricted_shortcut',
  'back_navigation',
  'refresh_attempt',
  'network_disconnected',
  'network_reconnected',
  'heartbeat_timeout',
  'secure_browser_failed',
  'page_exit',
  'session_recovered',
  'time_expired',
  'anomaly_limit_reached'
]);

export const INCIDENT_LABELS = Object.freeze({
  tab_switch: 'Tab or application switched',
  window_focus_lost: 'Browser window lost focus',
  fullscreen_exit: 'Fullscreen exited',
  duplicate_exam_tab: 'Duplicate exam tab',
  duplicate_device_session: 'Another device session',
  session_replaced: 'Exam session replaced',
  copy_attempt: 'Copy attempt',
  cut_attempt: 'Cut attempt',
  paste_attempt: 'Paste attempt',
  context_menu_attempt: 'Right-click attempt',
  drop_attempt: 'Drag-and-drop attempt',
  print_attempt: 'Print attempt',
  screenshot_shortcut: 'Screenshot shortcut detected',
  restricted_shortcut: 'Restricted keyboard shortcut',
  back_navigation: 'Browser-back navigation',
  refresh_attempt: 'Page refresh or reload',
  network_disconnected: 'Internet connection lost',
  network_reconnected: 'Internet connection restored',
  heartbeat_timeout: 'Exam session heartbeat missed',
  secure_browser_failed: 'Secure-browser verification failed',
  page_exit: 'Exam page closed or unloaded',
  session_recovered: 'Exam session recovered',
  time_expired: 'Time limit reached',
  anomaly_limit_reached: 'Warning limit reached'
});

export function canonicalIncidentCode(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return INCIDENT_ALIASES[key] || key;
}

export function incidentLabel(value) {
  const code = canonicalIncidentCode(value);
  return INCIDENT_LABELS[code] || code.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
