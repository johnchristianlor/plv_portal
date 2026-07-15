export class SecureBrowserVerifier {
  constructor(publicConfig = {}) { this.publicConfig = publicConfig || {}; }
  async collectProof() { return { status: 'unavailable', proof: '' }; }
}

function stableExamUrl() {
  try {
    const url = new URL(location.href);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function waitForSebKeys(securityApi, timeoutMs = 1200) {
  if (!securityApi || typeof securityApi.updateKeys !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      securityApi.updateKeys(finish);
      setTimeout(finish, timeoutMs);
    } catch {
      finish();
    }
  });
}

export class NoSecureBrowserVerifier extends SecureBrowserVerifier {
  async collectProof() {
    return { status: this.publicConfig.requireSecureBrowser ? 'unavailable' : 'not_required', proof: '' };
  }
}

export class SafeExamBrowserVerifier extends SecureBrowserVerifier {
  async collectProof() {
    const seb = globalThis.SafeExamBrowser;
    const security = seb?.security;
    if (!seb || !security) return { status: 'unavailable', proof: '' };
    try {
      await waitForSebKeys(security);
      const configKey = String(security.configKey || '').trim();
      const browserExamKey = String(security.browserExamKey || '').trim();
      if (!configKey && !browserExamKey) return { status: 'failed', proof: '' };
      const payload = {
        provider: 'safe_exam_browser',
        version: String(seb.version || ''),
        configKeyHash: configKey.slice(0, 512),
        browserExamKeyHash: browserExamKey.slice(0, 512),
        examUrl: stableExamUrl(),
        assessmentId: String(this.publicConfig.assessmentId || '')
      };
      return { status: 'available', proof: JSON.stringify(payload).slice(0, 4000) };
    } catch {
      return { status: 'failed', proof: '' };
    }
  }
}

export class ApprovedProviderBridgeVerifier extends SecureBrowserVerifier {
  async collectProof() {
    // A real approved secure-browser integration must inject this bridge.
    // The portal never guesses verification from the user-agent string.
    const bridge = globalThis.PLV_SECURE_BROWSER_BRIDGE;
    if (!bridge || typeof bridge.getVerificationProof !== 'function') {
      return { status: 'unavailable', proof: '' };
    }
    try {
      const result = await bridge.getVerificationProof({
        provider: this.publicConfig.secureBrowserProvider || 'approved_provider',
        assessmentId: this.publicConfig.assessmentId || ''
      });
      const proof = typeof result === 'string' ? result : result?.proof;
      return proof ? { status: 'available', proof: String(proof).slice(0, 4000) } : { status: 'failed', proof: '' };
    } catch {
      return { status: 'failed', proof: '' };
    }
  }
}

export function createSecureBrowserVerifier(publicConfig = {}) {
  if (!publicConfig.requireSecureBrowser) return new NoSecureBrowserVerifier(publicConfig);
  if (!publicConfig.secureBrowserVerificationEnabled) return new NoSecureBrowserVerifier(publicConfig);
  if ((publicConfig.secureBrowserProvider || '').toLowerCase() === 'safe_exam_browser') {
    return new SafeExamBrowserVerifier(publicConfig);
  }
  return new ApprovedProviderBridgeVerifier(publicConfig);
}
