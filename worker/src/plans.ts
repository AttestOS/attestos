/** Plans, prices and limits: the single source of truth for the API, the portal and the public pricing page
 *  (GET /api/v1/plans). Prices are monthly, charged on Whop. */

export type PlanId = "free" | "integrity" | "hardware" | "agent" | "enterprise";
export type Feature = "pow" | "robots" | "passkeys" | "signals" | "adaptive" | "alerts" | "pat" | "agentpass" | "export";

export interface PlanDef {
  id: PlanId;
  name: string;
  price: number;              // USD / month
  verifications: number;      // siteverify calls per month (all sites together)
  sites: number;
  domainsPerSite: number;
  passkeys: number;           // registered passkeys per site
  agentChecks: number;        // AgentPass checks per month
  features: Feature[];
  blurb: string;
}

export const PLANS: Record<PlanId, PlanDef> = {
  free: {
    id: "free", name: "Free", price: 0, verifications: 10_000, sites: 1, domainsPerSite: 3, passkeys: 50, agentChecks: 0,
    features: ["pow", "robots", "passkeys"],
    blurb: "Ghost-PoW widget + server-side verify, AI-crawler policy, passkeys for up to 50 users.",
  },
  integrity: {
    id: "integrity", name: "IntegrityRuntime Pro", price: 49, verifications: 100_000, sites: 5, domainsPerSite: 10, passkeys: 500, agentChecks: 0,
    features: ["pow", "robots", "passkeys", "signals", "adaptive", "alerts", "export"],
    blurb: "Automation signals and a risk score in every verify response, adaptive difficulty, surge alerts, audit export.",
  },
  hardware: {
    id: "hardware", name: "Hardware Gateway Pro", price: 149, verifications: 100_000, sites: 5, domainsPerSite: 10, passkeys: 1_000_000, agentChecks: 0,
    features: ["pow", "robots", "passkeys", "pat", "export"],
    blurb: "Privacy Pass / Private Access Tokens (Apple devices pass without solving), unlimited passkeys.",
  },
  agent: {
    id: "agent", name: "AgentPass Pro", price: 99, verifications: 100_000, sites: 5, domainsPerSite: 10, passkeys: 500, agentChecks: 250_000,
    features: ["pow", "robots", "passkeys", "agentpass", "export"],
    blurb: "Per-crawler allow / charge (HTTP 402) / block decisions, verified-crawler checks, metered agent keys you sell.",
  },
  enterprise: {
    id: "enterprise", name: "Enterprise (all modules)", price: 299, verifications: 300_000, sites: 25, domainsPerSite: 25, passkeys: 1_000_000, agentChecks: 1_000_000,
    features: ["pow", "robots", "passkeys", "signals", "adaptive", "alerts", "pat", "agentpass", "export"],
    blurb: "Everything above with the highest limits.",
  },
};

export const PAID: PlanId[] = ["integrity", "hardware", "agent", "enterprise"];

export function parsePlans(s: string | null | undefined): PlanId[] {
  const out = String(s || "").split(",").map((x) => x.trim()).filter((x): x is PlanId => x in PLANS && x !== "free");
  return out.length ? [...new Set(out)] : ["free"];
}

/** Effective entitlements of an account holding one or more plans: union of features, max of limits. */
export function entitlements(plans: PlanId[]) {
  const defs = (plans.length ? plans : ["free" as PlanId]).map((p) => PLANS[p] ?? PLANS.free);
  const max = (k: keyof Pick<PlanDef, "verifications" | "sites" | "domainsPerSite" | "passkeys" | "agentChecks">) => Math.max(...defs.map((d) => d[k]));
  return {
    plans: defs.map((d) => d.id),
    features: [...new Set(defs.flatMap((d) => d.features))] as Feature[],
    verifications: max("verifications"),
    sites: max("sites"),
    domainsPerSite: max("domainsPerSite"),
    passkeys: max("passkeys"),
    agentChecks: max("agentChecks"),
  };
}
export type Entitlements = ReturnType<typeof entitlements>;
export const has = (e: Entitlements, f: Feature) => e.features.includes(f);
