/**
 * AttestOS - Production Whop Monetization & Entitlements Engine
 * 
 * Handles:
 * - Real-time Whop API v2 License & Membership verification
 * - Secure Webhook verification via HMAC-SHA256 (timing-safe)
 * - Sub-millisecond in-memory cache with automatic eviction
 * - Dynamic Whop hosted checkout URL routing
 * - Free-tier usage tracking and overage triggers
 */

const https = require('https');
const crypto = require('crypto');
const config = require('../config');

class WhopGate {
  constructor() {
    this.apiKey = config.WHOP.API_KEY;
    this.webhookSecret = config.WHOP.WEBHOOK_SECRET;
    this.licenseCache = new Map();
    this.usageTracker = new Map();
    this.cacheTtlMs = 300000; // 5 minutes

    // Clean up stale cache entries periodically
    setInterval(() => this._cleanupStaleCache(), 60000).unref();
  }

  /**
   * Validate a Whop license key or membership ID
   */
  async validateLicense(licenseKey) {
    if (!licenseKey || typeof licenseKey !== 'string') {
      return this._resolveTier('free');
    }

    const trimmedKey = licenseKey.trim();
    if (!trimmedKey) {
      return this._resolveTier('free');
    }

    // Check fast cache
    const cached = this.licenseCache.get(trimmedKey);
    if (cached && (Date.now() - cached.timestamp < this.cacheTtlMs)) {
      return cached.data;
    }

    // Support deterministic testing / demo keys
    if (trimmedKey.startsWith('whop_demo_')) {
      const demoResult = this._resolveDemoKey(trimmedKey);
      this.licenseCache.set(trimmedKey, { timestamp: Date.now(), data: demoResult });
      return demoResult;
    }

    // In production: Query Whop API v2
    try {
      const whopResponse = await this._queryWhopApi(`/memberships/${encodeURIComponent(trimmedKey)}`);
      
      const isActive = whopResponse && (
        whopResponse.valid === true ||
        whopResponse.status === 'active' ||
        whopResponse.status === 'completed'
      );

      const planId = whopResponse ? (whopResponse.plan_id || (whopResponse.plan && whopResponse.plan.id)) : null;
      const tierId = isActive ? this._mapPlanIdToTier(planId) : 'free';
      const resolved = this._resolveTier(tierId, {
        licenseKey: trimmedKey,
        expiresAt: whopResponse ? whopResponse.expires_at : null,
        email: whopResponse ? whopResponse.email : null,
        membershipId: whopResponse ? whopResponse.id : null
      });

      this.licenseCache.set(trimmedKey, { timestamp: Date.now(), data: resolved });
      return resolved;
    } catch (err) {
      // If Whop API is unreachable, fallback to cached data if available, else free tier
      if (cached) {
        return cached.data;
      }
      return this._resolveTier('free', { error: `Whop check unavailable: ${err.message}` });
    }
  }

  /**
   * Enforce a required feature for an operation.
   * If not granted, returns HTTP 403 response with direct Whop hosted checkout URL.
   */
  async enforceFeature(featureName, licenseKey) {
    const status = await this.validateLicense(licenseKey);
    const hasFeature = status.features && status.features.includes(featureName);

    if (!hasFeature) {
      const upgrade = this._getUpgradeDetails(featureName);
      return {
        allowed: false,
        statusCode: 403,
        error: `Feature '${featureName}' requires an active ${upgrade.planName} subscription on Whop.`,
        requiredPlan: upgrade.planId,
        checkoutUrl: upgrade.checkoutUrl,
        brand: config.BRAND
      };
    }

    return { allowed: true, status };
  }

  /**
   * Track free-tier usage (e.g. AttestKit 25,000 monthly free hardware tokens)
   */
  trackUsage(siteKey, feature) {
    const key = `${siteKey}:${feature}`;
    const count = (this.usageTracker.get(key) || 0) + 1;
    this.usageTracker.set(key, count);

    const limit = config.TIERS.FREE.attestkit.monthly_limit;
    if (feature === 'attestkit_free' && count > limit) {
      return {
        exceeded: true,
        count,
        limit,
        upgradeUrl: config.WHOP.CHECKOUT_URLS.HARDWARE_PRO
      };
    }

    return { exceeded: false, count, limit };
  }

  /**
   * Process Whop Webhook notifications
   */
  handleWebhook(rawBody, signatureHeader) {
    // Timing-safe HMAC signature verification
    if (this.webhookSecret && this.webhookSecret !== 'whop_webhook_secret_placeholder') {
      if (!signatureHeader) {
        throw new Error('Missing Whop webhook signature header');
      }
      const hmac = crypto.createHmac('sha256', this.webhookSecret);
      const computed = hmac.update(rawBody).digest('hex');
      
      const computedBuf = Buffer.from(computed, 'utf8');
      const sigBuf = Buffer.from(signatureHeader, 'utf8');

      if (computedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(computedBuf, sigBuf)) {
        throw new Error('Invalid Whop webhook signature (timing-safe check failed)');
      }
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const action = payload.action;
    const data = payload.data || {};
    const licenseKey = data.license_key || data.id;

    if (licenseKey) {
      if (action === 'membership.went_valid' || action === 'payment.succeeded') {
        // Evict cached status so fresh entitlements fetch on next call
        this.licenseCache.delete(licenseKey);
      } else if (action === 'membership.went_invalid' || action === 'membership.canceled') {
        this.licenseCache.set(licenseKey, {
          timestamp: Date.now(),
          data: this._resolveTier('free')
        });
      }
    }

    return { success: true, action, processedAt: new Date().toISOString() };
  }

  _resolveTier(tierId, extra = {}) {
    const tierDef = config.TIERS[tierId.toUpperCase()] || config.TIERS.FREE;
    return {
      valid: tierId !== 'free',
      tier: tierDef.id,
      name: tierDef.name,
      features: [...tierDef.features],
      checkoutUrl: config.WHOP.CHECKOUT_URLS.ENTERPRISE_MESH,
      ...extra
    };
  }

  _resolveDemoKey(key) {
    switch (key) {
      case 'whop_demo_integrity_pro':
        return this._resolveTier('integrity_pro');
      case 'whop_demo_hardware_pro':
        return this._resolveTier('hardware_pro');
      case 'whop_demo_agentpass_pro':
        return this._resolveTier('agentpass_pro');
      case 'whop_demo_enterprise':
        return this._resolveTier('enterprise');
      default:
        return this._resolveTier('free');
    }
  }

  _mapPlanIdToTier(planId) {
    if (planId === config.WHOP.PLAN_IDS.INTEGRITY_PRO) return 'integrity_pro';
    if (planId === config.WHOP.PLAN_IDS.HARDWARE_PRO) return 'hardware_pro';
    if (planId === config.WHOP.PLAN_IDS.AGENTPASS_PRO) return 'agentpass_pro';
    if (planId === config.WHOP.PLAN_IDS.ENTERPRISE_MESH) return 'enterprise';
    return 'free';
  }

  _getUpgradeDetails(feature) {
    if (feature === 'integrity_runtime_pro') {
      return {
        planName: 'IntegrityRuntime Pro',
        planId: config.WHOP.PLAN_IDS.INTEGRITY_PRO,
        checkoutUrl: config.WHOP.CHECKOUT_URLS.INTEGRITY_PRO
      };
    }
    if (feature === 'hardware_gateway_pro') {
      return {
        planName: 'Hardware Gateway Pro',
        planId: config.WHOP.PLAN_IDS.HARDWARE_PRO,
        checkoutUrl: config.WHOP.CHECKOUT_URLS.HARDWARE_PRO
      };
    }
    if (feature === 'agentpass_pro') {
      return {
        planName: 'AgentPass Clearinghouse Pro',
        planId: config.WHOP.PLAN_IDS.AGENTPASS_PRO,
        checkoutUrl: config.WHOP.CHECKOUT_URLS.AGENTPASS_PRO
      };
    }
    return {
      planName: 'AttestOS Enterprise Mesh',
      planId: config.WHOP.PLAN_IDS.ENTERPRISE_MESH,
      checkoutUrl: config.WHOP.CHECKOUT_URLS.ENTERPRISE_MESH
    };
  }

  _cleanupStaleCache() {
    const now = Date.now();
    for (const [key, value] of this.licenseCache.entries()) {
      if (now - value.timestamp > this.cacheTtlMs * 2) {
        this.licenseCache.delete(key);
      }
    }
  }

  _queryWhopApi(endpoint) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.whop.com',
        path: `/api/v2${endpoint}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'User-Agent': `${config.BRAND}-Production-Node/${config.VERSION}`
        },
        timeout: 3000
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error(`Whop API HTTP ${res.statusCode}: ${raw}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Whop API request timed out'));
      });
      req.end();
    });
  }
}

module.exports = new WhopGate();
