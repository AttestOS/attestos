# Where bots touch an online store

channel: nostr30023
kind: longform

## Where bots touch an online store

### Account creation: fake accounts and promo farming  
When a visitor signs up, a bot can create thousands of accounts in a single run. It writes random emails or retrieves disposable ones, registers a name, and then pushes the account to a list that is later used for coupons. The bot does not need to interact with an actual product page-it can just hit the signup URL from a script. The real cost for the honest buyer is minimal: it takes a few microseconds to run the hidden puzzle but the user sees no prompt.  

The cheapest honest defence is the invisible proof‑of‑work that the server does not rely on a visible challenge. The script attempts a calculation that a normal CPU can do in milliseconds. A script with many requests is forced to pay that time for every attempt; the throughput drops quickly. Add a *siteverify* call tied to the store’s domain and the bot cannot spoof the request origin. A single check hides from the user but pushes the load onto the attacker’s machine.

### Login: credential stuffing  
Credential stuffing is a form of credential reuse attack. A bot takes a list of leaked usernames and passwords, posts them to the login endpoint, and watches the response. If a login succeeds it records it for future use. For a normal shopper the login page is fast, with no visible barrier, so the prompt grows low.  

A hidden proof‑of‑work forces the code that does the POST to do a winnable calculation. The wait time may be a few tenths of a second, undetectable to a human, but it becomes a significant fraction of the attack bandwidth. Coupled with *siteverify* that checks the store’s domain, the bot must pay a measurable cost for each try. The easiest way to set this up on a Shopify kit is to link the widget to the “Store Backend” route, then add a server‑side verify call. This adds almost no cost to a legitimate user and keeps the credential‑stuffing swarm in check.

### Checkout and payment: card testing  
Card testing is the practice of spinning card numbers through the payment gateway, expecting a decline, then adjusting the number and repeating. A bot can do this at a rate of up to thousands per minute costing the merchant nothing for each test except a small payment‑gateway fee if the tokeniser rejects the card. The customer’s checkout page is usually barebones with no concern for a puzzle.  

Insert a proof‑of‑work step before any transaction data is sent. This cost is an extra calculation per request. A normal shopper will be oblivious; the CPU on a smart phone will finish in less than a second. The attacker, however, must idle a thread for each test. One way to check for existing problems is to paste the store URL in the free scanner and look for invisible CAPTCHAs that appear prior to the payment form. The scanner will also reveal whether the storefront emits a Domain‑Based CSP header that blocks third‑party pixels, which is a subtle side‑effect of the service.

### Gift card, coupons, contact and review forms: guessing and spam  
Bots generate thousands of gift‑card entry attempts, try coupon codes from a dictionary, fill out contact forms with random lorem ipsum, and post dozens of reviews that contain a single spam link. The form typically loads quickly; a real user rarely has to wait for a stall. The bot, executing many posts in parallel, is able to ignore the time for the hidden challenge because it is hidden behind a script that solves it automatically.  

The invisible check can sit as the first test before the form data hits the server. The next cheap step is to issue a *siteverify* that verifies that the hostname of the request matches the store’s domain. If the attacker is still behind a proxy that remained in the dark, the challenge fails. For coupon or gift‑card validation you can add a simple hash that the store generates and returns on each request. The client must compete for the calculation; legitimate users’ browsers will do the work in a fraction of a second. The additional work is mathematical logic that most bots optimize for; the attacker can decide to ignore the request, but the save is minimal compared to the volume.

### Bringing it all together  
A single invisible widget can be embedded on every page that sends POST data to your store. The widget requests a proof‑of‑work calculation that delays the browser by an amount of time that is short for a human but significant for mass automation. On the server a single *siteverify* call confirms that the request came from the real domain and that the captcha balance matches.  

The technique can be added through any webhook‑ready e‑commerce platform. On Shopify you use the “Buy Button” API to wrap the checkout flow; on WooCommerce you embed the widget on the add‑to‑cart, checkout and account pages. The total additional compute cost for a legitimate query is a few hundred milliseconds of CPU on the client, but the cost for an attacker trying millions of requests is the same time multiplied by the number of attempted attempts. Because the solver is invisible, it does not create friction for the honest visitor, fulfilling the frustration‑free promise.

### Check how your store looks for free  
The first thing to do is paste your storefront URL into the free scanner (https://attestos‑edge.attestos.workers.dev/scanner/) and see whether it emits
