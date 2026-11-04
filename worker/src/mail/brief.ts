// The day-7 attachment (owner 2026-11-04): a swap guide made for this page. What we saw is only what the public
// scan recorded (the page and the challenge it loads); the code is the documented integration, nothing more.
import type { Env } from "../env";
import { first } from "../lib/db";
import { VENDORS } from "../scanner";
import { makePdf } from "./pdf";

export interface Attachment { filename: string; content: Uint8Array; type?: string }
type Section = { heading?: string; paras?: string[]; bullets?: string[]; code?: string[] };
const ACTION: Record<string, string> = { signup: "sign up", login: "log in", contact: "contact you" };

export function swapGuide(env: Env, p: { domain: string; page_url: string; vendor: string; page_kind: string | null }, postal = ""): Attachment {
  const v = VENDORS.find((x) => x.id === p.vendor)?.name ?? p.vendor;
  const page = p.page_kind && p.page_kind !== "home" && p.page_kind !== "other" ? `${p.page_kind} page` : "homepage";
  const action = ACTION[p.page_kind || ""] ?? "get through";
  const edge = env.SITE_URL.replace(/\/$/, "");
  const sections: Section[] = [
    { heading: "What the public scan saw", bullets: [`Page: ${p.page_url}`, `Challenge loaded: ${v}`, `Every real visitor has to clear it before they can ${action}.`] },
    { heading: "What that costs", paras: [
      `Each puzzle loses some of the people who were ready to ${action}: the ones on a phone, in a hurry, or on a weak connection. They rarely complain; they just leave. Meanwhile many bots get through anyway with paid solving services, so the people paying for the protection are mostly your real visitors.`,
    ] },
    { heading: "How AttestOS does the same job", paras: [
      "A small proof-of-work check runs quietly in the visitor's browser while they fill in the form. Your server verifies the token with one call shaped like reCAPTCHA's siteverify. Nobody is asked to pick out traffic lights.",
    ] },
    { heading: `Step 1: on the ${page}`, paras: ["Replace the challenge's script and widget with these two lines:"],
      code: [`<script src="${edge}/v1/attestos.js" async defer></script>`, `<div class="attestos" data-sitekey="ao_site_..."></div>`] },
    { heading: "Step 2: on your server", paras: ["Verify the token the form posts (field attestos-response). Node / Express shown; PHP and Python are in the docs."],
      code: [
        `const v = await fetch("${edge}/api/siteverify", {`,
        `  method: "POST", headers: { "content-type": "application/json" },`,
        `  body: JSON.stringify({ secret: process.env.ATTESTOS_SECRET,`,
        `                         response: req.body["attestos-response"] }),`,
        `}).then((r) => r.json());`,
        `if (!v.success) return res.status(400).send("Please try again");`,
      ] },
    { heading: "Try it in ten minutes", bullets: [
      `Create a free site key: ${edge}/app/#signup (10,000 verifications a month, no card).`,
      "Put it on a staging copy of the page, submit the form once, and watch the token verify.",
      `Full docs, including single-page apps: ${edge}/docs/`,
      `Your scan, live: ${edge}/scanner/?url=${encodeURIComponent(p.page_url)}`,
    ] },
  ];
  const content = (makePdf as (o: unknown) => Uint8Array)({
    title: `${p.domain}: swapping ${v} for a check nobody sees`,
    subtitle: `A two-step guide made for the ${page} on ${p.domain}.`,
    accent: "#3b2db3",
    sections,
    footer: `AttestOS${postal ? " - " + postal : ""}`,
  });
  return { filename: `${p.domain.replace(/[^a-z0-9.-]+/gi, "-")}-attestos-swap-guide.pdf`, content, type: "application/pdf" };
}

/** Outbox hook: only the day-7 follow-up carries the guide. */
export async function attachmentsFor(env: Env, row: { kind: string; ref?: string | null }): Promise<Attachment[]> {
  if (row.kind !== "follow" || !row.ref) return [];
  const p = await first<{ domain: string; page_url: string; vendor: string; page_kind: string | null }>(env, "SELECT domain, page_url, vendor, page_kind FROM prospects WHERE domain = ?", row.ref);
  return p ? [swapGuide(env, p, String(env.POSTAL_ADDRESS || ""))] : [];
}
