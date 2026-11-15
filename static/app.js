"use strict";

// Colours match the desktop dashboard in app.py.
const COLORS = {
  pulse: "#ff5a6e",
  breath: "#60a5fa",
  grid: "#2f343c",
  axis: "#2a2e36",
  label: "#6f747b",
};

const $ = (id) => document.getElementById(id);
const RING_LENGTH = 2 * Math.PI * 52;   // circumference of the average ring (r = 52)

const AVG_TAGS = { calibrating: "CAL", recording: "REC", paused: "PAUSED", done: "FINAL" };

let latest = null;

// ----- live connection -----

function connect() {
  const events = new EventSource("/api/stream");
  events.onopen = () => setConnection("live", "Live");
  events.onmessage = (event) => {
    setConnection("live", "Live");
    latest = JSON.parse(event.data);
    render(latest);
  };
  events.onerror = () => setConnection("lost", "Reconnecting");   // EventSource retries by itself
}

function setConnection(state, label) {
  const el = $("connection");
  if (el.dataset.state === state) return;
  el.dataset.state = state;
  el.querySelector(".label").textContent = label;
  if (state === "live") restartVideo();
}

// The MJPEG stream ends if the server restarts, so reopen it when the connection returns.
function restartVideo() {
  const img = $("video");
  img.src = "/video.mjpg?t=" + Date.now();
}
$("video").addEventListener("error", () => setTimeout(restartVideo, 2000));

// ----- page updates -----

function setNumber(el, value, digits = 0) {
  const empty = value === null || value === undefined;
  el.textContent = empty ? "--" : value.toFixed(digits);
  el.classList.toggle("empty", empty);
}

function render(s) {
  const error = $("error");
  error.hidden = !s.error;
  error.textContent = s.error || "";
  if (!s.ready) return;

  $("video-placeholder").hidden = true;

  // Status over the camera picture
  const status = $("status");
  status.dataset.level = s.status.level;
  status.querySelector(".label").textContent = s.status.text;

  // Heart rate
  const heart = s.heart;
  $("hr-source").textContent = heart.source;
  setNumber($("bpm"), heart.bpm);
  const beat = $("beat");
  beat.classList.toggle("active", heart.bpm !== null);
  if (heart.bpm) beat.style.setProperty("--beat", (60 / heart.bpm).toFixed(3) + "s");

  const qualityRow = $("quality-row");
  if (heart.source === "colour") {
    qualityRow.hidden = true;                // the colour method has no quality index
  } else {
    qualityRow.hidden = false;
    const q = heart.quality;
    $("quality-text").textContent = q === null ? "—" : q.toFixed(2);
    const fill = $("quality-bar");
    fill.style.width = q === null ? "0%" : Math.round(Math.max(0, Math.min(1, q)) * 100) + "%";
    fill.className = "bar-fill" + (q === null ? "" : q >= heart.good_quality ? " ok" : " warn");
    $("quality-mark").style.left = heart.good_quality * 100 + "%";
    $("quality-mark").title = "Good signal from " + heart.good_quality.toFixed(2);
  }

  // Average
  const avg = s.average;
  $("avg-duration").textContent = "(" + avg.duration_text + ")";
  const tag = $("avg-tag");
  tag.dataset.phase = avg.phase;
  tag.querySelector("span").textContent = AVG_TAGS[avg.phase];
  const avgValue = $("avg-value");
  setNumber(avgValue, avg.value);
  avgValue.classList.toggle("final", avg.phase === "done");
  $("avg-ring").style.strokeDashoffset = (RING_LENGTH * (1 - (avg.progress || 0))).toFixed(2);
  $("avg-footer").textContent = avg.footer;

  // Other readings
  setNumber($("resp"), s.breathing.rate, 1);
  $("resp-channel").textContent = s.breathing.channel ? "from " + s.breathing.channel + " movement" : "\u00a0";
  setNumber($("blinks"), s.blinks.rate);
  setNumber($("fps-camera"), s.fps.camera);
  const processed = $("fps-processed");
  setNumber(processed, s.fps.processed);
  processed.classList.toggle("low", s.fps.processed !== null && s.fps.processed < 15);

  const points = s.motion_points || {};
  $("motion-points").textContent = s.face_found
    ? `motion points: head ${points.head ?? 0}, neck ${points.neck ?? 0}` : "";

  const tips = $("tips");
  tips.replaceChildren(...s.tips.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));

  // Graphs
  $("pulse-value").textContent = heart.bpm !== null ? heart.bpm.toFixed(0) + " BPM" : "";
  $("breath-value").textContent = s.breathing.rate !== null ? s.breathing.rate.toFixed(1) + " /min" : "";
  drawChart($("pulse-chart"), s.pulse, 5, COLORS.pulse);
  drawChart($("breath-chart"), s.breath, 30, COLORS.breath);
}

// ----- graphs -----

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Scrolling signal with the newest sample on the right edge, like draw_graph in app.py. */
function drawChart(canvas, wave, seconds, color) {
  const { ctx, width, height } = prepareCanvas(canvas);
  const left = 2, right = width - 2, top = 6, bottom = height - 22;
  const plotW = right - left, plotH = bottom - top;

  // Grid and time axis
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.setLineDash([4, 5]);
  for (let i = 1; i < 4; i++) {
    const y = Math.round(top + (plotH * i) / 4) + 0.5;
    line(ctx, left, y, right, y);
  }
  const step = seconds <= 10 ? 1 : 5;
  ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
  ctx.fillStyle = COLORS.label;
  ctx.textBaseline = "top";
  for (let s = 0; s <= seconds; s += step) {
    const x = right - (plotW * s) / seconds;
    if (s) line(ctx, Math.round(x) + 0.5, top, Math.round(x) + 0.5, bottom);
    const label = s === 0 ? "now" : `-${s}s`;
    const w = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(Math.max(x - w / 2, left), right - w), bottom + 6);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = COLORS.axis;
  line(ctx, left, bottom + 0.5, right, bottom + 0.5);

  if (!wave || wave.values.length < 2) {
    ctx.fillStyle = COLORS.label;
    ctx.font = "13px " + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for signal…", left + plotW / 2, top + plotH / 2);
    ctx.textAlign = "start";
    return;
  }

  const values = wave.values;
  const n = values.length;
  const pad = 0.12 * plotH;
  const xs = values.map((_, i) => right - ((n - 1 - i) / wave.fs / seconds) * plotW);
  const ys = values.map((v) => bottom - pad - v * (plotH - 2 * pad));

  const path = new Path2D();
  path.moveTo(xs[0], ys[0]);
  for (let i = 1; i < n; i++) path.lineTo(xs[i], ys[i]);

  // Area fill under the line
  const area = new Path2D(path);
  area.lineTo(xs[n - 1], bottom);
  area.lineTo(xs[0], bottom);
  area.closePath();
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, hexToRgba(color, 0.28));
  gradient.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fill(area);

  // Glowing line
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = hexToRgba(color, 0.7);
  ctx.shadowBlur = 10;
  ctx.stroke(path);
  ctx.shadowBlur = 0;

  // Newest point
  const ex = xs[n - 1], ey = ys[n - 1];
  ctx.fillStyle = hexToRgba(color, 0.3);
  circle(ctx, ex, ey, 8);
  ctx.fillStyle = color;
  circle(ctx, ex, ey, 4);
  ctx.strokeStyle = "#ebebeb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(ex, ey, 4, 0, Math.PI * 2);
  ctx.stroke();
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

window.addEventListener("resize", () => {
  if (!latest || !latest.ready) return;
  drawChart($("pulse-chart"), latest.pulse, 5, COLORS.pulse);
  drawChart($("breath-chart"), latest.breath, 30, COLORS.breath);
});

// ----- restarting the average -----

async function resetAverage() {
  const button = $("avg-reset");
  button.disabled = true;
  try {
    await fetch("/api/average/reset", { method: "POST", headers: { "X-Cuore": "1" } });
  } finally {
    button.disabled = false;
  }
}

$("avg-reset").addEventListener("click", resetAverage);
document.addEventListener("keydown", (event) => {
  if ((event.key === "r" || event.key === "R") && !event.ctrlKey && !event.metaKey && !event.altKey) {
    resetAverage();
  }
});

// Draw empty graphs straight away so the layout doesn't jump.
drawChart($("pulse-chart"), null, 5, COLORS.pulse);
drawChart($("breath-chart"), null, 30, COLORS.breath);
connect();
