/**
 * AttestOS - PIVOT A (PRODUCT): IntegrityRuntime Pro
 * 
 * Deep Client Environment Integrity & Stealth Browser Unmasking Engine
 * 
 * "The arms race has moved from computer vision to client environment integrity."
 * 
 * Technical Capabilities:
 * 1. CDP (Chrome DevTools Protocol) Leakage Unmasking
 * 2. Undetected-Chromedriver ($cdc_) & Playwright Stealth Detection
 * 3. Native Function & Prototype Tampering Analysis
 * 4. WebGL Virtualized Hardware & Software Rasterizer Unmasking (SwiftShader, llvmpipe)
 * 5. Motor-Control Vector Trajectory Entropy (Human tremor vs Synthetic Bézier curves)
 * 6. Dynamic Computational Punishment: Asymmetric 256x-4096x CPU hash tax on bots
 * 
 * Monetization: Whop Plan `plan_integrity_pro_monthly` ($39/mo)
 * Brand: AttestOS
 */

const ghostPow = require('./ghost-pow-free');
const whopGate = require('../monetization/whop-gate');
const config = require('../config');

class IntegrityRuntimePro {
  /**
   * Run comprehensive forensic analysis on client-reported environment telemetry
   */
  async analyzeClientEnvironment(telemetry, whopLicenseKey, siteKey = 'default') {
    // 1. Enforce Whop Pro License
    const auth = await whopGate.enforceFeature('integrity_runtime_pro', whopLicenseKey);
    if (!auth.allowed) {
      return {
        allowed: false,
        requiresUpgrade: true,
        upgradeUrl: auth.checkoutUrl,
        brand: config.BRAND,
        message: 'IntegrityRuntime Pro is locked. Showing baseline free Ghost-PoW challenge.'
      };
    }

    const report = {
      timestamp: new Date().toISOString(),
      brand: config.BRAND,
      siteKey,
      riskScore: 0.0, // 0.0 (clean) to 1.0 (hostile automated runner)
      automationDetected: false,
      cdpActive: false,
      tamperingDetected: false,
      hardwareVirtualized: false,
      behavioralAnomaly: false,
      signaturesFound: []
    };

    if (!telemetry || typeof telemetry !== 'object') {
      report.riskScore = 0.90;
      report.signaturesFound.push('TELEMETRY_MISSING_OR_CORRUPT');
      return this._generateDynamicChallenge(report, siteKey);
    }

    // ─────────────────────────────────────────────────────────────
    // Check 1: Known Automation & Stealth Variables
    // ─────────────────────────────────────────────────────────────
    const botVariables = [
      'webdriver',
      '__playwright',
      '_phantom',
      '__nightmare',
      'callPhantom',
      'cdc_adoQpoasnfa76pfcZLmcfl_Array',
      '__puppeteer_evaluation_script__',
      '__selenium_evaluate',
      '__driver_evaluate'
    ];

    if (telemetry.detectedVariables && Array.isArray(telemetry.detectedVariables)) {
      for (const varName of telemetry.detectedVariables) {
        if (botVariables.includes(varName)) {
          report.automationDetected = true;
          report.cdpActive = true;
          report.signaturesFound.push(`AUTOMATION_GLOBAL_${varName.toUpperCase()}`);
          report.riskScore += 0.45;
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Check 2: Navigator Integrity
    // ─────────────────────────────────────────────────────────────
    if (telemetry.webdriver === true) {
      report.automationDetected = true;
      report.signaturesFound.push('NAVIGATOR_WEBDRIVER_FLAG');
      report.riskScore += 0.50;
    }

    // Platform mismatch checks
    if (telemetry.platform && telemetry.userAgent) {
      const ua = telemetry.userAgent.toLowerCase();
      const plat = telemetry.platform.toLowerCase();

      if (plat.includes('win') && (ua.includes('macintosh') || ua.includes('linux'))) {
        report.tamperingDetected = true;
        report.signaturesFound.push('PLATFORM_UA_MISMATCH');
        report.riskScore += 0.40;
      }
      if (plat.includes('mac') && (ua.includes('windows') || ua.includes('linux'))) {
        report.tamperingDetected = true;
        report.signaturesFound.push('PLATFORM_UA_MISMATCH');
        report.riskScore += 0.40;
      }
    }

    // Zero plugins on desktop browsers
    if (telemetry.pluginsLength === 0 && telemetry.platform && !telemetry.platform.includes('Mobile')) {
      report.signaturesFound.push('DESKTOP_ZERO_PLUGINS_ANOMALY');
      report.riskScore += 0.25;
    }

    // ─────────────────────────────────────────────────────────────
    // Check 3: Prototype & Native Function Tampering
    // ─────────────────────────────────────────────────────────────
    if (telemetry.nativeOverridesDetected === true || telemetry.prototypeTampered === true) {
      report.tamperingDetected = true;
      report.signaturesFound.push('FUNCTION_TOSTRING_PROTOTYPE_TAMPERED');
      report.riskScore += 0.45;
    }

    // ─────────────────────────────────────────────────────────────
    // Check 4: WebGL Virtualized Hardware & Software Rasterizers
    // ─────────────────────────────────────────────────────────────
    if (telemetry.webglRenderer) {
      const r = telemetry.webglRenderer.toLowerCase();
      const virtualGpuKeywords = ['swiftshader', 'llvmpipe', 'mesa offscreen', 'software rasterizer', 'virtualbox', 'vmware'];
      for (const keyword of virtualGpuKeywords) {
        if (r.includes(keyword)) {
          report.hardwareVirtualized = true;
          report.signaturesFound.push(`VIRTUALIZED_GPU_${keyword.toUpperCase().replace(/\s+/g, '_')}`);
          report.riskScore += 0.50;
          break;
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Check 5: Motor-Control Vector Trajectory Entropy
    // ─────────────────────────────────────────────────────────────
    if (telemetry.mouseSamples && Array.isArray(telemetry.mouseSamples)) {
      const entropyResult = this._calculateMouseEntropy(telemetry.mouseSamples);
      if (entropyResult.valid && entropyResult.entropy < 1.15) {
        report.behavioralAnomaly = true;
        report.signaturesFound.push('ROBOTIC_LINEAR_OR_SYNTHETIC_BEZIER_PATH');
        report.riskScore += 0.35;
      }
    }

    // Cap risk score between 0.0 and 1.0
    report.riskScore = Math.min(1.0, parseFloat(report.riskScore.toFixed(3)));

    return this._generateDynamicChallenge(report, siteKey);
  }

  /**
   * Determine dynamic Proof-of-Work difficulty escalation policy based on forensic risk
   */
  _generateDynamicChallenge(report, siteKey) {
    let difficulty = 4; // Baseline (clean visitor, ~150ms on mobile/desktop)
    let action = 'ALLOW_STANDARD_COMPUTE';
    let cpuMultiplier = '1x (Standard)';

    if (report.riskScore >= 0.70) {
      // Severe bot / stealth browser detected
      difficulty = 6; // 6 leading zeros: 16^2 = 256x harder
      action = 'ESCALATE_SEVERE_BOT_TAX';
      cpuMultiplier = '256x CPU penalty (Bot Farm Burn)';
    } else if (report.riskScore >= 0.35) {
      // Moderate suspicion
      difficulty = 5; // 5 leading zeros: 16x harder
      action = 'ESCALATE_MODERATE_BOT_TAX';
      cpuMultiplier = '16x CPU penalty';
    }

    const challenge = ghostPow.generateChallenge(difficulty, siteKey);

    return {
      allowed: true,
      action,
      riskScore: report.riskScore,
      forensics: report,
      cpuTaxApplied: cpuMultiplier,
      challenge
    };
  }

  /**
   * Calculate trajectory angle entropy from sequence of 2D coordinates.
   * Completely hardened against null, undefined, NaN, or corrupted points.
   * Note: Perfectly linear robotic trajectories have Shannon entropy = 0.0 (maximum determinism).
   */
  _calculateMouseEntropy(rawPoints) {
    if (!Array.isArray(rawPoints)) return { valid: false, entropy: 0 };

    // Filter strictly valid coordinate objects
    const points = rawPoints.filter(p => (
      p !== null &&
      typeof p === 'object' &&
      typeof p.x === 'number' &&
      typeof p.y === 'number' &&
      !isNaN(p.x) &&
      !isNaN(p.y) &&
      isFinite(p.x) &&
      isFinite(p.y)
    ));

    if (points.length < 6) return { valid: false, entropy: 0 };

    const angleChanges = [];
    for (let i = 2; i < points.length; i++) {
      const p0 = points[i - 2];
      const p1 = points[i - 1];
      const p2 = points[i];

      const v1 = { x: p1.x - p0.x, y: p1.y - p0.y };
      const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };

      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag1 = Math.hypot(v1.x, v1.y);
      const mag2 = Math.hypot(v2.x, v2.y);

      // Prevent division by zero if mouse paused on identical pixel
      if (mag1 > 0.001 && mag2 > 0.001) {
        const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
        angleChanges.push(Math.round(Math.acos(cosAngle) * 8));
      }
    }

    if (angleChanges.length === 0) return { valid: false, entropy: 0 };

    const freq = {};
    for (const a of angleChanges) freq[a] = (freq[a] || 0) + 1;

    let entropy = 0;
    const total = angleChanges.length;
    for (const k in freq) {
      const p = freq[k] / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }
    return { valid: true, entropy };
  }
}

module.exports = new IntegrityRuntimePro();
