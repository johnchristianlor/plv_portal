import { canonicalIncidentCode } from './exam-incident-codes.js';

const nowIso = () => new Date().toISOString();
const makeId = prefix => crypto.randomUUID ? `${prefix}_${crypto.randomUUID()}` : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export class ExamSecurityManager {
  constructor({ config, onIncident, onPause, onConnectionState, onDuplicateTab }) {
    this.config = config || {};
    this.onIncident = onIncident;
    this.onPause = onPause;
    this.onConnectionState = onConnectionState;
    this.onDuplicateTab = onDuplicateTab;
    this.active = false;
    this.submitting = false;
    this.suppressUntil = 0;
    this.removers = [];
    this.timers = new Set();
    this.lastIncident = new Map();
    this.hiddenStartedAt = 0;
    this.pageHideStartedAt = 0;
    this.offlineStartedAt = 0;
    this.pendingBlurTimer = null;
    this.mediaStreams = [];
    this.channel = null;
    this.tabId = '';
    this.assessmentId = '';
  }

  setConfig(config) { this.config = config || {}; }
  suppress(milliseconds = 1800) { this.suppressUntil = Math.max(this.suppressUntil, Date.now() + milliseconds); }
  setSubmitting(value) { this.submitting = Boolean(value); }
  shouldSuppress() { return !this.active || this.submitting || Date.now() < this.suppressUntil; }

  policy(code) {
    return this.config?.eventPolicies?.[code] || {};
  }

  monitoring(name) {
    return this.config?.monitoring?.[name] === true;
  }

  mobileMeta(extra = {}) {
    const ua = navigator.userAgent || '';
    const mobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
    return {
      mobile,
      visibility_state: document.visibilityState || '',
      viewport_width: window.innerWidth || 0,
      viewport_height: window.innerHeight || 0,
      fullscreen: !!document.fullscreenElement,
      ...extra
    };
  }

  emit(rawCode, details, options = {}) {
    const code = canonicalIncidentCode(rawCode);
    if (this.shouldSuppress()) return;
    const policy = this.policy(code);
    if (policy.enabled === false) return;
    const cooldownMs = Number(options.cooldownMs ?? policy.cooldownMs ?? 2500);
    const key = options.group || code;
    const last = Number(this.lastIncident.get(key) || 0);
    if (Date.now() - last < cooldownMs) return;
    this.lastIncident.set(key, Date.now());
    const incident = {
      client_event_id: makeId('evt'),
      type: code,
      event_group: String(options.group || code).slice(0, 80),
      details: String(details || '').slice(0, 1000),
      client_detected_at: nowIso(),
      first_detected_at: options.firstDetectedAt || nowIso(),
      last_detected_at: options.lastDetectedAt || nowIso(),
      duration_seconds: Math.max(0, Number(options.durationSeconds || 0)),
      metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {}
    };
    this.onIncident?.(incident, policy);
    if (policy.pausesExam || options.pause) this.onPause?.(incident, policy);
  }

  listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this.removers.push(() => target.removeEventListener(event, handler, options));
  }

  addTimer(timer) { this.timers.add(timer); return timer; }

  bind({ assessmentId, tabId }) {
    if (this.active) return;
    this.active = true;
    this.assessmentId = assessmentId;
    this.tabId = tabId;

    if (this.monitoring('tabSwitch') || this.monitoring('windowFocus')) {
      this.listen(document, 'visibilitychange', () => {
        if (document.hidden) {
          this.hiddenStartedAt = Date.now();
          if (this.pendingBlurTimer) clearTimeout(this.pendingBlurTimer);
          if (this.monitoring('tabSwitch')) {
            this.lastIncident.set('focus_transition', Date.now());
          }
          return;
        }
        if (!this.hiddenStartedAt) return;
        const started = this.hiddenStartedAt;
        this.hiddenStartedAt = 0;
        const duration = Math.max(0, (Date.now() - started) / 1000);
        if (this.monitoring('tabSwitch')) {
          const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '');
          this.emit('tab_switch', mobile
            ? `Possible mobile app switch or system overlay detected. The exam was hidden for ${duration.toFixed(1)} seconds.`
            : `The assessment tab was hidden for ${duration.toFixed(1)} seconds.`, {
            group: 'focus_transition',
            firstDetectedAt: new Date(started).toISOString(),
            durationSeconds: duration,
            metadata: this.mobileMeta({ trigger: 'visibilitychange' })
          });
        }
      });
      this.listen(window, 'blur', () => {
        if (!this.monitoring('windowFocus') || this.shouldSuppress()) return;
        if (this.pendingBlurTimer) clearTimeout(this.pendingBlurTimer);
        this.pendingBlurTimer = this.addTimer(setTimeout(() => {
          this.timers.delete(this.pendingBlurTimer);
          this.pendingBlurTimer = null;
          if (document.hidden) return; // visibilitychange will create the single grouped event.
          this.emit('window_focus_lost', 'The browser window lost focus while the exam page remained visible. This can happen with floating windows, system panels, or another active app.', {
            group: 'focus_transition',
            cooldownMs: 4000,
            metadata: this.mobileMeta({ trigger: 'blur' })
          });
        }, 650));
      });
      this.listen(window, 'focus', () => {
        if (this.pendingBlurTimer) {
          clearTimeout(this.pendingBlurTimer);
          this.timers.delete(this.pendingBlurTimer);
          this.pendingBlurTimer = null;
        }
      });
      this.listen(window, 'pagehide', event => {
        if (this.shouldSuppress()) return;
        this.pageHideStartedAt = Date.now();
        if (this.monitoring('browserNavigation') || this.monitoring('tabSwitch')) {
          this.emit('page_exit', event.persisted ? 'The exam page entered the browser back-forward cache.' : 'The exam page was hidden, refreshed, or closed.', {
            group: 'page_lifecycle',
            cooldownMs: 5000,
            metadata: this.mobileMeta({ trigger: 'pagehide', persisted: !!event.persisted })
          });
        }
      });
      this.listen(window, 'pageshow', event => {
        if (!this.pageHideStartedAt) return;
        const started = this.pageHideStartedAt;
        this.pageHideStartedAt = 0;
        const duration = Math.max(0, (Date.now() - started) / 1000);
        if (duration > 1 && (this.monitoring('tabSwitch') || this.monitoring('browserNavigation'))) {
          this.emit('session_recovered', `The exam page resumed after ${duration.toFixed(1)} seconds.`, {
            group: 'page_lifecycle_resume',
            cooldownMs: 1000,
            durationSeconds: duration,
            metadata: this.mobileMeta({ trigger: 'pageshow', persisted: !!event.persisted })
          });
        }
      });
      this.listen(document, 'freeze', () => {
        if (this.shouldSuppress()) return;
        this.emit('tab_switch', 'The mobile browser froze or suspended the exam page.', {
          group: 'focus_transition',
          cooldownMs: 4000,
          metadata: this.mobileMeta({ trigger: 'freeze' })
        });
      });
      this.listen(document, 'resume', () => {
        if (this.shouldSuppress()) return;
        this.emit('session_recovered', 'The mobile browser resumed the exam page after suspension.', {
          group: 'page_lifecycle_resume',
          cooldownMs: 1500,
          metadata: this.mobileMeta({ trigger: 'resume' })
        });
      });
    }

    if (this.monitoring('fullscreenExit')) {
      this.listen(document, 'fullscreenchange', () => {
        if (this.config.requireFullscreen && !document.fullscreenElement) {
          this.emit('fullscreen_exit', 'Required fullscreen mode was exited.', { pause: true, cooldownMs: 3500 });
        }
      });
    }

    if (this.monitoring('clipboard')) {
      this.listen(document, 'copy', event => { event.preventDefault(); this.emit('copy_attempt', 'Copying assessment content was blocked.'); });
      this.listen(document, 'cut', event => { event.preventDefault(); this.emit('cut_attempt', 'Cutting assessment content was blocked.'); });
      this.listen(document, 'paste', event => { event.preventDefault(); this.emit('paste_attempt', 'Pasting external content was blocked.'); });
    }
    if (this.monitoring('contextMenu')) this.listen(document, 'contextmenu', event => { event.preventDefault(); this.emit('context_menu_attempt', 'The context menu was blocked.'); });
    if (this.monitoring('dragDrop')) {
      this.listen(document, 'dragstart', event => event.preventDefault());
      this.listen(document, 'drop', event => { event.preventDefault(); this.emit('drop_attempt', 'Dropping external content into the assessment was blocked.'); });
    }
    if (this.monitoring('print')) this.listen(window, 'beforeprint', () => this.emit('print_attempt', 'A print action was requested.', { pause: true }));
    if (this.monitoring('restrictedShortcut')) {
      this.listen(document, 'keydown', event => {
        const key = String(event.key || '').toLowerCase();
        const restricted = key === 'f12' || key === 'printscreen' ||
          ((event.ctrlKey || event.metaKey) && ['p', 's', 'u', 'r', 't', 'n', 'w', 'l'].includes(key)) ||
          ((event.ctrlKey || event.metaKey) && event.shiftKey && ['i', 'j', 'c'].includes(key));
        if (!restricted) return;
        event.preventDefault();
        if (key === 'printscreen') this.emit('screenshot_shortcut', 'A screenshot keyboard shortcut was detected. This does not prove that an image was captured.');
        else this.emit('restricted_shortcut', `Restricted shortcut detected: ${event.key}.`);
      }, true);
    }
    if (this.monitoring('browserNavigation')) {
      this.listen(window, 'popstate', () => {
        history.pushState({ exam: true }, '', location.href);
        this.emit('back_navigation', 'Browser-back navigation was blocked.');
      });
    }
    if (this.monitoring('connection')) {
      this.listen(window, 'offline', () => {
        this.offlineStartedAt = Date.now();
        this.onConnectionState?.('offline');
      });
      this.listen(window, 'online', () => {
        const started = this.offlineStartedAt;
        this.offlineStartedAt = 0;
        const duration = started ? Math.max(0, (Date.now() - started) / 1000) : 0;
        this.onConnectionState?.('online');
        if (started) {
          this.emit('network_disconnected', `The internet connection was unavailable for ${duration.toFixed(1)} seconds.`, {
            group: 'network_cycle', firstDetectedAt: new Date(started).toISOString(), durationSeconds: duration,
            cooldownMs: 1000, metadata: { grace_seconds: Number(this.config.connectionGraceSeconds || 60) }
          });
          this.emit('network_reconnected', 'The internet connection was restored.', { group: `network_reconnected_${started}`, cooldownMs: 1000, durationSeconds: duration });
        }
      });
    }

    this.listen(window, 'beforeunload', event => {
      if (!this.active || this.submitting) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  attachDuplicateChannel(assessmentId, tabId) {
    if (!('BroadcastChannel' in window)) return null;
    this.channel = new BroadcastChannel(`plv-secure-exam:${assessmentId}`);
    this.channel.onmessage = event => {
      const message = event.data || {};
      if (message.tabId === tabId) return;
      if (message.type === 'probe' && this.active) this.channel.postMessage({ type: 'active', tabId });
      if (message.type === 'active' || message.type === 'starting') {
        this.onDuplicateTab?.(message);
      }
    };
    return this.channel;
  }

  trackMediaStream(stream, kind, required = false) {
    if (!stream) return;
    if (!this.mediaStreams.includes(stream)) this.mediaStreams.push(stream);
    const expectedTrackKind = kind === 'microphone' ? 'audio' : 'video';
    for (const track of stream.getTracks().filter(item => item.kind === expectedTrackKind)) {
      track.addEventListener('ended', () => {
        if (!this.active || this.submitting || !required) return;
        const code = kind === 'camera' ? 'camera_stopped' : kind === 'microphone' ? 'microphone_stopped' : 'screen_share_stopped';
        this.emit(code, `The required ${kind.replace('_', ' ')} stream stopped.`, { pause: true, cooldownMs: 30000 });
      }, { once: true });
    }
  }

  cleanup() {
    this.active = false;
    this.removers.splice(0).forEach(remove => { try { remove(); } catch {} });
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    if (this.pendingBlurTimer) clearTimeout(this.pendingBlurTimer);
    this.pendingBlurTimer = null;
    this.channel?.close();
    this.channel = null;
    this.mediaStreams.splice(0).forEach(stream => stream.getTracks().forEach(track => track.stop()));
  }
}
