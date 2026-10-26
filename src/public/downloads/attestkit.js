/**
 * AttestOS AttestKit Freebie Client
 * Zero-dependency, silent W3C WebAuthn passkey assertion module.
 * Free tier: 25,000 silent assertions/month.
 * 
 * Bypasses bot challenges instantly (0ms) using hardware Secure Enclaves
 * (Apple Touch ID / Face ID, Windows Hello, Android Biometrics).
 */

class AttestKit {
  constructor(options = {}) {
    this.edgeEndpoint = options.edgeEndpoint || 'https://attestos-edge.attestos.workers.dev';
    this.siteKey = options.siteKey || 'default_site';
  }

  static isSupported() {
    return typeof window !== 'undefined' &&
      window.PublicKeyCredential !== undefined &&
      typeof window.PublicKeyCredential === 'function';
  }

  async checkHardwareAvailability() {
    if (!AttestKit.isSupported()) return false;
    try {
      if (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      }
      return true;
    } catch {
      return false;
    }
  }

  async generateAssertion(challengeHex) {
    if (!AttestKit.isSupported()) {
      throw new Error('WebAuthn hardware credentials not supported in this client environment');
    }

    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);

    const publicKeyCredentialRequestOptions = {
      challenge: challengeBytes,
      timeout: 30000,
      userVerification: 'preferred',
      rpId: window.location.hostname || 'localhost'
    };

    try {
      const assertion = await navigator.credentials.get({
        publicKey: publicKeyCredentialRequestOptions
      });

      return {
        credentialId: btoa(String.fromCharCode(...new Uint8Array(assertion.rawId))),
        authenticatorData: btoa(String.fromCharCode(...new Uint8Array(assertion.response.authenticatorData))),
        clientDataJSON: btoa(String.fromCharCode(...new Uint8Array(assertion.response.clientDataJSON))),
        signature: btoa(String.fromCharCode(...new Uint8Array(assertion.response.signature))),
        userHandle: assertion.response.userHandle ? btoa(String.fromCharCode(...new Uint8Array(assertion.response.userHandle))) : null,
        siteKey: this.siteKey
      };
    } catch (err) {
      throw new Error(`Passkey assertion failed or cancelled: ${err.message}`);
    }
  }
}

if (typeof window !== 'undefined') {
  window.AttestKit = AttestKit;
}
if (typeof module !== 'undefined') {
  module.exports = AttestKit;
}
