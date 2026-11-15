(() => {
  const $ = (id) => document.getElementById(id);
  const RING_LEN = 326.7;
  let source = null;

  // ---------- views ----------
  function show(view) {
    $("home").classList.toggle("active", view === "home");
    $("dash").classList.toggle("active", view === "dash");
    window.scrollTo(0, 0);
  }

  async function post(path) {
    const res = await fetch(path, { method: "POST" });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
  }

  // ---------- start / stop ----------
  async function start() {
    const btn = $("btn-start");
    btn.disabled = true;
    $("home-error").hidden = true;
    try {
      await post("/api/start");
    } catch (e) {
      btn.disabled = false;
      return showHomeError("Could not reach the Cuore server. Is `python server.py` running?");
    }
    resetUi();
    show("dash");
    $("video").hidden = false;
    $("video").src = "/video?t=" + Date.now();
    source = new EventSource("/api/stream");
    source.onmessage = (ev) => render(JSON.parse(ev.data));
    btn.disabled = false;
  }

  async function stop() {
    closeStream();
    try { await post("/api/stop"); } catch (_) { /* server already gone */ }
    show("home");
  }

  function closeStream() {
    if (source) { source.close(); source = null; }
    $("video").removeAttribute("src");
    $("video").hidden = true;
  }

  function showHomeError(msg) {
    const el = $("home-error");
    el.textContent = msg;
    el.hidden = false;
    show("home");
  }

  // ---------- rendering ----------
  function resetUi() {
    render({
      phase: "starting", face: false, bpm: null, quality: null, signal: "none", breathing: null,
      blinks: null, calibration: { done_sec: 0, total_sec: 10 },
      measure: { done_sec: 0, total_sec: 60, paused: false },
      average: null, running_average: null, pulse: [], breath: [], fps: 0,
    });
  }

  const SIGNAL = {
    good: ["Signal good", "good"],
    weak: ["Weak signal", "warn"],
    measuring: ["Finding pulse", ""],
    no_face: ["No face", "bad"],
    none: ["Waiting", ""],
  };

  function setSteps(phase) {
    const order = ["calibrating", "measuring", "done"];
    const ids = ["step-cal", "step-meas", "step-done"];
    const idx = order.indexOf(phase);
    ids.forEach((id, i) => {
      const el = $(id);
      el.classList.toggle("active", i === idx && phase !== "done");
      el.classList.toggle("complete", idx > i || phase === "done");
    });
  }

  function setRing(fraction, main, sub, mode) {
    $("ring-fg").style.strokeDashoffset = String(RING_LEN * (1 - Math.max(0, Math.min(1, fraction))));
    $("ring-main").textContent = main;
    $("ring-sub").textContent = sub;
    $("ring").className = "ring" + (mode ? " " + mode : "");
  }

  function render(s) {
    const [sigText, sigClass] = SIGNAL[s.signal] || SIGNAL.none;
    const chip = $("signal-chip");
    chip.textContent = sigText;
    chip.className = "chip " + sigClass;

    if (s.phase === "error") {
      closeStream();
      post("/api/stop").catch(() => {});
      return showHomeError(s.error || "Something went wrong with the camera.");
    }

    // live BPM
    $("bpm").textContent = s.bpm != null ? s.bpm : "--";
    const beat = $("heartbeat");
    beat.classList.toggle("on", s.bpm != null);
    if (s.bpm) beat.style.setProperty("--beat", (60 / s.bpm).toFixed(2) + "s");

    // secondary signals
    $("breath").textContent = s.breathing != null ? s.breathing : "--";
    $("blinks").textContent = s.blinks != null ? s.blinks : "--";
    $("fps").textContent = s.fps ? `${s.fps} fps` : "-- fps";

    // phase card
    setSteps(s.phase);
    const cal = s.calibration, meas = s.measure;
    let greeting, msg;
    if (s.phase === "starting") {
      greeting = "Starting the camera…";
      msg = "Loading the face model. This can take a few seconds the first time.";
      setRing(0, "--", "starting", "");
    } else if (s.phase === "calibrating") {
      const left = Math.max(0, Math.ceil(cal.total_sec - cal.done_sec));
      greeting = "Calibrating. Please hold still.";
      msg = s.face
        ? (s.bpm == null ? "Finding your pulse. The countdown starts as soon as a reading appears."
                         : "Look at the camera and stay relaxed. Measuring starts automatically.")
        : "No face detected. Move into the camera view.";
      setRing(cal.done_sec / cal.total_sec, s.bpm == null ? "--" : left, s.bpm == null ? "waiting" : "seconds left", "");
    } else if (s.phase === "measuring") {
      const left = Math.max(0, Math.ceil(meas.total_sec - meas.done_sec));
      greeting = "Measuring your heart rate";
      msg = meas.paused
        ? "Paused: no reading right now. Face the camera and hold still."
        : "Recording one reading per second. Keep still until the timer ends.";
      setRing(meas.done_sec / meas.total_sec, left, "seconds left", "measuring");
    } else {
      greeting = "Your result is ready";
      msg = `Your average heart rate over ${Math.round(meas.total_sec)} seconds was ${s.average} BPM. Press Restart to measure again.`;
      setRing(1, s.average, "avg BPM", "done");
    }
    $("greeting").textContent = greeting;
    $("phase-msg").textContent = msg;

    // average card
    const done = s.phase === "done";
    $("card-avg").classList.toggle("done", done);
    const avgChip = $("avg-chip");
    const shownAvg = done ? s.average : s.running_average;
    $("avg").textContent = shownAvg != null ? shownAvg : "--";
    $("avg-bar").style.width = (done ? 100 : (meas.done_sec / meas.total_sec) * 100) + "%";
    $("avg-progress").textContent = `${Math.round(meas.done_sec)} s`;
    $("avg-total").textContent = `of ${Math.round(meas.total_sec)} s`;
    if (done) { avgChip.textContent = "Final"; avgChip.className = "chip purple"; }
    else if (s.phase === "measuring") { avgChip.textContent = "Recording"; avgChip.className = "chip"; }
    else { avgChip.textContent = "Pending"; avgChip.className = "chip"; }
    $("avg-note").textContent = done ? "Final average of the recording."
      : s.phase === "measuring" ? "Running average so far." : "Recording starts after calibration.";

    // video overlay
    const badge = $("video-badge");
    badge.hidden = s.face || s.phase === "starting";
    badge.textContent = "No face detected";
    badge.className = "video-badge bad";

    drawWave($("pulse-canvas"), s.pulse, "#2f63e6", "rgba(79,124,240,.18)");
    drawWave($("breath-canvas"), s.breath, "#8b6fe0", "rgba(139,111,224,.18)");
  }

  // ---------- waveform drawing ----------
  function drawWave(canvas, data, color, fill) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = parseInt(canvas.getAttribute("height"), 10);
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.height = cssH + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.strokeStyle = "#e4e9f5";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cssH / 2); ctx.lineTo(cssW, cssH / 2);
    ctx.stroke();

    if (!data || data.length < 2) return;
    const pad = 8, mid = cssH / 2, amp = mid - pad;
    const x = (i) => (i / (data.length - 1)) * cssW;
    const y = (v) => mid - v * amp;
    ctx.beginPath();
    ctx.moveTo(x(0), y(data[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineTo(cssW, mid); ctx.lineTo(0, mid); ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // ---------- wiring ----------
  $("btn-start").addEventListener("click", start);
  $("btn-stop").addEventListener("click", stop);
  $("btn-reset").addEventListener("click", () => post("/api/reset").catch(() => {}));

  // If the page is reloaded while a session is running, reattach to it.
  fetch("/api/state").then((r) => r.json()).then((s) => {
    if (s.phase && s.phase !== "idle" && s.phase !== "error") {
      show("dash");
      $("video").hidden = false;
      $("video").src = "/video?t=" + Date.now();
      source = new EventSource("/api/stream");
      source.onmessage = (ev) => render(JSON.parse(ev.data));
    }
  }).catch(() => {});
})();
