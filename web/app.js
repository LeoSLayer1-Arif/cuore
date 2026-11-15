// CUORE web UI. Every number shown comes from /api/readings, unchanged; the page
// only formats, plots and summarises it. Server text goes in with textContent only.
"use strict";

const POLL_MS = 1000;
const STALE_SEC = 3;
const REARM_CALM_MS = 30000;      // pop-up can return only after 30 s of unbroken calm
const BASELINE_SEC = 60;
// Test switches for validation runs (defaults are the current pipeline):
//   ?jpeg=0.97     JPEG quality of uploaded frames (default 0.92)
//   ?inflight=2    allow two uploads in flight (default 1; safe, see server push())
//   ?lock=0        skip the exposure/white-balance lock attempt
const TEST = (() => {
  const q = new URLSearchParams(location.search);
  const jpeg = parseFloat(q.get("jpeg"));
  return {
    jpeg: Number.isFinite(jpeg) ? Math.min(0.99, Math.max(0.5, jpeg)) : 0.92,
    inflight: q.get("inflight") === "2" ? 2 : 1,
    lock: q.get("lock") !== "0",
    diag: q.has("diag"),
  };
})();
const RING_LEN = 314.16;          // 2 * pi * 50
const SVG_NS = "http://www.w3.org/2000/svg";
const TIPS = [
  "Keep steady, even light on your face. Avoid a bright window behind you.",
  "Sit back a little so your shoulders are in view. Breathing reads best from the chest.",
  "Stay still and breathe as you normally do. Talking changes your breathing.",
  "Keep this tab in front. Chrome pauses the camera in background tabs.",
  "Blink naturally. Blink rate needs a full minute before it counts.",
];

const $ = (id) => document.getElementById(id);
const fmt = (v, d) => (v === null || v === undefined ? "--" : v.toFixed(d));
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const app = {
  screen: "start",
  view: "live",
  style: "nocturne",
  mode: "dark",          // C only: "dark" (Night lab) or "light" (Mineral)
  reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  source: null,          // "browser" or "webcam", from the server
  sessionId: null,
  sessionStart: null,
  sessionEnded: false,
  stream: null,
  cameraLost: false,
  sending: false,
  inFlight: 0,
  lastFrameOk: 0,
  frameErrors: 0,
  tick: 0,
  history: [],           // one sample per poll: {t, hr, br, blink, state}
  events: [],            // elevated moments: {t, reasons}
  exercises: [],         // breathing results: {t, hr, br}
  last: null,            // latest readings for this session
};

// ================================================================ style + art

let thumbHome = null;   // where the camera thumbnail lives in A/B

function applyStyle(name) {
  app.style = name;
  const living = name === "living";
  document.body.classList.toggle("style-nocturne", name === "nocturne");
  document.body.classList.toggle("style-instrument", name === "instrument");
  document.body.classList.toggle("style-living", living);
  document.body.classList.toggle("mode-dark", living && app.mode === "dark");
  document.body.classList.toggle("mode-light", living && app.mode === "light");
  for (const b of document.querySelectorAll(".style-btn")) b.setAttribute("aria-checked", String(b.dataset.style === name));
  $("mode-btn").hidden = !living;
  $("mode-btn").setAttribute("aria-label", app.mode === "dark" ? "Switch to light mode" : "Switch to dark mode");
  // one camera thumbnail, moved between layouts (the video keeps streaming)
  const thumb = $("thumb");
  if (!thumbHome) thumbHome = { parent: thumb.parentElement, next: thumb.nextElementSibling };
  if (living) $("thumb-slot-c").appendChild(thumb);
  else thumbHome.parent.insertBefore(thumb, thumbHome.next);
  mountHearts();
  if (app.screen === "app") showView(app.view);
}

function heartIsPhoto() {
  return app.style === "nocturne" || (app.style === "living" && app.mode === "dark");
}

// Dark looks use the blue 3D render (edges fade into the page); light looks use the engraving.
function mountHearts() {
  const photo = heartIsPhoto();
  const src = photo ? "/static/heart-dark.png" : "/static/heart.png";
  for (const stage of document.querySelectorAll("[data-heart]")) {
    const img = document.createElement("img");
    img.className = "heart-art " + (photo ? "photo" : "sketch");
    img.alt = "";
    img.src = src;
    img.addEventListener("error", () => img.remove());
    stage.replaceChildren(img);
  }
  // The start-page heart is illustration only: a calm fixed rhythm, no number attached.
  const intro = document.querySelector("[data-demo]");
  intro.style.setProperty("--beat", "1.1s");
  intro.classList.add("beating");
}

// ================================================================ screens + views

function showScreen(name) {
  app.screen = name;
  for (const s of ["start", "calibrate", "app"]) $("screen-" + s).hidden = s !== name;
  if (name !== "app") { $("notice").hidden = true; $("notif-panel").hidden = true; }
  window.scrollTo(0, 0);
}

function showView(name, focus) {
  app.view = name;
  const living = app.style === "living";
  $("view-live").hidden = !(name === "live" && !living);
  $("view-live-c").hidden = !(name === "live" && living);
  $("view-summary").hidden = name !== "summary";
  if (name !== "live") closeDrawer();
  for (const tab of document.querySelectorAll(".tab")) {
    const on = tab.dataset.view === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  if (name === "live") renderCharts();
  if (name === "summary") renderSummary();
  window.scrollTo(0, 0);
}

// ================================================================ dialogs (focus stays inside)

let returnFocus = null;

function openDialog(el, first) {
  returnFocus = document.activeElement;
  el.hidden = false;
  (first || el.querySelector("button")).focus();
}

function closeDialog(el) {
  const inside = el.contains(document.activeElement);
  el.hidden = true;
  if (returnFocus && returnFocus !== document.body && document.contains(returnFocus)) returnFocus.focus();
  else if (inside) document.activeElement.blur();   // never leave focus on a hidden control
  returnFocus = null;
}

function trapFocus(el, onEscape) {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
    if (e.key !== "Tab") return;
    const items = [...el.querySelectorAll("button:not([hidden]), [href]")].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// ================================================================ camera

async function serverSource() {
  const r = await fetch("/api/readings", { cache: "no-store" });
  if (!r.ok) throw new Error(`The CUORE server answered ${r.status}.`);
  return (await r.json()).session.source;
}

async function openCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  for (const track of app.stream.getVideoTracks()) track.addEventListener("ended", cameraLost);
  for (const id of ["cal-video", "thumb-video"]) {
    const v = $(id);
    v.srcObject = app.stream;
    v.hidden = false;
    await v.play().catch(() => {});
  }
  app.cameraLost = false;
  camLock.state = "pending"; camLock.detail = "auto exposure settling (3 s)";
  setTimeout(() => { lockCamera().catch((e) => { camLock.state = "failed"; camLock.detail = String(e); }); }, 3000);
}

function stopCamera() {
  app.sending = false;
  if (app.stream) for (const t of app.stream.getTracks()) { t.removeEventListener("ended", cameraLost); t.stop(); }
  app.stream = null;
  for (const id of ["cal-video", "thumb-video"]) $(id).srcObject = null;
  for (const id of ["cal-img", "thumb-img"]) $(id).removeAttribute("src");
}

// The camera was unplugged, taken by another app, or permission was revoked.
function cameraLost() {
  if (app.sessionEnded) return;
  app.cameraLost = true;
  app.sending = false;
  showBanner("The camera stopped. Readings are paused until it's back.", true);
  if (app.screen === "calibrate") $("cal-tip").textContent = "The camera stopped. Reconnect it to continue.";
}

async function reconnectCamera() {
  try {
    if (app.stream) for (const t of app.stream.getTracks()) t.stop();
    app.stream = null;
    await openCamera();
    app.sending = true;
    pump();
    showBanner("");
  } catch (e) {
    showBanner(cameraError(e), true);
  }
}

function cameraError(e) {
  switch (e && e.name) {
    case "NotAllowedError": return "Camera access is blocked. Click the camera icon in the address bar, allow it, then try again.";
    case "NotFoundError": return "No camera was found on this computer.";
    case "NotReadableError": return "The camera is busy. Close other apps using it (Zoom, FaceTime, app.py) and try again.";
    default: return e && e.message ? e.message : String(e);
  }
}

// Frames go to the server one at a time, each stamped with its capture time.
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

function pump() {
  if (!app.sending) return;
  const video = $("thumb-video");
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else setTimeout(() => onFrame(performance.now(), null), 33);
}

function onFrame(now, meta) {
  if (!app.sending) return;
  const video = $("thumb-video");
  if (app.inFlight < TEST.inflight && video.videoWidth) {
    const t = (meta && (meta.captureTime || meta.expectedDisplayTime)) || now;
    sendFrame(video, t);
  }
  pump();
}

// Upload statistics for ?diag: accepted uploads per second and round-trip time.
const upload = { okTimes: [], rtt: null, rejected: 0 };

async function sendFrame(video, tMs) {
  app.inFlight++;
  const started = performance.now();
  try {
    const w = video.videoWidth, h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(video, 0, 0, w, h);
    // toBlob snapshots the canvas synchronously, so a second upload can reuse it safely
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", TEST.jpeg));
    if (!blob) throw new Error("encode failed");
    const r = await fetch("/api/frame", {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Cuore-Client": "1",
        "X-Session": String(app.sessionId),
        "X-Capture-Time": (tMs / 1000).toFixed(4),
      },
      body: blob,
    });
    if (r.ok) {
      app.lastFrameOk = Date.now(); app.frameErrors = 0;
      const ms = performance.now() - started;
      upload.rtt = upload.rtt === null ? ms : upload.rtt * 0.8 + ms * 0.2;
      upload.okTimes.push(performance.now());
      if (upload.okTimes.length > 60) upload.okTimes.shift();
    } else if (r.status !== 409) { app.frameErrors++; upload.rejected++; }
  } catch (e) {
    app.frameErrors++;
  } finally {
    app.inFlight--;
  }
}

const uploadFps = () => {
  const t = upload.okTimes;
  return t.length < 2 ? null : (t.length - 1) / ((t[t.length - 1] - t[0]) / 1000);
};

// ---------------------------------------------------------------- camera controls
// Lock exposure and white balance after a 3 s warm-up, the method the original
// app.py used, but only where the browser and camera expose those controls.
// The result is read back from the camera, never assumed.
const camLock = { state: "pending", detail: "" };

async function lockCamera() {
  if (!TEST.lock) { camLock.state = "off"; camLock.detail = "disabled with ?lock=0"; return; }
  const track = app.stream && app.stream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== "function") {
    camLock.state = "unsupported"; camLock.detail = "this browser exposes no camera controls"; return;
  }
  const caps = track.getCapabilities(), before = track.getSettings();
  const adv = [];
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual")) {
    adv.push(before.exposureTime !== undefined ? { exposureMode: "manual", exposureTime: before.exposureTime } : { exposureMode: "manual" });
  }
  if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes("manual")) {
    adv.push(before.colorTemperature !== undefined ? { whiteBalanceMode: "manual", colorTemperature: before.colorTemperature } : { whiteBalanceMode: "manual" });
  }
  if (!adv.length) {
    camLock.state = "unsupported";
    camLock.detail = `camera offers exposure: ${caps.exposureMode ? caps.exposureMode.join("/") : "none"}, white balance: ${caps.whiteBalanceMode ? caps.whiteBalanceMode.join("/") : "none"}`;
    return;
  }
  try {
    await track.applyConstraints({ advanced: adv });
  } catch (e) {
    camLock.state = "failed"; camLock.detail = e.message || String(e); return;
  }
  const after = track.getSettings();
  const exp = after.exposureMode === "manual", wb = after.whiteBalanceMode === "manual";
  camLock.state = exp && wb ? "applied" : exp || wb ? "partial" : "failed";
  camLock.detail = `exposure ${after.exposureMode || "n/a"}, white balance ${after.whiteBalanceMode || "n/a"}`;
}

async function startSession() {
  const r = await fetch("/api/session/start", { method: "POST", headers: { "X-Cuore-Client": "1" } });
  if (!r.ok) throw new Error(`The CUORE server answered ${r.status}.`);
  const d = await r.json();
  app.sessionId = d.session_id;
  app.source = d.source;
  app.sessionStart = Date.now();
  app.sessionEnded = false;
  app.history = [];
  app.events = [];
  app.exercises = [];
  app.last = null;
  calibrationDone = false;
  lastCState = null;
  resetNotices();
  $("btn-back").hidden = false;
  if (app.source === "browser") { app.sending = true; pump(); }
}

async function begin() {
  app.source = await serverSource();
  if (app.source === "browser") {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't open the camera here. Use Chrome at http://127.0.0.1.");
    }
    if (!app.stream) await openCamera();
  } else {
    // Python owns the camera; show its stream instead.
    for (const id of ["cal-img", "thumb-img"]) { $(id).src = "/video?t=" + Date.now(); $(id).hidden = false; }
    for (const id of ["cal-video", "thumb-video"]) $(id).hidden = true;
  }
  await startSession();
  showScreen("calibrate");
}

async function onStart() {
  const btn = $("btn-start");
  btn.disabled = true;
  btn.textContent = "Waiting for camera…";
  $("start-error").hidden = true;
  try {
    await begin();
  } catch (e) {
    $("start-error").textContent = cameraError(e);
    $("start-error").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Start calibrating";
  }
}

function endSession() {
  closeBreathe();
  app.sessionEnded = true;
  stopCamera();
  $("btn-back").hidden = true;
  $("notice").hidden = true;
  showBanner("");
  showView("summary");
}

// ================================================================ signal quality (5 bars)

// rPPG mode reports quality 0-1; colour mode reports SNR in dB (-3 dB is its pass line).
function qualityLevel(d) {
  if (d.signal_quality !== null && d.signal_quality !== undefined) return { level: d.signal_quality, text: d.signal_quality.toFixed(2) };
  if (d.heart_snr_db !== null && d.heart_snr_db !== undefined) {
    return { level: Math.max(0, Math.min(1, (d.heart_snr_db + 6) / 16)), text: `${d.heart_snr_db.toFixed(1)} dB` };
  }
  return null;
}

function renderQuality(barsId, textId, d) {
  const q = qualityLevel(d);
  const bars = $(barsId);
  const on = q ? Math.max(1, Math.ceil(q.level * 5)) : 0;
  [...bars.children].forEach((b, i) => b.classList.toggle("on", i < on));
  bars.classList.toggle("good", d.signal_status === "good");
  bars.classList.toggle("weak", d.signal_status !== "good");
  $(textId).textContent = q ? q.text : "--";
}

// ================================================================ calibration

// ================================================================ per-metric status
// Each measurement reports its own availability from its own pipeline's checks.
// Nothing here relaxes a threshold: "provisional" is a value the estimator produced
// whose own quality measure is below its pass line, and it is shown as such.

const BASE_NAMES = { heart: "heart rate", breath: "breathing", blink: "blinks" };

function metricStatus(d) {
  const dg = d.diag || {};
  const face = !!d.face_found;
  const q = qualityLevel(d);
  const qText = q ? q.text : "--";

  let heart;
  if (!face) heart = { state: "none", text: "no face in view" };
  else if (d.heart_rate === null) heart = { state: "collecting", text: "measuring · about 10 s of steady signal" };
  else if (d.signal_status === "good") heart = { state: "reliable", text: `reliable · heart signal ${qText}` };
  else heart = { state: "provisional", text: `provisional · heart signal ${qText}, below its pass line` };

  let breath;
  const buf = dg.breathing_buffer_sec;
  if (d.breathing_rate !== null) {
    const conf = dg.breathing_snr_db !== null && dg.breathing_snr_db !== undefined ? ` · confidence ${dg.breathing_snr_db.toFixed(1)} dB` : "";
    breath = d.breathing_channel === "head"
      ? { state: "reliable", text: `from head motion${conf} · show your shoulders for a cleaner reading` }
      : { state: "reliable", text: `from chest motion${conf}` };
  } else if (!face) breath = { state: "none", text: "paused · no face in view" };
  else if (buf !== undefined && buf !== null && buf < 20) breath = { state: "collecting", text: `collecting · ${Math.floor(buf)} of 20 s` };
  else if (buf !== undefined && buf !== null) breath = { state: "unavailable", text: "temporarily unavailable · breathing motion not clear enough" };
  else breath = { state: "collecting", text: "collecting · about 20 s" };

  let blink;
  const win = dg.blink_window_sec, ratio = dg.face_ratio_60s;
  const missing = ratio !== undefined && ratio !== null && ratio < 0.8 ? ` · face missing ${Math.round((1 - ratio) * 100)}% of the last minute` : "";
  if (d.blink_rate === null) {
    blink = face ? { state: "collecting", text: `collecting${win !== undefined && win !== null ? ` · ${Math.floor(win)} of 10 s` : " · about 10 s"}` }
      : { state: "none", text: "insufficient face-landmark data" };
  } else if (win !== undefined && win !== null && win < 60) {
    blink = { state: "provisional", text: `provisional · counted over ${Math.floor(win)} of 60 s${missing}` };
  } else {
    blink = { state: missing ? "provisional" : "reliable", text: `counted over the last 60 s${missing}` };
  }
  return { heart, breath, blink };
}

// Baseline progress for one metric, from the server's per-metric baseline record.
function baselineText(d, key, digits, unit) {
  const m = d.baseline && d.baseline.metrics ? d.baseline.metrics[key] : null;
  if (!m) {
    const v = d.baseline ? d.baseline[{ heart: "heart_rate", breath: "breathing_rate", blink: "blink_rate" }[key]] : null;
    return v === null || v === undefined ? "baseline learning" : `baseline ${v.toFixed(digits)} ${unit}`;
  }
  if (m.ready) return null;   // caller shows the delta against the ready baseline
  if (!m.valid_sec) return "baseline · waiting for valid readings";
  return `baseline learning · ${Math.floor(m.valid_sec)} of ${m.need_valid_sec} s valid, ${Math.floor(m.elapsed_sec)} of ${m.need_elapsed_sec} s`;
}

function composureBasis(c) {
  if (!c) return "";
  if (c.state === "calibrating") return "No baseline is ready yet.";
  if (c.state === "insufficient") {
    const used = c.used && c.used.length ? `Only ${c.used.map((k) => BASE_NAMES[k]).join(" and ")} can be compared so far.` : "No measurement can be compared yet.";
    return `${used} At least two are needed.`;
  }
  if (c.used && c.used.length) return `Based on ${c.used.map((k) => BASE_NAMES[k]).join(", ")}.`;
  return "";
}

// first valid live reading of any kind opens the dashboard; baselines keep learning
function hasLiveReading(d) {
  return (d.heart_rate !== null && d.signal_status === "good") || d.breathing_rate !== null || d.blink_rate !== null;
}

function renderCalibration(d) {
  const fresh = d.updated_at !== null && d.server_time - d.updated_at < STALE_SEC;
  const st = metricStatus(d);
  const checks = {
    camera: app.source === "browser" ? Date.now() - app.lastFrameOk < 2000 : fresh,
    face: d.face_found,
    heart: st.heart.state === "reliable" || st.heart.state === "provisional",
    breath: st.breath.state === "reliable",
    blink: d.blink_rate !== null,
    signal: d.signal_status === "good",
  };
  for (const li of $("checklist").children) {
    li.classList.toggle("ok", !!checks[li.dataset.check]);
    const small = li.querySelector("small"), key = li.dataset.check;
    if (st[key]) { small.textContent = st[key].text; small.dataset.state = st[key].state; }
  }
  document.querySelector(".face-guide").classList.toggle("ok", !!d.face_found);
  $("cal-face").textContent = d.face_found ? "face found" : "looking for your face";
  renderQuality("cal-q", "cal-q-text", d);

  // The ring now counts toward the first live reading (about 10 s), not a full baseline.
  const secs = app.sessionStart ? (Date.now() - app.sessionStart) / 1000 : 0;
  const frac = Math.min(1, secs / 12);
  $("ring-secs").textContent = String(Math.floor(secs));
  $("ring-sub").textContent = "until the first reading";
  $("ring-bar").style.strokeDashoffset = String(RING_LEN * (1 - frac));
  const ticks = document.querySelectorAll(".ring-ticks line");
  ticks.forEach((t, i) => t.classList.toggle("on", i < Math.round(frac * ticks.length)));

  let tip = TIPS[Math.floor(app.tick / 6) % TIPS.length];
  if (app.cameraLost) tip = "The camera stopped. Reconnect it to continue.";
  else if (!checks.camera && app.source === "browser") tip = "Waiting for camera frames. Allow camera access if Chrome is asking.";
  else if (!checks.face) tip = "We can't see your face yet. Face the camera and move into the oval.";
  else if (d.signal_status === "weak") tip = "Heart signal is weak. Hold still and keep steady light on your face. Breathing and blinks measure independently.";
  $("cal-tip").textContent = tip;

  if (hasLiveReading(d) && !calibrationDone) {
    calibrationDone = true;
    // C: the ring closes and grows into the live dial before the screen changes
    if (app.style === "living" && !app.reduceMotion) {
      $("screen-calibrate").classList.add("complete");
      setTimeout(() => { $("screen-calibrate").classList.remove("complete"); showScreen("app"); showView("live"); }, 760);
    } else {
      showScreen("app"); showView("live");
    }
  }
}
let calibrationDone = false;

// ================================================================ static drawing

function buildStatic() {
  // calibration ring: one tick per second of the baseline minute
  const rt = document.querySelector(".ring-ticks");
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    rt.appendChild(svg("line", { x1: 60 + 56 * Math.cos(a), y1: 60 + 56 * Math.sin(a), x2: 60 + 59 * Math.cos(a), y2: 60 + 59 * Math.sin(a) }));
  }
  // halo: a dial of 72 ticks, every 6th major
  const ht = document.querySelector(".halo-ticks");
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2 - Math.PI / 2;
    const major = i % 6 === 0;
    const r1 = major ? 186 : 190;
    ht.appendChild(svg("line", { x1: 200 + r1 * Math.cos(a), y1: 200 + r1 * Math.sin(a), x2: 200 + 196 * Math.cos(a), y2: 200 + 196 * Math.sin(a), class: major ? "major" : "" }));
  }
  // one grid line per second on the 6 s pulse strip
  const grid = document.querySelector(".wave-grid");
  for (let s = 1; s < 6; s++) grid.appendChild(svg("line", { x1: s * 100, x2: s * 100, y1: 0, y2: 80 }));
}

// ================================================================ live

function sparkline(el, wave) {
  const vals = wave && wave.values ? wave.values : [];
  const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 2) { el.setAttribute("points", ""); return; }
  const box = el.ownerSVGElement.viewBox.baseVal;
  let lo = Infinity, hi = -Infinity;
  for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = hi - lo || 1, n = vals.length - 1 || 1, pad = 6;
  el.setAttribute("points", pts.map(([i, v]) =>
    `${(i / n * box.width).toFixed(1)},${(pad + (1 - (v - lo) / span) * (box.height - 2 * pad)).toFixed(1)}`).join(" "));
}

// The halo: the measured pulse wave (last 6 s) wrapped around the heart.
function renderHalo(wave) {
  const vals = wave && wave.values ? wave.values.filter((v) => v !== null) : [];
  const inst = document.querySelector(".instrument");
  if (vals.length < 8) { $("halo-path").setAttribute("d", ""); inst.classList.add("idle"); return; }
  inst.classList.remove("idle");
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = hi - lo || 1, n = vals.length;
  const d = vals.map((v, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = 168 + ((v - lo) / span - 0.5) * 16;
    return `${i ? "L" : "M"}${(200 + r * Math.cos(a)).toFixed(1)},${(200 + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ") + " Z";
  $("halo-path").setAttribute("d", d);
}

// The tide: the measured breathing wave (last 30 s) across the page.
function renderTideInto(id, wave) {
  const vals = wave && wave.values ? wave.values : [];
  const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 2) { $(id).setAttribute("d", "M0,28 L1200,28"); return; }
  let lo = Infinity, hi = -Infinity;
  for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = hi - lo || 1, n = vals.length - 1 || 1;
  $(id).setAttribute("d", pts.map(([i, v], k) =>
    `${k ? "L" : "M"}${(i / n * 1200).toFixed(1)},${(6 + (1 - (v - lo) / span) * 44).toFixed(1)}`).join(" "));
}
const renderTide = (wave) => renderTideInto("tide-path", wave);

// Heart and glow share one --beat from the measured BPM. No reading: still.
function setHeartBeat(bpm) {
  const live = bpm !== null && bpm > 0;
  const stage = $("live-heart");
  if (live) stage.style.setProperty("--beat", (60 / bpm).toFixed(3) + "s");
  stage.classList.toggle("beating", live);
}

function renderLive(d) {
  const hr = d.heart_rate, b = d.baseline;
  const st = metricStatus(d);
  const reliable = st.heart.state === "reliable";
  const provisional = st.heart.state === "provisional";
  $("hero-bpm").textContent = fmt(hr, 0);
  $("hero-bpm").classList.toggle("empty", hr === null);
  $("hero-bpm").classList.toggle("provisional", provisional);
  let delta;
  if (hr === null) delta = st.heart.text[0].toUpperCase() + st.heart.text.slice(1);
  else if (provisional) delta = `Provisional: heart signal below its pass line`;
  else if (b.heart_rate !== null) {
    const diff = Math.round(hr - b.heart_rate);
    delta = diff === 0 ? `At your baseline of ${b.heart_rate.toFixed(0)}`
      : `${Math.abs(diff)} ${diff > 0 ? "above" : "below"} your baseline of ${b.heart_rate.toFixed(0)}`;
  } else delta = baselineText(d, "heart", 0, "bpm") || "Baseline learning";
  $("hero-delta").textContent = delta;
  renderQuality("hero-q", "hero-q-text", d);
  // the heart and its ring only animate on a reliable reading
  setHeartBeat(reliable ? hr : null);
  renderHalo(reliable || provisional ? d.pulse_wave : null);
  document.querySelector(".instrument").classList.toggle("weak", provisional);
  renderTide(d.breath_wave);
  $("tide-label").textContent = `breathing · ${st.breath.text}`;
  $("heart-caption").textContent = hr === null ? "Waiting for a heart rate. The heart stays still until there's a real reading."
    : provisional ? `Heart signal weak (${qualityLevel(d) ? qualityLevel(d).text : "--"}). The rate is provisional, so the heart isn't animated. The dashed ring is the unreliable pulse wave.`
    : `The heart beats at your measured average, ${hr.toFixed(0)} bpm. The ring is your pulse wave from the last 6 s.`;

  // sections
  $("sec-hr-v").textContent = fmt(hr, 0);
  $("sec-hr-base").textContent = b.heart_rate === null ? "--" : `${b.heart_rate.toFixed(0)} bpm`;
  const q = qualityLevel(d);
  $("sec-hr-q").textContent = q ? (d.signal_quality !== null ? `${q.text} of 1` : q.text) : "--";
  sparkline($("pulse-spark"), d.pulse_wave);
  const avg = d.average_heart_rate;
  if (avg) {
    const value = avg.done ? avg.result : avg.running_average;
    $("avg-v").textContent = fmt(value, 0);
    $("hs-avg").textContent = value === null ? "--" : `${value.toFixed(0)} bpm${avg.done ? "" : " so far"}`;
    $("avg-span").textContent = `over ${mmss(avg.duration_sec)}`;
    $("avg-bar").style.width = `${Math.round((avg.progress || 0) * 100)}%`;
    $("avg-sub").textContent = avg.done ? `Final, from ${avg.readings} readings`
      : avg.readings === 0 ? "Waiting for heart rate"
      : `Recording ${mmss(avg.recorded_sec)} of ${mmss(avg.duration_sec)}` + (avg.paused ? " · paused" : "");
  }
  $("sec-br-v").textContent = fmt(d.breathing_rate, 1);
  $("sec-br-base").textContent = b.breathing_rate === null ? "--" : `${b.breathing_rate.toFixed(1)} /min`;
  $("sec-br-src").textContent = d.breathing_channel === "head" ? "From head motion · show your shoulders for better" : "From chest motion · optical flow";
  sparkline($("breath-spark"), d.breath_wave);
  $("sec-bl-v").textContent = fmt(d.blink_rate, 0);
  $("sec-bl-base").textContent = b.blink_rate === null ? "--" : `${b.blink_rate.toFixed(0)} /min`;

  const fps = d.processed_fps;
  $("fps").textContent = d.camera_fps === null ? "" :
    `camera ${fmt(d.camera_fps, 0)} fps · processed ${fmt(fps, 0)} fps` + (fps !== null && fps < 15 ? " · needs 15+" : "");

  renderComposure(d);
}

// ================================================================ C · Cardiac Dial
// Measured layers only: rate scale (40–160 bpm over 240°), baseline notch, elevated
// band (baseline +15 % up to 160), needle at the measured average, and the real
// 6 s pulse wave as the inner trace. The heart's beat and the aura are atmosphere,
// paced by the measured average and shown only while the signal is good.

const SCALE = { min: 40, max: 160, start: -120, sweep: 240 };
const RING = { segments: 60, segSec: 10 };          // rolling 10 min, newest at 12 o'clock
const polar = (r, deg) => {
  const a = deg * Math.PI / 180;
  return [200 + r * Math.sin(a), 200 - r * Math.cos(a)];
};
const arcPath = (r, a0, a1) => {
  const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const bpmAngle = (bpm) => SCALE.start + (Math.min(SCALE.max, Math.max(SCALE.min, bpm)) - SCALE.min) / (SCALE.max - SCALE.min) * SCALE.sweep;
let ringSegs = [];
let traceFlip = false;

function buildDial() {
  const scale = $("rate-scale");
  scale.appendChild(svg("path", { class: "arc", d: arcPath(172, SCALE.start, SCALE.start + SCALE.sweep) }));
  for (let bpm = SCALE.min; bpm <= SCALE.max; bpm += 5) {
    const major = bpm % 20 === 0, a = bpmAngle(bpm);
    const [x1, y1] = polar(major ? 163 : 167, a), [x2, y2] = polar(major ? 177 : 173, a);
    scale.appendChild(svg("line", { x1, y1, x2, y2, class: major ? "major" : "" }));
    if (major) {
      const [tx, ty] = polar(153, a);
      const t = svg("text", { x: tx, y: ty + 3.5, "text-anchor": "middle" });
      t.textContent = String(bpm);
      scale.appendChild(t);
    }
  }
  const ring = $("sess-ring");
  ringSegs = [];
  for (let i = 0; i < RING.segments; i++) {
    const a1 = -i * 6 - 0.7, a0 = -(i + 1) * 6 + 0.7;
    const p = svg("path", { d: arcPath(192, a0, a1), class: "empty" });
    ring.appendChild(p);
    ringSegs.push(p);
  }
  for (let m = 0; m < 10; m++) {                     // a mark at each minute boundary
    const [x1, y1] = polar(186, -m * 36), [x2, y2] = polar(198, -m * 36);
    ring.appendChild(svg("line", { x1, y1, x2, y2 }));
  }
  const now = svg("text", { x: 200, y: 19, "text-anchor": "middle", class: "now" });
  now.textContent = "now";
  const back = svg("text", { x: 200, y: 386, "text-anchor": "middle" });
  back.textContent = "−5 min";
  ring.append(now, back);
}

function dialState(d) {
  if (!d.face_found || d.heart_rate === null) return "none";
  return d.signal_status === "good" ? "good" : "weak";
}

function renderTrace(wave, state) {
  const vals = wave && wave.values ? wave.values.filter((v) => v !== null) : [];
  if (state === "none" || vals.length < 8) { $("trace-a").setAttribute("d", ""); $("trace-b").setAttribute("d", ""); return; }
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = hi - lo || 1, n = vals.length;
  const d = vals.map((v, i) => {
    const [x, y] = polar(128 + ((v - lo) / span - 0.5) * 18, (i / n) * 360);
    return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ") + " Z";
  // Cross-fade the previous sample into the new one. Shapes are never interpolated,
  // so no in-between wave is ever drawn that wasn't measured.
  traceFlip = !traceFlip;
  const incoming = $(traceFlip ? "trace-b" : "trace-a"), outgoing = $(traceFlip ? "trace-a" : "trace-b");
  incoming.setAttribute("d", d);
  incoming.classList.add("on");
  outgoing.classList.remove("on");
}

function renderRing() {
  const now = (Date.now() - app.sessionStart) / 1000;
  const buckets = ringSegs.map(() => ({ calm: 0, elevated: 0, other: 0 }));
  for (let k = app.history.length - 1; k >= 0; k--) {
    const s = app.history[k], age = now - s.t;
    if (age >= RING.segments * RING.segSec) break;
    const b = buckets[Math.floor(Math.max(0, age) / RING.segSec)];
    if (s.state === "calm") b.calm++; else if (s.state === "elevated") b.elevated++; else b.other++;
  }
  buckets.forEach((b, i) => {
    const total = b.calm + b.elevated + b.other;
    const cls = total === 0 ? "empty" : b.elevated && b.elevated >= b.calm ? "elevated" : b.calm ? "calm" : "none";
    if (ringSegs[i].getAttribute("class") !== cls) ringSegs[i].setAttribute("class", cls);
  });
}

function renderDial(d) {
  const dial = $("dial"), hr = d.heart_rate, base = d.baseline.heart_rate;
  const state = dialState(d);
  dial.dataset.state = state;
  dial.dataset.composure = d.composure.state || "calibrating";
  const needle = $("needle");
  let note = "";
  if (hr !== null) {
    needle.style.transform = `rotate(${bpmAngle(hr).toFixed(2)}deg)`;
    needle.classList.toggle("over", hr > SCALE.max);
    needle.classList.toggle("under", hr < SCALE.min);
    if (hr > SCALE.max) note = `above scale · ${hr.toFixed(0)} bpm`;
    if (hr < SCALE.min) note = `below scale · ${hr.toFixed(0)} bpm`;
  }
  $("range-note").textContent = note;

  const mark = $("base-mark");
  if (base !== null) {
    const a = bpmAngle(base), [x, y] = polar(183, a);
    mark.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(a + 180).toFixed(1)})`);
    mark.setAttribute("visibility", "visible");
    // elevated threshold: a thin line just outside the scale from baseline +15 % to the top,
    // starting with a clear tick and a "+15 %" label
    const thr = base * 1.15, zs = $("zone-start");
    if (thr < SCALE.max) {
      const at = bpmAngle(thr);
      $("zone-elev").setAttribute("d", arcPath(180, at, SCALE.start + SCALE.sweep));
      const [x1, y1] = polar(176, at), [x2, y2] = polar(186, at);
      zs.setAttribute("x1", x1); zs.setAttribute("y1", y1); zs.setAttribute("x2", x2); zs.setAttribute("y2", y2);
      

      zs.setAttribute("visibility", "visible");
    } else {
      $("zone-elev").setAttribute("d", "");
      zs.setAttribute("visibility", "hidden");
    }
  } else {
    mark.setAttribute("visibility", "hidden");
    $("zone-elev").setAttribute("d", "");
    $("zone-start").setAttribute("visibility", "hidden");
  }
  renderTrace(d.pulse_wave, state);
  renderRing();

  const stage = $("c-heart");
  if (state === "good") { const beat = (60 / hr).toFixed(3) + "s"; stage.style.setProperty("--beat", beat); dial.style.setProperty("--beat", beat); }
  stage.classList.toggle("beating", state === "good");

  const legend = base !== null
    ? `▲ baseline ${base.toFixed(0)}` + (base * 1.15 < SCALE.max ? ` · ━ elevated above ${(base * 1.15).toFixed(0)}` : "")
    : "baseline appears after calibration";
  const caption = state === "good"
    ? `${legend}\nbeat paced at the measured average · inner line: pulse wave, last 6 s`
    : state === "weak" ? `${legend}\nsignal weak · the line and rate may be unreliable` : `${legend}\nno heart rate yet`;
  $("dial-caption").textContent = caption;
  const alert = $("dial-alert");
  const alertText = !d.face_found ? "No face in view. Face the camera."
    : state === "weak" ? "Signal weak. Readings are unreliable until it steadies. Hold still, keep the light even." : "";
  alert.textContent = alertText;
  alert.hidden = !alertText;

  const thrText = base !== null ? `, elevated above ${(base * 1.15).toFixed(0)}` : "";
  $("dial-desc").textContent = hr === null ? "No heart rate yet."
    : `Heart rate ${hr.toFixed(0)} bpm${base !== null ? `, baseline ${base.toFixed(0)}` : ""}${thrText}. Signal ${state === "good" ? "good" : "weak, readings unreliable"}.${note ? " " + note + "." : ""}`;
}

// ================================================================ C · readouts + drawer

function setValue(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (app.reduceMotion) return;
  el.classList.remove("value-tick");
  void el.offsetWidth;                               // restart the short settle animation
  el.classList.add("value-tick");
}

function deltaText(now, base, digits, unit) {
  if (base === null || base === undefined) return "baseline after calibration";
  if (now === null) return `baseline ${base.toFixed(digits)} ${unit}`;
  const diff = now - base, r = Number(diff.toFixed(digits));
  const sign = r > 0 ? "+" : r < 0 ? "−" : "±";
  return `${sign}${Math.abs(r).toFixed(digits)} vs baseline ${base.toFixed(digits)}`;
}

let lastCState = null;

function renderLiveC(d) {
  const b = d.baseline, c = d.composure;
  setValue($("c2-hr"), fmt(d.heart_rate, 0));
  setValue($("c2-br"), fmt(d.breathing_rate, 1));
  setValue($("c2-bl"), fmt(d.blink_rate, 0));
  // each readout: its own baseline progress or delta, and its own status line
  const st = metricStatus(d);
  const rows = [
    [".ro-hr", "c2-hr", "heart", "heart_rate", 0, "bpm", c.hr_high],
    [".ro-br", "c2-br", "breath", "breathing_rate", 1, "/min", c.breath_high],
    [".ro-bl", "c2-bl", "blink", "blink_rate", 0, "/min", c.blink_low],
  ];
  for (const [sel, id, key, field, digits, unit, flag] of rows) {
    const el = document.querySelector(sel), s = st[key];
    const learning = baselineText(d, key, digits, unit);
    let dText = learning === null ? deltaText(d[field], b[field], digits, unit) : learning;
    if (key === "blink" && c.blink_baseline_too_low) dText = "blink baseline too low to judge";
    $(id + "-d").textContent = dText;
    $(id + "-s").textContent = s.text;
    $(id + "-s").dataset.state = s.state;
    el.classList.toggle("flagged", flag === true);
    el.classList.toggle("provisional", s.state === "provisional" && d[field] !== null);
    el.classList.toggle("absent", d[field] === null);
    el.querySelector(".ro-d").classList.toggle("up", flag === true);
  }
  renderQuality("c2-q", "c2-q-text", d);
  $("c2-q-text").textContent = "heart signal " + $("c2-q-text").textContent;

  const state = c.state;
  const pill = $("c2-state");
  pill.dataset.state = state === null ? "unknown" : state;
  pill.textContent = state === null ? "no reading" : state === "calibrating" ? "learning baseline" : state === "insufficient" ? "insufficient data" : state;
  let note = state === null ? "No current readings to compare."
    : state === "elevated" ? "You've drifted from your usual rhythm."
    : state === "calm" ? "Steady. Within your usual range."
    : state === "insufficient" ? "Not enough measurements to judge composure yet."
    : "Learning your baseline.";
  if (c.blink_baseline_too_low) note += " Blinks aren't used: your blink baseline is too low to judge.";
  $("c2-basis").textContent = composureBasis(c);
  if ($("c2-note").textContent !== note) {
    $("c2-note").textContent = note;
    if (lastCState !== null && state !== lastCState && !app.reduceMotion) {
      const st = $("c2-statement");
      st.classList.remove("shift"); void st.offsetWidth; st.classList.add("shift");
    }
  }
  lastCState = state;

  renderDial(d);
  renderTideInto("tide-c", d.breath_wave);
  $("tide-c-label").textContent = d.breathing_rate === null ? "breathing · measured · waiting for 20 s of signal"
    : `breathing · measured · last 30 s · from your ${d.breathing_channel}`;
  const fps = d.processed_fps;
  $("fps-c").textContent = d.camera_fps === null ? "" :
    `outer ring: last 10 min, 10 s per mark, newest at top · camera ${fmt(d.camera_fps, 0)} fps · processed ${fmt(fps, 0)} fps` + (fps !== null && fps < 15 ? " · needs 15+" : "");
  if (!$("drawer").hidden) updateDrawer(d);
}

const DRAWER = {
  heart_rate: { title: "Heart rate", kicker: "From skin colour · rPPG", unit: "bpm", digits: 0, wave: "pulse_wave", waveTitle: "Pulse wave", waveMeta: "measured · last 6 s",
    explain: (b) => `Estimated from tiny colour changes in your skin. It's an average over the last few seconds, not individual beats.${b !== null ? ` Your baseline is ${b.toFixed(0)} bpm; it counts as raised above ${(b * 1.15).toFixed(0)}.` : ""}` },
  breathing_rate: { title: "Breathing", kicker: "From chest motion · optical flow", unit: "/min", digits: 1, wave: "breath_wave", waveTitle: "Breathing wave", waveMeta: "measured · last 30 s",
    explain: (b) => `Measured from the rise and fall of your chest (or head if your shoulders aren't visible), averaged over 30 seconds, so it trails real changes.${b !== null ? ` Your baseline is ${b.toFixed(1)}/min; it counts as raised above ${(b * 1.25).toFixed(1)}.` : ""}` },
  blink_rate: { title: "Blinks", kicker: "From eye landmarks", unit: "/min", digits: 0, wave: null,
    explain: (b) => `Counted over the last 60 seconds from the openness of your eyes.${b !== null ? ` Your baseline is ${b.toFixed(0)}/min; it counts as low below ${(b * 0.6).toFixed(1)} and at least 3/min under it.` : ""}` },
};
let drawerMetric = null;

function openDrawer(metric, btn) {
  drawerMetric = metric;
  const m = DRAWER[metric];
  $("drawer-title").textContent = m.title;
  $("drawer-kicker").textContent = m.kicker;
  $("drawer-u").textContent = m.unit;
  $("drawer-chart").dataset.trend = metric;
  $("drawer-chart").setAttribute("aria-label", `${m.title} over this session`);
  $("drawer-wave-fig").hidden = !m.wave;
  if (m.wave) { $("drawer-wave-title").textContent = m.waveTitle; $("drawer-wave-meta").textContent = m.waveMeta; }
  $("drawer-wave").classList.toggle("heart", metric === "heart_rate");
  for (const r of document.querySelectorAll(".ro")) r.setAttribute("aria-expanded", String(r === btn));
  if ($("drawer").hidden) openDialog($("drawer"), $("drawer-close"));
  if (app.last) updateDrawer(app.last);
  renderCharts();
}

function updateDrawer(d) {
  const m = DRAWER[drawerMetric];
  if (!m) return;
  $("drawer-v").textContent = fmt(d[drawerMetric], m.digits);
  $("drawer-explain").textContent = m.explain(d.baseline[drawerMetric]);
  if (m.wave) sparkline($("drawer-wave"), d[m.wave]);
}

function closeDrawer() {
  if ($("drawer").hidden) return;
  for (const r of document.querySelectorAll(".ro")) r.setAttribute("aria-expanded", "false");
  closeDialog($("drawer"));
  drawerMetric = null;
}

// ================================================================ composure

const ROWS = [
  { row: "r-heart", flag: "hr_high", key: "heart_rate", digits: 0, unit: " bpm",
    reason: (d) => `Heart rate ${fmt(d.heart_rate, 0)} bpm, your baseline is ${fmt(d.baseline.heart_rate, 0)}` },
  { row: "r-breath", flag: "breath_high", key: "breathing_rate", digits: 1, unit: " /min",
    reason: (d) => `Breathing ${fmt(d.breathing_rate, 1)} /min, your baseline is ${fmt(d.baseline.breathing_rate, 1)}` },
  { row: "r-blink", flag: "blink_low", key: "blink_rate", digits: 0, unit: " /min",
    reason: (d) => `Blinking ${fmt(d.blink_rate, 0)} /min, your baseline is ${fmt(d.baseline.blink_rate, 0)}` },
];

const reasons = (d) => ROWS.filter((r) => d.composure[r.flag] === true).map((r) => r.reason(d));

function renderComposure(d) {
  const c = d.composure, b = d.baseline, state = c.state;
  const pill = $("c-state");
  pill.dataset.state = state === null ? "unknown" : state;
  pill.textContent = state === null ? "No reading" : state === "calibrating" ? "learning baseline" : state === "insufficient" ? "insufficient data" : state;
  let note = state === null ? "No current readings to compare."
    : state === "elevated" ? "You've drifted from your usual rhythm."
    : state === "calm" ? "Steady. You're within your usual range."
    : state === "insufficient" ? "Not enough data to judge yet."
    : "Learning your baseline.";
  $("c-note").textContent = note;
  // the reason goes on its own smaller line, so the statement stays short
  let basis = composureBasis(c);
  if (c.blink_baseline_too_low) basis += " Blinks aren't used: your blink baseline is too low to judge.";
  $("c-basis").textContent = basis.trim();

  const st = metricStatus(d);
  const statusKey = { "r-heart": "heart", "r-breath": "breath", "r-blink": "blink" };
  for (const r of ROWS) {
    const row = $(r.row), flag = c[r.flag], now = d[r.key], base = b[r.key];
    const s = st[statusKey[r.row]];
    row.querySelector("[data-now]").textContent = now === null ? "--" : fmt(now, r.digits) + r.unit;
    row.querySelector("[data-base]").textContent = base === null ? "baseline learning" : `baseline ${fmt(base, r.digits)}`;
    row.classList.toggle("provisional", s.state === "provisional" && now !== null);
    row.title = s.text;
    const cell = row.querySelector("[data-flag]");
    const tooLow = r.flag === "blink_low" && c.blink_baseline_too_low;
    cell.textContent = flag === true ? "shifted" : flag === false ? "ok" : tooLow ? "n/a" : "–";
    cell.className = "flag" + (flag === true ? " on" : flag === false ? " ok" : "");
    row.classList.toggle("flagged", flag === true);
    // bar: now on a scale of twice the baseline, so the baseline tick sits at the middle
    const scale = base ? base * 2 : (now || 1) * 2;
    row.querySelector(".now").style.width = now === null ? "0%" : `${Math.min(100, now / scale * 100)}%`;
    row.querySelector(".base").style.opacity = base ? "" : "0";
  }
}

// ================================================================ pop-up + moments

let lastState = null, armed = true, calmSince = null, unread = 0;

function resetNotices() {
  lastState = null; armed = true; calmSince = null; unread = 0;
  $("notice").hidden = true;
  $("bell-badge").hidden = true;
  $("notif-list").replaceChildren();
  $("notif-empty").hidden = false;
}

function momentItem(kind, title, lines, when) {
  const li = document.createElement("li");
  li.className = kind;
  const time = document.createElement("time");
  time.textContent = when;
  const strong = document.createElement("b");
  strong.textContent = title;
  li.append(time, strong);
  for (const text of lines) {
    const div = document.createElement("div");
    div.textContent = text;
    li.appendChild(div);
  }
  return li;
}

function addNotification(kind, title, lines) {
  const when = mmss((Date.now() - app.sessionStart) / 1000);
  $("notif-list").prepend(momentItem(kind, title, lines, when));
  $("notif-empty").hidden = true;
  if ($("notif-panel").hidden) {
    unread++;
    $("bell-badge").textContent = String(unread);
    $("bell-badge").hidden = false;
  }
}

function updateNotice(d) {
  const state = d.composure.state;
  const now = Date.now();
  if (state === "calm") {
    if (calmSince === null) calmSince = now;
    if (now - calmSince >= REARM_CALM_MS) armed = true;
  } else {
    calmSince = null;
  }
  if (state === "elevated" && lastState !== "elevated") {
    const why = reasons(d);
    app.events.push({ t: (now - app.sessionStart) / 1000, reasons: why });
    addNotification("elevated", "Shifted from your baseline", why);
    if (armed && app.view !== "summary" && $("breathe").hidden) {
      $("notice-reasons").replaceChildren(...why.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
      $("notice").hidden = false;
      armed = false;
    }
  }
  if (state === "calm" && lastState === "elevated") addNotification("calm", "Back within your usual range", []);
  if (state !== null) lastState = state;   // a missing reading doesn't count as a switch
}

// ================================================================ session charts (with hover readout)

function chart(svgEl, samples, key, baseline) {
  const w = Math.max(320, svgEl.clientWidth || 900), h = 190;
  svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const pts = samples.filter((s) => s[key] !== null);
  svgEl.replaceChildren();
  svgEl.__chart = null;
  if (pts.length < 2) return false;

  const tMax = Math.max(60, samples[samples.length - 1].t);
  let lo = Math.min(...pts.map((s) => s[key])), hi = Math.max(...pts.map((s) => s[key]));
  if (baseline !== null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  const margin = Math.max(1, (hi - lo) * 0.15);
  lo = Math.max(0, lo - margin); hi += margin;
  const x = (t) => pad.l + (t / tMax) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  const bands = svg("g");
  let start = null;
  samples.forEach((s, i) => {
    const on = s.state === "elevated";
    if (on && start === null) start = s.t;
    if ((!on || i === samples.length - 1) && start !== null) {
      bands.appendChild(svg("rect", { class: "band", x: x(start), y: pad.t, width: Math.max(2, x(s.t) - x(start)), height: h - pad.t - pad.b }));
      start = null;
    }
  });
  const grid = svg("g", { class: "grid" }), axis = svg("g", { class: "axis" });
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    grid.appendChild(svg("line", { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }));
    const label = svg("text", { x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = v.toFixed(0);
    axis.appendChild(label);
  }
  const step = tMax > 600 ? 120 : tMax > 240 ? 60 : 30;
  for (let t = 0; t <= tMax; t += step) {
    const label = svg("text", { x: x(t), y: h - 4, "text-anchor": "middle" });
    label.textContent = mmss(t);
    axis.appendChild(label);
  }
  const series = svg("g");
  let run = [];
  const flush = () => { if (run.length > 1) series.appendChild(svg("polyline", { class: "series", points: run.join(" ") })); run = []; };
  for (const s of samples) {
    if (s[key] === null) flush(); else run.push(`${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`);
  }
  flush();
  svgEl.append(bands, grid, axis, series);
  if (baseline !== null) {
    svgEl.appendChild(svg("line", { class: "baseline", x1: pad.l, x2: w - pad.r, y1: y(baseline), y2: y(baseline) }));
    const bl = svg("text", { class: "base-label", x: pad.l + 6, y: y(baseline) - 6, "text-anchor": "start" });
    bl.textContent = `baseline ${baseline.toFixed(key === "breathing_rate" ? 1 : 0)}`;
    svgEl.appendChild(bl);
  }
  const cross = svg("line", { class: "cross", y1: pad.t, y2: h - pad.b, visibility: "hidden" });
  const dot = svg("circle", { class: "dot", r: 4, visibility: "hidden" });
  dot.style.stroke = getComputedStyle(svgEl.querySelector(".series") || svgEl).stroke;
  svgEl.append(cross, dot);
  svgEl.__chart = { samples, key, x, y, w, cross, dot, pad };
  return true;
}

function chartHover(svgEl, tip, e) {
  const c = svgEl.__chart;
  if (!c) return;
  const rect = svgEl.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (c.w / rect.width);
  let best = null, bestDist = Infinity;
  for (const s of c.samples) {
    if (s[c.key] === null) continue;
    const dist = Math.abs(c.x(s.t) - px);
    if (dist < bestDist) { bestDist = dist; best = s; }
  }
  if (!best) return;
  const cx = c.x(best.t), cy = c.y(best[c.key]);
  c.cross.setAttribute("x1", cx); c.cross.setAttribute("x2", cx); c.cross.setAttribute("visibility", "visible");
  c.dot.setAttribute("cx", cx); c.dot.setAttribute("cy", cy); c.dot.setAttribute("visibility", "visible");
  const unit = { heart_rate: "bpm", breathing_rate: "/min", blink_rate: "/min" }[c.key];
  const state = best.state === "elevated" ? " · shifted" : best.state === "calm" ? " · calm" : "";
  tip.textContent = `${mmss(best.t)} · ${best[c.key].toFixed(c.key === "breathing_rate" ? 1 : 0)} ${unit}${state}`;
  tip.style.left = `${(cx / c.w) * rect.width}px`;
  tip.style.top = `${Math.max(0, (cy / 190) * rect.height - 40)}px`;
  tip.hidden = false;
}

function chartLeave(svgEl, tip) {
  tip.hidden = true;
  const c = svgEl.__chart;
  if (c) { c.cross.setAttribute("visibility", "hidden"); c.dot.setAttribute("visibility", "hidden"); }
}

// Draws the session chart inside every section whose graph is open.
function renderCharts() {
  const d = app.last;
  for (const svgEl of document.querySelectorAll(".metric-panel:not([hidden]) .chart, #drawer:not([hidden]) .chart")) {
    const key = svgEl.dataset.trend;
    const histKey = { heart_rate: "hr", breathing_rate: "br", blink_rate: "blink" }[key];
    const base = d && d.baseline ? d.baseline[key] : null;
    const wrap = svgEl.parentElement, tip = wrap.querySelector(".tip-box");
    const drawn = chart(svgEl, app.history.map((s) => ({ t: s.t, state: s.state, [key]: s[histKey] })), key, base);
    if (!drawn) {
      tip.hidden = true;
      const msg = svg("text", { x: "50%", y: 95, "text-anchor": "middle", class: "chart-empty" });
      msg.textContent = "The graph fills in as readings arrive.";
      svgEl.appendChild(msg);
    } else if (wrap.__pointer) {
      chartHover(svgEl, tip, wrap.__pointer);   // keep the readout under the pointer across redraws
    }
  }
}

function toggleGraph(btn) {
  const panel = $(btn.getAttribute("aria-controls"));
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "Hide graph" : "Show graph";
  if (open) renderCharts();
}

// ================================================================ summary

function stats(key) {
  const vals = app.history.map((s) => s[key]).filter((v) => v !== null);
  if (!vals.length) return null;
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) };
}

function renderSummary() {
  const dur = app.sessionStart ? (Date.now() - app.sessionStart) / 1000 : 0;
  $("sum-when").textContent = app.sessionEnded ? "Session ended" : "Session in progress";
  $("sum-dur").textContent = mmss(dur);
  const judged = app.history.filter((s) => s.state === "calm" || s.state === "elevated");
  const calm = judged.filter((s) => s.state === "calm").length;
  $("sum-dur-sub").textContent = `${judged.length} s compared with your baseline`;
  $("sum-calm").textContent = judged.length ? Math.round(calm / judged.length * 100).toString() : "--";
  $("sum-episodes").textContent = String(app.events.length);
  $("sum-ex").textContent = String(app.exercises.length);

  const tl = $("sum-timeline");
  tl.replaceChildren();
  let prev = null, count = 0;
  const push = () => { if (prev !== null) { const i = document.createElement("i"); i.className = prev; i.style.flexGrow = String(count); tl.appendChild(i); } };
  for (const s of app.history) {
    const kind = s.state === "calm" || s.state === "elevated" ? s.state : "none";
    if (kind !== prev) { push(); prev = kind; count = 0; }
    count++;
  }
  push();

  const keys = { heart_rate: ["hr", 0, "bpm"], breathing_rate: ["br", 1, "/min"], blink_rate: ["blink", 0, "/min"] };
  for (const card of document.querySelectorAll(".sum-metric")) {
    const [k, digits, unit] = keys[card.dataset.sum];
    const st = stats(k);
    card.querySelector("[data-mean]").textContent = st ? st.mean.toFixed(digits) : "--";
    const base = app.last && app.last.baseline ? app.last.baseline[card.dataset.sum] : null;
    card.querySelector("[data-range]").textContent = st
      ? `range ${st.min.toFixed(digits)}–${st.max.toFixed(digits)} ${unit}` + (base !== null && base !== undefined ? ` · baseline ${base.toFixed(digits)}` : "")
      : "no readings";
  }

  const moments = [
    ...app.events.map((e) => ({ t: e.t, node: momentItem("elevated", "Shifted from your baseline", e.reasons, mmss(e.t)) })),
    ...app.exercises.map((x) => ({ t: x.t, node: momentItem("exercise", "Breathing exercise", [`Heart rate ${x.hr}`, `Breathing ${x.br}`], mmss(x.t)) })),
  ].sort((a, b) => a.t - b.t);
  $("sum-events").replaceChildren(...moments.map((m) => m.node));
  $("sum-events-empty").hidden = moments.length > 0;
}

// ================================================================ polling

function setStatus(d, age) {
  const el = $("pill-signal");
  const stale = age !== null && age > STALE_SEC;
  const text = stale ? `No readings for ${Math.floor(age)} s`
    : { no_face: "No face", measuring: "Heart: measuring", weak: "Heart signal weak", good: "Heart signal good" }[d.signal_status] || d.signal_status;
  el.dataset.status = d.signal_status;
  el.classList.toggle("stale", stale);
  el.querySelector("span").textContent = text;
}

function showBanner(text, reconnect) {
  $("banner-text").textContent = text || "";
  $("banner").hidden = !text;
  $("btn-reconnect").hidden = !reconnect || app.source !== "browser";
}

async function poll() {
  app.tick++;
  if (app.screen === "start" || app.sessionEnded) return;
  let d;
  try {
    const r = await fetch("/api/readings", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    showBanner("Can't reach the CUORE server. Is server.py still running?");
    return;
  }
  if (!d.session || d.session.id !== app.sessionId) return;   // readings from another session
  app.last = d;
  renderDiag(d);

  if (app.cameraLost) showBanner("The camera stopped. Readings are paused until it's back.", true);
  else if (d.error) showBanner(`Processing stopped: ${d.error}`);
  else if (app.source === "browser" && app.frameErrors > 5) showBanner("Camera frames aren't reaching the server.");
  else showBanner("");

  const age = d.updated_at === null ? null : d.server_time - d.updated_at;
  if (age !== null && age <= STALE_SEC) {
    app.history.push({
      t: (Date.now() - app.sessionStart) / 1000,
      hr: d.heart_rate, br: d.breathing_rate, blink: d.blink_rate,
      state: d.composure.state,
    });
  }

  if (app.screen === "calibrate") { renderCalibration(d); return; }
  setStatus(d, age);
  $("pill-time").textContent = mmss((Date.now() - app.sessionStart) / 1000);
  if (app.style === "living") renderLiveC(d); else renderLive(d);
  updateNotice(d);
  updateBreatheLive(d);
  if (app.view === "live") renderCharts();
  if (app.view === "summary") renderSummary();
}

// ================================================================ guided breathing
// Paces 4 s in / 6 s out (six breaths a minute) for one minute. The readings
// shown are the live measured ones; the result compares the reading when the
// exercise began with the average of every real sample from its last 15 seconds.

const PACE = { prepMs: 3000, inMs: 4000, outMs: 6000, totalMs: 60000, endWindowSec: 15 };
let breathe = null;

function clearBreatheTimers() {
  if (!breathe) return;
  for (const t of breathe.timeouts) clearTimeout(t);
  clearInterval(breathe.ticker);
}

function openBreathe() {
  if (app.sessionEnded || !app.sessionStart) return;
  clearBreatheTimers();
  $("notice").hidden = true;
  $("breathe-result").hidden = true;
  if ($("breathe").hidden) openDialog($("breathe"), $("btn-breathe-close"));
  const d = app.last;
  breathe = { startHr: d ? d.heart_rate : null, startBr: d ? d.breathing_rate : null, t0: null, timeouts: [], ticker: null };
  $("br-hr-start").textContent = `at start ${fmt(breathe.startHr, 0)}`;
  $("br-br-start").textContent = `at start ${fmt(breathe.startBr, 1)}`;
  updateBreatheLive(d);

  const orb = $("orb");
  orb.style.transitionDuration = "1s";
  orb.classList.remove("in");
  $("orb-count").textContent = "1:00";
  let n = Math.round(PACE.prepMs / 1000);
  $("orb-text").textContent = `Starting in ${n}`;
  breathe.ticker = setInterval(() => { n--; if (n > 0) $("orb-text").textContent = `Starting in ${n}`; }, 1000);
  breathe.timeouts.push(setTimeout(beginBreathing, PACE.prepMs));
  startField();
}

function beginBreathing() {
  clearInterval(breathe.ticker);
  breathe.t0 = Date.now();
  const phase = (inhale) => {
    if (!breathe || $("breathe").hidden) return;
    const ms = inhale ? PACE.inMs : PACE.outMs;
    const orb = $("orb");
    orb.style.transitionDuration = ms / 1000 + "s";
    orb.classList.toggle("in", inhale);
    $("orb-text").textContent = inhale ? "Breathe in" : "Breathe out";
    // reduced motion: one still frame per phase, showing where this breath ends
    if (app.style === "living" && app.reduceMotion) drawField(Date.now() + (inhale ? PACE.inMs : PACE.outMs));
    breathe.timeouts.push(setTimeout(() => phase(!inhale), ms));
  };
  phase(true);
  breathe.ticker = setInterval(() => {
    const left = PACE.totalMs - (Date.now() - breathe.t0);
    $("orb-count").textContent = mmss(Math.max(0, left) / 1000).replace(/^0/, "");
    if (left <= 0) finishBreathing();
  }, 250);
}

function meanOf(values) {
  const v = values.filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function compareText(start, end, digits, unit) {
  if (start === null || end === null) return { value: `${fmt(start, digits)} → ${fmt(end, digits)} ${unit}`, delta: "", cls: "" };
  const diff = end - start;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return { value: `${start.toFixed(digits)} → ${end.toFixed(digits)} ${unit}`, delta: `${sign}${Math.abs(diff).toFixed(digits)}`, cls: diff < 0 ? "down" : diff > 0 ? "up" : "" };
}

function finishBreathing() {
  clearBreatheTimers();
  stopField();
  const endSec = (Date.now() - app.sessionStart) / 1000;
  const recent = app.history.filter((s) => s.t >= endSec - PACE.endWindowSec);
  const hr = compareText(breathe.startHr, meanOf(recent.map((s) => s.hr)), 0, "bpm");
  const br = compareText(breathe.startBr, meanOf(recent.map((s) => s.br)), 1, "/min");
  $("res-hr").textContent = hr.value; $("res-hr-d").textContent = hr.delta; $("res-hr-d").className = hr.cls;
  $("res-br").textContent = br.value; $("res-br-d").textContent = br.delta; $("res-br-d").className = br.cls;
  $("breathe-result").hidden = false;
  $("btn-breathe-done").focus();
  app.exercises.push({ t: endSec, hr: hr.value, br: br.value });
  addNotification("exercise", "Breathing exercise, 1 min", [`Heart rate ${hr.value}`, `Breathing ${br.value}`]);
}

function closeBreathe() {
  clearBreatheTimers();
  stopField();
  breathe = null;
  $("orb").classList.remove("in");
  if (!$("breathe").hidden) closeDialog($("breathe"));
}

function updateBreatheLive(d) {
  if (!d || $("breathe").hidden) return;
  $("br-hr").textContent = fmt(d.heart_rate, 0);
  $("br-br").textContent = fmt(d.breathing_rate, 1);
  sparkline($("br-wave"), d.breath_wave);   // the measured breathing wave, shown apart from the guide
}

// ================================================================ C · Breath Field
// The guide: layered contour forms that inflate over 4 s and settle over 6 s, timed
// from the exercise clock (breathe.t0), never from your measured breathing. A few
// slow motes add depth. One canvas, at most 30 fps, running only while open.

const field = { raf: 0, last: 0, motes: [], colors: null };

function guidePhase(now) {
  if (!breathe || breathe.t0 === null) return { expansion: 0.18, inhale: null, frac: 0 };
  const pos = (now - breathe.t0) % (PACE.inMs + PACE.outMs);
  const inhale = pos < PACE.inMs;
  const frac = inhale ? pos / PACE.inMs : (pos - PACE.inMs) / PACE.outMs;
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * frac);
  return { expansion: inhale ? eased : 1 - eased, inhale, frac };
}

function fieldColors() {
  const cs = getComputedStyle(document.body);
  return { a: cs.getPropertyValue("--breath").trim() || "#5a8cf2", b: cs.getPropertyValue("--heart").trim() || "#ec5a68", dark: document.body.classList.contains("mode-dark") };
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function drawField(now) {
  const canvas = $("breath-canvas"), ctx2 = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const { expansion, frac, inhale } = guidePhase(now);
  const c = field.colors;
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2.clearRect(0, 0, w, h);
  ctx2.globalCompositeOperation = c.dark ? "lighter" : "source-over";
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3, s = 0.6 + 0.4 * expansion;
  const t = app.reduceMotion ? 0 : now;
  for (let k = 0; k < 6; k++) {
    const rk = R * s * (1 - k * 0.12);
    ctx2.beginPath();
    for (let i = 0; i <= 96; i++) {
      const th = (i / 96) * Math.PI * 2;
      const r = rk * (1 + 0.03 * Math.sin(3 * th + t * 0.00035 + k * 1.3) + 0.018 * Math.sin(5 * th - t * 0.00026 + k * 0.7) + 0.01 * Math.sin(2 * th + t * 0.0002 * (k + 1)));
      const x = cx + r * Math.cos(th), y = cy + r * Math.sin(th);
      i ? ctx2.lineTo(x, y) : ctx2.moveTo(x, y);
    }
    ctx2.closePath();
    const g = ctx2.createRadialGradient(cx, cy - rk * 0.2, rk * 0.05, cx, cy, rk);
    const col = k % 2 ? c.b : c.a;
    g.addColorStop(0, hexA(col, c.dark ? 0.22 : 0.1));
    g.addColorStop(1, hexA(col, 0));
    ctx2.fillStyle = g;
    ctx2.fill();
    ctx2.lineWidth = 1;
    ctx2.strokeStyle = hexA(c.a, c.dark ? 0.42 - k * 0.04 : 0.42 - k * 0.04);
    ctx2.stroke();
  }
  if (!app.reduceMotion) {
    for (const m of field.motes) {
      m.a += m.v;
      const r = R * s * m.d;
      ctx2.beginPath();
      ctx2.arc(cx + r * Math.cos(m.a), cy + r * Math.sin(m.a), m.size, 0, Math.PI * 2);
      ctx2.fillStyle = hexA(c.a, c.dark ? 0.5 : 0.35);
      ctx2.fill();
    }
  }
  ctx2.globalCompositeOperation = "source-over";
  // the guide ring shows how far through the current breath the guide is
  const arc = $("guide-arc");
  arc.style.strokeDashoffset = String(603.2 * (1 - (inhale === null ? 0 : frac)));
  arc.classList.toggle("out", inhale === false);
}

function fieldLoop(now) {
  if ($("breathe").hidden || app.style !== "living" || !breathe) { field.raf = 0; return; }
  if (now - field.last >= 33) { field.last = now; drawField(Date.now()); }
  field.raf = requestAnimationFrame(fieldLoop);
}

function startField() {
  if (app.style !== "living") return;
  field.colors = fieldColors();
  if (!field.motes.length) {
    for (let i = 0; i < 22; i++) field.motes.push({ a: Math.random() * Math.PI * 2, d: 1.05 + Math.random() * 0.4, v: (Math.random() - 0.5) * 0.004, size: 0.8 + Math.random() * 1.2 });
  }
  if (app.reduceMotion) { drawField(Date.now()); return; }   // static frames only, redrawn at each phase change
  if (!field.raf) field.raf = requestAnimationFrame(fieldLoop);
}

function stopField() {
  if (field.raf) cancelAnimationFrame(field.raf);
  field.raf = 0;
}

// ================================================================ diagnostics (?diag)
// One row per poll. Exports numbers and status words only, never images or video.

const diag = { rows: [], first: {}, t0: null };

function diagReset() {
  diag.rows = []; diag.first = {}; diag.t0 = app.sessionStart;
  if (TEST.diag) $("diag-stats").replaceChildren();
}

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "--");
const num = (v, d) => (v === null || v === undefined ? "--" : Number(v).toFixed(d));

function diagRow(d) {
  const st = metricStatus(d), dg = d.diag || {}, bm = (d.baseline && d.baseline.metrics) || {};
  const t = app.sessionStart ? (Date.now() - app.sessionStart) / 1000 : 0;
  const bl = (k) => (bm[k] ? (bm[k].ready ? "ready" : `${Math.floor(bm[k].valid_sec || 0)}/${bm[k].need_valid_sec}s valid`) : "--");
  return {
    t: +t.toFixed(1), condition: $("diag-cond").value.trim(), style: app.style, source: app.source,
    jpeg: TEST.jpeg, inflight: TEST.inflight, cam_lock: camLock.state,
    camera_fps: d.camera_fps, upload_fps: uploadFps(), upload_rtt_ms: upload.rtt, processed_fps: d.processed_fps,
    frame_latency_ms: dg.frame_latency_ms ?? null, frames_dropped: dg.frames_dropped ?? null,
    face_found: d.face_found ? 1 : 0, face_ratio_60s: dg.face_ratio_60s ?? null,
    heart_rate: d.heart_rate, heart_quality: d.signal_quality ?? d.heart_snr_db, heart_status: st.heart.state,
    breathing_rate: d.breathing_rate, breathing_snr_db: dg.breathing_snr_db ?? null, breathing_buffer_sec: dg.breathing_buffer_sec ?? null,
    breathing_channel: d.breathing_channel, breathing_status: st.breath.state,
    blink_rate: d.blink_rate, blink_window_sec: dg.blink_window_sec ?? null, blink_status: st.blink.state,
    baseline_heart: bl("heart"), baseline_breath: bl("breath"), baseline_blink: bl("blink"),
    composure: d.composure.state, composure_used: (d.composure.used || []).join("+"),
  };
}

function renderDiag(d) {
  if (!TEST.diag || !app.sessionStart) return;
  if (diag.t0 !== app.sessionStart) diagReset();
  const row = diagRow(d);
  const fresh = d.updated_at !== null && d.server_time - d.updated_at <= STALE_SEC;
  if (fresh) diag.rows.push(row);
  for (const [k, ok] of [["heart_reliable", row.heart_status === "reliable"], ["heart_any", row.heart_rate !== null],
                         ["breath", row.breathing_rate !== null], ["blink", row.blink_rate !== null]]) {
    if (ok && diag.first[k] === undefined) diag.first[k] = row.t;
  }
  $("diag-cfg").textContent = `${app.source || "?"} · jpeg ${TEST.jpeg} · inflight ${TEST.inflight}`;
  const items = [
    ["camera fps (accepted)", num(row.camera_fps, 1)], ["upload fps", num(row.upload_fps, 1)], ["upload round trip", `${num(row.upload_rtt_ms, 0)} ms`],
    ["processed fps", num(row.processed_fps, 1)], ["capture → result", `${num(row.frame_latency_ms, 0)} ms`], ["frames dropped (order)", num(row.frames_dropped, 0)],
    ["camera lock", camLock.state], ["", camLock.detail],
    ["face now / last 60 s", `${row.face_found ? "yes" : "no"} / ${row.face_ratio_60s === null ? "--" : pct(row.face_ratio_60s, 1)}`],
    ["heart", `${num(row.heart_rate, 0)} · q ${num(row.heart_quality, 2)} · ${row.heart_status}`],
    ["breathing", `${num(row.breathing_rate, 1)} · ${num(row.breathing_snr_db, 1)} dB · ${num(row.breathing_buffer_sec, 0)} s · ${row.breathing_status}`],
    ["blinks", `${num(row.blink_rate, 0)} · window ${num(row.blink_window_sec, 0)} s · ${row.blink_status}`],
    ["baseline heart / breath / blink", `${row.baseline_heart} / ${row.baseline_breath} / ${row.baseline_blink}`],
    ["composure", `${row.composure || "--"}${row.composure_used ? ` (${row.composure_used})` : ""}`],
  ];
  $("diag-list").replaceChildren(...items.flatMap(([k, v]) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));

  const n = diag.rows.length;
  const mean = (k) => { const v = diag.rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const count = (f) => diag.rows.filter(f).length;
  diag.stats = [
    ["rows (s of live data)", String(n)],
    ["first heart (reliable / any)", `${num(diag.first.heart_reliable, 0)} s / ${num(diag.first.heart_any, 0)} s`],
    ["first breathing", `${num(diag.first.breath, 0)} s`], ["first blink rate", `${num(diag.first.blink, 0)} s`],
    ["heart reliable / any", `${pct(count((r) => r.heart_status === "reliable"), n)} / ${pct(count((r) => r.heart_rate !== null), n)}`],
    ["breathing available", pct(count((r) => r.breathing_rate !== null), n)], ["blink rate available", pct(count((r) => r.blink_rate !== null), n)],
    ["face found", pct(count((r) => r.face_found), n)], ["mean heart quality", num(mean("heart_quality"), 2)], ["mean processed fps", num(mean("processed_fps"), 1)],
  ];
  $("diag-stats").replaceChildren(...diag.stats.flatMap(([k, v]) => { const a = document.createElement("span"), b = document.createElement("span"); a.textContent = k; b.textContent = v; return [a, b]; }));
}

// CSV cell: always quoted; text starting = + - @ is prefixed so spreadsheets never run it as a formula
function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadDiag() {
  if (!diag.rows.length) return;
  const cols = Object.keys(diag.rows[0]);
  const lines = [cols.join(","), ...diag.rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))];
  for (const [k, v] of diag.stats || []) lines.push(`# ${k}: ${v}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `cuore-diag-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ================================================================ full screen

function openFull() {
  $("full-img").src = "/video?t=" + Date.now();
  openDialog($("full"), $("btn-full-close"));
  const el = $("full");
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function closeFull() {
  if ($("full").hidden) return;
  $("full-img").removeAttribute("src");
  closeDialog($("full"));
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ================================================================ wiring

document.addEventListener("DOMContentLoaded", () => {
  buildStatic();
  buildDial();
  applyStyle("nocturne");

  $("mode-btn").addEventListener("click", () => {
    app.mode = app.mode === "dark" ? "light" : "dark";
    applyStyle("living");
    if (!$("breathe").hidden) field.colors = fieldColors();
  });
  for (const ro of document.querySelectorAll(".ro")) ro.addEventListener("click", () => openDrawer(ro.dataset.metric, ro));
  $("drawer-close").addEventListener("click", closeDrawer);
  trapFocus($("drawer"), closeDrawer);
  $("btn-breathe-c").addEventListener("click", openBreathe);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => { app.reduceMotion = e.matches; });

  if (TEST.diag) {
    $("diag").hidden = false;
    $("diag-csv").addEventListener("click", downloadDiag);
    $("diag-fold").addEventListener("click", () => {
      const folded = $("diag").classList.toggle("folded");
      $("diag-fold").textContent = folded ? "show" : "hide";
      $("diag-fold").setAttribute("aria-expanded", String(!folded));
    });
    $("diag-reset").addEventListener("click", () => { diag.rows = []; diag.first = {}; $("diag-stats").replaceChildren(); });
  }

  // ?perf shows frames per second and the slowest frame, to check smoothness with the camera running
  if (new URLSearchParams(location.search).has("perf")) {
    const out = $("perf");
    out.hidden = false;
    let frames = 0, worst = 0, prev = performance.now(), windowStart = prev;
    const tick = (now) => {
      frames++; worst = Math.max(worst, now - prev); prev = now;
      if (now - windowStart >= 1000) {
        out.textContent = `${Math.round(frames * 1000 / (now - windowStart))} fps · slowest frame ${worst.toFixed(0)} ms`;
        frames = 0; worst = 0; windowStart = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  for (const b of document.querySelectorAll(".style-btn")) b.addEventListener("click", () => applyStyle(b.dataset.style));
  $("btn-start").addEventListener("click", onStart);
  $("btn-cancel").addEventListener("click", () => { stopCamera(); showScreen("start"); });
  $("btn-recal").addEventListener("click", async () => {
    try { await startSession(); showScreen("calibrate"); }
    catch (e) { showBanner(`Couldn't restart calibration: ${e.message || e}`); }
  });
  $("btn-end").addEventListener("click", endSession);
  $("btn-new").addEventListener("click", async () => {
    try { await begin(); } catch (e) { showBanner(cameraError(e)); }
  });
  $("btn-back").addEventListener("click", () => showView("live"));
  $("btn-reconnect").addEventListener("click", reconnectCamera);

  // tabs: click, plus left/right arrows within the tab list
  const tabs = [...document.querySelectorAll(".tab")];
  for (const tab of tabs) tab.addEventListener("click", () => showView(tab.dataset.view));
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.dataset.view === app.view);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showView(next.dataset.view, true);
  });

  for (const btn of document.querySelectorAll(".toggle")) btn.addEventListener("click", () => toggleGraph(btn));
  for (const wrap of document.querySelectorAll(".chart-wrap")) {
    const svgEl = wrap.querySelector(".chart"), tip = wrap.querySelector(".tip-box");
    wrap.addEventListener("pointermove", (e) => { wrap.__pointer = { clientX: e.clientX }; chartHover(svgEl, tip, e); });
    wrap.addEventListener("pointerleave", () => { wrap.__pointer = null; chartLeave(svgEl, tip); });
  }

  $("btn-full").addEventListener("click", openFull);
  $("btn-full-close").addEventListener("click", closeFull);
  trapFocus($("full"), closeFull);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) closeFull(); });

  $("notice-close").addEventListener("click", () => { $("notice").hidden = true; });
  $("notice-breathe").addEventListener("click", openBreathe);
  $("btn-breathe").addEventListener("click", openBreathe);
  $("btn-breathe-close").addEventListener("click", closeBreathe);
  $("btn-breathe-done").addEventListener("click", closeBreathe);
  $("btn-breathe-again").addEventListener("click", openBreathe);
  trapFocus($("breathe"), closeBreathe);

  $("btn-bell").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = $("notif-panel");
    panel.hidden = !panel.hidden;
    $("btn-bell").setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) { unread = 0; $("bell-badge").hidden = true; }
  });
  $("notif-panel").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { $("notif-panel").hidden = true; $("btn-bell").setAttribute("aria-expanded", "false"); });
  $("btn-clear").addEventListener("click", () => { $("notif-list").replaceChildren(); $("notif-empty").hidden = false; });
  window.addEventListener("resize", () => { if (app.view === "live") renderCharts(); });

  showScreen("start");
  setInterval(poll, POLL_MS);
});
