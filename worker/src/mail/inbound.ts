// Inbound mail classifier (owner 2026-11-04): a delivery error is NEVER a stop.
// One set of rules for every Jacaranda Labs business (JS here; TS and Python ports carry the same tests).
//   bounce : the address does not exist / was rejected      -> suppress; counts toward the bounce brake
//   soft   : mailbox full, over quota, temporarily refused   -> end this lead's sequence quietly; counts as nothing
//   gone   : inbox unmonitored, person has left, deactivated -> end this lead's sequence quietly; counts as nothing
//   auto   : out-of-office and other robots                  -> ignore; the sequence carries on
//   stop   : a person asked us not to write                  -> suppress; counts toward the stop brake
//   reply  : a person answered                               -> hand to the owner (and send the link once)
// Order matters: delivery reports and robots are recognised BEFORE anyone's words are read for "stop",
// because a bounce quotes our own footer ('reply "stop"') and dead inboxes answer "No longer monitored".

export const DSN_FROM = /^(mailer-?daemon|mail-?daemon|postmaster|microsoftexchange[0-9a-f]*|mail\.?delivery\.?subsystem|bounces?)@/i;
export const DSN_SUBJECT = /(delivery status notification|undeliver(able|ed)|delivery (has )?failed|delivery failure|failure notice|returned mail|mail delivery (failed|failure|subsystem|system)|could not be delivered|not (been )?delivered|non-?delivery|message blocked|delivery delayed|warning: could not send)/i;
const DSN_BODY = /^(diagnostic-code|final-recipient|action: (failed|delayed)|status: [45]\.\d)/im;
const HARD = /(address not found|user unknown|unknown user|no such (user|mailbox|recipient|address)|does ?n[o’']t exist|doesn’t exist|recipient (address )?rejected|invalid (recipient|address|mailbox)|unknown (recipient|address)|address (is )?invalid|mailbox not found|\b5\.1\.[0-9]+\b|\b550[ -]5\.1|account (has been )?(disabled|deleted|terminated))/i;
const SOFT = /(mailbox (is |was )?full|inbox (is |was )?full|over (its |the |their )?(storage )?quota|quota (exceeded|full)|exceeded (the |its |their )?(storage|quota|allocation)|out of (storage|space)|insufficient (storage|space)|storage (space )?(is )?full|temporar(y|ily)|try (again )?later|greylist|\b4\.\d\.\d+\b|\b5\.2\.2\b|currently unavailable|not available (right )?now|delivery (is )?delayed|still trying|will (retry|keep trying))/i;
const GONE = /(no longer (with|at|employed|working|part of)|(has|have) left (the |our )?(company|organi[sz]ation|firm|business|team)|(this |the |my )?(e-?mail|mail|address|mailbox|inbox|account)( address)? (is |has been |was )?(no longer|not) (in use|monitored|active|valid|available|checked|being (monitored|checked|used))|(account|mailbox|address|inbox|e-?mail) (is |has been |was )?(deactivated|disabled|closed|discontinued|retired|suspended)|\bnot (being )?monitored\b|\bunmonitored\b|no longer (monitored|in use|active|checked|in operation))/i;
const AUTO = /\b(out of (the )?office|automatic reply|auto-?reply|autoreply|auto-?response|away from (the |my )?(office|desk)|on (annual |parental |maternity |paternity |sick )?leave|currently (away|travel+ing|out)|limited access to (e-?mail|my e-?mail)|i am away|i'?m away|back in the office on|will (respond|reply|get back to you) (to your (e-?mail|message) )?(as soon as|when|on my return)|thank you for (your (e-?mail|message)|contacting)[^.]{0,60}(we|our team) will|this is an automated)\b/i;
const AUTO_SUBJECT = /^(auto(matic)?[ -]?(reply|response)|out of (the )?office|ooo\b|away:|abwesenheit|r[ée]ponse automatique|respuesta autom)/i;
const STOP_PHRASE = /\b(unsubscribe|remove me|take me off|opt(ed)? ?out|not interested|no,? thanks|no thank you|stop (emailing|writing|contacting|sending|messaging)|do not (email|contact|write|message)|don'?t (email|contact|write|message)|leave (me|us) alone|please stop|stop it|remove (us|me|our (address|e-?mail|details))( from)?)\b/i;

const qp = (s: string): string => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
const b64 = (s: string): string => { const t = s.replace(/[^A-Za-z0-9+/]/g, ""); try { return new TextDecoder().decode(Uint8Array.from(atob(t.slice(0, t.length - (t.length % 4))), (c) => c.charCodeAt(0))); } catch { return ""; } };
const unhtml = (s: string): string => s.replace(/<blockquote[\s\S]*$/i, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

/** The readable text of a fetched BODY[TEXT]: the text/plain part (else html), base64/quoted-printable decoded. */
export function decodeBody(raw: unknown): string {
  const s = String(raw || "");
  let chosen: { h: string; b: string } | null = null;
  for (const part of s.split(/\r?\n--[^\r\n]{6,}\r?\n/)) {
    const m = part.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
    if (!m || !/content-type:/i.test(m[1])) continue;
    if (/text\/plain/i.test(m[1])) { chosen = { h: m[1], b: m[2] }; break; }
    if (!chosen && /text\/html/i.test(m[1])) chosen = { h: m[1], b: m[2] };
  }
  if (!chosen) {
    const t = s.trim();
    const lines = t.split(/\r?\n/);
    if (t.length >= 24 && lines.every((l, i) => /^[A-Za-z0-9+/]*={0,2}$/.test(l) && (i === lines.length - 1 || l.length >= 40))) {
      const d = b64(t);
      if (d && !/[\u0000-\u0008\uFFFD]/.test(d)) return d;
    }
    return /=\r?\n|=[0-9A-F]{2}/.test(s) ? qp(s) : s;
  }
  let b = chosen.b.split(/\r?\n--[^\r\n]{6,}--/)[0];
  if (/content-transfer-encoding:\s*base64/i.test(chosen.h)) b = b64(b);
  else if (/quoted-printable/i.test(chosen.h)) b = qp(b);
  return /text\/html/i.test(chosen.h) ? unhtml(b) : b;
}

/** The sender's own words: everything above the first quote marker (they quote our footer with its "stop"). */
export function ownWords(text: string): string {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^\s*On .{4,200}wrote:\s*$/i.test(line) || /^\s*On .{4,200}\d{4}.*<[^>]+@/i.test(line) || /^\s*-- ?$/.test(line) || /^-{2,}\s*(original message|forwarded message)/i.test(line)
      || /^\s*(from|sent|von|de):\s/i.test(line) || /^\s*sent from my /i.test(line) || /^_{5,}/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** A stop phrase, unless negated: "don't stop emailing us" / "never stop sending" are compliments. */
function stopPhrase(w: string): boolean {
  const re = new RegExp(STOP_PHRASE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(w))) {
    const before = w.slice(Math.max(0, m.index - 16), m.index);
    if (/^stop/i.test(m[0]) && /(don'?t|do not|never|n't)\s+$/i.test(before)) continue;
    return true;
  }
  return false;
}

/** A human opt-out. "No" alone counts only as a short answer ("No thanks", "no."), never "No longer monitored". */
export function isStop(words: string): boolean {
  const w = String(words || "").trim();
  if (!w) return false;
  if (/^\W*(stop|unsubscribe|remove( me)?)\b/i.test(w)) return true;
  if (/^\W*(no|nope|nah)\b/i.test(w) && w.length <= 60 && !GONE.test(w) && !SOFT.test(w)) return true;
  return stopPhrase(w.slice(0, 600));
}

type Hdrs = Headers | Record<string, string> | null | undefined;
function headerOf(headers: Hdrs, name: string): string {
  if (!headers) return "";
  if (typeof (headers as Headers).get === "function") return String((headers as Headers).get(name) || "");
  const h = headers as Record<string, string>;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? String(h[k] || "") : "";
}

/** -> { kind, why }. `from` = sender address, `text` = decoded body, `headers` = optional map/Headers. */
export type InboundKind = "bounce" | "soft" | "gone" | "auto" | "stop" | "reply";
export function classifyInbound({ from = "", subject = "", text = "", headers = null }: { from?: string; subject?: string; text?: string; headers?: Hdrs } = {}): { kind: InboundKind; why: string } {
  const f = String(from || "").toLowerCase().trim(), s = String(subject || ""), t = String(text || "");
  const ctype = headerOf(headers, "content-type");
  const isDsn = DSN_FROM.test(f) || (DSN_SUBJECT.test(s) && !/^\s*(re|aw|sv|antw?)\s*:/i.test(s)) || DSN_BODY.test(t) || /report-type="?delivery-status/i.test(ctype)
    || !!headerOf(headers, "x-failed-recipients");
  if (isDsn) {
    const blob = s + "\n" + t.slice(0, 8000);
    if (HARD.test(blob) && !/\b5\.2\.2\b|mailbox (is )?full|over quota/i.test(blob)) return { kind: "bounce", why: "address rejected" };
    if (SOFT.test(blob)) return { kind: "soft", why: "temporary or full mailbox" };
    if (GONE.test(blob)) return { kind: "gone", why: "inbox closed" };
    return { kind: "bounce", why: "delivery failed" };
  }
  const words = ownWords(t);
  const head = (s + "\n" + words).slice(0, 1500);
  const autoHdr = (headerOf(headers, "auto-submitted") && !/^no$/i.test(headerOf(headers, "auto-submitted").trim()))
    || !!headerOf(headers, "x-autoreply") || !!headerOf(headers, "x-autorespond")
    || /^(auto_reply|bulk|junk|list)$/i.test(headerOf(headers, "precedence").trim());
  if (GONE.test(head)) return { kind: "gone", why: "inbox closed or person left" };
  if ((autoHdr || AUTO_SUBJECT.test(s) || AUTO.test(head)) && SOFT.test(head)) return { kind: "soft", why: "mailbox full / unavailable" };
  if (autoHdr || AUTO_SUBJECT.test(s)) return { kind: "auto", why: "automatic reply" };
  const bareSubject = s.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
  if (/^\W*(stop|unsubscribe|remove me|opt ?out)\W*$/i.test(bareSubject)) return { kind: "stop", why: "asked not to be contacted" };
  if (isStop(words)) return { kind: "stop", why: "asked not to be contacted" };
  if (AUTO.test(head)) return { kind: "auto", why: "automatic reply" };
  if (/^(mailbox (is )?full|inbox (is )?full)/i.test(words)) return { kind: "soft", why: "mailbox full" };
  return { kind: "reply", why: "a person answered" };
}

/** The failed recipient named in a delivery report (null if none of `candidates` is named). */
export function failedRecipient({ text = "", headers = null }: { text?: string; headers?: Hdrs } = {}, candidates: string[] = []): string | null {
  const x = headerOf(headers, "x-failed-recipients").toLowerCase();
  const fr = (String(text).match(/final-recipient:\s*(?:rfc822;)?\s*<?([^\s>]+@[^\s>]+)/i) || [])[1];
  const pool = [x, String(fr || "").toLowerCase(), String(text).toLowerCase()].join("\n");
  return candidates.find((c) => c && pool.includes(String(c).toLowerCase())) || null;
}
