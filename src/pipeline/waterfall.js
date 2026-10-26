/**
 * AttestOS - Production Master Waterfall Pipeline Orchestrator
 * 
 * Chains the three pivots in strict priority order:
 * 1. Pivot C: Agentic Gateway (Proof-of-Intent & Micro-Billing)
 * 2. Pivot B: Hardware Attestation (Silent Secure Enclave / Passkeys)
 * 3. Pivot A: Compute Integrity & Proof-of-Work (CDP Unmasking & Dynamic Hash Tax)
 * 
 * Production Features:
 * - Sub-millisecond pipeline latency tracking
 * - Fail-secure / fail-open policy configuration
 * - Complete forensic decision tracing
 * - Unified Whop license resolution
 * - Brand: AttestOS
 */

const ghostPow = require('../pivot-a-compute/ghost-pow-free');
const integrityRuntime = require('../pivot-a-compute/integrity-runtime-pro');
const attestKit = require('../pivot-b-hardware/attestkit-free');
const hardwareGateway = require('../pivot-b-hardware/hardware-gateway-pro');
const robotsAi = require('../pivot-c-agentic/robots-ai-free');
const agentPass = require('../pivot-c-agentic/agentpass-pro');
const whopGate = require('../monetization/whop-gate');
const tenantManager = require('../autonomous/tenant-manager');
const autoTuner = require('../autonomous/auto-tuner');
const config = require('../config');

class WaterfallPipeline {
  /**
   * Process and evaluate an incoming request through the complete Tri-Factor Pipeline
   */
  async evaluateRequest(ctx = {}) {
    const startTime = process.hrtime.bigint();

    const safeCtx = (ctx && typeof ctx === 'object') ? ctx : {};

    let {
      headers = {},
      url = '/',
      method = 'POST',
      whopLicenseKey = null,
      siteKey = 'default_site',
      clientTelemetry = null,
      hardwareToken = null,
      webAuthnAssertion = null,
      powSolution = null
    } = safeCtx;

    // Safely auto-parse payloads if passed as serialized JSON strings
    if (typeof clientTelemetry === 'string') {
      try { clientTelemetry = JSON.parse(clientTelemetry); } catch (e) { clientTelemetry = null; }
    }
    if (typeof hardwareToken === 'string') {
      try { hardwareToken = JSON.parse(hardwareToken); } catch (e) { hardwareToken = null; }
    }
    if (typeof webAuthnAssertion === 'string') {
      try { webAuthnAssertion = JSON.parse(webAuthnAssertion); } catch (e) { webAuthnAssertion = null; }
    }
    if (typeof powSolution === 'string') {
      try { powSolution = JSON.parse(powSolution); } catch (e) { powSolution = null; }
    }

    const auditTrace = {
      brand: config.BRAND,
      version: config.VERSION,
      timestamp: new Date().toISOString(),
      url,
      method,
      siteKey,
      decision: 'PENDING',
      executedPillars: []
    };

    // ─────────────────────────────────────────────────────────────
    // STEP 1: PIVOT C (Agentic Web Gateway / Proof-of-Intent)
    // ─────────────────────────────────────────────────────────────
    const agentCheck = robotsAi.inspectAgentRequest(headers);
    if (agentCheck.isAgent) {
      auditTrace.executedPillars.push('PIVOT_C_AGENTIC');

      // Check if site operator has AgentPass Pro active on Whop
      const licenseStatus = await whopGate.validateLicense(whopLicenseKey);
      const hasAgentPass = licenseStatus.features.includes('agentpass_pro');

      if (hasAgentPass) {
        const clearing = await agentPass.processAgentRequest(headers, url, whopLicenseKey);
        auditTrace.latencyMs = this._calcDurationMs(startTime);

        if (clearing.cleared) {
          tenantManager.recordEvent(siteKey, 'AGENT_PAID');
          auditTrace.decision = 'ADMIT_MONETIZED_AI_AGENT';
          return {
            admitted: true,
            statusCode: 200,
            pillar: 'PIVOT_C_AGENTPASS_PRO',
            trace: auditTrace,
            response: clearing
          };
        } else if (clearing.statusCode === 402) {
          tenantManager.recordEvent(siteKey, 'AGENT_SERVED');
          auditTrace.decision = 'PAYMENT_REQUIRED_402';
          return {
            admitted: false,
            statusCode: 402,
            pillar: 'PIVOT_C_AGENTPASS_PRO',
            trace: auditTrace,
            headers: clearing.headers,
            response: clearing
          };
        }
      }

      // Fallback: Open robots.ai free policy
      auditTrace.latencyMs = this._calcDurationMs(startTime);
      if (!agentCheck.allow) {
        auditTrace.decision = 'BLOCK_UNAUTHORIZED_SCRAPER';
        return {
          admitted: false,
          statusCode: 403,
          pillar: 'PIVOT_C_ROBOTS_AI_FREE',
          trace: auditTrace,
          error: 'Autonomous scraper blocked per robots.ai open policy'
        };
      } else {
        tenantManager.recordEvent(siteKey, 'AGENT_SERVED', { savedBytes: 520000 });
        auditTrace.decision = 'ADMIT_SEARCH_AGENT_MARKDOWN';
        return {
          admitted: true,
          statusCode: 200,
          pillar: 'PIVOT_C_ROBOTS_AI_FREE',
          trace: auditTrace,
          format: 'text/markdown',
          notice: 'Served clean markdown to authorized search crawler (95% bandwidth saved)'
        };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 2: PIVOT B (Hardware Attestation & Secure Enclaves)
    // ─────────────────────────────────────────────────────────────
    // Check A: RFC 9505 Private Access Token (Apple PAT / Android Titan)
    if (hardwareToken) {
      auditTrace.executedPillars.push('PIVOT_B_HARDWARE_PAT');
      const patResult = await hardwareGateway.verifyHardwareToken(hardwareToken, whopLicenseKey);

      if (patResult.verified) {
        tenantManager.recordEvent(siteKey, 'SILENT_HUMAN_PASS');
        auditTrace.latencyMs = this._calcDurationMs(startTime);
        auditTrace.decision = 'ADMIT_SILENT_SECURE_ENCLAVE';
        return {
          admitted: true,
          statusCode: 200,
          pillar: 'PIVOT_B_HARDWARE_GATEWAY_PRO',
          trace: auditTrace,
          details: patResult,
          friction: '0ms (Completely Invisible)'
        };
      }
    }

    // Check B: Silent WebAuthn Passkey (AttestKit Free)
    if (webAuthnAssertion) {
      auditTrace.executedPillars.push('PIVOT_B_ATTESTKIT_WEBAUTHN');
      const webAuthnResult = attestKit.verifyAssertion(webAuthnAssertion);

      if (webAuthnResult.verified) {
        tenantManager.recordEvent(siteKey, 'SILENT_HUMAN_PASS');
        auditTrace.latencyMs = this._calcDurationMs(startTime);
        auditTrace.decision = 'ADMIT_SILENT_WEBAUTHN';
        return {
          admitted: true,
          statusCode: 200,
          pillar: 'PIVOT_B_ATTESTKIT_FREE',
          trace: auditTrace,
          details: webAuthnResult,
          friction: '<15ms (Silent Platform Authenticator)'
        };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 3: PIVOT A (Compute Integrity & Proof-of-Work)
    // ─────────────────────────────────────────────────────────────
    auditTrace.executedPillars.push('PIVOT_A_COMPUTE_INTEGRITY');

    // Case A: Client submitted solved mathematical hash
    if (powSolution) {
      const powResult = ghostPow.verifySolution(powSolution);
      auditTrace.latencyMs = this._calcDurationMs(startTime);

      if (powResult.success) {
        tenantManager.recordEvent(siteKey, 'SILENT_HUMAN_PASS');
        autoTuner.processTrafficSignal(siteKey, false);
        auditTrace.decision = 'ADMIT_COMPUTE_POW_VERIFIED';
        return {
          admitted: true,
          statusCode: 200,
          pillar: 'PIVOT_A_GHOST_POW_FREE',
          trace: auditTrace,
          details: powResult,
          friction: 'Background client compute (<300ms)'
        };
      } else {
        autoTuner.processTrafficSignal(siteKey, true);
        auditTrace.decision = 'REJECT_INVALID_POW_SOLUTION';
        return {
          admitted: false,
          statusCode: 400,
          pillar: 'PIVOT_A_GHOST_POW_FREE',
          trace: auditTrace,
          error: powResult.reason
        };
      }
    }

    // Case B: No token present yet -> Run CDP analysis & issue challenge
    const licenseStatus = await whopGate.validateLicense(whopLicenseKey);
    const hasIntegrityPro = licenseStatus.features.includes('integrity_runtime_pro');

    auditTrace.latencyMs = this._calcDurationMs(startTime);

    if (hasIntegrityPro && clientTelemetry) {
      const analysis = await integrityRuntime.analyzeClientEnvironment(clientTelemetry, whopLicenseKey, siteKey);
      if (analysis.forensics && analysis.forensics.riskScore >= 0.35) {
        tenantManager.recordEvent(siteKey, 'BOT_TAXED', { multiplier: analysis.action === 'ESCALATE_SEVERE_BOT_TAX' ? 256 : 16 });
        autoTuner.processTrafficSignal(siteKey, true);
      }
      auditTrace.decision = 'CHALLENGE_ISSUED_DYNAMIC_INTEGRITY';
      return {
        admitted: false,
        statusCode: 428, // Precondition Required
        pillar: 'PIVOT_A_INTEGRITY_RUNTIME_PRO',
        trace: auditTrace,
        challenge: analysis.challenge,
        forensicAnalysis: analysis
      };
    }

    // Case C: Standard Baseline: Ghost-PoW Free Challenge (Stateless $0 server cost)
    const baseChallenge = ghostPow.generateChallenge(null, siteKey);
    auditTrace.decision = 'CHALLENGE_ISSUED_BASE_GHOST_POW';
    return {
      admitted: false,
      statusCode: 428,
      pillar: 'PIVOT_A_GHOST_POW_FREE',
      trace: auditTrace,
      challenge: baseChallenge,
      notice: 'Compute client-side hash to proceed (Zero-cost for host server)'
    };
  }

  _calcDurationMs(startNs) {
    const diff = process.hrtime.bigint() - startNs;
    return parseFloat((Number(diff) / 1e6).toFixed(3));
  }
}

module.exports = new WaterfallPipeline();
