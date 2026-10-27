"""One-off generator for press/topics.json (AttestOS's 4-audience library). Kept in the repo so
the library can be regenerated or extended in one place; the press reads topics.json only.

Audience keys are shared with the mesh engine (auto.py AUDIENCES); for AttestOS they mean:
  ecom   = online stores (login, account and checkout abuse, card testing)
  saas   = SaaS and app founders (signup and free-trial abuse, API keys)
  sales  = publishers and content sites (AI crawlers, robots.txt, paid crawling)
  agency = agencies and freelance developers who build and run client sites (contact forms)
Prices and limits are {{placeholders}} filled from brand/brand.json; never type a literal price here.
"""
import json
from pathlib import Path

V, L, P = "value", "longform", "promo"
T = []


def add(aud, kind, fmt, tid, title, angle, beats, tags=None, asset=None):
    t = {"id": tid, "kind": kind, "format": fmt, "audience": aud, "title": title, "angle": angle, "beats": beats}
    if tags:
        t["tags"] = tags
    if asset:
        t["asset"] = asset
    T.append(t)


# ---------------- online stores ----------------
E = "ecom"
add(E, V, "short", "card-testing-pattern", "Card testing looks like tiny failed orders",
    "Stolen card lists get checked on small stores first, one cheap order at a time.",
    ["The pattern: many low-value attempts, many declines, new accounts or guest checkouts", "Why the decline fees and chargeback risk land on the store", "Where a check before the payment call adds cost to every attempt"])
add(E, V, "short", "login-stuffing", "Leaked passwords get tried on your login page",
    "Credential stuffing replays username and password pairs leaked elsewhere.",
    ["How to spot it: bursts of failed logins across many accounts from many addresses", "Rate limits per account and per address, not only per address", "Passkeys remove the reusable password entirely"])
add(E, V, "short", "checkout-puzzle-cost", "A puzzle at checkout taxes the buyer who already decided",
    "The person most likely to pay is the one asked to click every traffic light.",
    ["Who actually sees the puzzle: real buyers on phones", "What bots do instead: solving services and replayed tokens", "Moving the check out of sight and onto the server"])
add(E, V, "short", "verify-on-server", "A widget that is never verified on the server is decoration",
    "The token in the form only matters if your backend checks it.",
    ["The common mistake: front-end widget, no server call", "What siteverify checks: secret, token, age, single use", "Reject the request when the call fails, not only when it says no"])
add(E, V, "short", "token-single-use", "Every bot token should work exactly once",
    "If a solved token can be replayed, one solve buys unlimited submissions.",
    ["What replay looks like in the logs", "Single use and a short expiry are the two properties to check", "How to test your own form with one token twice"])
add(E, V, "short", "fake-account-signals", "Fake store accounts leave the same fingerprints",
    "Mass-created accounts share timing, address patterns and empty profiles.",
    ["Sign-up bursts at odd hours", "Disposable email domains and plus-address runs", "Checking the account before it reaches a discount code"])
add(E, V, "short", "headless-browsers", "Headless browsers announce themselves more than they think",
    "Automation frameworks leave traces a page can read without bothering a human.",
    ["webdriver flags and headless user agents", "Software graphics renderers and missing plugins", "Signals are evidence for a score, never a verdict on their own"])
add(E, V, "short", "gift-card-abuse", "Gift card balance checks are a target",
    "A balance-check form is an oracle for anyone holding a list of guessed card numbers.",
    ["Why balance pages get hammered", "Per-session limits and a proof-of-work cost per check", "Alerting on spikes instead of reading logs weekly"])
add(E, V, "longform", "store-abuse-map", "Where bots touch an online store",
    "A walk through every form on a store and the abuse that targets each one, with the cheapest defence for each.",
    ["Account creation: fake accounts and promo farming", "Login: credential stuffing", "Checkout and payment: card testing", "Gift cards, coupons, contact and review forms: guessing and spam", "Putting one invisible check and one server call in front of all of them"],
    tags="ecommerce,security,webdev,shopify")
add(E, V, "longform", "replace-captcha-checklist", "Replacing a visible CAPTCHA without opening a hole",
    "A checklist for swapping an image puzzle for an invisible check while keeping the server side strict.",
    ["Inventory every form that sends a token", "Keep the server call and its failure handling", "Test single use and expiry", "Watch failure rates for a week", "Remove the old script last"],
    tags="security,webdev,javascript,ecommerce")
add(E, P, "short", "promo-store-scan", "Scan your store's login and checkout pages",
    "Point store owners at the free scanner: which CAPTCHA each page shows and which forms are exposed.",
    ["Paste a URL, no signup", "See what a shopper sees on the login and checkout pages", "Link once, plainly"], asset="{{ecom_url}}")
add(E, P, "short", "promo-store-free-plan", "An invisible check for small stores",
    "The free plan: {{free_verifs}} verifications a month on 1 site, no puzzle for shoppers.",
    ["Proof of work runs in the background", "One server call, the same shape as reCAPTCHA's", "Free plan, upgrade only if you need signals"], asset="{{signup_url}}")
add(E, P, "short", "promo-plans-store", "Plans for stores",
    "Plain summary of the plans for a store owner.",
    ["Free {{free_price}}: {{free_verifs}} verifications", "IntegrityRuntime Pro {{integrity_price}}: risk score and surge alerts", "Checkout on Whop"], asset="{{pricing_url}}")

# ---------------- SaaS ----------------
S = "saas"
add(S, V, "short", "trial-abuse", "Free-trial abuse is a signup-form problem",
    "Repeat trials come through the same form honest users fill in.",
    ["What repeat trial signups look like", "Why email verification alone does not stop it", "Adding a cost per signup that humans never notice"])
add(S, V, "short", "signup-friction", "Every visible check on a signup form costs signups",
    "A puzzle on the signup form is paid for by the people you most want.",
    ["The visitor who just decided to try you meets a test", "Accessibility: puzzles fail screen reader users first", "Invisible checks keep the cost on automation"])
add(S, V, "short", "api-key-farming", "Free API keys attract key farms",
    "If signing up hands out a usable key, scripts will sign up a lot.",
    ["Spot it: many accounts, one usage pattern", "Gate the key behind a verified action", "Meter by account and by key"])
add(S, V, "short", "pow-explained", "Proof of work in one paragraph",
    "The browser solves a small hashing puzzle before submitting; one solve is cheap, a million are not.",
    ["Difficulty in bits: each extra bit doubles the work", "Why it is invisible to a human", "What it does not do: it slows attackers, it does not identify them"])
add(S, V, "short", "risk-score-use", "Use a risk score to decide the next step, not to block",
    "A score is most useful as a fork: let through, ask for more, or review.",
    ["Low score: proceed", "Middle: ask for email confirmation or a passkey", "High: hold for review instead of a silent block"])
add(S, V, "short", "passkeys-for-saas", "Passkeys remove the password attackers reuse",
    "With a passkey there is no shared secret to leak or stuff.",
    ["What a passkey is in one sentence", "Offer it at signup and after login", "Keep a recovery path that is not weaker than the passkey"])
add(S, V, "short", "adaptive-difficulty", "Raise the cost only when traffic surges",
    "Fixed difficulty is either annoying all the time or too weak during an attack.",
    ["Measure normal solves per minute", "Add work when the rate jumps", "Drop back automatically when it calms down"])
add(S, V, "short", "siteverify-errors", "Read the error codes your verify call returns",
    "A verify call that fails quietly is the most common hole in a bot check.",
    ["missing-input-secret and invalid-input-response mean a broken integration", "timeout-or-duplicate means a replayed or stale token", "Log the codes and alert on a spike"])
add(S, V, "longform", "signup-defence-stack", "A layered signup defence for small SaaS teams",
    "Cheap layers in order: an invisible check, a server verify, rate limits, email confirmation, then passkeys.",
    ["Layer 1: proof of work on the form", "Layer 2: server-side verify with strict failure handling", "Layer 3: limits per address and account", "Layer 4: confirmation and passkeys", "What to log so you can tell which layer stopped what"],
    tags="saas,security,webdev,startup")
add(S, V, "longform", "migrating-from-recaptcha", "Moving off reCAPTCHA with a small diff",
    "The siteverify call has the same shape, so the migration is mostly a script tag and a URL.",
    ["Swap the script and the site key", "Point the server call at the new endpoint", "Keep the response checks you already have", "Run both for a day if you are nervous", "Remove the old keys"],
    tags="javascript,webdev,security,tutorial")
add(S, P, "short", "promo-saas-scan", "Scan your signup page",
    "Point founders at the free scanner: what a visitor sees on the signup page and which forms are exposed.",
    ["Paste the signup URL", "Free, no signup", "Link once"], asset="{{saas_url}}")
add(S, P, "short", "promo-saas-integrity", "A risk score in every verify response",
    "IntegrityRuntime Pro adds named automation signals and a score to the verify call, plus surge alerts.",
    ["Signals you can read, not a black box", "Adaptive difficulty during spikes", "IntegrityRuntime Pro {{integrity_price}}"], asset="{{pricing_url}}")
add(S, P, "short", "promo-saas-docs", "The verify call is the same shape you already use",
    "Point developers at the docs: the server call mirrors reCAPTCHA's siteverify.",
    ["A script tag and one URL change", "Error codes documented", "Free plan to try it"], asset="{{docs_url}}")
add(S, P, "short", "promo-plans-saas", "Plans for SaaS teams",
    "Plain summary of the plans for a founder.",
    ["Free {{free_price}}: {{free_verifs}} verifications a month", "IntegrityRuntime Pro {{integrity_price}}: {{paid_verifs}} verifications, {{paid_sites}} sites", "Hardware Gateway Pro {{hardware_price}}: Private Access Tokens and unlimited passkeys"], asset="{{pricing_url}}")

# ---------------- publishers (AI crawlers) ----------------
B = "sales"
add(B, V, "short", "robots-ai-user-agents", "AI crawlers have names you can write rules for",
    "robots.txt can address training crawlers and answer-engine fetchers separately.",
    ["Training crawlers versus live fetchers acting for a user", "Allow one, disallow the other, per section", "Rules are a request: check who honours them"])
add(B, V, "short", "verify-crawler-ip", "A user agent string is a claim, not an identity",
    "Anyone can send a crawler's user agent; the published IP ranges are what confirm it.",
    ["Several crawler operators publish their address ranges", "Match the address before granting crawler treatment", "Crawlers without published ranges cannot be verified, say so"])
add(B, V, "short", "http-402-crawling", "HTTP 402 lets you charge crawlers instead of blocking them",
    "Payment Required has been reserved for decades; it fits paid crawling.",
    ["Return 402 with how to get a key", "Meter requests per key", "Keep search crawlers on their normal path"])
add(B, V, "short", "training-vs-search", "Blocking training does not have to block search",
    "Search visibility and model training are different decisions with different user agents.",
    ["List what each crawler is for", "Decide per category, not per company", "Review the list when new crawlers appear"])
add(B, V, "short", "robots-mistakes", "Common robots.txt mistakes with AI rules",
    "One wrong wildcard can hide the whole site from search.",
    ["Disallow: / under the wrong user agent", "Rules placed after a catch-all group", "Testing the file before deploying it"])
add(B, V, "short", "crawl-logs", "Your server logs already say who is reading",
    "Before writing rules, count which crawlers actually visit and what they fetch.",
    ["Group by user agent and path", "Check claimed crawlers against their ranges", "Look for fetchers that ignore robots.txt"])
add(B, V, "short", "agent-keys", "Give well-behaved agents a key",
    "A key separates agents you have an arrangement with from anonymous scraping.",
    ["Issue keys per partner", "Rate and meter per key", "Revoke without touching robots.txt"])
add(B, V, "short", "private-access-tokens", "Private Access Tokens prove a device without identifying it",
    "An issuer signs a token after checking the device; your site verifies the signature.",
    ["What the site learns: a valid token, not who sent it", "Where they work today and where they do not", "A good first check before showing anything harder"])
add(B, V, "longform", "ai-crawler-policy", "Writing an AI crawler policy for a content site",
    "A practical policy: which crawlers to allow, which to charge, which to block, and how to verify each.",
    ["Inventory crawlers from your logs", "Categories: search, answer engines, training, unknown", "Verification by published IP ranges", "Paid access with HTTP 402 and keys", "Reviewing the policy every quarter"],
    tags="ai,webdev,seo,security")
add(B, V, "longform", "robots-generator-walkthrough", "From blanket rules to per-crawler rules",
    "How to move a robots.txt from one catch-all group to deliberate per-crawler groups without hurting search.",
    ["Start from the current file", "Split search crawlers from training crawlers", "Add answer-engine fetchers deliberately", "Test with a validator", "Monitor what changes in the logs"],
    tags="seo,webdev,ai,tutorial")
add(B, P, "short", "promo-robots-check", "Check how your robots.txt treats AI crawlers",
    "Point publishers at the free AI-crawler rule check and generator.",
    ["Paste a URL", "See which AI crawlers your file allows", "Generate per-crawler rules for free"], asset="{{scanner_url}}")
add(B, P, "short", "promo-agentpass", "Allow, charge or block each crawler category",
    "AgentPass Pro: per-category decisions, crawler IP verification, HTTP 402 and metered agent keys.",
    ["{{agent_checks}} agent checks a month", "Verified crawlers only get crawler treatment", "AgentPass Pro {{agent_price}}"], asset="{{sales_url}}")
add(B, P, "short", "promo-plans-publisher", "Plans for publishers",
    "Plain summary of the plans for a publisher.",
    ["Free {{free_price}}: robots.txt generator and the widget", "AgentPass Pro {{agent_price}}: crawler decisions and paid keys", "Enterprise {{enterprise_price}}: every module"], asset="{{pricing_url}}")

# ---------------- agencies and freelance developers ----------------
A = "agency"
add(A, V, "short", "contact-form-spam", "Contact form spam is a client complaint you can prevent",
    "The client notices spam in the inbox long before they notice the form.",
    ["Where spam comes from: scripts posting directly to the endpoint", "Why a front-end-only check does nothing", "A server-side verify on every submission"])
add(A, V, "short", "honeypot-limits", "Honeypot fields catch lazy bots only",
    "A hidden field stops scripts that fill everything; targeted scripts skip it.",
    ["What honeypots are good for", "Why they fail against form-aware scripts", "Pair them with a check that costs work"])
add(A, V, "short", "client-handover-keys", "Hand over bot-check keys like any other credential",
    "Site keys and secrets belong to the client account, not a freelancer's.",
    ["Create keys under the client's account", "Document where the secret lives", "Rotate on handover"])
add(A, V, "short", "accessibility-captcha", "Image puzzles are an accessibility problem",
    "Visual puzzles block screen reader users and people with low vision first.",
    ["Audio fallbacks are hard too", "Invisible checks need no interaction", "Worth raising with clients who care about accessibility; legal questions go to their adviser"])
add(A, V, "short", "form-endpoint-exposure", "Bots post to the endpoint, not the page",
    "Hiding the form does nothing if the endpoint accepts any POST.",
    ["Find your form endpoints", "Require a fresh token on each", "Reject missing tokens with a clear error"])
add(A, V, "short", "monitor-failure-rates", "Watch verify failures after every launch",
    "A spike in failed verifies is either an attack or a broken integration; both need a look.",
    ["Baseline the failure rate in week one", "Alert on a jump", "Check the error codes before assuming an attack"])
add(A, V, "short", "domain-allowlist", "Lock site keys to the client's domains",
    "A site key that works on any domain can be borrowed.",
    ["Allowlist production and staging hosts", "Separate keys per environment", "Remove old domains after a migration"])
add(A, V, "short", "wordpress-forms", "Every WordPress form plugin needs the server check",
    "Contact, comment, login and checkout forms often come from different plugins.",
    ["List each form and the plugin behind it", "Confirm each one verifies the token on the server", "Test with the token removed"])
add(A, V, "longform", "agency-bot-defence-playbook", "A bot-defence playbook for client sites",
    "A repeatable setup an agency can apply to every site it builds or maintains.",
    ["Inventory forms at kickoff", "One account per client, keys per environment", "Server verify everywhere", "Monitoring and alert routing", "Handover notes the client can follow"],
    tags="webdev,agency,security,wordpress")
add(A, V, "longform", "spam-incident-response", "When a client site gets flooded with spam",
    "A calm order of operations for the day a form gets hammered.",
    ["Confirm it is automated", "Raise difficulty or close the form briefly", "Check the server verify is actually enforced", "Clean up and tell the client what changed", "Keep the alert that would have caught it earlier"],
    tags="webdev,security,agency,devops")
add(A, P, "short", "promo-agency-scan", "Scan a client's contact form before the first call",
    "Point agencies at the free scanner: which CAPTCHA the page shows and which forms are exposed.",
    ["A concrete finding to open the conversation", "Free, no signup", "Link once"], asset="{{agency_url}}")
add(A, P, "short", "promo-agency-enterprise", "Every module across client sites",
    "Enterprise: {{enterprise_sites}} sites, {{enterprise_verifs}} verifications a month, every module.",
    ["One account for the client portfolio", "Signals, alerts, Private Access Tokens and AgentPass", "Enterprise {{enterprise_price}}"], asset="{{pricing_url}}")
add(A, P, "short", "promo-plans-agency", "Plans for agencies",
    "Plain summary of the plans for an agency owner.",
    ["Free {{free_price}} per site to start", "IntegrityRuntime Pro {{integrity_price}}: {{paid_sites}} sites", "Enterprise {{enterprise_price}}: {{enterprise_sites}} sites"], asset="{{pricing_url}}")

if __name__ == "__main__":
    ids = [t["id"] for t in T]
    assert len(ids) == len(set(ids)), "duplicate topic ids"
    Path(__file__).with_name("topics.json").write_text(json.dumps(T, indent=1, ensure_ascii=False) + "\n")
    print(len(T), "topics")
