/**
 * AttestOS - Next.js (App Router / Pages / Edge) Integration SDK
 * 
 * Includes:
 * 1. React Component for embedding: <AttestOSWidget siteKey="..." />
 * 2. Server-side validation helper: verifyAttestOSPayload(payload)
 * 3. Edge / Next.js Middleware helper: attestosNextMiddleware(request)
 */

// Server-side validation helper
export async function verifyAttestOS(payload, options = {}) {
  const endpoint = options.endpoint || process.env.ATTESTOS_ENDPOINT || 'http://localhost:3000/api/pipeline/evaluate';
  const whopKey = options.whopLicenseKey || process.env.WHOP_LICENSE_KEY;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Whop-License': whopKey || ''
      },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    return { admitted: false, error: err.message };
  }
}

// React Component for Next.js / React apps
export function AttestOSWidget({ siteKey = 'default_site', onVerified }) {
  return (
    <div
      className="attestos-widget"
      data-sitekey={siteKey}
      ref={(el) => {
        if (el && typeof window !== 'undefined' && window.AttestOS) {
          window.AttestOS.mount(el);
          if (onVerified) {
            window.addEventListener('attestos:verified', (e) => onVerified(e.detail), { once: true });
          }
        }
      }}
    />
  );
}
