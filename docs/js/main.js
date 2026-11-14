// Camera, face tracking, main loop and dashboard updates.
import { HR_FS, RESP_FS } from "./dsp.js";
import {
  ChestMotion, FOREHEAD, LEFT_CHEEK, LEFT_EYE, RIGHT_CHEEK, RIGHT_EYE,
  eyeAspectRatio, meanY, regionMeanRgb, regionPolygon, toPixels,
} from "./face.js";
import { SignalGraph } from "./graph.js";
import {
  AverageBpmMonitor, BlinkCounter, HeartRateEstimator, RespirationEstimator,
} from "./vitals.js";

// MediaPipe is loaded from a CDN, pinned to one version so an update can't break the app.
const MEDIAPIPE_VERSION = "1.2.3";
const MEDIAPIPE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_PATH = "models/face_landmarker.task";

const PROCESS_MAX_SIDE = 640;     // frames are shrunk to this size before processing
const UPDATE_EVERY_SEC = 0.5;     // how often to recompute the vitals
const FACE_LOST_RESET_SEC = 1.0;  // a longer gap would corrupt the signals, so start fresh
const DEFAULT_AVG_SECONDS = 120;

const $ = (id) => document.getElementById(id);
const ui = {
  start: $("start"), startButton: $("start-button"), startError: $("start-error"),
  app: $("app"), stage: $("stage"), video: $("video"), overlay: $("overlay"),
  status: $("status"), switchCamera: $("switch-camera"),
  liveBpm: $("live-bpm"), avgBpm: $("avg-bpm"), avgTag: $("avg-tag"), avgLength: $("avg-length"),
  avgProgress: $("avg-progress"), avgFooter: $("avg-footer"), avgRestart: $("avg-restart"),
  pulseValue: $("pulse-value"), breathValue: $("breath-value"),
  breathing: $("breathing"), blinks: $("blinks"), fps: $("fps"), tip: $("tip"),
};

const state = {
  landmarker: null,
  delegate: null,
  detectTimes: [],
  switchingDelegate: false,
  stream: null,
  cameras: [],
  cameraIndex: 0,
  heart: new HeartRateEstimator(),
  breathing: new RespirationEstimator(["chest", "head"]),
  blinks: new BlinkCounter(),
  chest: new ChestMotion(),
  average: new AverageBpmMonitor(avgSecondsFromUrl()),
  t0: null,
  lastTimestampMs: -1,
  lastUpdate: -1e9,
  lastFaceTime: -1e9,
  frameTimes: [],
  bpm: null, respRate: null, blinkRate: null,
  processCanvas: document.createElement("canvas"),
  wakeLock: null,
};
const processCtx = state.processCanvas.getContext("2d", { willReadFrequently: true });
const overlayCtx = ui.overlay.getContext("2d");
const pulseGraph = new SignalGraph($("pulse-graph"), 5, "#ff5a6e");
const breathGraph = new SignalGraph($("breath-graph"), 30, "#60a5fa");

// ?avg=90 in the address sets the average length (seconds).
function avgSecondsFromUrl() {
  const value = Number(new URLSearchParams(location.search).get("avg"));
  return Number.isFinite(value) && value >= 10 ? value : DEFAULT_AVG_SECONDS;
}

function showStartError(message) {
  ui.startError.textContent = message;
  ui.startError.hidden = false;
}

// ---------- setup ----------

let createLandmarker = null;     // (delegate) => Promise<FaceLandmarker>

async function loadFaceTracker() {
  const { FaceLandmarker, FilesetResolver } = await import(`${MEDIAPIPE_URL}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);
  createLandmarker = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
  });
  try {
    state.delegate = "GPU";
    return await createLandmarker("GPU");
  } catch (error) {
    console.warn("GPU face tracking unavailable, using CPU", error);
    state.delegate = "CPU";
    return createLandmarker("CPU");
  }
}

// Some phones (and browsers without hardware WebGL) run the GPU version slower than
// the CPU one. Time the first frames and switch to CPU if the GPU is slow.
const GPU_CHECK_FRAMES = 30;
const GPU_SLOW_MS = 40;
function checkTrackerSpeed(detectMs) {
  if (state.delegate !== "GPU" || state.switchingDelegate) return;
  state.detectTimes.push(detectMs);
  if (state.detectTimes.length < GPU_CHECK_FRAMES) return;
  const typical = state.detectTimes.slice(5).sort((a, b) => a - b)[Math.floor((GPU_CHECK_FRAMES - 5) / 2)];
  state.delegate = "GPU (checked)";
  if (typical <= GPU_SLOW_MS) return;
  state.switchingDelegate = true;
  createLandmarker("CPU").then((cpu) => {
    const old = state.landmarker;
    state.landmarker = cpu;
    state.delegate = "CPU";
    old.close();
    console.info(`GPU face tracking took ${typical.toFixed(0)} ms per frame; switched to CPU`);
  }).catch((error) => console.warn("CPU face tracking unavailable", error))
    .finally(() => { state.switchingDelegate = false; });
}

async function openCamera(deviceId) {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());   // phones allow one camera at a time
  const video = {
    width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
  };
  state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  ui.video.srcObject = state.stream;
  await ui.video.play();
  const settings = state.stream.getVideoTracks()[0].getSettings();
  ui.stage.classList.toggle("mirror", settings.facingMode !== "environment");   // mirror selfie view
  const { videoWidth: w, videoHeight: h } = ui.video;
  const scale = Math.min(1, PROCESS_MAX_SIDE / Math.max(w, h));
  state.processCanvas.width = Math.round(w * scale);
  state.processCanvas.height = Math.round(h * scale);
  ui.stage.style.setProperty("--video-aspect", `${w} / ${h}`);
  resetSignals();
  return settings.deviceId;
}

async function listCameras(currentId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  state.cameras = devices.filter((d) => d.kind === "videoinput");
  state.cameraIndex = Math.max(0, state.cameras.findIndex((d) => d.deviceId === currentId));
  ui.switchCamera.hidden = state.cameras.length < 2;
}

async function switchCamera() {
  if (state.cameras.length < 2) return;
  state.cameraIndex = (state.cameraIndex + 1) % state.cameras.length;
  try {
    await openCamera(state.cameras[state.cameraIndex].deviceId);
  } catch (error) {
    console.error(error);
    await openCamera();                       // fall back to the default camera
  }
}

function resetSignals() {
  state.heart.reset();
  state.breathing.reset();
  state.chest.reset();
}

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      state.wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch { /* not supported or refused: the screen may dim, which is fine */ }
}

// ---------- main loop ----------

function scheduleFrame() {
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    ui.video.requestVideoFrameCallback((now, meta) => onFrame(meta.captureTime || now));
  } else {
    requestAnimationFrame(onFrame);
  }
}

let lastVideoTime = -1;
function onFrame(timeMs) {
  try {
    if (ui.video.readyState >= 2 && ui.video.currentTime !== lastVideoTime) {
      lastVideoTime = ui.video.currentTime;
      processFrame(timeMs);
    }
  } catch (error) {
    console.error(error);
  }
  scheduleFrame();
}

function processFrame(timeMs) {
  const { width: w, height: h } = state.processCanvas;
  if (!w || !h) return;
  if (state.t0 === null) state.t0 = timeMs;
  const now = (timeMs - state.t0) / 1000;
  state.frameTimes.push(now);
  if (state.frameTimes.length > 60) state.frameTimes.shift();

  processCtx.drawImage(ui.video, 0, 0, w, h);
  const pixels = processCtx.getImageData(0, 0, w, h).data;
  // MediaPipe needs strictly increasing timestamps in milliseconds.
  const timestampMs = Math.max(Math.round(timeMs), state.lastTimestampMs + 1);
  state.lastTimestampMs = timestampMs;
  const detectStart = performance.now();
  const result = state.landmarker.detectForVideo(state.processCanvas, timestampMs);
  checkTrackerSpeed(performance.now() - detectStart);

  const faceFound = result.faceLandmarks.length > 0;
  let polygons = [];
  if (faceFound) {
    if (now - state.lastFaceTime > FACE_LOST_RESET_SEC) resetSignals();
    state.lastFaceTime = now;
    const points = toPixels(result.faceLandmarks[0], w, h);
    polygons = [regionPolygon(points, FOREHEAD, 0.8), regionPolygon(points, LEFT_CHEEK),
                regionPolygon(points, RIGHT_CHEEK)];
    const colors = polygons.map((polygon) => regionMeanRgb(pixels, w, h, polygon));
    if (colors.every((c) => c !== null)) state.heart.add(now, colors.flat());
    const chestY = state.chest.update(pixels, w, h, points);
    state.breathing.add(now, [chestY, meanY(points)]);
    const ear = (eyeAspectRatio(points, LEFT_EYE) + eyeAspectRatio(points, RIGHT_EYE)) / 2;
    state.blinks.update(now, ear);
  }

  if (now - state.lastUpdate >= UPDATE_EVERY_SEC) {
    state.lastUpdate = now;
    state.bpm = state.heart.update();
    state.respRate = state.breathing.update();
    state.blinkRate = state.blinks.ratePerMin(now);
  }
  const liveBpm = faceFound ? state.bpm : null;
  state.average.update(now, liveBpm);              // pauses while there is no reading

  drawOverlay(faceFound ? polygons : [], faceFound ? state.chest.box : null);
  updateDashboard(now, faceFound, liveBpm);
}

// ---------- drawing ----------

// Face regions on top of the video. The video uses object-fit: cover, so map the same way.
function drawOverlay(polygons, chestBox) {
  const dpr = window.devicePixelRatio || 1;
  const W = ui.overlay.clientWidth, H = ui.overlay.clientHeight;
  if (ui.overlay.width !== Math.round(W * dpr) || ui.overlay.height !== Math.round(H * dpr)) {
    ui.overlay.width = Math.round(W * dpr);
    ui.overlay.height = Math.round(H * dpr);
  }
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, W, H);
  const { width: pw, height: ph } = state.processCanvas;
  const s = Math.max(W / pw, H / ph);
  const ox = (W - pw * s) / 2, oy = (H - ph * s) / 2;
  const map = ([x, y]) => [ox + x * s, oy + y * s];

  overlayCtx.lineWidth = 1.5;
  overlayCtx.lineJoin = "round";
  overlayCtx.strokeStyle = "rgba(52, 211, 153, 0.85)";
  overlayCtx.fillStyle = "rgba(52, 211, 153, 0.10)";
  for (const polygon of polygons) {
    overlayCtx.beginPath();
    polygon.map(map).forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
    overlayCtx.closePath();
    overlayCtx.fill();
    overlayCtx.stroke();
  }
  if (chestBox) {
    const [x0, y0] = map([chestBox[0], chestBox[1]]);
    const [x1, y1] = map([chestBox[2], chestBox[3]]);
    overlayCtx.strokeStyle = "rgba(96, 165, 250, 0.8)";
    overlayCtx.setLineDash([6, 5]);
    overlayCtx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    overlayCtx.setLineDash([]);
  }
}

const formatDuration = (seconds) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function setStatus(text, kind) {
  ui.status.className = `pill ${kind}`;
  setText(ui.status.lastElementChild, text);
}

function updateDashboard(now, faceFound, liveBpm) {
  const { heart, average } = state;
  if (!faceFound) setStatus("No face detected", "bad");
  else if (heart.snrDb === null) setStatus("Measuring… hold still", "idle");
  else if (!heart.signalOk) setStatus("Hold still, good light", "warn");
  else setStatus("Signal good", "good");

  const bpmText = liveBpm !== null ? liveBpm.toFixed(0) : "--";
  setText(ui.liveBpm, bpmText);
  ui.liveBpm.classList.toggle("empty", liveBpm === null);
  setText(ui.pulseValue, liveBpm !== null ? `${bpmText} BPM` : "");

  // Average card
  let tag, tagClass, value, valueClass, footer;
  if (average.done) {
    [tag, tagClass] = ["FINAL", "final"];
    [value, valueClass] = [average.result.toFixed(0), "final"];
    footer = `${average.readings.length} readings`;
  } else {
    [tag, tagClass] = average.paused ? ["PAUSED", ""] : ["REC", "rec"];
    const running = average.runningAverage;
    [value, valueClass] = running !== null ? [running.toFixed(0), "running"] : ["--", "empty"];
    footer = average.readings.length
      ? `${formatDuration(average.recordedSec)} / ${formatDuration(average.duration)}`
      : "waiting for heart rate…";
  }
  ui.avgTag.className = `tag ${tagClass}`;
  setText(ui.avgTag.lastElementChild, tag);
  setText(ui.avgBpm, value);
  ui.avgBpm.className = `value ${valueClass}`;
  setText(ui.avgFooter, footer);
  setText(ui.avgLength, `(${formatDuration(average.duration)})`);
  ui.avgProgress.style.width = `${(average.progress * 100).toFixed(1)}%`;

  // Details
  const { breathing } = state;
  setText(ui.breathing, state.respRate !== null
    ? `${state.respRate.toFixed(1)} /min (${breathing.channelName})` : "--");
  setText(ui.breathValue, state.respRate !== null ? `${state.respRate.toFixed(1)} /min` : "");
  setText(ui.blinks, state.blinkRate !== null ? `${state.blinkRate.toFixed(0)} /min` : "--");
  const times = state.frameTimes;
  const fps = times.length > 1 ? (times.length - 1) / (times[times.length - 1] - times[0] + 1e-9) : 0;
  setText(ui.fps, `Processing ${fps.toFixed(0)} fps${fps < 15 ? " (need 15+)" : ""}`);
  ui.tip.hidden = !(faceFound && state.chest.box === null);

  pulseGraph.draw(heart.waveform, HR_FS);
  breathGraph.draw(breathing.waveform, RESP_FS);
}

// ---------- average controls ----------

function setAverageLength(seconds) {
  state.average = new AverageBpmMonitor(seconds);
  document.querySelectorAll(".segmented button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.seconds) === seconds));
}

document.querySelectorAll(".segmented button").forEach((button) =>
  button.addEventListener("click", () => setAverageLength(Number(button.dataset.seconds))));
ui.avgRestart.addEventListener("click", () => state.average.reset());
document.addEventListener("keydown", (event) => {
  if (event.key === "r" || event.key === "R") state.average.reset();
});
ui.switchCamera.addEventListener("click", switchCamera);
document.addEventListener("visibilitychange", keepScreenOn);
setAverageLength(state.average.duration);

// ---------- start ----------

async function start() {
  ui.startButton.disabled = true;
  ui.startButton.textContent = "Opening camera…";
  ui.startError.hidden = true;
  try {
    const deviceId = await openCamera();
    await listCameras(deviceId);
  } catch (error) {
    console.error(error);
    ui.startButton.disabled = false;
    ui.startButton.textContent = "Try again";
    if (error.name === "NotAllowedError") {
      showStartError("Camera access was blocked. Allow the camera for this site in your browser settings, then try again.");
    } else if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      showStartError("No camera was found.");
    } else if (error.name === "NotReadableError") {
      showStartError("The camera is being used by another app. Close it and try again.");
    } else {
      showStartError(`Could not open the camera: ${error.message}`);
    }
    return;
  }
  ui.start.hidden = true;
  ui.app.hidden = false;
  keepScreenOn();
  scheduleFrame();
}

async function init() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    ui.startButton.textContent = "Camera unavailable";
    showStartError("The camera only works on a secure page. Open this app with an https:// address (or on localhost).");
    return;
  }
  try {
    state.landmarker = await loadFaceTracker();
  } catch (error) {
    console.error(error);
    ui.startButton.textContent = "Couldn't load";
    showStartError("Couldn't load the face tracker. Check your internet connection and reload the page.");
    return;
  }
  ui.startButton.disabled = false;
  ui.startButton.textContent = "Start measuring";
  ui.startButton.addEventListener("click", start);
}

init();
