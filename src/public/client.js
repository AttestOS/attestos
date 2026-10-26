/**
 * AttestOS Unified Client SDK (Browser)
 * 
 * Embeddable script that executes:
 * 1. Silent Hardware Attestation check (Pivot B)
 * 2. Background Client Proof-of-Work (Pivot A)
 * 3. Client Environment Telemetry Collection (for CDP & Automation detection)
 */

(function (window) {
  const AttestOS = {
    endpoint: '/api/pipeline/evaluate',

    /**
     * Collect client-side environment signals to detect CDP & stealth frameworks
     */
    collectTelemetry: function () {
      const detectedVars = [];
      const suspiciousProps = [
        'webdriver',
        '__playwright',
        '_phantom',
        '__nightmare',
        'callPhantom',
        'cdc_adoQpoasnfa76pfcZLmcfl_Array',
        '__puppeteer_evaluation_script__'
      ];

      suspiciousProps.forEach(prop => {
        if (prop in window || prop in navigator) {
          detectedVars.push(prop);
        }
      });

      // Check for native toString tampering
      let nativeOverrides = false;
      try {
        if (Function.prototype.toString.call(navigator.plugins.namedItem).indexOf('[native code]') === -1) {
          nativeOverrides = true;
        }
      } catch (e) {
        // Ignored
      }

      return {
        webdriver: navigator.webdriver || false,
        platform: navigator.platform,
        userAgent: navigator.userAgent,
        pluginsLength: navigator.plugins ? navigator.plugins.length : 0,
        detectedVariables: detectedVars,
        nativeOverridesDetected: nativeOverrides,
        screenRes: `${window.screen.width}x${window.screen.height}`,
        hardwareConcurrency: navigator.hardwareConcurrency || 4
      };
    },

    /**
     * Compute Proof of Work in browser using WebCrypto (zero server cost)
     */
    solvePoW: async function (challenge) {
      const { salt, difficulty, expiresAt, signature } = challenge;
      const targetPrefix = '0'.repeat(difficulty);
      let nonce = 0;
      const startTime = performance.now();

      const encoder = new TextEncoder();

      while (true) {
        nonce++;
        const message = encoder.encode(salt + nonce);
        const hashBuffer = await crypto.subtle.digest('SHA-256', message);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        if (hashHex.startsWith(targetPrefix)) {
          const duration = Math.round(performance.now() - startTime);
          return {
            salt,
            timestamp: challenge.timestamp || (expiresAt - 120000),
            expiresAt,
            difficulty,
            nonce,
            signature,
            hash: hashHex,
            clientSolveTimeMs: duration
          };
        }

        // Yield occasionally to avoid locking main thread
        if (nonce % 5000 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
    },

    /**
     * Attempt silent WebAuthn hardware passkey check
     */
    attemptHardwareAttestation: async function (challengeHex) {
      if (!window.PublicKeyCredential) {
        return { supported: false };
      }

      try {
        const challengeBuffer = new Uint8Array(challengeHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const credential = await navigator.credentials.get({
          publicKey: {
            challenge: challengeBuffer,
            timeout: 10000,
            userVerification: 'preferred',
            rpId: window.location.hostname
          }
        });

        if (credential) {
          return {
            supported: true,
            success: true,
            clientDataJSON: btoa(String.fromCharCode(...new Uint8Array(credential.response.clientDataJSON))),
            authenticatorData: btoa(String.fromCharCode(...new Uint8Array(credential.response.authenticatorData))),
            signature: btoa(String.fromCharCode(...new Uint8Array(credential.response.signature)))
          };
        }
      } catch (err) {
        // Graceful fallback to PoW
        return { supported: true, success: false, error: err.message };
      }
    }
  };

  window.AttestOS = AttestOS;
})(window);
