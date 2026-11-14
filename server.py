"""Serve the live vital-sign readings to a browser on this machine.

Runs the same capture-and-process loop as app.py's main() on a background
thread (webcam only, exposure lock on, no --record / --screen), and serves:

    GET /              throwaway test page (video + raw readings)
    GET /api/readings  latest readings as JSON
    GET /video         MJPEG stream of the annotated frames (same image as app.py's window)

Usage:
    python server.py                 # default webcam on http://127.0.0.1:5001/
    python server.py --camera 1 --port 5002

Bound to 127.0.0.1 only. Press Ctrl+C to stop.

app.py and vitals.py are imported, not changed. No reading is recomputed here:
values are copied out of the estimators exactly as app.py displays them.
"""
import argparse
import math
import os
import threading
import time
from collections import deque

import cv2
import mediapipe as mp
import numpy as np
from flask import Flask, Response, abort, jsonify, request

import app as vs
from vitals import HR_FS, RESP_FS, BlinkCounter, HeartRateEstimator, RespirationEstimator

HOST = "127.0.0.1"
JPEG_QUALITY = 80


# --------------------------------------------------------------------------
# Composure: a comparison with the person's own baseline, nothing more.
# --------------------------------------------------------------------------

BASELINE_SEC = 60.0
BLINK_LOW_RATIO = 0.6
BREATH_HIGH_RATIO = 1.25
HR_HIGH_RATIO = 1.15


class Baseline:
    """Running mean of blink, breathing and heart rate over the first 60 s of good signal.

    Samples are taken once per vitals update (every 0.5 s), only while the
    signal status is "good", and only for values that exist (not None). The
    60 s clock starts at the first good update. If a metric still has no
    sample after 60 s, collection continues until all three have at least
    one, so the baseline never contains a guess.
    """

    def __init__(self):
        self.start = None
        self.sums = {"blink": 0.0, "breath": 0.0, "heart": 0.0}
        self.counts = {"blink": 0, "breath": 0, "heart": 0}
        self.ready = False

    def add(self, now, status, blink, breath, heart):
        if self.ready or status != "good":
            return
        if self.start is None:
            self.start = now
        for key, value in (("blink", blink), ("breath", breath), ("heart", heart)):
            if value is not None:
                self.sums[key] += value
                self.counts[key] += 1
        if now - self.start >= BASELINE_SEC and all(self.counts.values()):
            self.ready = True

    def mean(self, key):
        return self.sums[key] / self.counts[key] if self.counts[key] else None

    def seconds_collected(self, now):
        return None if self.start is None else min(BASELINE_SEC, now - self.start)


def evaluate_composure(baseline_ready, base_blink, base_breath, base_heart,
                       blink, breath, heart):
    """Compare current readings to the baseline. All the rules live here.

    Each flag is True/False when the current reading exists, or None when it
    is missing (we can't say either way). Rule:
      - "elevated" if blink_low is True on its own (blink is the most reliable
        signal, so it counts double), or if at least two of the three are True
      - "calm" otherwise
      - "calibrating" before the baseline is ready
      - None if there are no current readings at all to compare
    """
    if not baseline_ready:
        return {"state": "calibrating", "blink_low": None, "breath_high": None, "hr_high": None}

    def compare(current, check):
        return None if current is None else bool(check(current))

    blink_low = compare(blink, lambda v: v < BLINK_LOW_RATIO * base_blink)
    breath_high = compare(breath, lambda v: v > BREATH_HIGH_RATIO * base_breath)
    hr_high = compare(heart, lambda v: v > HR_HIGH_RATIO * base_heart)

    flags = (blink_low, breath_high, hr_high)
    if all(f is None for f in flags):
        state = None
    elif blink_low is True or sum(f is True for f in flags) >= 2:
        state = "elevated"
    else:
        state = "calm"
    return {"state": state, "blink_low": blink_low, "breath_high": breath_high, "hr_high": hr_high}


# --------------------------------------------------------------------------
# Shared state between the processing thread and the web handlers
# --------------------------------------------------------------------------

def _num(value):
    """Float for JSON, or None. NaN/inf become None (they are not valid JSON)."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


class SharedState:
    def __init__(self):
        self.lock = threading.Lock()
        self.frame_ready = threading.Condition(self.lock)
        self.readings = {
            "running": False,
            "error": None,
            "heart_rate": None,
            "heart_snr_db": None,
            "breathing_rate": None,
            "breathing_channel": None,
            "blink_rate": None,
            "signal_status": "no_face",
            "camera_fps": None,
            "processed_fps": None,
            "face_found": False,
            "shoulders_in_view": False,
            "composure": evaluate_composure(False, None, None, None, None, None, None),
            "baseline": {"ready": False, "seconds_collected": None,
                         "blink_rate": None, "breathing_rate": None, "heart_rate": None},
            "updated_at": None,
        }
        self.jpeg = None
        self.jpeg_id = 0

    def set_readings(self, **values):
        with self.lock:
            self.readings.update(values)

    def get_readings(self):
        with self.lock:
            data = dict(self.readings)
        data["server_time"] = time.monotonic()   # compare with updated_at to see staleness
        return data

    def set_jpeg(self, jpeg):
        with self.frame_ready:
            self.jpeg = jpeg
            self.jpeg_id += 1
            self.frame_ready.notify_all()

    def wait_jpeg(self, last_id, timeout=2.0):
        with self.frame_ready:
            self.frame_ready.wait_for(lambda: self.jpeg_id != last_id, timeout=timeout)
            return self.jpeg, self.jpeg_id


# --------------------------------------------------------------------------
# Processing loop: copied from app.main(), webcam only, no window
# --------------------------------------------------------------------------

def signal_status(face_found, heart):
    """app.py's status decision, as a short code."""
    if not face_found:
        return "no_face", ("No face detected", vs.RED)
    if heart.snr_db is None:
        return "measuring", ("Measuring... hold still", vs.GRAY)
    if not heart.signal_ok:
        return "weak", ("Hold still, good light", vs.YELLOW)
    return "good", ("Signal good", vs.GREEN)


def processing_loop(args, shared, stop):
    if not os.path.exists(vs.MODEL_PATH):
        # create_landmarker() would download it; this server must not download at runtime.
        shared.set_readings(error=f"Missing {os.path.basename(vs.MODEL_PATH)}; place the model "
                                  "file next to app.py.")
        return

    source = landmarker = None
    try:
        source = vs.CameraSource(args.camera, vs.CAMERA_WARMUP_SEC)   # exposure lock on
        landmarker = vs.create_landmarker()
        heart = HeartRateEstimator()
        breathing = RespirationEstimator(channel_names=("chest", "head"))
        blinks = BlinkCounter()
        chest = vs.ChestMotion()
        smooth_points = None
        baseline = Baseline()

        t0 = None
        last_timestamp_ms = -1
        last_update = 0.0
        last_face_time = -1e9
        processed_times = deque(maxlen=60)
        bpm = resp_rate = blink_rate = None
        shared.set_readings(running=True)

        while not stop.is_set():
            frame, arrived = source.read()
            if frame is None:
                shared.set_readings(error="No frames from the camera. Is another app using it?")
                break
            if t0 is None:
                t0 = arrived
            now = arrived - t0
            processed_times.append(now)

            # MediaPipe needs strictly increasing timestamps in milliseconds.
            timestamp_ms = max(int(now * 1000), last_timestamp_ms + 1)
            last_timestamp_ms = timestamp_ms
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms)

            face_found = bool(result.face_landmarks)
            if face_found:
                if now - last_face_time > vs.FACE_LOST_RESET_SEC:
                    heart.reset()
                    breathing.reset()
                    chest.reset()
                    smooth_points = None
                last_face_time = now

                h, w = frame.shape[:2]
                points = vs.to_pixels(result.face_landmarks[0], w, h)
                # ROI smoothing, as in app.py: regions use smoothed points, blinks use raw ones.
                if smooth_points is None:
                    smooth_points = points.copy()
                else:
                    smooth_points = (vs.ROI_SMOOTHING * smooth_points
                                     + (1 - vs.ROI_SMOOTHING) * points)
                polygons = [vs.region_polygon(smooth_points, vs.FOREHEAD, shrink=0.8),
                            vs.region_polygon(smooth_points, vs.LEFT_CHEEK),
                            vs.region_polygon(smooth_points, vs.RIGHT_CHEEK)]
                # Sample colors before drawing anything on the frame.
                colors = [vs.region_mean_rgb(frame, polygon) for polygon in polygons]
                if all(c is not None for c in colors):
                    heart.add(now, np.concatenate(colors))

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                chest_y = chest.update(gray, points)
                head_y = float(points[:, 1].mean())
                breathing.add(now, [chest_y, head_y])

                ear = (vs.eye_aspect_ratio(points, vs.LEFT_EYE)
                       + vs.eye_aspect_ratio(points, vs.RIGHT_EYE)) / 2
                blinks.update(now, ear)

                cv2.polylines(frame, polygons, True, vs.GREEN, 1)
                if chest.box is not None:
                    x0, y0, x1, y1 = chest.box
                    cv2.rectangle(frame, (x0, y0), (x1, y1), vs.BLUE, 1)

            ticked = False
            if now - last_update >= vs.UPDATE_EVERY_SEC:
                last_update = now
                ticked = True
                bpm = heart.update()
                resp_rate = breathing.update()
                blink_rate = blinks.rate_per_min(now)

            status_code, status = signal_status(face_found, heart)

            # HUD and waveforms, identical to app.py.
            hr_text = f"{bpm:.0f} BPM" if bpm is not None else "--"
            resp_text = (f"{resp_rate:.1f} /min ({breathing.channel_name})"
                         if resp_rate is not None else "--")
            blink_text = f"{blink_rate:.0f} /min" if blink_rate is not None else "--"
            fps = vs.rate_from_times(processed_times)
            camera_fps = source.fps
            fps_text = f"Camera {camera_fps:.0f} fps, processed {fps:.0f} fps"
            lines = [
                (f"Heart rate: {hr_text}", vs.WHITE),
                (f"Breathing:  {resp_text}", vs.WHITE),
                (f"Blinks:     {blink_text}", vs.WHITE),
                status,
                (fps_text + ("  (need 15+)" if fps < 15 else ""), vs.GRAY),
            ]
            if face_found and chest.box is None:
                lines.append(("Tip: sit back so your shoulders show", vs.GRAY))
            vs.draw_hud(frame, lines)

            h, w = frame.shape[:2]
            vs.draw_waveform(frame, heart.waveform, HR_FS, 5, (10, h - 170, w - 20, 70),
                             vs.RED, "pulse")
            vs.draw_waveform(frame, breathing.waveform, RESP_FS, 30, (10, h - 90, w - 20, 80),
                             vs.BLUE, "breathing")

            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                shared.set_jpeg(jpeg.tobytes())

            if ticked:
                baseline.add(now, status_code, blink_rate, resp_rate, bpm)
            composure = evaluate_composure(
                baseline.ready, baseline.mean("blink"), baseline.mean("breath"),
                baseline.mean("heart"), blink_rate, resp_rate, bpm)

            shared.set_readings(
                heart_rate=_num(bpm),
                heart_snr_db=_num(heart.snr_db),
                breathing_rate=_num(resp_rate),
                breathing_channel=breathing.channel_name if resp_rate is not None else None,
                blink_rate=_num(blink_rate),
                signal_status=status_code,
                camera_fps=_num(camera_fps),
                processed_fps=_num(fps),
                face_found=face_found,
                shoulders_in_view=chest.box is not None,
                composure=composure,
                baseline={"ready": baseline.ready,
                          "seconds_collected": _num(baseline.seconds_collected(now)),
                          "blink_rate": _num(baseline.mean("blink")),
                          "breathing_rate": _num(baseline.mean("breath")),
                          "heart_rate": _num(baseline.mean("heart"))},
                updated_at=time.monotonic(),
            )
    except BaseException as exc:   # includes SystemExit from CameraSource
        shared.set_readings(error=f"{type(exc).__name__}: {exc}")
        print(f"Processing stopped: {type(exc).__name__}: {exc}")
    finally:
        shared.set_readings(running=False)
        if source is not None:
            source.release()
        if landmarker is not None:
            landmarker.close()


# --------------------------------------------------------------------------
# Web server
# --------------------------------------------------------------------------

TEST_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Vitals test page</title>
<style>
  #notice { display: none; position: fixed; top: 16px; right: 16px; max-width: 320px;
            background: #fff; border: 2px solid #444; padding: 12px; }
</style>
</head>
<body>
<p>Throwaway test page. Video: /video &middot; Readings: /api/readings (polled every second)</p>
<p id="composure">Composure: waiting...</p>
<img src="/video" alt="annotated camera stream" style="max-width:100%">
<pre id="readings">waiting...</pre>

<div id="notice" role="alertdialog" aria-labelledby="notice-title">
  <strong id="notice-title">Change from your baseline</strong>
  <ul id="notice-reasons"></ul>
  <button id="notice-close" type="button">Dismiss</button>
</div>

<script>
  // Pop-up rule: show once when composure switches to "elevated". It can show again
  // only after the state has stayed "calm" for REARM_CALM_MS without a break.
  const REARM_CALM_MS = 30000;

  const out = document.getElementById("readings");
  const composureLine = document.getElementById("composure");
  const notice = document.getElementById("notice");
  const reasonsList = document.getElementById("notice-reasons");
  document.getElementById("notice-close").addEventListener("click", () => {
    notice.style.display = "none";
  });

  let lastState = null;
  let armed = true;
  let calmSince = null;

  function fmt(value, digits) {
    return value === null || value === undefined ? "--" : value.toFixed(digits);
  }

  function reasons(d) {
    const c = d.composure, b = d.baseline, items = [];
    if (c.blink_low) items.push(`Blinking less: ${fmt(d.blink_rate, 0)}/min (baseline ${fmt(b.blink_rate, 0)})`);
    if (c.breath_high) items.push(`Breathing faster: ${fmt(d.breathing_rate, 1)}/min (baseline ${fmt(b.breathing_rate, 1)})`);
    if (c.hr_high) items.push(`Heart rate higher: ${fmt(d.heart_rate, 0)} BPM (baseline ${fmt(b.heart_rate, 0)})`);
    return items;
  }

  function showNotice(d) {
    reasonsList.replaceChildren();
    for (const text of reasons(d)) {
      const li = document.createElement("li");
      li.textContent = text;
      reasonsList.appendChild(li);
    }
    notice.style.display = "block";
  }

  function updateComposure(d) {
    const state = d.composure.state;
    const now = Date.now();
    if (state === "calibrating") {
      const secs = d.baseline.seconds_collected;
      composureLine.textContent = "Composure: calibrating" + (secs === null ? " (waiting for a good signal)" : ` (${Math.floor(secs)}/60 s)`);
    } else if (state === null) {
      composureLine.textContent = "Composure: no current readings to compare";
    } else {
      const why = reasons(d);
      composureLine.textContent = `Composure: ${state}` + (why.length ? " - " + why.join("; ") : "");
    }

    if (state === "calm") {
      if (calmSince === null) calmSince = now;
      if (now - calmSince >= REARM_CALM_MS) armed = true;
    } else {
      calmSince = null;
    }
    if (state === "elevated" && lastState !== "elevated" && armed) {
      showNotice(d);
      armed = false;
    }
    if (state !== null) lastState = state;   // a missing reading doesn't count as a switch
  }

  async function poll() {
    try {
      const r = await fetch("/api/readings", {cache: "no-store"});
      const d = await r.json();
      out.textContent = JSON.stringify(d, null, 2);
      updateComposure(d);
    } catch (e) {
      out.textContent = "error: " + e;
    }
  }
  poll();
  setInterval(poll, 1000);
</script>
</body></html>
"""


def create_app(shared, port):
    web = Flask(__name__)
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    @web.before_request
    def local_host_only():
        # Blocks DNS rebinding: a page on another domain pointed at 127.0.0.1
        # sends its own Host header and is refused here.
        if request.host not in allowed_hosts:
            abort(403)

    @web.get("/")
    def index():
        return Response(TEST_PAGE, mimetype="text/html")

    @web.get("/api/readings")
    def readings():
        response = jsonify(shared.get_readings())
        response.headers["Cache-Control"] = "no-store"
        return response

    @web.get("/video")
    def video():
        def stream():
            last_id = 0
            while True:
                jpeg, new_id = shared.wait_jpeg(last_id)
                if jpeg is None or new_id == last_id:
                    if not shared.get_readings()["running"]:
                        return                        # processing has stopped; end the stream
                    continue
                last_id = new_id
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n"
                       b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                       + jpeg + b"\r\n")

        return Response(stream(), mimetype="multipart/x-mixed-replace; boundary=frame",
                        headers={"Cache-Control": "no-store"})

    return web


# app.py names this server relies on. Fails clearly if a different app.py sits next to it.
REQUIRED_FROM_APP = ("CameraSource", "CAMERA_WARMUP_SEC", "ROI_SMOOTHING", "ChestMotion",
                     "create_landmarker", "draw_hud", "draw_waveform", "to_pixels",
                     "region_polygon", "region_mean_rgb", "eye_aspect_ratio",
                     "rate_from_times", "MODEL_PATH", "FACE_LOST_RESET_SEC",
                     "UPDATE_EVERY_SEC")


def check_app_version():
    missing = [name for name in REQUIRED_FROM_APP if not hasattr(vs, name)]
    if missing:
        raise SystemExit(f"{vs.__file__} is missing {', '.join(missing)}; "
                         "server.py was written for the web-ui branch's app.py.")


def parse_args():
    parser = argparse.ArgumentParser(description="Serve live vital-sign readings on 127.0.0.1")
    parser.add_argument("--camera", type=int, default=0, help="webcam index")
    # 5000 is taken by macOS AirPlay Receiver, which answers with an empty 403.
    parser.add_argument("--port", type=int, default=5001, help="port on 127.0.0.1")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    return args


def main():
    args = parse_args()
    check_app_version()
    shared = SharedState()
    stop = threading.Event()
    worker = threading.Thread(target=processing_loop, args=(args, shared, stop), daemon=True)
    worker.start()
    print(f"Open http://{HOST}:{args.port}/  (Ctrl+C to stop)")
    try:
        create_app(shared, args.port).run(host=HOST, port=args.port, debug=False,
                                          threaded=True, use_reloader=False)
    finally:
        stop.set()
        worker.join(timeout=5.0)


if __name__ == "__main__":
    main()
