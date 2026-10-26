/**
 * AttestOS - Autonomous Tenant & Key Provisioning Engine
 * 
 * Operates 100% on autopilot without human operator intervention.
 * Customers are self-served:
 * 1. Instant SiteKey & Secret Generation (0 approval latency)
 * 2. Automatic Binding to Whop Memberships via Webhooks
 * 3. Customer-in-the-Loop Policy Customization
 * 4. Persistent JSON storage with in-memory caching
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'tenants.json');

class TenantManager {
  constructor() {
    this.tenants = new Map();
    this._loadStorage();
  }

  _loadStorage() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        const data = JSON.parse(raw);
        for (const [key, val] of Object.entries(data)) {
          this.tenants.set(key, val);
        }
      } else {
        // Seed initial default demo tenant
        this.provisionTenant({
          domain: 'localhost',
          email: 'demo@attestos.dev',
          siteKey: 'default_site'
        });
      }
    } catch (e) {
      console.warn('[TenantManager] Error loading storage, starting clean:', e.message);
    }
  }

  _saveStorage() {
    try {
      const obj = {};
      for (const [k, v] of this.tenants.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      console.error('[TenantManager] Storage write failed:', e.message);
    }
  }

  /**
   * Autonomous Self-Serve Onboarding
   * Called by customer directly from web interface.
   */
  provisionTenant({ domain, email, siteKey = null }) {
    const cleanDomain = (domain || 'mysite.com').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    const finalSiteKey = siteKey || `attest_${cleanDomain.replace(/[^a-z0-9]/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;

    if (this.tenants.has(finalSiteKey)) {
      return this.tenants.get(finalSiteKey);
    }

    const tenantRecord = {
      siteKey: finalSiteKey,
      domain: cleanDomain,
      email: email || 'user@' + cleanDomain,
      apiSecret: 'sec_' + crypto.randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
      whopLicenseKey: null,
      tier: 'free',
      
      // Customer-In-The-Loop Configuration
      customerPolicies: {
        securityLevel: 'balanced', // 'frictionless' | 'balanced' | 'strict'
        allowSilentWebAuthn: true,
        basePowDifficulty: 4,
        escalateOnCdp: true,
        agentPolicies: {
          searchCrawlers: 'allow_markdown', // 'allow_markdown' | 'block' | '402_monetize'
          taskAgents: 'require_signed_key', // 'require_signed_key' | 'block' | 'free_allow'
          scrapingBots: 'block_403' // 'block_403' | 'tax_pow' | '402_monetize'
        },
        customPricePerAgentCallUsd: 0.002
      },

      // Daily Addictive Dopamine Analytics
      stats: {
        totalEvaluations: 0,
        silentHumansPassed: 0,
        cdpBotsTaxed: 0,
        botCpuCyclesBurned: 0,
        aiAgentsServed: 0,
        bandwidthSavedBytes: 0,
        potentialAgentRevenueUsd: 0.00,
        settledAgentRevenueUsd: 0.00,
        lastActiveAt: new Date().toISOString()
      }
    };

    this.tenants.set(finalSiteKey, tenantRecord);
    this._saveStorage();
    return tenantRecord;
  }

  /**
   * Get tenant by siteKey
   */
  getTenant(siteKey) {
    if (!siteKey) return null;
    return this.tenants.get(siteKey) || null;
  }

  /**
   * Update Customer-in-the-Loop policies
   */
  updatePolicies(siteKey, newPolicies = {}) {
    const tenant = this.getTenant(siteKey);
    if (!tenant) return { success: false, error: 'Site key not found' };

    tenant.customerPolicies = {
      ...tenant.customerPolicies,
      ...newPolicies,
      agentPolicies: {
        ...tenant.customerPolicies.agentPolicies,
        ...(newPolicies.agentPolicies || {})
      }
    };

    this._saveStorage();
    return { success: true, tenant };
  }

  /**
   * Bind Whop License Key to Tenant automatically
   */
  bindWhopLicense(siteKey, whopLicenseKey, tier = 'enterprise') {
    const tenant = this.getTenant(siteKey);
    if (!tenant) return false;

    tenant.whopLicenseKey = whopLicenseKey;
    tenant.tier = tier;
    this._saveStorage();
    return true;
  }

  /**
   * Increment real-time habit-forming metrics
   */
  recordEvent(siteKey, eventType, metadata = {}) {
    const tenant = this.getTenant(siteKey);
    if (!tenant) return;

    tenant.stats.totalEvaluations++;
    tenant.stats.lastActiveAt = new Date().toISOString();

    if (eventType === 'SILENT_HUMAN_PASS') {
      tenant.stats.silentHumansPassed++;
    } else if (eventType === 'BOT_TAXED') {
      tenant.stats.cdpBotsTaxed++;
      const multiplier = metadata.multiplier || 256;
      tenant.stats.botCpuCyclesBurned += (multiplier * 45000);
    } else if (eventType === 'AGENT_SERVED') {
      tenant.stats.aiAgentsServed++;
      tenant.stats.bandwidthSavedBytes += (metadata.savedBytes || 450000); // ~450KB per heavy SPA avoided
      tenant.stats.potentialAgentRevenueUsd = parseFloat((tenant.stats.potentialAgentRevenueUsd + 0.002).toFixed(4));
    } else if (eventType === 'AGENT_PAID') {
      tenant.stats.settledAgentRevenueUsd = parseFloat((tenant.stats.settledAgentRevenueUsd + 0.002).toFixed(4));
    }

    // Persist asynchronously occasionally
    if (tenant.stats.totalEvaluations % 10 === 0) {
      this._saveStorage();
    }
  }

  /**
   * Generate embed snippet for customer
   */
  getEmbedSnippet(siteKey) {
    return {
      scriptTag: `<script src="https://cdn.attestos.dev/attestos.js" async defer></script>`,
      widgetTag: `<div class="attestos-widget" data-sitekey="${siteKey}"></div>`,
      instructions: `Paste the script tag in your <head> and the widget tag inside any <form> you wish to protect.`
    };
  }
}

module.exports = new TenantManager();
