// Polls /api/readings once a second and shows the values exactly as the server reports them.
// All text goes in with textContent; nothing from the server is parsed as HTML.
"use strict";

const POLL_MS = 1000;
const STALE_SEC = 3;            // readings older than this are shown as stale
const REARM_CALM_MS = 30000;    // pop-up can return only after 30 s of unbroken calm
const BASELINE_SEC = 60;

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = { no_face: "No face", measuring: "Measuring", weak: "Weak signal", good: "Signal good" };
const STATUS_HINT = {
  no_face: "Face the camera.",
  measuring: "Hold still while it measures.",
  weak: "Hold still and keep steady light on your face.",
  good: "",
};

function fmt(value, digits) {
  return value === null || value === undefined ? "--" : value.toFixed(digits);
}

// ----- metrics -----

function mmss(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function averageText(avg) {
  if (!avg) return "";
  const span = mmss(avg.duration_sec);
  if (avg.done) return `Average over ${span}: ${fmt(avg.result, 0)} BPM (final)`;
  if (avg.readings === 0) return `Average over ${span}: waiting for heart rate`;
  return `Average so far: ${fmt(avg.running_average, 0)} BPM · ${mmss(avg.recorded_sec)} / ${span}`
    + (avg.paused ? " (paused)" : "");
}

function setMetric(id, value, digits, sub) {
  const card = $(id);
  card.querySelector("[data-v]").textContent = fmt(value, digits);
  card.querySelector("[data-sub]").textContent = sub;
  card.classList.toggle("empty", value === null || value === undefined);
}

function renderMetrics(d) {
  let heartSub = "Waiting for signal";
  if (d.signal_quality !== null && d.signal_quality !== undefined) {
    heartSub = `Quality ${d.signal_quality.toFixed(2)} · ${d.hr_source}`;
  } else if (d.heart_snr_db !== null && d.heart_snr_db !== undefined) {
    heartSub = `SNR ${d.heart_snr_db.toFixed(1)} dB · ${d.hr_source}`;
  }
  setMetric("m-heart", d.heart_rate, 0, heartSub);
  $("m-heart").querySelector("[data-avg]").textContent = averageText(d.average_heart_rate);
  setMetric("m-breath", d.breathing_rate, 1,
    d.breathing_rate === null ? "Needs about 20 s"
      : `from ${d.breathing_channel}${d.breathing_channel === "head" ? " (show shoulders for better)" : ""}`);
  setMetric("m-blink", d.blink_rate, 0, d.blink_rate === null ? "Needs about 10 s" : "last 60 s");

  const signal = $("signal");
  signal.dataset.status = d.signal_status;
  signal.textContent = STATUS_TEXT[d.signal_status] || d.signal_status;

  let hint = STATUS_HINT[d.signal_status] || "";
  if (d.face_found && !d.shoulders_in_view) hint = (hint + " Sit back so your shoulders show.").trim();
  $("hint").textContent = hint;

  const fps = d.processed_fps;
  $("fps").textContent = d.camera_fps === null ? "" :
    `Camera ${fmt(d.camera_fps, 0)} fps · processed ${fmt(fps, 0)} fps` + (fps !== null && fps < 15 ? " (needs 15+)" : "");
}

// ----- composure -----

const ROWS = [
  { row: "r-blink", flag: "blink_low", now: "blink_rate", base: "blink_rate", digits: 0, unit: "/min",
    reason: (d) => `Blinking less: ${fmt(d.blink_rate, 0)}/min (baseline ${fmt(d.baseline.blink_rate, 0)})` },
  { row: "r-breath", flag: "breath_high", now: "breathing_rate", base: "breathing_rate", digits: 1, unit: "/min",
    reason: (d) => `Breathing faster: ${fmt(d.breathing_rate, 1)}/min (baseline ${fmt(d.baseline.breathing_rate, 1)})` },
  { row: "r-heart", flag: "hr_high", now: "heart_rate", base: "heart_rate", digits: 0, unit: " BPM",
    reason: (d) => `Heart rate higher: ${fmt(d.heart_rate, 0)} BPM (baseline ${fmt(d.baseline.heart_rate, 0)})` },
];

function reasons(d) {
  return ROWS.filter((r) => d.composure[r.flag] === true).map((r) => r.reason(d));
}

function renderComposure(d) {
  const c = d.composure, b = d.baseline;
  const pill = $("c-state");
  const state = c.state;
  pill.dataset.state = state === null ? "unknown" : state;
  pill.textContent = state === null ? "No data" : state[0].toUpperCase() + state.slice(1);

  const progress = $("c-progress");
  if (b.ready) {
    progress.hidden = true;
    let note = state === null
      ? "No current readings to compare."
      : state === "elevated" ? reasons(d).join(" · ") : "Within range of your baseline.";
    if (c.blink_baseline_too_low) {
      note += " Blink baseline is too low to judge a drop, so blinks aren't used this session.";
    }
    $("c-note").textContent = note;
  } else {
    progress.hidden = false;
    const secs = b.seconds_collected;
    const waiting = b.waiting_for || [];
    $("c-bar").style.width = `${Math.min(100, ((secs || 0) / BASELINE_SEC) * 100)}%`;
    if (secs === null) {
      $("c-note").textContent = "Waiting for a good signal to start the baseline.";
    } else if (secs >= BASELINE_SEC && waiting.includes("blink")) {
      $("c-note").textContent = "Waiting for a full minute of blink data before using blinks.";
    } else if (secs >= BASELINE_SEC && waiting.length) {
      $("c-note").textContent = `Waiting for a first reading of: ${waiting.join(", ")}.`;
    } else {
      $("c-note").textContent = `Learning your baseline: ${Math.floor(secs)} / ${BASELINE_SEC} s`;
    }
  }

  for (const r of ROWS) {
    const tr = $(r.row);
    const flag = c[r.flag];
    tr.querySelector("[data-now]").textContent = d[r.now] === null ? "--" : fmt(d[r.now], r.digits) + r.unit;
    tr.querySelector("[data-base]").textContent = b[r.base] === null ? "--" : fmt(b[r.base], r.digits) + r.unit;
    const notJudged = r.flag === "blink_low" && c.blink_baseline_too_low;
    tr.querySelector("[data-flag]").textContent =
      flag === true ? "Flagged" : flag === false ? "OK" : notJudged ? "Too low" : "–";
    tr.classList.toggle("flagged", flag === true);
  }
}

// ----- pop-up: once on a switch to "elevated", rearmed after 30 s of calm -----

let lastState = null;
let armed = true;
let calmSince = null;

function updateNotice(d) {
  const state = d.composure.state;
  const now = Date.now();
  if (state === "calm") {
    if (calmSince === null) calmSince = now;
    if (now - calmSince >= REARM_CALM_MS) armed = true;
  } else {
    calmSince = null;
  }
  if (state === "elevated" && lastState !== "elevated" && armed) {
    const list = $("notice-reasons");
    list.replaceChildren(...reasons(d).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
    $("notice").hidden = false;
    armed = false;
  }
  if (state !== null) lastState = state;   // a missing reading doesn't count as a switch
}

// ----- connection, errors, video -----

let wasDown = false;

function setConn(text, cls) {
  const conn = $("conn");
  conn.textContent = text;
  conn.className = "conn" + (cls ? " " + cls : "");
}

function showBanner(text) {
  const banner = $("banner");
  banner.textContent = text || "";
  banner.hidden = !text;
}

function restartVideo() {
  $("video").src = "/video?t=" + Date.now();   // reconnect the MJPEG stream
}

async function poll() {
  let d;
  try {
    const r = await fetch("/api/readings", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    setConn("Server not reachable", "down");
    wasDown = true;
    return;
  }
  if (wasDown) { wasDown = false; restartVideo(); }

  if (d.error) showBanner(`Processing stopped: ${d.error}`);
  else if (!d.running) showBanner("Starting camera…");
  else showBanner("");

  const age = d.updated_at === null ? null : d.server_time - d.updated_at;
  if (age === null) setConn("Waiting for first frame", "stale");
  else if (age > STALE_SEC) setConn(`No new readings for ${Math.floor(age)} s`, "stale");
  else setConn("Live", "");

  renderMetrics(d);
  renderComposure(d);
  updateNotice(d);
}

document.addEventListener("DOMContentLoaded", () => {
  $("notice-close").addEventListener("click", () => { $("notice").hidden = true; });
  $("video").addEventListener("error", () => setTimeout(restartVideo, 2000));
  poll();
  setInterval(poll, POLL_MS);
});
