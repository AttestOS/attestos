/**
 * AttestOS - Express / Node.js Production Middleware
 * 
 * Usage:
 * const { attestosProtect } = require('./integrations/express/middleware');
 * app.post('/api/checkout', attestosProtect({ failAction: 'block' }), (req, res) => { ... });
 */

const waterfall = require('../../src/pipeline/waterfall');

function attestosProtect(options = {}) {
  const {
    whopLicenseKey = process.env.WHOP_LICENSE_KEY,
    siteKey = process.env.ATTESTOS_SITE_KEY || 'default_site',
    failAction = 'challenge' // 'challenge' | 'block'
  } = options;

  return async function (req, res, next) {
    let payload = null;

    if (req.body && req.body.attestos_payload) {
      try {
        payload = typeof req.body.attestos_payload === 'string' 
          ? JSON.parse(req.body.attestos_payload) 
          : req.body.attestos_payload;
      } catch (e) {}
    } else if (req.query && req.query.attestos_payload) {
      try {
        payload = typeof req.query.attestos_payload === 'string'
          ? JSON.parse(req.query.attestos_payload)
          : req.query.attestos_payload;
      } catch (e) {}
    } else if (req.headers['x-attestos-payload']) {
      try {
        payload = JSON.parse(req.headers['x-attestos-payload']);
      } catch (e) {}
    }

    const evaluation = await waterfall.evaluateRequest({
      headers: req.headers,
      url: req.originalUrl || req.url,
      method: req.method,
      whopLicenseKey,
      siteKey,
      clientTelemetry: payload ? payload.telemetry : null,
      hardwareToken: payload ? payload.hardwareToken : null,
      webAuthnAssertion: payload ? payload.webAuthnAssertion : null,
      powSolution: payload ? payload.powSolution : null
    });

    if (evaluation.admitted) {
      req.attestos = evaluation;
      return next();
    }

    if (evaluation.statusCode === 402) {
      if (evaluation.headers) {
        for (const [key, val] of Object.entries(evaluation.headers)) {
          res.setHeader(key, val);
        }
      }
      return res.status(402).json(evaluation.response);
    }

    if (failAction === 'block') {
      return res.status(403).json({
        error: 'AttestOS verification required',
        pillar: evaluation.pillar,
        details: evaluation.error || 'Request did not pass client environment integrity verification.'
      });
    }

    // Default: Return challenge
    return res.status(evaluation.statusCode || 428).json(evaluation);
  };
}

module.exports = { attestosProtect };
