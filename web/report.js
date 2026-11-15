// CUORE session report export: PDF, PNG and CSV, built in this page from this
// session's own history. Nothing is uploaded and no library is loaded: the PDF is
// written directly (vector text and lines, standard PDF fonts), and the PNG is the
// same layout drawn on a canvas. Missing readings stay missing; provisional
// readings are drawn and labelled as provisional.
"use strict";

const RP = { W: 595.28, H: 841.89, M: 42 };            // A4 in points
const RC = {
  ink: "#141412", ink2: "#3a3935", muted: "#6f6c64", faint: "#aaa69c", line: "#d9d7d0", line2: "#b3b0a8",
  panel: "#f3f2ee", white: "#ffffff", heart: "#d4302c", breath: "#2350c4", blink: "#0f8a72",
  good: "#1d7a4b", warn: "#9a6200", bad: "#d4302c", band: "#f6dcda",
};

// ---------------------------------------------------------------- text helpers

// Helvetica advance widths (1/1000 em) for ASCII 32–126, from the standard AFM.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

// Characters outside WinAnsi are written in plain equivalents (≈ → ~, − → -).
const ASCII_SUBS = { "≈": "~", "−": "-", "→": "->", "≥": ">=", "≤": "<=", " ": " ", " ": " " };
const WIN = { "·": 0xb7, "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "×": 0xd7, "°": 0xb0, "±": 0xb1 };
function plain(str) { return String(str).replace(/[≈−→≥≤  ]/g, (c) => ASCII_SUBS[c]); }
function winAnsi(str) {
  let out = "";
  for (const ch of plain(str)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c < 127) out += ch;
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else out += "?";
  }
  return out;
}

function wrapText(r, str, maxW, size, font) {
  const words = plain(str).split(/\s+/).filter(Boolean), lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (r.width(test, size, font) <= maxW || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- PDF backend

const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" "); };
const pnum = (v) => (Math.round(v * 100) / 100).toString();

class PdfDoc {
  constructor() { this.pages = []; this.image = null; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); }
  setPage(i) { this.ops = this.pages[i]; }
  get pageCount() { return this.pages.length; }
  width(str, size, font = "sans") {
    const s = plain(str);
    if (font.startsWith("mono")) return s.length * 0.6 * size;
    let w = 0;
    for (const ch of s) { const c = ch.charCodeAt(0); w += c >= 32 && c < 127 ? HELV[c - 32] : 556; }
    return (w / 1000) * size * (font === "bold" ? 1.06 : 1);
  }
  text(str, x, y, o = {}) {
    const size = o.size || 10, font = o.font || "sans", w = this.width(str, size, font);
    const tx = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    const f = { sans: "F1", bold: "F2", mono: "F3", monobold: "F4" }[font];
    const esc = winAnsi(str).replace(/[\\()]/g, (c) => "\\" + c);
    this.ops.push(`BT /${f} ${size} Tf ${hexRgb(o.color || RC.ink)} rg ${pnum(tx)} ${pnum(RP.H - y)} Td (${esc}) Tj ET`);
  }
  stroke(o) { return `${hexRgb(o.color || RC.ink)} RG ${pnum(o.width || 1)} w ${o.dash ? `[${o.dash.join(" ")}] 0 d` : "[] 0 d"}`; }
  line(x1, y1, x2, y2, o = {}) { this.ops.push(`${this.stroke(o)} ${pnum(x1)} ${pnum(RP.H - y1)} m ${pnum(x2)} ${pnum(RP.H - y2)} l S`); }
  poly(pts, o = {}) {
    if (pts.length < 2) return;
    this.ops.push(`${this.stroke(o)} 1 J 1 j ` + pts.map(([x, y], i) => `${pnum(x)} ${pnum(RP.H - y)} ${i ? "l" : "m"}`).join(" ") + " S 0 J 0 j");
  }
  rect(x, y, w, h, o = {}) {
    const path = `${pnum(x)} ${pnum(RP.H - y - h)} ${pnum(w)} ${pnum(h)} re`;
    if (o.fill && o.stroke) this.ops.push(`${hexRgb(o.fill)} rg ${this.stroke({ color: o.stroke, width: o.width || 0.75 })} ${path} B`);
    else if (o.fill) this.ops.push(`${hexRgb(o.fill)} rg ${path} f`);
    else this.ops.push(`${this.stroke({ color: o.stroke || RC.ink, width: o.width || 0.75 })} ${path} S`);
  }
  img(x, y, w, h) { if (this.image) this.ops.push(`q ${pnum(w)} 0 0 ${pnum(h)} ${pnum(x)} ${pnum(RP.H - y - h)} cm /Im1 Do Q`); }

  // Assemble the file. Every string is Latin-1, one character per byte.
  bytes() {
    const objs = [];
    const fonts = ["Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"]
      .map((n) => `<< /Type /Font /Subtype /Type1 /BaseFont /${n} /Encoding /WinAnsiEncoding >>`);
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    fonts.forEach((f, i) => { objs[3 + i] = f; });
    let next = 7;
    let xobj = "";
    if (this.image) {
      objs[7] = `<< /Type /XObject /Subtype /Image /Width ${this.image.w} /Height ${this.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.image.data.length} >>\nstream\n${this.image.data}\nendstream`;
      xobj = " /XObject << /Im1 7 0 R >>";
      next = 8;
    }
    const res = `<< /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >>${xobj} >>`;
    const kids = [];
    for (const ops of this.pages) {
      const content = ops.join("\n");
      const pageNo = next++, contNo = next++;
      objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${RP.W} ${RP.H}] /Resources ${res} /Contents ${contNo} 0 R >>`;
      objs[contNo] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      kids.push(`${pageNo} 0 R`);
    }
    objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
    const infoNo = next++;
    objs[infoNo] = `<< /Title (CUORE session report) /Producer (CUORE) /Creator (CUORE) >>`;
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = [];
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = out.length;
      out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

// ---------------------------------------------------------------- canvas backend (PNG of page 1)

class CanvasDoc {
  constructor(scale) {
    this.scale = scale;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(RP.W * scale); this.canvas.height = Math.round(RP.H * scale);
    this.ctx = this.canvas.getContext("2d");
    this.ctx.scale(scale, scale);
    this.ctx.fillStyle = RC.white; this.ctx.fillRect(0, 0, RP.W, RP.H);
    this.page = 0; this.on = true; this.image = null; this.pageCount = 1;
  }
  newPage() { this.page++; this.pageCount = this.page + 1; this.on = false; }   // only page 1 is drawn
  setPage(i) { this.on = i === 0; }
  font(size, font) {
    const fam = font.startsWith("mono") ? 'ui-monospace, Menlo, "Courier New", monospace' : '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
    return `${font === "bold" || font === "monobold" ? 600 : 400} ${size}px ${fam}`;
  }
  width(str, size, font = "sans") { this.ctx.font = this.font(size, font); return this.ctx.measureText(plain(str)).width; }
  text(str, x, y, o = {}) {
    if (!this.on) return;
    const c = this.ctx;
    c.font = this.font(o.size || 10, o.font || "sans");
    c.fillStyle = o.color || RC.ink;
    c.textAlign = o.align || "left";
    c.textBaseline = "alphabetic";
    c.fillText(plain(str), x, y);
  }
  setStroke(o) { const c = this.ctx; c.strokeStyle = o.color || RC.ink; c.lineWidth = o.width || 1; c.setLineDash(o.dash || []); }
  line(x1, y1, x2, y2, o = {}) { if (!this.on) return; const c = this.ctx; this.setStroke(o); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
  poly(pts, o = {}) {
    if (!this.on || pts.length < 2) return;
    const c = this.ctx; this.setStroke(o); c.lineJoin = "round"; c.lineCap = "round";
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke();
  }
  rect(x, y, w, h, o = {}) {
    if (!this.on) return;
    const c = this.ctx;
    if (o.fill) { c.fillStyle = o.fill; c.fillRect(x, y, w, h); }
    if (o.stroke || !o.fill) { this.setStroke({ color: o.stroke || RC.ink, width: o.width || 0.75 }); c.strokeRect(x, y, w, h); }
  }
  img(x, y, w, h) { if (this.on && this.image) this.ctx.drawImage(this.image.el, x, y, w, h); }
}

// ---------------------------------------------------------------- layout (shared by PDF and PNG)

const STATE_COL = { ok: RC.good, warn: RC.warn, bad: RC.bad, na: RC.faint, "": RC.faint };

function reportModel() {
  const S = summaryData();
  const b = app.last && app.last.baseline ? app.last.baseline : {};
  const end = app.sessionEnded ? app.sessionEnd : Date.now();
  const dur = app.sessionStart ? (end - app.sessionStart) / 1000 : 0;
  // the six overview tiles, read back from what the report page shows, so both always agree
  const tile = (id, label, unit, color) => ({
    label, unit, color,
    value: $(id).textContent, na: $(id).classList.contains("na"),
    status: $(id + "-st").textContent, state: $(id + "-st").dataset.state || "",
    sub: $(id + "-sub").textContent,
  });
  return {
    S, b, dur,
    start: new Date(app.sessionStart), end: new Date(end),
    tiles: [
      tile("ov-dur", "Duration", "", RC.ink), tile("ov-hr", "Heart rate", "bpm avg", RC.heart),
      tile("ov-br", "Breathing", "/min avg", RC.breath), tile("ov-bl", "Blinks", "/min", RC.blink),
      tile("ov-q", "Heart signal", "reliable", RC.ink2), tile("ov-c", "Composure", $("ov-c-u").textContent, RC.good),
    ],
    findings: findings(S, b),
    metrics: (app.last && app.last.baseline && app.last.baseline.metrics) || {},
  };
}

function drawReport(r, m) {
  const { W, H, M } = RP, CW = W - 2 * M;
  let y = M;
  const ensure = (h) => { if (y + h > H - M - 24) { r.newPage(); y = M + 6; } };

  // ---- header
  r.img(M, y - 6, 74, 34);
  r.text("Session report", W - M, y + 6, { size: 9, font: "mono", color: RC.muted, align: "right" });
  r.text(m.start.toLocaleString([], { dateStyle: "long", timeStyle: "short" }), W - M, y + 19, { size: 9, font: "mono", color: RC.ink2, align: "right" });
  y += 40;
  r.line(M, y, W - M, y, { color: RC.ink, width: 1.2 });
  y += 30;
  r.text(app.quick ? `Quick read, ${mmss(m.dur)}` : `Session of ${mmss(m.dur)}`, M, y, { size: 24, font: "bold" });
  y += 16;
  r.text(`${m.start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${m.end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${app.quick ? "45-second quick read (experimental)" : "Open-ended session"} · ${m.S.n} s with readings`, M, y, { size: 9, font: "mono", color: RC.muted });
  y += 16;

  if (app.quick) {
    const lines = wrapText(r, $("rep-quick").textContent, CW - 24, 8.5, "sans");
    const h = lines.length * 11.5 + 14;
    r.rect(M, y, CW, h, { fill: "#fbf3e3" });
    r.rect(M, y, 2.5, h, { fill: RC.warn });
    lines.forEach((l, i) => r.text(l, M + 12, y + 16 + i * 11.5, { size: 8.5, color: RC.ink2 }));
    y += h + 12;
  }

  // ---- six tiles, 3 × 2
  const gap = 8, tw = (CW - 2 * gap) / 3, th = 98;
  m.tiles.forEach((t, i) => {
    const x = M + (i % 3) * (tw + gap), ty = y + Math.floor(i / 3) * (th + gap);
    r.rect(x, ty, tw, th, { fill: RC.panel, stroke: RC.line2, width: 0.6 });
    r.rect(x, ty, tw, 2.5, { fill: t.color });
    r.text(t.label, x + 12, ty + 19, { size: 9, color: RC.ink2 });
    r.text(t.value, x + 12, ty + 50, { size: 28, font: "mono", color: t.na ? RC.faint : RC.ink });
    if (t.unit) r.text(t.unit, x + 14 + r.width(t.value, 28, "mono"), ty + 50, { size: 8, font: "mono", color: RC.muted });
    if (t.status) {
      r.rect(x + 12, ty + 61, 5, 5, { fill: STATE_COL[t.state] || RC.faint });
      r.text(t.status, x + 21, ty + 66, { size: 8, font: "monobold", color: STATE_COL[t.state] || RC.muted });
    }
    wrapText(r, t.sub, tw - 24, 7.5, "sans").slice(0, 2).forEach((l, k) => r.text(l, x + 12, ty + 79 + k * 9.5, { size: 7.5, color: RC.muted }));
  });
  y += 2 * th + gap + 26;

  // ---- findings
  r.text("What this session shows", M, y, { size: 12, font: "bold" });
  y += 14;
  const fcol = { ok: RC.good, warn: RC.warn, bad: RC.bad, "": RC.faint };
  for (const [cls, [lead, rest]] of m.findings) {
    const lines = wrapText(r, `${lead} ${rest}`, CW - 14, 9, "sans");
    ensure(lines.length * 12 + 4);
    r.rect(M, y + 3, 5, 5, { fill: fcol[cls] || RC.faint });
    lines.forEach((l, i) => {
      if (i === 0 && l.startsWith(lead)) {
        r.text(lead, M + 12, y + 10, { size: 9, font: "bold" });
        r.text(l.slice(lead.length), M + 12 + r.width(lead, 9, "bold"), y + 10, { size: 9, color: RC.ink2 });
      } else r.text(l, M + 12, y + 10 + i * 12, { size: 9, color: RC.ink2 });
    });
    y += lines.length * 12 + 4;
  }
  y += 14;

  // ---- availability + composure
  ensure(150);
  r.text("Data availability", M, y, { size: 12, font: "bold" });
  r.text("Share of seconds with readings", W - M, y, { size: 8, font: "mono", color: RC.muted, align: "right" });
  y += 12;
  const H_ = app.history, n = Math.max(1, H_.length);
  const rows = [
    ["Heart rate", (s) => (s.hr === null ? "none" : s.hrState === "reliable" ? "rel" : "prov"), m.S.hrRel.length],
    ["Breathing", (s) => (s.br === null ? "none" : "rel"), m.S.br.length],
    ["Blinks", (s) => (s.blink === null ? "none" : s.blinkFull ? "rel" : "prov"), m.S.blinkFull.length],
    ["Face in view", (s) => (s.face ? "rel" : "none"), m.S.face],
    ["Composure", (s) => (s.state === "calm" ? "calm" : s.state === "elevated" ? "elev" : "none"), m.S.judged.length],
  ];
  const sx = M + 86, sw = CW - 86 - 40;
  const fillOf = { rel: RC.ink2, prov: RC.faint, calm: RC.good, elev: RC.bad };
  for (const [label, kind, good] of rows) {
    r.text(label, M, y + 9, { size: 9, color: RC.ink2 });
    r.rect(sx, y + 1, sw, 10, { fill: RC.white, stroke: RC.line, width: 0.5 });
    H_.forEach((s, i) => { const k = kind(s); if (fillOf[k]) r.rect(sx + (i / n) * sw, y + 1, sw / n + 0.3, 10, { fill: fillOf[k] }); });
    r.text(H_.length ? `${Math.round((good / H_.length) * 100)}%` : "--", W - M, y + 9, { size: 8.5, font: "mono", color: RC.muted, align: "right" });
    y += 16;
  }
  const lg = [["Reliable / measured", RC.ink2], ["Provisional", RC.faint], ["Calm", RC.good], ["Elevated", RC.bad], ["No reading (blank)", null]];
  let lx = sx;
  for (const [t, c] of lg) {
    if (c) r.rect(lx, y + 2, 7, 7, { fill: c }); else r.rect(lx, y + 2, 7, 7, { stroke: RC.line2, width: 0.5 });
    r.text(t, lx + 10, y + 8.5, { size: 7.5, font: "mono", color: RC.muted });
    lx += r.width(t, 7.5, "mono") + 24;
  }
  y += 26;

  // ---- baselines
  ensure(80);
  r.text("Personal baselines", M, y, { size: 12, font: "bold" });
  y += 6;
  const bl = [["Heart rate", "heart", "heart_rate", 0, "bpm"], ["Breathing", "breath", "breathing_rate", 1, "/min"], ["Blinks", "blink", "blink_rate", 0, "/min"]];
  for (const [label, k, field, dg, unit] of bl) {
    const v = m.b[field], mm = m.metrics[k];
    r.line(M, y + 6, W - M, y + 6, { color: RC.line, width: 0.5 });
    r.text(label, M, y + 19, { size: 9, color: RC.ink2 });
    r.text(v != null ? `${v.toFixed(dg)} ${unit}` : mm ? `Not ready · ${Math.floor(mm.valid_sec || 0)} of ${mm.need_valid_sec} s of valid readings` : "Not ready", M + 120, y + 19, { size: 9, font: "mono", color: v != null ? RC.ink : RC.muted });
    y += 18;
  }
  r.line(M, y + 6, W - M, y + 6, { color: RC.line, width: 0.5 });
  y += 14;
  wrapText(r, "Each baseline is ready once 60 s have passed since that measurement's first valid reading and at least 30 s of valid readings were collected. Composure needs two or more ready baselines.", CW, 8, "sans")
    .forEach((l) => { r.text(l, M, y + 8, { size: 8, color: RC.muted }); y += 10.5; });

  // ---- page 2: trends
  r.newPage(); y = M;
  r.text("Trends", M, y + 12, { size: 16, font: "bold" });
  r.text("One reading per second · time is minutes:seconds from the session start", W - M, y + 12, { size: 8, font: "mono", color: RC.muted, align: "right" });
  y += 26;
  const charts = [
    ["Heart rate", "heart_rate", RC.heart, "bpm", "Solid = reliable · dashed = provisional (weak signal) · grey dashed line = baseline · shaded = elevated"],
    ["Breathing", "breathing_rate", RC.breath, "/min", "Each reading averages the previous 30 s · gaps = no reading"],
    ["Blinks", "blink_rate", RC.blink, "/min", "Solid = counted over a full 60 s · dashed = counted over less (provisional)"],
    ["Heart signal quality", "quality", RC.ink2, "", "0 to 1 · heart rate counts as reliable above the 0.50 pass line (green)"],
  ];
  for (const [title, key, color, unit, note] of charts) {
    const ch = key === "quality" ? 92 : 118;
    ensure(ch + 40);
    r.text(title, M, y + 10, { size: 11, font: "bold" });
    r.text(note, W - M, y + 10, { size: 7, font: "mono", color: RC.muted, align: "right" });
    y += 16;
    reportChart(r, M, y, CW, ch, key, color, unit, m.b);
    y += ch + 22;
  }

  // ---- page 3: moments + method
  r.newPage(); y = M;
  r.text("Moments", M, y + 12, { size: 16, font: "bold" });
  y += 26;
  const moments = [
    ...app.events.map((e) => ({ t: e.t, title: "Shifted from your baseline", lines: e.reasons, c: RC.bad })),
    ...app.exercises.map((x) => ({ t: x.t, title: "Breathing exercise, 1 min", lines: [`Heart rate ${x.hr}`, `Breathing ${x.br}`], c: RC.breath })),
  ].sort((a, b2) => a.t - b2.t);
  if (!moments.length) { r.text("No elevated moments or breathing exercises in this session.", M, y + 8, { size: 9, color: RC.muted }); y += 22; }
  for (const mo of moments) {
    ensure(18 + mo.lines.length * 11);
    r.line(M, y, W - M, y, { color: RC.line, width: 0.5 });
    r.text(mmss(mo.t), M, y + 14, { size: 9, font: "mono", color: RC.muted });
    r.text(mo.title, M + 50, y + 14, { size: 9.5, font: "bold", color: mo.c });
    mo.lines.forEach((l, i) => r.text(l, M + 50, y + 26 + i * 11, { size: 8.5, color: RC.ink2 }));
    y += 20 + mo.lines.length * 11;
  }
  y += 18;

  ensure(60);
  r.text("How to read this report", M, y + 12, { size: 16, font: "bold" });
  y += 28;
  const notes = [
    ["Reliable", "The value passed its own quality check. Only reliable heart-rate seconds are averaged."],
    ["Provisional", "The estimator produced a value but its quality was below the pass line (heart rate), or the count covered less than its full window (blinks). Shown, labelled, never averaged as reliable."],
    ["Unavailable", "No reading: not enough signal yet, quality too low (breathing), or the face was out of view. Left blank, never filled in."],
    ["Heart rate", "Remote photoplethysmography (rPPG): a neural model (FacePhys, via open-rppg) recovers the pulse wave from skin-colour changes. 10 s window, updated each second; reliable when signal quality is at least 0.50."],
    ["Breathing", "Dense optical flow (Farnebäck) on the chest and shoulders below the chin, or head motion as a fallback. 30 s window, needs 20 s; shown only when the breathing peak is at least -3 dB above the noise."],
    ["Blinks", "Eye aspect ratio from 478 face landmarks; a blink is a short drop below 75 % of your open level. Counted over the last 60 s; provisional until the full window is counted."],
    ["Composure", "A comparison with your own baselines, not a measure of stress. Elevated when blinks fall below 60 % of baseline (and at least 3/min lower), or when two of these happen together: heart rate +15 %, breathing +25 %, fewer blinks."],
  ];
  for (const [k, v] of notes) {
    const lines = wrapText(r, v, CW - 100, 8.5, "sans");
    ensure(lines.length * 11 + 10);
    r.line(M, y, W - M, y, { color: RC.line, width: 0.5 });
    r.text(k, M, y + 13, { size: 9, font: "bold" });
    lines.forEach((l, i) => r.text(l, M + 100, y + 13 + i * 11, { size: 8.5, color: RC.ink2 }));
    y += lines.length * 11 + 10;
  }
  y += 16;
  ensure(40);
  wrapText(r, "CUORE is not a medical device. These are estimates from a webcam, for personal awareness only, and should not be used for diagnosis or treatment decisions. The video was processed on the computer running CUORE and was not stored.", CW, 8.5, "sans")
    .forEach((l) => { r.text(l, M, y + 8, { size: 8.5, color: RC.muted }); y += 11; });

  // ---- footer on every page
  const total = r.pageCount;
  for (let i = 0; i < total; i++) {
    r.setPage(i);
    r.line(M, H - M + 6, W - M, H - M + 6, { color: RC.line, width: 0.5 });
    r.text("CUORE · personal vitals · not a medical device", M, H - M + 18, { size: 7.5, font: "mono", color: RC.muted });
    r.text(`Page ${i + 1} of ${total}`, W - M, H - M + 18, { size: 7.5, font: "mono", color: RC.muted, align: "right" });
  }
}

// One trend chart: real samples only; runs split by reliability; gaps stay gaps.
function reportChart(r, x, y, w, h, key, color, unit, b) {
  const pad = { l: 30, r: 6, t: 6, b: 16 };
  r.rect(x, y, w, h, { fill: RC.white, stroke: RC.line, width: 0.5 });
  const samples = app.history.map((s) => ({ t: s.t, state: s.state, ...SERIES[key](s) }));
  const pts = samples.filter((s) => s.v !== null);
  if (pts.length < 2) {
    r.text(emptyChartText(key), x + w / 2, y + h / 2 + 3, { size: 9, color: RC.muted, align: "center" });
    return;
  }
  const base = key !== "quality" && b[key] != null ? b[key] : null;
  let lo, hi;
  if (key === "quality") { lo = 0; hi = 1; }
  else {
    lo = Math.min(...pts.map((s) => s.v)); hi = Math.max(...pts.map((s) => s.v));
    if (base !== null) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
    const mg = Math.max(1, (hi - lo) * 0.15); lo = Math.max(0, lo - mg); hi += mg;
  }
  const tMax = Math.max(30, samples[samples.length - 1].t);
  const X = (t) => x + pad.l + (t / tMax) * (w - pad.l - pad.r);
  const Y = (v) => y + pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  // elevated bands
  if (key !== "quality") {
    let st = null;
    samples.forEach((s, i) => {
      const on = s.state === "elevated";
      if (on && st === null) st = s.t;
      if ((!on || i === samples.length - 1) && st !== null) { r.rect(X(st), y + pad.t, Math.max(1, X(s.t) - X(st)), h - pad.t - pad.b, { fill: RC.band }); st = null; }
    });
  }
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    r.line(x + pad.l, Y(v), x + w - pad.r, Y(v), { color: RC.line, width: 0.4 });
    r.text(key === "quality" ? v.toFixed(1) : v.toFixed(0), x + pad.l - 4, Y(v) + 2.5, { size: 6.5, font: "mono", color: RC.muted, align: "right" });
  }
  const step = tMax > 600 ? 120 : tMax > 240 ? 60 : tMax > 90 ? 30 : 15;
  for (let t = 0; t <= tMax; t += step) r.text(mmss(t), X(t), y + h - 5, { size: 6.5, font: "mono", color: RC.muted, align: "center" });
  if (base !== null) {
    r.line(x + pad.l, Y(base), x + w - pad.r, Y(base), { color: RC.muted, width: 0.6, dash: [3, 3] });
    r.text(`Baseline ${base.toFixed(DIGITS[key])}`, x + w - pad.r - 3, Y(base) - 3, { size: 6.5, font: "mono", color: RC.ink2, align: "right" });
  }
  if (key === "quality" && hasQualityScale()) {
    r.line(x + pad.l, Y(0.5), x + w - pad.r, Y(0.5), { color: RC.good, width: 0.6, dash: [3, 3] });
    r.text("Pass line 0.50", x + w - pad.r - 3, Y(0.5) - 3, { size: 6.5, font: "mono", color: RC.good, align: "right" });
  }
  let run = [], prov = null, prev = null;
  const flush = () => { if (run.length > 1) r.poly(run, { color, width: prov ? 0.9 : 1.3, dash: prov ? [1.5, 2] : null }); run = []; };
  for (const s of samples) {
    if (s.v === null) { flush(); prev = null; prov = null; continue; }
    const p = [X(s.t), Y(s.v)];
    if (prov !== null && s.prov !== prov) { flush(); if (prev) run.push(prev); }
    prov = s.prov; run.push(p); prev = p;
  }
  flush();
}

// ---------------------------------------------------------------- logo (JPEG for the PDF, image for the canvas)

function loadLogo() {
  return new Promise((resolve) => {
    const el = new Image();
    el.onload = () => {
      const c = document.createElement("canvas");
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(el, 0, 0);
      const b64 = c.toDataURL("image/jpeg", 0.92).split(",")[1];
      resolve({ el: c, w: c.width, h: c.height, data: atob(b64) });
    };
    el.onerror = () => resolve(null);
    el.src = "/static/logo.png";
  });
}

// ---------------------------------------------------------------- CSV

const CSV_COLS = ["elapsed_s", "timestamp_utc", "face_in_view", "heart_rate_bpm", "heart_rate_status", "heart_signal_quality",
  "breathing_rate_per_min", "breathing_status", "blink_rate_per_min", "blink_status", "composure_state"];

function reportCsv() {
  const COMPOSURE = { calm: "calm", elevated: "elevated", calibrating: "learning_baseline", insufficient: "insufficient_data" };
  const HEART = { reliable: "reliable", provisional: "provisional", collecting: "measuring", none: "no_face" };
  const rows = app.history.map((s) => [
    Number(s.t.toFixed(1)),
    new Date(app.sessionStart + s.t * 1000).toISOString(),
    s.face ? 1 : 0,
    s.hr === null ? null : Number(s.hr.toFixed(1)),
    s.hr === null ? (s.face ? "no_reading" : "no_face") : HEART[s.hrState] || "unknown",
    s.q === null ? null : Number(s.q.toFixed(3)),
    s.br === null ? null : Number(s.br.toFixed(1)),
    s.br === null ? "no_reading" : "measured",
    s.blink === null ? null : Number(s.blink.toFixed(1)),
    s.blink === null ? "no_reading" : s.blinkFull ? "full_60s_window" : "provisional",
    COMPOSURE[s.state] || "no_reading",
  ]);
  // empty cell = no reading; the status column next to it says why
  const lines = [CSV_COLS.join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
}

// ---------------------------------------------------------------- save

function reportName(ext) {
  const d = new Date(app.sessionStart), p = (v) => String(v).padStart(2, "0");
  return `cuore-${app.quick ? "quick-read" : "session"}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

// Phones (and installed apps) get the share sheet, where "Save to Files" lives;
// everything else gets an ordinary download.
async function saveFile(blob, name) {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ((coarse || standalone) && typeof File === "function" && navigator.canShare) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return "Shared"; }
      catch (e) { if (e && e.name === "AbortError") return "Cancelled"; }
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return "Downloaded";
}

async function downloadReport(kind) {
  const status = $("dl-status");
  if (!app.history.length) { status.textContent = "No readings to export."; return; }
  status.textContent = `Preparing ${kind.toUpperCase()}…`;
  try {
    renderSummary();                                    // the tiles the report reads are current
    let blob, name;
    if (kind === "csv") { blob = reportCsv(); name = reportName("csv"); }
    else {
      const logo = await loadLogo(), model = reportModel();
      if (kind === "pdf") {
        const doc = new PdfDoc(); doc.image = logo; drawReport(doc, model);
        blob = new Blob([doc.bytes()], { type: "application/pdf" }); name = reportName("pdf");
      } else {
        const doc = new CanvasDoc(2); doc.image = logo; drawReport(doc, model);
        blob = await new Promise((res) => doc.canvas.toBlob(res, "image/png"));
        name = reportName("png");
      }
    }
    const how = await saveFile(blob, name);
    status.textContent = how === "Cancelled" ? "" : `${how}: ${name}`;
  } catch (e) {
    status.textContent = `Couldn't create the ${kind.toUpperCase()}: ${e.message || e}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = $("btn-dl"), menu = $("dl-menu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button").focus();
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-dl]");
    if (!item) return;
    e.stopPropagation(); close(); btn.focus();
    downloadReport(item.dataset.dl);
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { close(); btn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener("click", close);
});
