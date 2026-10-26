/**
 * AttestOS - Production Configuration
 * 
 * Brand: AttestOS
 * Architecture: Tri-Factor Waterfall Pipeline (Agentic C -> Hardware B -> Compute A)
 * Monetization & Checkout: Whop API & Hosted Checkout Pages
 * Budget: $0 Operating Cost (Pure Standard Library, Stateless Verification)
 */

const crypto = require('crypto');

module.exports = {
  // Service Identity
  BRAND: 'AttestOS',
  VERSION: '2.0.0-production',
  PORT: parseInt(process.env.PORT, 10) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'production',

  // Cryptographic Secrets for Stateless Zero-Cost Verification
  // In production, set ATTESTOS_HMAC_SECRET in your environment
  HMAC_SECRET: process.env.ATTESTOS_HMAC_SECRET || 'attestos_prod_hmac_secret_5f8a92b3c4d1e6',
  JWT_SECRET: process.env.ATTESTOS_JWT_SECRET || 'attestos_prod_jwt_secret_99a8b7c6d5e4f3',

  // Challenge Time-To-Live & Replay Window (Milliseconds)
  CHALLENGE_TTL_MS: 120000, // 2 minutes challenge validity
  REPLAY_WINDOW_MS: 300000, // 5 minutes duplicate nonce cache

  // Security Policy
  SECURITY: {
    FAIL_MODE: process.env.ATTESTOS_FAIL_MODE || 'fail_open_with_telemetry', // 'fail_open_with_telemetry' or 'fail_closed'
    ENABLE_CORS: true,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'],
    MAX_REQUEST_BODY_SIZE_BYTES: 1048576, // 1 MB max payload
  },

  // Whop Monetization & Checkout Gateway Configuration
  WHOP: {
    API_URL: 'https://api.whop.com/api/v2',
    API_KEY: process.env.WHOP_API_KEY || 'whop_live_api_key_placeholder',
    WEBHOOK_SECRET: process.env.WHOP_WEBHOOK_SECRET || 'whop_webhook_secret_placeholder',
    COMPANY_ID: process.env.WHOP_COMPANY_ID || 'biz_attestos_global',

    // Whop Hosted Checkout Links (0 frontend billing code needed)
    CHECKOUT_URLS: {
      INTEGRITY_PRO: process.env.WHOP_CHECKOUT_INTEGRITY || 'https://whop.com/checkout/plan_integrity_pro',
      HARDWARE_PRO: process.env.WHOP_CHECKOUT_HARDWARE || 'https://whop.com/checkout/plan_hardware_pro',
      AGENTPASS_PRO: process.env.WHOP_CHECKOUT_AGENTPASS || 'https://whop.com/checkout/plan_agentpass_pro',
      ENTERPRISE_MESH: process.env.WHOP_CHECKOUT_ENTERPRISE || 'https://whop.com/checkout/plan_attestos_enterprise'
    },

    // Whop Plan Identifiers
    PLAN_IDS: {
      INTEGRITY_PRO: 'plan_integrity_pro_monthly',
      HARDWARE_PRO: 'plan_hardware_pro_monthly',
      AGENTPASS_PRO: 'plan_agentpass_pro_monthly',
      ENTERPRISE_MESH: 'plan_attestos_enterprise_mesh'
    }
  },

  // Tiers and Features Matrix
  TIERS: {
    FREE: {
      id: 'free',
      name: 'AttestOS Free Community',
      features: ['ghost_pow_free', 'attestkit_free', 'robots_ai_free'],
      ghost_pow: {
        max_difficulty: 4,
        allow_custom_salt: true
      },
      attestkit: {
        monthly_limit: 25000,
        upgrade_plan: 'plan_hardware_pro'
      },
      robots_ai: {
        format_support: ['text/markdown', 'application/json'],
        unmonetized_clearing: true
      }
    },
    INTEGRITY_PRO: {
      id: 'integrity_pro',
      name: 'AttestOS IntegrityRuntime Pro',
      price: '$39/month on Whop',
      features: ['ghost_pow_free', 'integrity_runtime_pro'],
      anti_cdp: true,
      anti_stealth: true,
      dynamic_difficulty_max: 7 // Up to 4096x bot CPU penalty
    },
    HARDWARE_PRO: {
      id: 'hardware_pro',
      name: 'AttestOS Hardware Gateway Pro',
      price: '$0.002/attestation on Whop',
      features: ['ghost_pow_free', 'attestkit_free', 'hardware_gateway_pro'],
      unlimited_hardware_checks: true,
      rfc9505_pat_support: true,
      apple_secure_enclave: true,
      android_titan_m2: true
    },
    AGENTPASS_PRO: {
      id: 'agentpass_pro',
      name: 'AttestOS AgentPass Clearinghouse Pro',
      price: '$0.002/clearance on Whop',
      features: ['ghost_pow_free', 'robots_ai_free', 'agentpass_pro'],
      http_402_gateway: true,
      signed_agent_clearing: true,
      micro_settlement_ledger: true
    },
    ENTERPRISE: {
      id: 'enterprise',
      name: 'AttestOS Enterprise Mesh All-In-One',
      price: '$299/month on Whop',
      features: [
        'ghost_pow_free',
        'integrity_runtime_pro',
        'attestkit_free',
        'hardware_gateway_pro',
        'robots_ai_free',
        'agentpass_pro'
      ]
    }
  }
};
