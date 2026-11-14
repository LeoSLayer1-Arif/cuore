// Cuore phone page. This file only captures camera frames, sends them to the
// laptop, and draws the results it sends back. All measuring (face tracking,
// colour signals, filtering, FFT, heart rate, breathing, average) happens in
// Python on the laptop. Nothing here calculates a heart rate.
"use strict";

const MAGIC = [0x43, 0x55, 0x4f, 0x31];          // "CUO1", must match server.py FRAME_MAGIC
const STALE_RESULT_MS = 2000;                      // older results are hidden, not shown as live
const ACK_TIMEOUT_MS = 3000;                       // no answer for this long = network problem
const MAX_BUFFERED_BYTES = 1_000_000;              // don't pile frames into a slow connection

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $("stage"), video: $("video"), overlay: $("overlay"),
  liveValue: $("live-value"), liveSource: $("live-source"),
  avgTitle: $("avg-title"), avgTag: $("avg-tag"), avgTagText: $("avg-tag-text"), avgDot: $("avg-dot"),
  avgValue: $("avg-value"), avgBar: $("avg-bar"), avgFooter: $("avg-footer"),
  rows: $("rows"), statusDot: $("status-dot"), statusText: $("status-text"), notes: $("notes"),
  pulse: $("pulse-graph"), breath: $("breath-graph"),
  start: $("start"), stop: $("stop"), reset: $("reset"), banner: $("banner"),
};

const COLORS = {
  panelBorder: "rgb(66,70,78)", grid: "rgb(60,64,70)", text: "rgb(235,235,235)",
  dim: "rgb(155,160,165)", faint: "rgb(110,115,120)", pulse: "rgb(255,90,110)",
  breath: "rgb(96,165,250)", red: "rgb(255,80,80)", yellow: "rgb(255,220,0)",
  gray: "rgb(170,170,170)", green: "rgb(0,255,0)", blue: "rgb(60,160,255)", magenta: "rgb(255,0,255)",
};

const state = {
  ws: null, stream: null, measuring: false, ready: false, stopping: false,
  seq: 0, inFlight: new Map(), maxInFlight: 2, capture: { max_side: 640, frame_rate: 30, jpeg_quality: 0.92 },
  encoding: false, lastCaptureMs: 0, timestampSource: "-",
  canvas: document.createElement("canvas"), ctx: null,
  vitals: null, vitalsAt: 0, clientIssue: null, wakeLock: null, frameCallback: null,
  stats: null,
};
state.ctx = state.canvas.getContext("2d", { willReadFrequently: false });

function resetStats() {
  state.stats = {
    presented: [], sent: [], skippedBusy: 0, skippedInFlight: 0, skippedTime: 0, droppedByServer: 0,
    rtt: [], latency: [], lastPresented: null, missedCallbacks: 0,
  };
}
resetStats();

// ---------------------------------------------------------------- helpers

function rate(times) {                              // same formula as rate_from_times in app.py
  if (times.length < 2) return 0;
  return (times.length - 1) / ((times[times.length - 1] - times[0]) / 1000 + 1e-9);
}
function pushWindow(list, value, max = 60) { list.push(value); if (list.length > max) list.shift(); }
function mean(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; }

function showBanner(text) { ui.banner.textContent = text; ui.banner.hidden = !text; }

function setStatus(text, color) {
  ui.statusText.textContent = text;
  ui.statusText.style.color = color;
  ui.statusDot.style.background = color;
}

function setButtons() {
  ui.start.disabled = state.measuring || state.stopping;
  ui.stop.disabled = !state.measuring;
  ui.reset.disabled = !state.ready;
}

// ---------------------------------------------------------------- camera

async function openCamera() {
  const want = {
    audio: false,
    video: {
      facingMode: { ideal: "user" },
      width: { ideal: 640 }, height: { ideal: 480 },
      frameRate: { ideal: state.capture.frame_rate, max: state.capture.frame_rate },
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(want);
  } catch (error) {
    if (error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
    }
    throw error;
  }
}

function cameraErrorText(error) {
  switch (error && error.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied. Allow camera access for this site in your browser's settings, then press Start.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No front camera was found on this device.";
    case "NotReadableError":
    case "AbortError":
      return "The camera is in use by another app. Close it and press Start again.";
    default:
      return `Could not open the camera (${error && error.name ? error.name : error}).`;
  }
}

function stopCamera() {
  if (state.frameCallback !== null && ui.video.cancelVideoFrameCallback) {
    ui.video.cancelVideoFrameCallback(state.frameCallback);
  }
  state.frameCallback = null;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  ui.video.srcObject = null;
  ui.stage.classList.remove("live");
}

// ---------------------------------------------------------------- frame capture and sending

function scheduleFrame() {
  if (!state.measuring) return;
  if (ui.video.requestVideoFrameCallback) {
    state.frameCallback = ui.video.requestVideoFrameCallback(onVideoFrame);
  } else {
    // Older browsers: no per-frame callback, so poll at the camera's frame rate.
    const settings = state.stream.getVideoTracks()[0].getSettings();
    setTimeout(() => onVideoFrame(performance.now(), null), 1000 / (settings.frameRate || 30));
  }
}

function onVideoFrame(now, meta) {
  scheduleFrame();
  const video = ui.video;
  if (!state.ready || !video.videoWidth) return;
  const st = state.stats;

  // The real capture time if the browser reports it, else the moment this frame was handed to us.
  let t = now;
  state.timestampSource = "callback";
  if (meta && typeof meta.captureTime === "number" && meta.captureTime > 0) {
    t = meta.captureTime;
    state.timestampSource = "camera";
  }
  if (meta && typeof meta.presentedFrames === "number") {
    if (st.lastPresented !== null && meta.presentedFrames > st.lastPresented + 1) {
      st.missedCallbacks += meta.presentedFrames - st.lastPresented - 1;
    }
    st.lastPresented = meta.presentedFrames;
  }
  pushWindow(st.presented, t);
  const captureMs = performance.timeOrigin + t;
  if (captureMs <= state.lastCaptureMs) { st.skippedTime++; return; }

  // Flow control: never queue frames. If the laptop or network is behind, skip this
  // frame (counted) rather than sending it late; the server sees the gap in the times.
  if (state.inFlight.size >= state.maxInFlight || state.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    st.skippedInFlight++; return;
  }
  if (state.encoding) { st.skippedBusy++; return; }

  const scale = Math.min(1, state.capture.max_side / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
  if (state.canvas.width !== w || state.canvas.height !== h) { state.canvas.width = w; state.canvas.height = h; }
  state.ctx.drawImage(video, 0, 0, w, h);          // un-mirrored, like a webcam; the laptop mirrors it
  state.lastCaptureMs = captureMs;
  const seq = state.seq++;
  state.encoding = true;
  state.canvas.toBlob(async (blob) => {
    try {
      if (!blob || !state.measuring || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      const image = await blob.arrayBuffer();
      const header = new ArrayBuffer(16);
      const view = new DataView(header);
      MAGIC.forEach((b, i) => view.setUint8(i, b));
      view.setUint32(4, seq, true);
      view.setFloat64(8, captureMs, true);
      const message = new Uint8Array(16 + image.byteLength);
      message.set(new Uint8Array(header), 0);
      message.set(new Uint8Array(image), 16);
      state.inFlight.set(seq, { sentAt: performance.now(), captureMs });
      state.ws.send(message);
      pushWindow(st.sent, performance.now());
    } finally {
      state.encoding = false;
    }
  }, "image/jpeg", state.capture.jpeg_quality);
}

function onAck(msg) {
  const sent = state.inFlight.get(msg.seq);
  state.inFlight.delete(msg.seq);
  if (msg.dropped) { state.stats.droppedByServer++; return; }
  if (!sent) return;
  const now = performance.now();
  pushWindow(state.stats.rtt, now - sent.sentAt, 30);
  pushWindow(state.stats.latency, performance.timeOrigin + now - sent.captureMs, 30);
}

function sendStats() {
  if (!state.ready || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const st = state.stats;
  const s = {
    type: "stats", camera_fps: rate(st.presented), sent_fps: rate(st.sent),
    skipped_busy: st.skippedBusy, skipped_in_flight: st.skippedInFlight,
    rtt_ms: mean(st.rtt), latency_ms: mean(st.latency),
    width: state.canvas.width, height: state.canvas.height,
  };
  Object.keys(s).forEach((k) => (s[k] === null ? delete s[k] : null));
  state.ws.send(JSON.stringify(s));
}

// ---------------------------------------------------------------- connection

function connect() {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Could not connect to the laptop."));
    ws.onmessage = (event) => onMessage(JSON.parse(event.data));
    ws.onclose = () => onClose(ws);
  });
}

function onMessage(msg) {
  switch (msg.type) {
    case "loading":
      setStatus("Laptop is loading the measurement model...", COLORS.gray);
      break;
    case "ready":
      state.ready = true;
      state.maxInFlight = msg.max_in_flight || 2;
      state.capture = Object.assign(state.capture, msg.capture || {});
      ui.liveSource.textContent = msg.hr_source;
      setStatus("Measuring... hold still", COLORS.gray);
      setButtons();
      break;
    case "ack":
      onAck(msg);
      break;
    case "vitals":
      state.vitals = msg;
      state.vitalsAt = performance.now();
      break;
    case "stopped":
      state.ready = false;
      setButtons();
      break;
    case "error":
      if (msg.code === "busy" || msg.code === "processing") {
        showBanner(msg.code === "busy" ? msg.message : `Laptop processing error: ${msg.message}`);
        stopMeasuring(false);
      }
      console.warn("server:", msg);
      break;
  }
}

function onClose(ws) {
  if (ws !== state.ws) return;
  state.ws = null;
  if (state.measuring) {
    showBanner("Connection to the laptop was lost. Check that the server is still running and the phone is on the same Wi-Fi, then press Start.");
    stopMeasuring(false);
  }
  state.stopping = false;
  setButtons();
}

// ---------------------------------------------------------------- start / stop

async function startMeasuring() {
  showBanner("");
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showBanner("The camera needs a secure (https://) page. Open the https:// address printed by server.py, after installing the certificate as described in the README.");
    return;
  }
  state.measuring = true;
  setButtons();
  resetStats();
  state.inFlight.clear();
  state.seq = 0;
  state.lastCaptureMs = 0;
  state.vitals = null;
  state.clientIssue = null;
  try {
    state.stream = await openCamera();
  } catch (error) {
    showBanner(cameraErrorText(error));
    state.measuring = false;
    setButtons();
    return;
  }
  const track = state.stream.getVideoTracks()[0];
  track.addEventListener("ended", () => {
    if (!state.measuring) return;
    showBanner("The camera stopped (disconnected or taken by another app). Press Start to try again.");
    stopMeasuring(true);
  });
  ui.video.srcObject = state.stream;
  try { await ui.video.play(); } catch (e) { /* autoplay with muted+playsinline is allowed */ }
  ui.stage.classList.add("live");
  layout();

  try {
    state.ws = await connect();
  } catch (error) {
    showBanner(error.message + " Is server.py running?");
    stopMeasuring(false);
    return;
  }
  state.ws.send(JSON.stringify({ type: "start" }));
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { state.wakeLock = null; }
  scheduleFrame();
}

function stopMeasuring(tellServer = true) {
  const wasMeasuring = state.measuring;
  state.measuring = false;
  stopCamera();
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  if (tellServer && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.stopping = true;
    state.ws.send(JSON.stringify({ type: "stop" }));
    const ws = state.ws;
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); }, 3000);
  } else if (state.ws) {
    state.ws.close();
  }
  state.ready = false;
  state.inFlight.clear();
  if (wasMeasuring) setStatus("Stopped", COLORS.gray);
  ui.liveValue.textContent = "--";
  ui.liveValue.classList.add("faint");
  setButtons();
}

ui.start.addEventListener("click", startMeasuring);
ui.stop.addEventListener("click", () => stopMeasuring(true));
ui.reset.addEventListener("click", () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: "reset_average" }));
});
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.measuring) {
    try { await ui.video.play(); } catch (e) { /* ignore */ }
    if (!state.wakeLock) { try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* ignore */ } }
  }
});
setInterval(sendStats, 1000);

// ---------------------------------------------------------------- drawing

function render() {
  requestAnimationFrame(render);
  const v = state.vitals;
  const now = performance.now();

  // Problems only the phone can see take priority over the laptop's status.
  let issue = null;
  if (state.measuring && state.ready) {
    let oldest = Infinity;
    state.inFlight.forEach((f) => { oldest = Math.min(oldest, f.sentAt); });
    if (now - oldest > ACK_TIMEOUT_MS) issue = ["Network interruption: waiting for the laptop", COLORS.red];
    else if (document.visibilityState !== "visible") issue = ["Camera paused (page in background)", COLORS.yellow];
  }
  const fresh = v && state.measuring && now - state.vitalsAt < STALE_RESULT_MS;

  if (state.measuring && state.ready) {
    if (issue) setStatus(issue[0], issue[1]);
    else if (fresh) setStatus(v.status, v.status_color);
    else if (v) setStatus("Waiting for results from the laptop...", COLORS.yellow);
  }

  // Live heart rate: only ever the laptop's current reading, never an old one.
  const liveText = fresh && !issue ? v.bpm_text : "--";
  ui.liveValue.textContent = liveText;
  ui.liveValue.classList.toggle("faint", liveText === "--");

  if (v) {
    const a = v.average;
    ui.avgTitle.textContent = a.title;
    ui.avgTagText.textContent = a.tag;
    ui.avgTag.style.color = a.tag_color;
    ui.avgDot.classList.toggle("on", a.tag === "REC" && state.measuring);
    ui.avgDot.classList.toggle("blink", Math.floor(now / 500) % 2 === 1);
    ui.avgValue.textContent = a.value;
    ui.avgValue.style.color = a.value_color;
    ui.avgValue.classList.remove("faint");
    ui.avgBar.style.width = `${(a.progress * 100).toFixed(1)}%`;
    ui.avgFooter.textContent = a.footer;
    ui.liveSource.textContent = v.hr_source;
    renderRows(v);
  }
  const pulse = fresh ? v.pulse : null;
  const breath = fresh ? v.breath : null;
  drawGraph(ui.pulse, pulse && pulse.samples, pulse && pulse.fs, 5, COLORS.pulse, "PULSE",
            fresh && v.bpm !== null && !issue ? `${v.bpm_text} BPM` : null);
  drawGraph(ui.breath, breath && breath.samples, breath && breath.fs, 30, COLORS.breath, "BREATHING", null);
  drawOverlay(fresh ? v.overlay : null);
}

let lastRowsKey = "";
function renderRows(v) {
  const st = state.stats;
  const net = state.measuring
    ? `Phone: sent ${rate(st.sent).toFixed(0)} fps, skipped ${st.skippedInFlight + st.skippedBusy}` +
      (mean(st.latency) !== null ? `, delay ${mean(st.latency).toFixed(0)} ms` : "") +
      ` (${state.timestampSource} times)`
    : null;
  const notes = v.notes.slice();
  if (net) notes.push(net);
  if (v.gap_s) notes.push(`Frames interrupted: ${v.gap_s.toFixed(1)} s gap`);
  const key = JSON.stringify([v.rows, notes]);
  if (key === lastRowsKey) return;
  lastRowsKey = key;
  ui.rows.replaceChildren(...v.rows.map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("span"); l.textContent = label;
    const r = document.createElement("span"); r.textContent = value;
    row.append(l, r);
    return row;
  }));
  ui.notes.replaceChildren(...notes.map((text) => {
    const d = document.createElement("div");
    d.textContent = text;
    if (text.startsWith("Frames interrupted")) d.style.color = COLORS.yellow;
    return d;
  }));
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

function percentile(sorted, p) {                    // NumPy's default (linear) percentile
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function dashed(ctx, x0, y0, x1, y1) {
  ctx.save();
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.restore();
}

// Same layout and look as draw_graph() in app.py: title, live value, dashed grid,
// time axis, glow line with area fill, and a marker on the newest sample.
function drawGraph(canvas, samples, fs, seconds, color, title, valueText) {
  const [ctx, w, h] = fitCanvas(canvas);
  ctx.textBaseline = "alphabetic";
  ctx.font = "13px system-ui, sans-serif"; ctx.fillStyle = COLORS.dim;
  ctx.fillText(title, 16, 26);
  if (valueText) {
    ctx.font = "600 15px ui-monospace, Menlo, monospace"; ctx.fillStyle = color;
    ctx.fillText(valueText, w - 16 - ctx.measureText(valueText).width, 27);
  }
  const left = 16, top = 42, right = w - 16, bottom = h - 30;
  const plotW = right - left, plotH = bottom - top;
  for (let i = 1; i < 4; i++) dashed(ctx, left, top + plotH * i / 4, right, top + plotH * i / 4);
  const step = seconds <= 10 ? 1 : 5;
  ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COLORS.faint;
  for (let s = 0; s <= seconds; s += step) {
    const gx = right - plotW * s / seconds;
    if (s) dashed(ctx, gx, top, gx, bottom);
    const label = s === 0 ? "now" : `-${s}s`;
    const lw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(Math.max(gx - lw / 2, left), right - lw), bottom + 18);
  }
  ctx.strokeStyle = COLORS.panelBorder; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke();

  if (!samples || samples.length < 2 || !fs) {
    const msg = "waiting for signal...";
    ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = COLORS.faint;
    ctx.fillText(msg, left + (plotW - ctx.measureText(msg).width) / 2, top + plotH / 2 + 5);
    return;
  }
  const n = samples.length;
  const sorted = samples.slice().sort((a, b) => a - b);
  const low = percentile(sorted, 2), high = percentile(sorted, 98);   // ignore single spikes
  const pad = 0.12 * plotH;
  const xs = new Array(n), ys = new Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = right - (n - 1 - i) / fs / seconds * plotW;
    const norm = Math.min(1, Math.max(0, (samples[i] - low) / (high - low + 1e-9)));
    ys[i] = bottom - pad - norm * (plotH - 2 * pad);
  }
  const path = new Path2D();
  path.moveTo(xs[0], ys[0]);
  for (let i = 1; i < n; i++) path.lineTo(xs[i], ys[i]);
  const area = new Path2D(path);
  area.lineTo(xs[n - 1], bottom); area.lineTo(xs[0], bottom); area.closePath();

  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, plotW + 1, plotH + 1); ctx.clip();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = color; ctx.fill(area);
  ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke(path);
  ctx.restore();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke(path);
  const ex = xs[n - 1], ey = ys[n - 1];
  ctx.globalAlpha = 0.35; ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(ex, ey, 8, 0, 2 * Math.PI); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(ex, ey, 4, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = COLORS.text; ctx.lineWidth = 1; ctx.stroke();
}

// Face regions, chest box and motion points, as the desktop app draws them on the picture.
function drawOverlay(o) {
  const [ctx, w, h] = fitCanvas(ui.overlay);
  if (!o || !o.frame || !o.polygons) return;
  const [fw, fh] = o.frame;
  const s = Math.min(w / fw, h / fh);
  const ox = (w - fw * s) / 2, oy = (h - fh * s) / 2;
  const P = (p) => [ox + p[0] * s, oy + p[1] * s];
  const poly = (points, color) => {
    if (!points || !points.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    points.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke();
  };
  const rect = (b, color) => { if (b) poly([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], color); };
  if (o.mode === "colour") o.polygons.forEach((p) => poly(p, COLORS.green));
  else rect(o.box, COLORS.green);
  rect(o.chest, COLORS.blue);
  (o.motion || []).forEach((outlines) => outlines.forEach((p) => poly(p, COLORS.magenta)));
  ctx.fillStyle = COLORS.magenta;
  (o.motion_points || []).forEach((pts) => pts.forEach((p) => {
    const [x, y] = P(p); ctx.fillRect(x - 1, y - 1, 2, 2);
  }));
}

// ---------------------------------------------------------------- layout

// Big screens get the desktop layout itself (1024 px board over the camera picture),
// scaled to fit. Phones get the same cards stacked, so the text stays readable.
function layout() {
  const dash = $("dash");
  const vw = ui.video.videoWidth || 640, vh = ui.video.videoHeight || 480;
  const boardH = Math.round(1024 * vh / vw);
  const scale = Math.min(window.innerWidth / 1024, window.innerHeight / boardH);
  const board = scale >= 0.7 && vw >= vh;
  document.body.classList.toggle("board-mode", board);
  if (board) {
    dash.style.height = `${boardH}px`;
    dash.style.transform = `scale(${scale})`;
    ui.stage.style.aspectRatio = "";
  } else {
    dash.style.height = ""; dash.style.transform = "";
    ui.stage.style.aspectRatio = `${vw} / ${vh}`;
  }
}
window.addEventListener("resize", layout);
ui.video.addEventListener("loadedmetadata", layout);
layout();
setButtons();
requestAnimationFrame(render);
