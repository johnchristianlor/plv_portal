export class SecureBrowserVerifier {
  constructor(publicConfig = {}) { this.publicConfig = publicConfig || {}; }
  async collectProof() { return { status: 'unavailable', proof: '' }; }
}

export class NoSecureBrowserVerifier extends SecureBrowserVerifier {
  async collectProof() {
    return { status: this.publicConfig.requireSecureBrowser ? 'unavailable' : 'not_required', proof: '' };
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
  return new ApprovedProviderBridgeVerifier(publicConfig);
}
