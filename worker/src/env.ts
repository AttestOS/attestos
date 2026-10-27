export interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  EDGE_RL?: RateLimit;     // per-IP flood guard for public APIs (in-memory, free)
  LOGIN_RL?: RateLimit;    // owner + customer login attempts
  SCAN_RL?: RateLimit;     // public scanner

  // vars
  SITE_URL: string;
  BRAND: string;
  OWNER_NAME?: string;
  OWNER_EMAIL?: string;
  POSTAL_ADDRESS?: string;               // required (CAN-SPAM) before cold outreach can send
  MAILBOXES?: string;                    // JSON lanes, secrets MAILBOX_<ID>_USER / _PASS
  OUTREACH_DAILY_CAP?: string;
  WHOP_PLAN_MAP?: string;                // {"plan_xxx":"integrity", ...}
  WHOP_STORE_URL?: string;
  WHOP_CHECKOUT_INTEGRITY?: string;
  WHOP_CHECKOUT_HARDWARE?: string;
  WHOP_CHECKOUT_AGENT?: string;
  WHOP_CHECKOUT_ENTERPRISE?: string;
  D1_WRITE_BUDGET?: string;              // AttestOS's own daily share (default 20,000 = 20% of 100k)
  D1_READ_BUDGET?: string;               // default 1,000,000 (20% of 5M)
  PAT_ISSUERS?: string;                  // JSON [{"name":"pat-issuer.cloudflare.com"}]
  DEMO_SITEKEY?: string;                 // the landing-page demo's public site key
  DEV_MODE?: string;

  // secrets
  APP_SECRET: string;
  OWNER_PASSWORD_HASH?: string;
  WHOP_WEBHOOK_SECRET?: string;
  AO_OPS_TOKEN?: string;                 // prospects workflow → /api/ops/*
  AO_PRESS_TOKEN?: string;               // distribution mesh → /api/press/*
  NTFY_TOPIC?: string;
  DEMO_SECRET?: string;                  // secret key of the demo site (used by /api/v1/demo/verify)
  [key: string]: unknown;
}
