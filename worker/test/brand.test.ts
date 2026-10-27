// @ts-nocheck
// brand/brand.json feeds the press (press/facts.py gates every price and limit in social copy). It must say exactly
// what plans.ts sells, or the mesh would advertise numbers the product does not honour.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS } from "../src/plans";

const brand = JSON.parse(readFileSync(join(__dirname, "..", "..", "brand", "brand.json"), "utf8"));
const n = (s: string) => Number(s.replace(/,/g, ""));

describe("brand.json mirrors plans.ts", () => {
  it("prices, verification limits, site counts and agent checks match", () => {
    for (const c of brand.catalog) {
      const p = PLANS[c.key];
      expect(p, c.key).toBeTruthy();
      expect(c.price).toBe(p.price === 0 ? "$0" : `$${p.price}/mo`);
      const b = c.bullets.join(" | ");
      expect(n(b.match(/([\d,]+) verifications a month/)?.[1] ?? String(p.verifications))).toBe(p.verifications);
      expect(Number(b.match(/(\d+) sites?\b/)?.[1] ?? p.sites)).toBe(p.sites);
      const ac = b.match(/([\d,]+) agent checks a month/);
      if (ac) expect(n(ac[1])).toBe(p.agentChecks);
    }
    expect(brand.catalog.map((c) => c.key).sort()).toEqual(Object.keys(PLANS).sort());
  });
});
