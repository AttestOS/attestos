// Tiny dependency-free PDF writer for outreach briefs (owner 2026-11-04: the day-7 email carries an attachment).
// A4, Helvetica / Helvetica-Bold (built-in, no font files), word-wrapped, multi-page, one accent colour bar.
// makePdf({ title, subtitle, accent: "#0b6e4f", sections: [{ heading, paras: [..], bullets: [..], code: [..] }], footer }) -> Uint8Array

// Helvetica advance widths (1/1000 em) for ASCII 32..126 (standard AFM metrics).
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Text the built-in fonts can print: curly quotes, dashes, ellipses and accents folded to ASCII. */
export function pdfSafe(s) {
  return String(s ?? "")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/[\u00A0\u2009\u202F]/g, " ")
    .replace(/\u2022/g, "-").replace(/\u00D7/g, "x")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E\n]/g, "");
}
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const width = (s, size, bold) => { const w = bold ? HBW : HW; let n = 0; for (const ch of s) n += w[ch.charCodeAt(0) - 32] ?? 556; return (n * size) / 1000; };

function wrap(text, size, bold, max) {
  const out = [];
  for (const para of pdfSafe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (width(next, size, bold) <= max || !line) line = next; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "")) || [0, "1f3a5f"];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
}

export function makePdf({ title = "", subtitle = "", accent = "#1f3a5f", sections = [], footer = "" } = {}) {
  const W = 595, H = 842, L = 56, R = 56, TOP = 70, BOTTOM = 64, MAX = W - L - R;
  const pages = [];
  let ops = [], y = H - TOP;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = H - TOP; ops.push(`${rgb(accent)} rg 0 ${H - 18} ${W} 18 re f 0 g`); };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };
  const text = (s, size, bold, x = L, color = "0 g") => { ops.push(`BT ${color} /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y.toFixed(1)} Td (${esc(s)}) Tj ET`); };
  newPage();
  for (const line of wrap(title, 20, true, MAX)) { need(26); text(line, 20, true, L, `${rgb(accent)} rg`); y -= 26; }
  if (subtitle) { y -= 2; for (const line of wrap(subtitle, 11, false, MAX)) { need(15); text(line, 11, false, L, "0.35 g"); y -= 15; } }
  y -= 10;
  for (const sec of sections) {
    if (sec.heading) { y -= 6; need(34); for (const line of wrap(sec.heading, 13, true, MAX)) { text(line, 13, true); y -= 18; } }
    for (const p of sec.paras || []) { for (const line of wrap(p, 10.5, false, MAX)) { need(14.5); text(line, 10.5, false); y -= 14.5; } y -= 6; }
    if (sec.code && sec.code.length) { // monospace (Courier, built in)
      y -= 2; const per = Math.floor(MAX / (0.6 * 8.5));
      for (const raw of sec.code) {
        let rest = pdfSafe(raw), first = true; // long lines wrap with an indent; code is never cut
        do { const w = first ? per - 2 : per - 6; const piece = (first ? "" : "    ") + rest.slice(0, w); rest = rest.slice(w); first = false;
          need(11.5); ops.push(`BT 0.12 g /F3 8.5 Tf ${L + 8} ${y.toFixed(1)} Td (${esc(piece)}) Tj ET`); y -= 11.5; } while (rest.length);
      }
      y -= 8;
    }
    for (const b of sec.bullets || []) {
      const lines = wrap(b, 10.5, false, MAX - 14);
      lines.forEach((line, i) => { need(14.5); if (i === 0) text("-", 10.5, true); text(line, 10.5, false, L + 14); y -= 14.5; });
      y -= 3;
    }
  }
  pages.push(ops);
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const f3 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1; objs.push(null);
  const kids = [];
  pages.forEach((p, i) => {
    const foot = `BT 0.45 g /F1 8.5 Tf ${L} 36 Td (${esc(pdfSafe(footer))}) Tj ET BT 0.45 g /F1 8.5 Tf ${W - R - 30} 36 Td (${i + 1}/${pages.length}) Tj ET`;
    const stream = [...p, foot].join("\n");
    const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(pdfSafe(title))}) /Producer (Jacaranda Labs) >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}

/** base64 of bytes, wrapped at 76 columns (MIME). */
export function b64wrap(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** A multipart/mixed body: the plain text first, then each attachment. Returns { contentType, body }. */
export function mixedBody(text, attachments, boundary = "jl" + Math.random().toString(36).slice(2, 14)) {
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(new TextEncoder().encode(text))}\r\n`];
  for (const a of attachments) {
    const name = pdfSafe(a.filename).replace(/["\\\r\n]/g, "").slice(0, 80) || "brief.pdf";
    parts.push(`--${boundary}\r\nContent-Type: ${a.type || "application/pdf"}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(a.content)}\r\n`);
  }
  return { contentType: `multipart/mixed; boundary="${boundary}"`, body: parts.join("") + `--${boundary}--\r\n` };
}
