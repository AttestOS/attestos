/**
 * AttestOS Ghost-PoW Freebie Client
 * Zero-dependency, client-side Proof-of-Work solver using native WebCrypto API.
 * Free tier: 25,000 challenge solves/month.
 * 
 * Usage:
 *   const solver = new GhostPoW({ edgeEndpoint: 'https://attestos-edge.attestos.workers.dev' });
 *   const solution = await solver.solve();
 *   // Attach solution to request headers or payload
 */

class GhostPoW {
  constructor(options = {}) {
    this.edgeEndpoint = options.edgeEndpoint || 'https://attestos-edge.attestos.workers.dev';
    this.siteKey = options.siteKey || 'default_site';
  }

  async fetchChallenge(difficulty = 4) {
    const res = await fetch(`${this.edgeEndpoint}/api/pow/challenge?difficulty=${difficulty}&siteKey=${encodeURIComponent(this.siteKey)}`);
    if (!res.ok) throw new Error(`Failed to fetch PoW challenge: ${res.statusText}`);
    return await res.json();
  }

  async solve(challenge) {
    if (!challenge) {
      challenge = await this.fetchChallenge();
    }

    const { salt, difficulty, timestamp, expiresAt, signature } = challenge;
    const targetPrefix = '0'.repeat(difficulty);
    const encoder = new TextEncoder();
    let nonce = 0;
    const startTime = performance.now();

    while (true) {
      const data = encoder.encode(`${salt}${nonce}`);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      if (hashHex.startsWith(targetPrefix)) {
        const solveDurationMs = Math.round(performance.now() - startTime);
        return {
          salt,
          nonce,
          difficulty,
          timestamp,
          expiresAt,
          signature,
          hash: hashHex,
          durationMs: solveDurationMs,
          siteKey: this.siteKey
        };
      }
      nonce++;

      // Yield event loop every 2000 iterations to avoid freezing browser UI
      if (nonce % 2000 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  async verify(solution) {
    const res = await fetch(`${this.edgeEndpoint}/api/pow/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(solution)
    });
    return await res.json();
  }
}

if (typeof window !== 'undefined') {
  window.GhostPoW = GhostPoW;
}
if (typeof module !== 'undefined') {
  module.exports = GhostPoW;
}
