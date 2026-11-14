// CUORE web UI. Shows readings exactly as the server reports them; all text goes
// in with textContent, nothing from the server is parsed as HTML.
"use strict";

const POLL_MS = 1000;
const STALE_SEC = 3;
const REARM_CALM_MS = 30000;      // pop-up can return only after 30 s of unbroken calm
const BASELINE_SEC = 60;
const JPEG_QUALITY = 0.92;        // high, so the tiny skin-colour changes survive
const GAUGE_MIN = 40, GAUGE_MAX = 160;
const RING_LEN = 326.7;           // 2 * pi * 52
const TIPS = [
  "Keep steady, even light on your face.",
  "Sit back a little so your shoulders show.",
  "Try to stay still and breathe normally.",
  "Keep this tab in front while measuring.",
  "Blink naturally. Blinks need a full minute to count.",
];

const $ = (id) => document.getElementById(id);
const fmt = (v, d) => (v === null || v === undefined ? "--" : v.toFixed(d));

const app = {
  screen: "start",
  source: null,          // "browser" or "webcam", from the server
  sessionId: null,
  sessionStart: null,
  stream: null,
  sending: false,
  inFlight: false,
  lastFrameOk: 0,
  frameErrors: 0,
  wasDown: false,
  tip: 0,
};

// ---------------------------------------------------------------- screens

function showScreen(name) {
  app.screen = name;
  for (const s of ["start", "calibrate", "main"]) $("screen-" + s).hidden = s !== name;
  if (name !== "main") { $("notice").hidden = true; $("notif-panel").hidden = true; }
}

function logoFallback() {
  for (const img of document.querySelectorAll("img.logo")) {
    const swap = () => { img.hidden = true; img.nextElementSibling.hidden = false; };
    if (img.complete && img.naturalWidth === 0) swap();
    else img.addEventListener("error", swap);
  }
}

// ---------------------------------------------------------------- camera

async function serverSource() {
  const r = await fetch("/api/readings", { cache: "no-store" });
  if (!r.ok) throw new Error(`server answered ${r.status}`);
  return (await r.json()).session.source;
}

async function openCamera() {
  app.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  for (const id of ["cal-video", "thumb-video"]) {
    const v = $(id);
    v.srcObject = app.stream;
    v.hidden = false;
    await v.play().catch(() => {});
  }
}

function stopCamera() {
  app.sending = false;
  if (app.stream) for (const t of app.stream.getTracks()) t.stop();
  app.stream = null;
  for (const id of ["cal-video", "thumb-video"]) $(id).srcObject = null;
  for (const id of ["cal-img", "thumb-img"]) $(id).removeAttribute("src");
}

function cameraError(e) {
  switch (e && e.name) {
    case "NotAllowedError": return "Camera permission was blocked. Click the camera icon in the address bar, allow it, then try again.";
    case "NotFoundError": return "No camera was found on this computer.";
    case "NotReadableError": return "The camera is busy. Close other apps using it (Zoom, FaceTime, app.py) and try again.";
    default: return `Couldn't start: ${e && e.message ? e.message : e}`;
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
  if (!app.inFlight && video.videoWidth) {
    const t = (meta && (meta.captureTime || meta.expectedDisplayTime)) || now;
    sendFrame(video, t);
  }
  pump();
}

async function sendFrame(video, tMs) {
  app.inFlight = true;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(video, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
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
    if (r.ok) { app.lastFrameOk = Date.now(); app.frameErrors = 0; }
    else if (r.status !== 409) app.frameErrors++;
  } catch (e) {
    app.frameErrors++;
  } finally {
    app.inFlight = false;
  }
}

async function startSession() {
  const r = await fetch("/api/session/start", { method: "POST", headers: { "X-Cuore-Client": "1" } });
  if (!r.ok) throw new Error(`server answered ${r.status}`);
  const d = await r.json();
  app.sessionId = d.session_id;
  app.source = d.source;
  app.sessionStart = Date.now();
  resetNotices();
  if (app.source === "browser") { app.sending = true; pump(); }
}

async function onStart() {
  const btn = $("btn-start");
  btn.disabled = true;
  $("start-error").hidden = true;
  try {
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
  } catch (e) {
    $("start-error").textContent = e && e.name ? cameraError(e) : String(e.message || e);
    $("start-error").hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- calibration

function renderCalibration(d) {
  const b = d.baseline, wf = b.waiting_for;
  const fresh = d.updated_at !== null && d.server_time - d.updated_at < STALE_SEC;
  const checks = {
    camera: app.source === "browser" ? Date.now() - app.lastFrameOk < 2000 : fresh,
    face: d.face_found,
    heart: d.heart_rate !== null,
    breath: d.breathing_rate !== null,
    blink: Array.isArray(wf) && !wf.includes("blink"),
    signal: d.signal_status === "good",
  };
  for (const li of $("checklist").children) li.classList.toggle("ok", !!checks[li.dataset.check]);

  const secs = b.seconds_collected;
  let frac = secs === null ? 0 : Math.min(1, secs / BASELINE_SEC);
  let sub = "waiting for a good signal";
  if (secs !== null) sub = "of 60 s of good signal";
  if (secs !== null && secs >= BASELINE_SEC && wf && wf.length) {
    frac = 0.97;
    sub = wf.includes("blink") ? "waiting for a full minute of blinks" : `waiting for ${wf.join(", ")}`;
  }
  $("ring-secs").textContent = String(Math.floor(secs || 0));
  $("ring-sub").textContent = sub;
  $("ring-bar").style.strokeDashoffset = String(RING_LEN * (1 - frac));

  if (!checks.face) $("cal-tip").textContent = "We can't see your face yet. Face the camera.";
  else if (d.signal_status === "weak") $("cal-tip").textContent = "Signal is weak. Hold still and keep steady light on your face.";
  else $("cal-tip").textContent = TIPS[app.tip % TIPS.length];

  if (b.ready) showScreen("main");
}

// ---------------------------------------------------------------- main screen

function sparkline(el, wave) {
  const vals = wave && wave.values ? wave.values : [];
  const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 2) { el.setAttribute("points", ""); return; }
  const box = el.ownerSVGElement.viewBox.baseVal;
  let lo = Infinity, hi = -Infinity;
  for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = hi - lo || 1, n = vals.length - 1 || 1, pad = 4;
  el.setAttribute("points", pts.map(([i, v]) =>
    `${(i / n * box.width).toFixed(1)},${(pad + (1 - (v - lo) / span) * (box.height - 2 * pad)).toFixed(1)}`).join(" "));
}

function buildGauge() {
  const g = $("gauge-ticks"), n = 31, cx = 110, cy = 116;
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (1 - i / (n - 1));
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", (cx + 74 * Math.cos(a)).toFixed(1));
    line.setAttribute("y1", (cy - 74 * Math.sin(a)).toFixed(1));
    line.setAttribute("x2", (cx + 96 * Math.cos(a)).toFixed(1));
    line.setAttribute("y2", (cy - 96 * Math.sin(a)).toFixed(1));
    line.dataset.bpm = String(GAUGE_MIN + (GAUGE_MAX - GAUGE_MIN) * i / (n - 1));
    g.appendChild(line);
  }
}

function renderGauge(bpm) {
  for (const line of $("gauge-ticks").children) {
    const v = Number(line.dataset.bpm);
    line.classList.toggle("on", bpm !== null && v <= bpm);
    line.classList.toggle("hot", v > 100);
  }
}

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderMain(d) {
  const hr = d.heart_rate;
  const signal = $("pill-signal");
  signal.dataset.status = d.signal_status;
  signal.textContent = { no_face: "No face", measuring: "Measuring", weak: "Weak signal", good: "Signal good" }[d.signal_status] || d.signal_status;
  $("pill-time").textContent = "Session " + mmss((Date.now() - app.sessionStart) / 1000);

  // heart rate gauge + heart
  const hrCard = $("m-heart");
  hrCard.querySelector("[data-v]").textContent = fmt(hr, 0);
  hrCard.classList.toggle("empty", hr === null);
  let sub = "Waiting for signal";
  if (d.signal_quality !== null) sub = `Signal quality ${d.signal_quality.toFixed(2)} (0 to 1)`;
  else if (d.heart_snr_db !== null) sub = `Signal-to-noise ${d.heart_snr_db.toFixed(1)} dB`;
  hrCard.querySelector("[data-sub]").textContent = sub;
  $("hr-source").textContent = d.hr_source || "";
  renderGauge(hr);

  const heart = $("heart");
  if (hr !== null && hr > 0) {
    heart.classList.remove("idle");
    heart.querySelector(".beat").style.animationDuration = (60 / hr).toFixed(3) + "s";
    $("heart-caption").textContent = `Pulsing at your measured ${hr.toFixed(0)} BPM.`;
  } else {
    heart.classList.add("idle");
    $("heart-caption").textContent = "Waiting for a heart rate. The heart stays still until there's a real reading.";
  }
  $("co-bpm").textContent = hr === null ? "-- BPM" : `${hr.toFixed(0)} BPM`;
  $("co-quality").textContent = d.signal_quality !== null ? `Quality ${d.signal_quality.toFixed(2)}`
    : d.heart_snr_db !== null ? `SNR ${d.heart_snr_db.toFixed(1)} dB` : "Signal --";

  const avg = d.average_heart_rate;
  if (avg) {
    const value = avg.done ? avg.result : avg.running_average;
    $("avg-v").textContent = fmt(value, 0);
    $("avg-span").textContent = `over ${mmss(avg.duration_sec)}`;
    $("avg-bar").style.width = `${Math.round((avg.progress || 0) * 100)}%`;
    $("avg-sub").textContent = avg.done ? `Final, from ${avg.readings} readings`
      : avg.readings === 0 ? "Waiting for heart rate"
      : `Recording ${mmss(avg.recorded_sec)} / ${mmss(avg.duration_sec)}` + (avg.paused ? " (paused)" : "");
    $("co-avg").textContent = value === null ? "Average --" : `Average ${value.toFixed(0)}`;
  }
  sparkline($("pulse-spark"), d.pulse_wave);

  // breathing + blinks
  const br = $("m-breath");
  br.querySelector("[data-v]").textContent = fmt(d.breathing_rate, 1);
  br.classList.toggle("empty", d.breathing_rate === null);
  br.querySelector("[data-sub]").textContent = d.breathing_rate === null ? "Needs about 20 s"
    : `From your ${d.breathing_channel}` + (d.breathing_channel === "head" ? ". Show your shoulders for better." : "");
  sparkline(br.querySelector("[data-spark]"), d.breath_wave);
  const bl = $("m-blink");
  bl.querySelector("[data-v]").textContent = fmt(d.blink_rate, 0);
  bl.classList.toggle("empty", d.blink_rate === null);

  renderComposure(d);
  updateNotice(d);

  const fps = d.processed_fps;
  $("fps").textContent = d.camera_fps === null ? "" :
    `Camera ${fmt(d.camera_fps, 0)} fps · processed ${fmt(fps, 0)} fps` + (fps !== null && fps < 15 ? " (needs 15+)" : "");
}

// ---------------------------------------------------------------- composure

const ROWS = [
  { row: "r-blink", flag: "blink_low", key: "blink_rate", digits: 0, unit: "/min",
    reason: (d) => `Blinking less: ${fmt(d.blink_rate, 0)}/min (baseline ${fmt(d.baseline.blink_rate, 0)})` },
  { row: "r-breath", flag: "breath_high", key: "breathing_rate", digits: 1, unit: "/min",
    reason: (d) => `Breathing faster: ${fmt(d.breathing_rate, 1)}/min (baseline ${fmt(d.baseline.breathing_rate, 1)})` },
  { row: "r-heart", flag: "hr_high", key: "heart_rate", digits: 0, unit: " BPM",
    reason: (d) => `Heart rate higher: ${fmt(d.heart_rate, 0)} BPM (baseline ${fmt(d.baseline.heart_rate, 0)})` },
];

const reasons = (d) => ROWS.filter((r) => d.composure[r.flag] === true).map((r) => r.reason(d));

function renderComposure(d) {
  const c = d.composure, b = d.baseline, state = c.state;
  const pill = $("c-state");
  pill.dataset.state = state === null ? "unknown" : state;
  pill.textContent = state === null ? "No data" : state[0].toUpperCase() + state.slice(1);
  let note = state === null ? "No current readings to compare."
    : state === "elevated" ? reasons(d).join(" · ")
    : state === "calm" ? "Within range of your baseline." : "Learning your baseline.";
  if (c.blink_baseline_too_low) note += " Your blink baseline is too low to judge a drop, so blinks aren't used this session.";
  $("c-note").textContent = note;

  for (const r of ROWS) {
    const tr = $(r.row), flag = c[r.flag];
    tr.querySelector("[data-now]").textContent = d[r.key] === null ? "--" : fmt(d[r.key], r.digits) + r.unit;
    tr.querySelector("[data-base]").textContent = b[r.key] === null ? "--" : fmt(b[r.key], r.digits) + r.unit;
    const cell = tr.querySelector("[data-flag]");
    const tooLow = r.flag === "blink_low" && c.blink_baseline_too_low;
    cell.textContent = flag === true ? "Flagged" : flag === false ? "OK" : tooLow ? "Too low" : "–";
    cell.classList.toggle("unknown", flag === null);
    tr.classList.toggle("flagged", flag === true);
  }
}

// ---------------------------------------------------------------- pop-up + notifications

let lastState = null, armed = true, calmSince = null, unread = 0;

function resetNotices() {
  lastState = null; armed = true; calmSince = null;
  $("notice").hidden = true;
}

function addNotification(kind, title, lines) {
  const li = document.createElement("li");
  li.className = kind;
  const strong = document.createElement("strong");
  strong.textContent = title;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.append(strong, time);
  for (const text of lines) {
    const p = document.createElement("div");
    p.textContent = text;
    li.appendChild(p);
  }
  $("notif-list").prepend(li);
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
    addNotification("elevated", "Change from your baseline", why);
    if (armed) {
      $("notice-reasons").replaceChildren(...why.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
      $("notice").hidden = false;
      armed = false;
    }
  }
  if (state === "calm" && lastState === "elevated") addNotification("calm", "Back within your baseline", []);
  if (state !== null) lastState = state;   // a missing reading doesn't count as a switch
}

// ---------------------------------------------------------------- polling

function setConn(text, cls) {
  const p = $("pill-conn");
  p.textContent = text;
  p.className = "pill pill-light" + (cls ? " " + cls : "");
}

function showBanner(text) {
  $("banner").textContent = text || "";
  $("banner").hidden = !text;
}

async function poll() {
  app.tip++;
  let d;
  try {
    const r = await fetch("/api/readings", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    setConn("Server not reachable", "down");
    app.wasDown = true;
    return;
  }
  if (app.screen === "start") return;
  if (!d.session || d.session.id !== app.sessionId) return;   // readings from another session

  if (d.error) showBanner(`Processing stopped: ${d.error}`);
  else if (app.source === "browser" && app.frameErrors > 5) showBanner("Camera frames aren't reaching the server.");
  else showBanner("");

  const age = d.updated_at === null ? null : d.server_time - d.updated_at;
  if (age === null) setConn("Starting…", "stale");
  else if (age > STALE_SEC) setConn(`No new readings for ${Math.floor(age)} s`, "stale");
  else setConn("Live", "");

  if (app.screen === "calibrate") renderCalibration(d);
  if (app.screen === "main") renderMain(d);
}

// ---------------------------------------------------------------- full screen

function openFull() {
  $("full-img").src = "/video?t=" + Date.now();
  $("full").hidden = false;
  const el = $("full");
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function closeFull() {
  $("full").hidden = true;
  $("full-img").removeAttribute("src");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------------------------------------------------------------- wiring

document.addEventListener("DOMContentLoaded", () => {
  logoFallback();
  buildGauge();
  $("btn-start").addEventListener("click", onStart);
  $("btn-cancel").addEventListener("click", () => { stopCamera(); showScreen("start"); });
  $("btn-recal").addEventListener("click", async () => {
    try { await startSession(); showScreen("calibrate"); }
    catch (e) { showBanner(`Couldn't restart calibration: ${e.message || e}`); }
  });
  $("btn-full").addEventListener("click", openFull);
  $("btn-full-close").addEventListener("click", closeFull);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !$("full").hidden) closeFull(); });
  $("notice-close").addEventListener("click", () => { $("notice").hidden = true; });
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
  showScreen("start");
  poll();
  setInterval(poll, POLL_MS);
});
