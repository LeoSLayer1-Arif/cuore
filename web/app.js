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
  quick: false,          // 45-second quick read (experimental)
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
  history: [],           // one sample per poll; see historySample()
  events: [],            // elevated moments: {t, reasons}
  exercises: [],         // breathing results: {t, hr, br}
  last: null,            // latest readings for this session
};

// ================================================================ art

// The engraving heart, shared by the start page and the live instrument.
function mountHearts() {
  for (const stage of document.querySelectorAll("[data-heart]")) {
    const img = document.createElement("img");
    img.className = "heart-art";
    img.alt = "";
    img.src = "/static/heart.png";
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
  $("view-live").hidden = name !== "live";
  $("view-summary").hidden = name !== "summary";
  for (const tab of document.querySelectorAll(".tab")) {
    const on = tab.dataset.view === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
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
  if (r.status === 401) { showPairForm(true); throw new Error("This device isn't paired yet. Enter the pairing code shown in the CUORE terminal."); }
  if (!r.ok) throw new Error(`The CUORE server answered ${r.status}.`);
  return (await r.json()).session.source;
}

async function openCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    // front camera on phones; resolution and frame rate requests are unchanged from desktop
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  for (const track of app.stream.getVideoTracks()) {
    track.addEventListener("ended", cameraLost);
    // iOS and Android mute the track during interruptions (a call, Control Centre, another app)
    track.addEventListener("mute", () => pauseForBackground("The camera was interrupted. Readings are paused."));
    track.addEventListener("unmute", resumeFromBackground);
  }
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

const PLATFORM = (() => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return { ios, android: /Android/.test(ua), mobile: ios || /Android|Mobi/.test(ua) };
})();

function cameraError(e) {
  switch (e && e.name) {
    case "NotAllowedError":
      return PLATFORM.ios ? "Camera access is blocked. In Settings › Safari › Camera (or tap “aA” in the address bar › Website Settings), allow the camera, then try again."
        : PLATFORM.android ? "Camera access is blocked. Tap the icon beside the address, open Permissions, allow Camera, then try again."
        : "Camera access is blocked. Click the camera icon in the address bar, allow it, then try again.";
    case "NotFoundError": case "OverconstrainedError": return "No suitable camera was found on this device.";
    case "NotReadableError": return "The camera is busy. Close other apps using it (Zoom, FaceTime, app.py) and try again.";
    case "SecurityError": return insecureMessage();
    default: return e && e.message ? e.message : String(e);
  }
}

// Browsers only allow the camera on https:// pages or on this computer (127.0.0.1).
function insecureMessage() {
  return PLATFORM.mobile
    ? "The camera can't open on this page: phones only allow it over https. On your computer, start CUORE with home Wi-Fi mode (server.py --lan) and open the https address it prints."
    : "The camera only works on a secure page. Open CUORE at http://127.0.0.1:5001 on the computer running server.py.";
}

// ---------------------------------------------------------------- pairing (home Wi-Fi mode)
// The code goes in a request body, never in a URL, so it never appears in server logs.
function showPairForm(on) {
  $("pair-form").hidden = !on;
  $("btn-start").disabled = on;
  if (on) $("pair-code").focus();
}

async function pairDevice(code) {
  $("pair-error").hidden = true;
  const r = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cuore-Client": "1" },
    body: JSON.stringify({ code }),
  }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) {
    $("pair-error").textContent = d.error || (r ? `Pairing failed (${r.status}).` : "Can't reach the CUORE server.");
    $("pair-error").hidden = false;
    return false;
  }
  showPairForm(false);
  return true;
}

// On load: in home Wi-Fi mode an unpaired device sees the pairing form; otherwise nothing changes.
async function checkPairing() {
  const r = await fetch("/api/readings", { cache: "no-store" }).catch(() => null);
  showPairForm(!!r && r.status === 401);
}

// ---------------------------------------------------------------- background + interruptions
// Switching apps or locking the phone stops the camera on mobile. Readings pause (the
// gap is recorded as "no reading"), and frames resume when CUORE is back in front.
let pausedForBackground = false;

function pauseForBackground(msg) {
  if (app.sessionEnded || !app.sessionStart || app.source !== "browser" || app.screen === "start") return;
  pausedForBackground = true;
  app.sending = false;
  showBanner(msg || "Paused while CUORE was in the background.", false, "info");
}

async function resumeFromBackground() {
  if (!pausedForBackground || app.sessionEnded) return;
  pausedForBackground = false;
  if (!app.stream) { showBanner(""); return; }              // no camera was open: nothing to resume
  const track = app.stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended") { await reconnectCamera(); return; }   // the OS stopped it
  if (track.muted) { pausedForBackground = true; return; }   // still interrupted; unmute will resume
  const v = $("thumb-video");
  if (v.paused) await v.play().catch(() => {});
  if ($("cal-video").paused) await $("cal-video").play().catch(() => {});
  app.sending = true;
  pump();
  showBanner("");
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
  resetNotices();
  $("btn-back").hidden = false;
  $("quick-bar").hidden = !app.quick;
  $("screen-app").classList.remove("ended");
  pausedForBackground = false;
  $("btn-breathe").hidden = app.quick;   // a 1-minute exercise doesn't fit in 45 s
  if (app.source === "browser") { app.sending = true; pump(); }
}

// ---------------------------------------------------------------- 45-second quick read (experiment)
// The clock starts with the camera (calibration included) and ends the session at
// 45 s. Nothing about the measurements changes: no threshold is relaxed, so any
// metric that needs a longer window is reported as provisional or unavailable.
const QUICK_SEC = 45;
const sessionSec = () => (app.sessionStart ? (Date.now() - app.sessionStart) / 1000 : 0);

function updateQuick() {
  if (!app.quick || app.sessionEnded) return;
  const t = sessionSec(), left = Math.max(0, QUICK_SEC - t);
  $("quick-left").textContent = mmss(left).replace(/^0/, "");
  $("quick-fill").style.width = `${Math.min(100, (t / QUICK_SEC) * 100)}%`;
  if (left <= 0) {
    if (app.screen !== "app") showScreen("app");
    endSession();
  }
}

async function begin() {
  const pick = document.querySelector('input[name="length"]:checked');
  app.quick = !!pick && pick.value === "45";
  app.source = await serverSource();
  if (app.source === "browser") {
    if (!window.isSecureContext) throw new Error(insecureMessage());
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't open the camera. Use a current version of Chrome, Edge, Safari or Firefox.");
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
    btn.textContent = "Start Calibrating";
  }
}

function endSession() {
  closeBreathe();
  app.sessionEnded = true;
  app.sessionEnd = Date.now();
  stopCamera();
  $("btn-back").hidden = true;
  $("quick-bar").hidden = true;
  $("screen-app").classList.add("ended");
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
// Heart signal pass line, as the server classifies it: good only when quality > this value.
const sqiPass = () => (app.last && typeof app.last.signal_quality_threshold === "number" ? app.last.signal_quality_threshold : null);
const passText = () => (sqiPass() === null ? "its pass line" : `its ${sqiPass().toFixed(2)} pass line`);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function metricStatus(d) {
  const dg = d.diag || {};
  const face = !!d.face_found;
  const q = qualityLevel(d);
  const qText = q ? q.text : "--";

  let heart;
  if (!face) heart = { state: "none", text: "no face in view" };
  else if (d.heart_rate === null) heart = { state: "collecting", text: "measuring · about 10 s of steady signal" };
  else if (d.signal_status === "good") heart = { state: "reliable", text: `reliable · heart signal ${qText}` };
  else heart = { state: "provisional", text: `provisional · heart signal ${qText}, at or below ${passText()}` };

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
    if (st[key]) { small.textContent = cap(st[key].text); small.dataset.state = st[key].state; }
    if (key === "blink" && app.quick && d.blink_rate === null) small.textContent = "Provisional at best in 45 s (needs 60 s)";
  }
  document.querySelector(".face-guide").classList.toggle("ok", !!d.face_found);
  $("cal-face").textContent = d.face_found ? "Face found" : "Looking for your face";
  $("cal-lede").textContent = app.quick
    ? `Quick read: ${Math.max(0, Math.ceil(QUICK_SEC - sessionSec()))} s left. Heart rate and breathing can be measured in this time; blink rate stays provisional and no baseline can form.`
    : "Readings appear as soon as each one is ready. Your baseline keeps learning in the background, separately for heart rate, breathing and blinks.";
  renderQuality("cal-q", "cal-q-text", d);

  // The ring now counts toward the first live reading (about 10 s), not a full baseline.
  const secs = app.sessionStart ? (Date.now() - app.sessionStart) / 1000 : 0;
  const frac = Math.min(1, secs / 12);
  $("ring-secs").textContent = String(Math.floor(secs));
  $("ring-sub").textContent = "Until the first reading";
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
    showScreen("app"); showView("live");
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
  else if (provisional) delta = `Provisional: heart signal at or below ${passText()}`;
  else if (b.heart_rate !== null) {
    const diff = Math.round(hr - b.heart_rate);
    delta = diff === 0 ? `At your baseline of ${b.heart_rate.toFixed(0)}`
      : `${Math.abs(diff)} ${diff > 0 ? "above" : "below"} your baseline of ${b.heart_rate.toFixed(0)}`;
  } else delta = app.quick ? "No baseline in a 45 s quick read" : cap(baselineText(d, "heart", 0, "bpm") || "Baseline learning");
  $("hero-delta").textContent = delta;
  renderQuality("hero-q", "hero-q-text", d);
  $("pass-line").textContent = sqiPass() === null ? "" : `Good above ${sqiPass().toFixed(2)}`;
  // the heart and its ring only animate on a reliable reading
  setHeartBeat(reliable ? hr : null);
  renderHalo(reliable || provisional ? d.pulse_wave : null);
  document.querySelector(".instrument").classList.toggle("weak", provisional);
  renderTide(d.breath_wave);
  $("tide-label").textContent = `Breathing · ${st.breath.text}`;
  $("heart-caption").textContent = hr === null ? "Waiting for a heart rate. The heart stays still until there's a real reading."
    : provisional ? `Heart signal weak (${qualityLevel(d) ? qualityLevel(d).text : "--"}). The rate is provisional, so the heart isn't animated. The dashed ring is the unreliable pulse wave.`
    : `The heart beats at your measured average, ${hr.toFixed(0)} bpm. The ring is your pulse wave from the last 6 s.`;

  // live state chip: one word, so the big number never has to explain itself
  const chip = $("hr-state");
  chip.dataset.state = st.heart.state;
  chip.textContent = { reliable: "Reliable", provisional: "Provisional", collecting: "Measuring", none: "No face" }[st.heart.state];

  // Session average: reliable seconds only, computed here from this session's history.
  // (The server's 2-minute monitor also averages weak readings, so it isn't shown.)
  const rel = app.history.filter((s) => s.hr !== null && s.hrState === "reliable");
  if (rel.length) {
    const avg = rel.reduce((a, s) => a + s.hr, 0) / rel.length;
    $("avg-v").textContent = avg.toFixed(0);
    let sub = `From ${rel.length} reliable second${rel.length === 1 ? "" : "s"} of ${mmss(sessionSec())}`;
    if (b.heart_rate !== null) {
      const diff = Math.round(avg - b.heart_rate);
      sub += diff === 0 ? ` · at your baseline of ${b.heart_rate.toFixed(0)}` : ` · ${Math.abs(diff)} ${diff > 0 ? "above" : "below"} your baseline of ${b.heart_rate.toFixed(0)}`;
    }
    $("avg-sub").textContent = sub;
  } else {
    $("avg-v").textContent = "--";
    $("avg-sub").textContent = d.heart_rate !== null ? "No reliable seconds yet · weak-signal readings are left out" : "Waiting for reliable readings";
  }
  $("avg-v").classList.toggle("empty", !rel.length);

  const fps = d.processed_fps;
  $("fps").textContent = d.camera_fps === null ? "" :
    `Camera ${fmt(d.camera_fps, 0)} fps · processed ${fmt(fps, 0)} fps` + (fps !== null && fps < 15 ? " · needs 15+" : "");

  renderComposure(d);
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
  pill.textContent = state === null ? "No reading" : state === "calibrating" ? (app.quick ? "Not available" : "Learning baseline")
    : state === "insufficient" ? "Insufficient data" : cap(state);
  let note = state === null ? "No current readings to compare."
    : state === "elevated" ? "You've drifted from your usual rhythm."
    : state === "calm" ? "Steady. You're within your usual range."
    : state === "insufficient" ? "Not enough data to judge yet."
    : app.quick ? "Composure needs a personal baseline." : "Learning your baseline.";
  $("c-note").textContent = note;
  // the reason goes on its own smaller line, so the statement stays short
  let basis = app.quick && state === "calibrating"
    ? "Each baseline needs 60 s after its first valid reading, longer than a 45 s quick read."
    : composureBasis(c);
  if (c.blink_baseline_too_low) basis += " Blinks aren't used: your blink baseline is too low to judge.";
  $("c-basis").textContent = basis.trim();

  const st = metricStatus(d);
  const statusKey = { "r-heart": "heart", "r-breath": "breath", "r-blink": "blink" };
  for (const r of ROWS) {
    const row = $(r.row), flag = c[r.flag], now = d[r.key], base = b[r.key];
    const s = st[statusKey[r.row]];
    row.querySelector("[data-now]").textContent = now === null ? "--" : fmt(now, r.digits) + r.unit;
    row.querySelector("[data-base]").textContent = base === null ? (app.quick ? "No baseline" : "Baseline learning") : `Baseline ${fmt(base, r.digits)}`;
    row.classList.toggle("provisional", s.state === "provisional" && now !== null);
    row.title = cap(s.text);
    const cell = row.querySelector("[data-flag]");
    const tooLow = r.flag === "blink_low" && c.blink_baseline_too_low;
    cell.textContent = flag === true ? "Shifted" : flag === false ? "OK" : tooLow ? "N/A" : "–";
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
// Every point is one real sample from this session (one per poll). Reliable and
// provisional samples are drawn differently; gaps (no reading) are left as gaps.

const CHART_H = { default: 170, short: 110 };
const UNITS = { heart_rate: "bpm", breathing_rate: "/min", blink_rate: "/min", quality: "" };
const DIGITS = { heart_rate: 0, breathing_rate: 1, blink_rate: 0, quality: 2 };

function chart(svgEl, samples, opts) {
  const h = svgEl.classList.contains("short") ? CHART_H.short : CHART_H.default;
  const w = Math.max(320, svgEl.clientWidth || 900);
  svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const pts = samples.filter((s) => s.v !== null);
  svgEl.replaceChildren();
  svgEl.__chart = null;
  if (pts.length < 2) return false;

  const { baseline = null, fixed = null, pass = null } = opts;
  const tMax = Math.max(30, samples[samples.length - 1].t);
  let lo, hi;
  if (fixed) [lo, hi] = fixed;
  else {
    lo = Math.min(...pts.map((s) => s.v)); hi = Math.max(...pts.map((s) => s.v));
    if (baseline !== null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
    const margin = Math.max(1, (hi - lo) * 0.15);
    lo = Math.max(0, lo - margin); hi += margin;
  }
  const x = (t) => pad.l + (t / tMax) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  const bands = svg("g");
  if (opts.bands) {
    let start = null;
    samples.forEach((s, i) => {
      const on = s.state === "elevated";
      if (on && start === null) start = s.t;
      if ((!on || i === samples.length - 1) && start !== null) {
        bands.appendChild(svg("rect", { class: "band", x: x(start), y: pad.t, width: Math.max(2, x(s.t) - x(start)), height: h - pad.t - pad.b }));
        start = null;
      }
    });
  }
  const grid = svg("g", { class: "grid" }), axis = svg("g", { class: "axis" });
  const rows = h < 150 ? 2 : 3;
  for (let i = 0; i <= rows; i++) {
    const v = lo + (hi - lo) * i / rows;
    grid.appendChild(svg("line", { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }));
    const label = svg("text", { x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = fixed ? v.toFixed(1) : v.toFixed(0);
    axis.appendChild(label);
  }
  const step = tMax > 600 ? 120 : tMax > 240 ? 60 : tMax > 90 ? 30 : 15;
  for (let t = 0; t <= tMax; t += step) {
    const label = svg("text", { x: x(t), y: h - 4, "text-anchor": "middle" });
    label.textContent = mmss(t);
    axis.appendChild(label);
  }
  // runs of consecutive samples with the same reliability share one polyline;
  // a run shares its first point with the previous one so the line is continuous
  const series = svg("g");
  let run = [], runProv = null, prevPt = null;
  const flush = () => {
    if (run.length > 1) series.appendChild(svg("polyline", { class: "series" + (runProv ? " prov" : ""), points: run.join(" ") }));
    run = [];
  };
  for (const s of samples) {
    if (s.v === null) { flush(); prevPt = null; runProv = null; continue; }
    const p = `${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`;
    if (runProv !== null && s.prov !== runProv) { flush(); if (prevPt) run.push(prevPt); }
    runProv = s.prov;
    run.push(p);
    prevPt = p;
  }
  flush();
  svgEl.append(bands, grid, axis, series);
  const refLine = (v, cls, labelCls, text) => {
    svgEl.appendChild(svg("line", { class: cls, x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }));
    const t = svg("text", { class: labelCls, x: w - pad.r - 4, y: y(v) - 6, "text-anchor": "end" });
    t.textContent = text;
    svgEl.appendChild(t);
  };
  if (baseline !== null) refLine(baseline, "baseline", "base-label", `Baseline ${baseline.toFixed(DIGITS[opts.key])}`);
  if (pass !== null) refLine(pass, "passline", "pass-label", `Pass line ${pass.toFixed(2)}`);
  const cross = svg("line", { class: "cross", y1: pad.t, y2: h - pad.b, visibility: "hidden" });
  const dot = svg("circle", { class: "dot", r: 4, visibility: "hidden" });
  dot.style.stroke = getComputedStyle(svgEl.querySelector(".series") || svgEl).stroke;
  svgEl.append(cross, dot);
  svgEl.__chart = { samples, key: opts.key, x, y, w, h, cross, dot, pad };
  return true;
}

function chartHover(svgEl, tip, e) {
  const c = svgEl.__chart;
  if (!c) return;
  const rect = svgEl.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (c.w / rect.width);
  let best = null, bestDist = Infinity;
  for (const s of c.samples) {
    if (s.v === null) continue;
    const dist = Math.abs(c.x(s.t) - px);
    if (dist < bestDist) { bestDist = dist; best = s; }
  }
  if (!best) return;
  const cx = c.x(best.t), cy = c.y(best.v);
  c.cross.setAttribute("x1", cx); c.cross.setAttribute("x2", cx); c.cross.setAttribute("visibility", "visible");
  c.dot.setAttribute("cx", cx); c.dot.setAttribute("cy", cy); c.dot.setAttribute("visibility", "visible");
  const unit = UNITS[c.key] ? " " + UNITS[c.key] : "";
  const tags = [best.prov ? "provisional" : "", best.state === "elevated" ? "shifted" : best.state === "calm" ? "calm" : ""].filter(Boolean);
  tip.textContent = `${mmss(best.t)} · ${best.v.toFixed(DIGITS[c.key])}${unit}${tags.length ? " · " + tags.join(" · ") : ""}`;
  tip.style.left = `${(cx / c.w) * rect.width}px`;
  tip.style.top = `${Math.max(0, (cy / c.h) * rect.height - 40)}px`;
  tip.hidden = false;
}

function chartLeave(svgEl, tip) {
  tip.hidden = true;
  const c = svgEl.__chart;
  if (c) { c.cross.setAttribute("visibility", "hidden"); c.dot.setAttribute("visibility", "hidden"); }
}

// What each report chart plots, taken straight from the session history.
const SERIES = {
  heart_rate: (s) => ({ v: s.hr, prov: s.hrState !== "reliable" }),
  breathing_rate: (s) => ({ v: s.br, prov: false }),
  blink_rate: (s) => ({ v: s.blink, prov: !s.blinkFull }),
  quality: (s) => ({ v: s.q, prov: false }),
};

function renderCharts() {
  if (app.view !== "summary") return;
  const d = app.last;
  for (const svgEl of document.querySelectorAll("#view-summary .chart")) {
    const key = svgEl.dataset.trend;
    const base = key !== "quality" && d && d.baseline ? d.baseline[key] : null;
    const wrap = svgEl.parentElement, tip = wrap.querySelector(".tip-box");
    const samples = app.history.map((s) => ({ t: s.t, state: s.state, ...SERIES[key](s) }));
    const drawn = chart(svgEl, samples, {
      key, baseline: base ?? null, bands: key !== "quality",
      fixed: key === "quality" ? [0, 1] : null, pass: key === "quality" && hasQualityScale() ? sqiPass() : null,
    });
    if (!drawn) {
      tip.hidden = true;
      const msg = svg("text", { x: "50%", y: svgEl.classList.contains("short") ? 60 : 90, "text-anchor": "middle", class: "chart-empty" });
      msg.textContent = emptyChartText(key);
      svgEl.appendChild(msg);
    } else if (wrap.__pointer) {
      chartHover(svgEl, tip, wrap.__pointer);   // keep the readout under the pointer across redraws
    }
  }
}

// rPPG reports a 0–1 quality (good above the server's pass line); colour mode reports SNR instead.
const hasQualityScale = () => app.history.some((s) => s.q !== null);

function emptyChartText(key) {
  if (!app.history.length) return "No readings were recorded in this session.";
  return {
    heart_rate: "No heart-rate readings in this session.",
    breathing_rate: app.quick ? "Too short for breathing: it needs 20 s of steady signal." : "No breathing readings in this session.",
    blink_rate: "No blink-rate readings in this session.",
    quality: "No 0–1 heart-signal quality was reported.",
  }[key];
}

// ================================================================ summary: session report

const meanOfKey = (rows, k) => (rows.length ? rows.reduce((a, s) => a + s[k], 0) / rows.length : null);
const pctText = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "--");

function summaryData() {
  const H = app.history, n = H.length;
  const hrAll = H.filter((s) => s.hr !== null);
  const hrRel = hrAll.filter((s) => s.hrState === "reliable");
  const br = H.filter((s) => s.br !== null);
  const blink = H.filter((s) => s.blink !== null);
  const blinkFull = blink.filter((s) => s.blinkFull);
  const qs = H.filter((s) => s.q !== null);
  const judged = H.filter((s) => s.state === "calm" || s.state === "elevated");
  const range = (rows, k) => (rows.length ? [Math.min(...rows.map((s) => s[k])), Math.max(...rows.map((s) => s[k]))] : null);
  return {
    n, face: H.filter((s) => s.face).length,
    hrAll, hrRel, hrMean: meanOfKey(hrRel, "hr"), hrRange: range(hrRel, "hr"),
    br, brMean: meanOfKey(br, "br"), brRange: range(br, "br"),
    blink, blinkFull, blinkLast: blink.length ? blink[blink.length - 1] : null, blinkFullMean: meanOfKey(blinkFull, "blink"),
    qMean: meanOfKey(qs, "q"),
    judged, calm: judged.filter((s) => s.state === "calm").length,
  };
}

// One overview tile: value, a one-line status (ok / warn / na) and a supporting line.
function setOv(id, value, sub, na, status) {
  $(id).textContent = value;
  $(id).classList.toggle("na", !!na);
  $(id + "-sub").textContent = sub;
  const st = $(id + "-st");
  st.textContent = status ? status[0] : "";
  st.dataset.state = status ? status[1] : "";
}

function renderSummary() {
  const S = summaryData(), b = app.last && app.last.baseline ? app.last.baseline : {};
  const end = app.sessionEnded ? app.sessionEnd : Date.now();
  const dur = app.sessionStart ? (end - app.sessionStart) / 1000 : 0;
  const when = app.sessionStart ? new Date(app.sessionStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  $("sum-when").textContent = `${app.sessionEnded ? "Session report" : "Session report · in progress"}${when ? " · started " + when : ""}`;
  $("sum-title").textContent = app.quick ? `Quick read, ${mmss(dur)}` : `Session of ${mmss(dur)}`;
  $("btn-back").hidden = app.sessionEnded;

  const quick = $("rep-quick");
  quick.hidden = !app.quick;
  if (app.quick) quick.textContent = "45-second quick read (experimental). No personal baseline can form in 45 s, because each baseline needs 60 s after its first valid reading, so there is no composure result and no comparison with your baseline. Blink rates are counted over less than the full 60 s window, so they are provisional. Heart rate and breathing use the same quality checks as a full session.";

  // overview
  const relPct = S.n ? S.hrRel.length / S.n : 0;
  setOv("ov-dur", mmss(dur), `${S.n} s with readings · face in view ${pctText(S.face, S.n)}`, false,
    app.sessionEnded ? [app.quick ? "Quick read" : "Complete", "ok"] : ["In progress", "warn"]);
  setOv("ov-hr", S.hrMean === null ? "--" : S.hrMean.toFixed(0),
    S.hrMean === null ? (S.hrAll.length ? `${S.hrAll.length} s of weak-signal readings only; not averaged` : "No heart-rate readings")
      : `Reliable seconds only · range ${S.hrRange[0].toFixed(0)}–${S.hrRange[1].toFixed(0)}` + (b.heart_rate != null ? ` · baseline ${b.heart_rate.toFixed(0)}` : ""),
    S.hrMean === null,
    S.hrMean === null ? (S.hrAll.length ? ["Provisional only", "warn"] : ["Unavailable", "na"]) : relPct >= 0.6 ? ["Reliable", "ok"] : ["Partly reliable", "warn"]);
  setOv("ov-br", S.brMean === null ? "--" : S.brMean.toFixed(1),
    S.brMean === null ? (app.quick ? "Needs 20 s of steady signal" : "No breathing readings")
      : `${S.br.length} s of readings · range ${S.brRange[0].toFixed(1)}–${S.brRange[1].toFixed(1)}` + (b.breathing_rate != null ? ` · baseline ${b.breathing_rate.toFixed(1)}` : ""),
    S.brMean === null, S.brMean === null ? ["Unavailable", "na"] : ["Measured", "ok"]);
  if (S.blinkFull.length) {
    setOv("ov-bl", S.blinkFullMean.toFixed(0), `Average of full 60 s counts (${S.blinkFull.length} s)` + (b.blink_rate != null ? ` · baseline ${b.blink_rate.toFixed(0)}` : ""), false, ["Full 60 s window", "ok"]);
  } else if (S.blinkLast) {
    setOv("ov-bl", `≈${S.blinkLast.blink.toFixed(0)}`, "Last count covered under 60 s", false, ["Provisional", "warn"]);
  } else setOv("ov-bl", "--", "No blink-rate readings", true, ["Unavailable", "na"]);
  setOv("ov-q", pctText(S.hrRel.length, S.n), S.qMean === null ? "Of seconds with readings" : `Of seconds with readings · mean quality ${S.qMean.toFixed(2)}${sqiPass() === null ? "" : ` (good above ${sqiPass().toFixed(2)})`}`, !S.n,
    !S.n ? ["No data", "na"] : relPct >= 0.6 ? ["Good", "ok"] : ["Often weak", "warn"]);
  if (S.judged.length) {
    setOv("ov-c", String(Math.round(S.calm / S.judged.length * 100)), `Of ${S.judged.length} judged seconds within baseline · ${app.events.length} elevated moment${app.events.length === 1 ? "" : "s"}`, false,
      app.events.length ? ["Some elevated", "warn"] : ["Within baseline", "ok"]);
    $("ov-c-u").textContent = "% calm";
  } else {
    setOv("ov-c", "--", app.quick ? "Not available in a 45 s quick read" : "Not judged: fewer than two baselines were ready", true, ["Not judged", "na"]);
    $("ov-c-u").textContent = "";
  }
  $("dl-wrap").hidden = !app.sessionEnded || !app.history.length;

  // composure block
  $("sum-calm").textContent = S.judged.length ? String(Math.round(S.calm / S.judged.length * 100)) : "--";
  $("sum-calm-u").textContent = S.judged.length ? `% of ${S.judged.length} judged seconds within your baseline` : "Composure was not judged in this session";
  stripInto($("sum-timeline"), app.history.map((s) => (s.state === "calm" || s.state === "elevated" ? s.state : "none")));
  const bm = (app.last && app.last.baseline && app.last.baseline.metrics) || {};
  const bl = [["Heart rate", "heart", "heart_rate", 0, "bpm"], ["Breathing", "breath", "breathing_rate", 1, "/min"], ["Blinks", "blink", "blink_rate", 0, "/min"]];
  $("baselines").replaceChildren(...bl.flatMap(([label, k, field, dg, unit]) => {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = `${label} baseline`;
    const m = bm[k];
    dd.textContent = b[field] != null ? `${b[field].toFixed(dg)} ${unit}`
      : m ? `Not ready · ${Math.floor(m.valid_sec || 0)} of ${m.need_valid_sec} s valid` : "Not ready";
    return [dt, dd];
  }));

  // availability strips
  const rows = [
    ["Heart rate", app.history.map((s) => (s.hr === null ? "none" : s.hrState === "reliable" ? "rel" : "prov")), S.hrRel.length],
    ["Breathing", app.history.map((s) => (s.br === null ? "none" : "rel")), S.br.length],
    ["Blinks", app.history.map((s) => (s.blink === null ? "none" : s.blinkFull ? "rel" : "prov")), S.blinkFull.length],
    ["Face", app.history.map((s) => (s.face ? "rel" : "none")), S.face],
  ];
  $("avail").replaceChildren(...rows.map(([label, kinds, good]) => {
    const row = document.createElement("div");
    row.className = "avail-row";
    const name = document.createElement("span"); name.textContent = label;
    const strip = document.createElement("div"); strip.className = "strip"; stripInto(strip, kinds);
    const pc = document.createElement("span"); pc.className = "pc"; pc.textContent = pctText(good, S.n);
    pc.title = "Reliable share of seconds with readings";
    row.append(name, strip, pc);
    return row;
  }));

  // per-chart stats lines
  const statLine = {
    heart_rate: S.hrAll.length ? `${S.hrRel.length} reliable s · ${S.hrAll.length - S.hrRel.length} provisional s · ${S.n - S.hrAll.length} s without a reading` : "",
    breathing_rate: S.br.length ? `${S.br.length} s with a reading · ${S.n - S.br.length} s without` : "",
    blink_rate: S.blink.length ? `${S.blinkFull.length} s counted over a full 60 s · ${S.blink.length - S.blinkFull.length} s provisional` : "",
  };
  for (const el of document.querySelectorAll("[data-stats]")) el.textContent = statLine[el.dataset.stats] || "";

  $("findings").replaceChildren(...findings(S, b).map(([cls, html]) => {
    const li = document.createElement("li");
    li.className = cls;
    // findings are built from numbers and fixed words only; <b> marks the lead phrase
    const [lead, rest] = html;
    const strong = document.createElement("b"); strong.textContent = lead;
    li.append(strong, document.createTextNode(" " + rest));
    return li;
  }));

  const moments = [
    ...app.events.map((e) => ({ t: e.t, node: momentItem("elevated", "Shifted from your baseline", e.reasons, mmss(e.t)) })),
    ...app.exercises.map((x) => ({ t: x.t, node: momentItem("exercise", "Breathing exercise", [`Heart rate ${x.hr}`, `Breathing ${x.br}`], mmss(x.t)) })),
  ].sort((a, b2) => a.t - b2.t);
  $("sum-events").replaceChildren(...moments.map((m) => m.node));
  $("sum-events-empty").hidden = moments.length > 0;
  $("q-plot-meta").textContent = `0 to 1 · heart rate counts as reliable only above ${passText().replace(/^its /, "the ")}`;
  renderCharts();
}

// A horizontal strip of runs, one cell per sample.
function stripInto(el, kinds) {
  el.replaceChildren();
  let prev = null, count = 0;
  const push = () => { if (prev !== null) { const i = document.createElement("i"); i.className = prev; i.style.flexGrow = String(count); el.appendChild(i); } };
  for (const k of kinds) {
    if (k !== prev) { push(); prev = k; count = 0; }
    count++;
  }
  push();
}

// Plain statements derived only from this session's numbers. No diagnosis, no guesses.
function findings(S, b) {
  const out = [];
  if (!S.n) return [["", ["No readings.", "The session ended before any measurement arrived."]]];
  const relShare = S.hrRel.length / S.n;
  if (S.hrRel.length) {
    out.push([relShare >= 0.6 ? "ok" : "warn", ["Heart rate", `was reliable for ${pctText(S.hrRel.length, S.n)} of the session, averaging ${S.hrMean.toFixed(0)} bpm.`]]);
  } else if (S.hrAll.length) {
    out.push(["bad", ["Heart rate", `was never reliable: the heart signal never rose above ${passText()}${S.qMean !== null ? ` (mean ${S.qMean.toFixed(2)})` : ""}. Even light from the front usually helps.`]]);
  } else out.push(["bad", ["Heart rate", "was not measured."]]);
  if (S.hrAll.length > S.hrRel.length && S.hrRel.length) {
    out.push(["warn", ["Weak-signal seconds", `(${S.hrAll.length - S.hrRel.length} s) are drawn dotted and left out of the average.`]]);
  }
  if (S.br.length) out.push(["ok", ["Breathing", `was measured for ${pctText(S.br.length, S.n)} of the session, averaging ${S.brMean.toFixed(1)} breaths/min.`]]);
  else out.push([app.quick ? "warn" : "bad", ["Breathing", app.quick ? "needs 20 s of steady signal; none passed its check in this quick read." : "never passed its quality check (chest motion not clear enough)."]]);
  if (S.blinkFull.length) out.push(["ok", ["Blinks", `averaged ${S.blinkFullMean.toFixed(0)}/min over full 60 s windows.`]]);
  else if (S.blinkLast) out.push(["warn", ["Blinks", `≈${S.blinkLast.blink.toFixed(0)}/min, counted over less than 60 s, so provisional.`]]);
  else out.push(["bad", ["Blinks", "were not counted."]]);
  if (S.face < S.n) out.push([S.face / S.n >= 0.9 ? "" : "warn", ["Face in view", `for ${pctText(S.face, S.n)} of the session; readings pause while it's missing.`]]);
  const cmp = [["heart_rate", S.hrMean, 0, "Heart rate", 1.15], ["breathing_rate", S.brMean, 1, "Breathing", 1.25]];
  for (const [k, mean, dg, label, ratio] of cmp) {
    if (b[k] != null && mean !== null) {
      const diff = ((mean / b[k]) - 1) * 100;
      out.push([mean > b[k] * ratio ? "warn" : "ok", [`${label} vs baseline:`, `session average ${mean.toFixed(dg)} against a baseline of ${b[k].toFixed(dg)} (${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(0)}%; elevated counts above +${Math.round((ratio - 1) * 100)}%).`]]);
    }
  }
  if (S.judged.length) {
    out.push([app.events.length ? "warn" : "ok", ["Composure", `was judged for ${S.judged.length} s and was within your baseline ${pctText(S.calm, S.judged.length)} of that time${app.events.length ? `, with ${app.events.length} elevated moment${app.events.length === 1 ? "" : "s"}` : ""}.`]]);
  } else {
    out.push(["", ["Composure", app.quick ? "is not available in a 45 s quick read: baselines need longer." : "was not judged: it needs at least two measurements with a ready baseline."]]);
  }
  return out;
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

// One row of session history per fresh reading. Every report chart and statistic
// is computed from these rows; each keeps its own reliability so nothing is upgraded.
function historySample(d) {
  const st = metricStatus(d);
  return {
    t: sessionSec(),
    face: !!d.face_found,
    hr: d.heart_rate, hrState: st.heart.state,
    q: d.signal_quality ?? null,
    br: d.breathing_rate,
    blink: d.blink_rate, blinkFull: st.blink.state === "reliable",
    state: d.composure.state,
  };
}

function showBanner(text, reconnect, tone) {
  $("banner-text").textContent = text || "";
  $("banner").hidden = !text;
  $("banner").classList.toggle("info", tone === "info");
  $("btn-reconnect").hidden = !reconnect || app.source !== "browser";
}

async function poll() {
  app.tick++;
  if (app.screen === "start" || app.sessionEnded) return;
  let d;
  try {
    const r = await fetch("/api/readings", { cache: "no-store" });
    if (r.status === 401) d = null;
    else if (!r.ok) throw new Error(`HTTP ${r.status}`);
    else d = await r.json();
  } catch (e) {
    showBanner("Can't reach the CUORE server. Is server.py still running?");
    return;
  }
  if (d === null) {                           // 401: the server restarted with a new pairing code
    showBanner("This device is no longer paired (the server restarted). End the session and pair again.");
    return;
  }
  if (!d.session || d.session.id !== app.sessionId) return;   // readings from another session
  app.last = d;
  renderDiag(d);

  if (app.cameraLost) showBanner("The camera stopped. Readings are paused until it's back.", true);
  else if (d.error) showBanner(`Processing stopped: ${d.error}`);
  else if (pausedForBackground) { /* keep the pause message until frames resume */ }
  else if (app.source === "browser" && app.frameErrors > 5) showBanner("Camera frames aren't reaching the server.");
  else showBanner("");

  const age = d.updated_at === null ? null : d.server_time - d.updated_at;
  if (age !== null && age <= STALE_SEC) app.history.push(historySample(d));
  updateQuick();
  if (app.sessionEnded) return;

  if (app.screen === "calibrate") { renderCalibration(d); return; }
  setStatus(d, age);
  $("pill-time").textContent = mmss(sessionSec());
  renderLive(d);
  updateNotice(d);
  updateBreatheLive(d);
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
  $("br-hr-start").textContent = `At start ${fmt(breathe.startHr, 0)}`;
  $("br-br-start").textContent = `At start ${fmt(breathe.startBr, 1)}`;
  updateBreatheLive(d);

  const orb = $("orb");
  orb.style.transitionDuration = "1s";
  orb.classList.remove("in");
  $("orb-count").textContent = "1:00";
  let n = Math.round(PACE.prepMs / 1000);
  $("orb-text").textContent = `Starting in ${n}`;
  breathe.ticker = setInterval(() => { n--; if (n > 0) $("orb-text").textContent = `Starting in ${n}`; }, 1000);
  breathe.timeouts.push(setTimeout(beginBreathing, PACE.prepMs));
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
    t: +t.toFixed(1), condition: $("diag-cond").value.trim(), quick: app.quick ? 1 : 0, source: app.source,
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
  $("diag-list").replaceChildren(...items.flatMap(([k, v]) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = cap(k); dd.textContent = v; return [dt, dd]; }));

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
  $("diag-stats").replaceChildren(...diag.stats.flatMap(([k, v]) => { const a = document.createElement("span"), b = document.createElement("span"); a.textContent = cap(k); b.textContent = v; return [a, b]; }));
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
  mountHearts();

  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => { app.reduceMotion = e.matches; });

  if (TEST.diag) {
    $("diag").hidden = false;
    $("diag-csv").addEventListener("click", downloadDiag);
    $("diag-fold").addEventListener("click", () => {
      const folded = $("diag").classList.toggle("folded");
      $("diag-fold").textContent = folded ? "Show" : "Hide";
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

  $("btn-start").addEventListener("click", onStart);
  $("btn-cancel").addEventListener("click", () => { stopCamera(); showScreen("start"); });
  $("btn-recal").addEventListener("click", async () => {
    try { await startSession(); showScreen("calibrate"); }
    catch (e) { showBanner(`Couldn't restart calibration: ${e.message || e}`); }
  });
  $("btn-end").addEventListener("click", endSession);
  // a new session starts from the start screen, so the length can be chosen again
  $("btn-new").addEventListener("click", () => { app.sessionStart = null; showScreen("start"); });
  $("btn-to-summary").addEventListener("click", () => showView("summary"));
  // Leaving mid-session (logo, back button, closing the tab) asks first: the
  // session's history lives only in this page and would be lost.
  window.addEventListener("beforeunload", (e) => {
    if (app.screen !== "start" && app.sessionStart && !app.sessionEnded) { e.preventDefault(); e.returnValue = ""; }
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
  window.addEventListener("resize", () => renderCharts());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseForBackground("Paused while CUORE was in the background. Readings resume when you come back.");
    else resumeFromBackground();
  });

  $("pair-form").addEventListener("submit", (e) => { e.preventDefault(); pairDevice($("pair-code").value); });
  showScreen("start");
  checkPairing();
  setInterval(poll, POLL_MS);
});
