"""Serve the live vital-sign readings to a browser on this machine.

Runs the same capture-and-process loop as app.py's main() on a background
thread and serves the CUORE web UI. By default the camera is opened by the
BROWSER (its own permission prompt); the page sends frames here, stamped with
the time they were captured, and they go through the same processing.

    GET  /                   the product homepage (web/home.html, web/home.css, web/home.js)
    GET  /app                the measurement app (web/index.html, web/app.js, web/app.css)
    GET  /static/...         the UI's files
    GET  /api/readings       latest readings as JSON
    GET  /video              MJPEG stream of the annotated frames (app.py's dashboard)
    POST /api/session/start  start a fresh session: new baseline, estimators reset
    POST /api/frame          one camera frame from the page (browser mode only)
    POST /api/pair           pair a device with the printed code (--lan mode only)

Usage:
    python server.py                      # browser camera, http://127.0.0.1:5001/
    python server.py --lan                # phone mode: https on the home network, pairing code
    python server.py --source webcam      # Python opens the camera itself, as before
    python server.py --hr colour          # the app's own colour-based heart rate
    python server.py --avg-seconds 90 --port 5002

Bound to 127.0.0.1 only, unless --lan is given (then this computer's home-network
address, https, and every device must pair). Press Ctrl+C to stop.

app.py and vitals.py are imported, not changed by this server. Heart rate,
breathing and blink values are copied out of their estimators exactly as app.py
displays them; this server adds per-metric baselines, composure, and which heart
readings count toward the session average (after the first 10 s calibration).
"""
import argparse
import hmac
import ipaddress
import math
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
from collections import deque

import cv2
import mediapipe as mp
import numpy as np
from flask import Flask, Response, abort, jsonify, request, send_from_directory

import app as vs
from vitals import HR_FS, RESP_FS, BlinkCounter, HeartRateEstimator, RespirationEstimator

HOST = "127.0.0.1"
JPEG_QUALITY = 80
MAX_FRAME_BYTES = 4 * 1024 * 1024    # one uploaded camera frame
MAX_FRAME_SIDE = 4096                # pixels
WAVE_POINTS = 120                    # waveform samples sent to the page per signal


# --------------------------------------------------------------------------
# Composure: a comparison with the person's own baseline, nothing more.
# --------------------------------------------------------------------------

BASELINE_SEC = 60.0
BLINK_LOW_RATIO = 0.6
# With a low baseline, 60% is only a blink or two a minute, which is chance. The drop
# must also be at least this many blinks/min (6/min baseline: needs under 3, not 3.6).
BLINK_MIN_DROP = 3.0
BREATH_HIGH_RATIO = 1.25
HR_HIGH_RATIO = 1.15


BASELINE_MIN_VALID_SEC = 30.0   # coverage: at least this many seconds of valid readings
TICK_SEC = 0.5                  # one baseline sample per vitals update (app.UPDATE_EVERY_SEC)
METRICS = ("heart", "breath", "blink")
CALIBRATION_SEC = 10.0          # first 10 s of each session initialise CUORE; never in Average BPM


class MetricBaseline:
    """Baseline for ONE measurement: the mean of its own valid readings.

    A sample is offered every vitals update (0.5 s); `value` is None when this
    measurement's own validity rule fails at that moment (the caller decides
    validity, using the existing per-measurement rules). Ready only when BOTH:
      - at least BASELINE_SEC (60 s) have passed since its first valid reading, and
      - at least BASELINE_MIN_VALID_SEC (30 s) of valid readings were collected,
    so elapsed time alone never makes a baseline ready.
    """

    def __init__(self):
        self.start = None
        self.total = 0.0
        self.count = 0
        self.ready = False
        self.last_now = None

    def add(self, now, value):
        self.last_now = now
        if self.ready:
            return
        if value is not None:
            if self.start is None:
                self.start = now
            self.total += value
            self.count += 1
        if (self.start is not None and now - self.start >= BASELINE_SEC
                and self.valid_sec() >= BASELINE_MIN_VALID_SEC):
            self.ready = True

    def valid_sec(self):
        return self.count * TICK_SEC

    def elapsed_sec(self):
        return 0.0 if self.start is None or self.last_now is None else self.last_now - self.start

    def mean(self):
        """The baseline value, only once it is ready."""
        return self.total / self.count if self.ready and self.count else None

    def report(self):
        return {"ready": self.ready, "value": _num(self.mean()),
                "valid_sec": _num(self.valid_sec()), "elapsed_sec": _num(self.elapsed_sec()),
                "need_valid_sec": BASELINE_MIN_VALID_SEC, "need_elapsed_sec": BASELINE_SEC}


class Baseline:
    """Independent baselines for heart rate, breathing and blinks.

    A weak heart signal no longer blocks the breathing or blink baselines; each
    one learns from its own valid readings and becomes ready on its own.
    """

    def __init__(self):
        self.metrics = {key: MetricBaseline() for key in METRICS}

    def add(self, now, heart, breath, blink):
        """Each value is None unless that measurement passed its own validity rule."""
        for key, value in (("heart", heart), ("breath", breath), ("blink", blink)):
            self.metrics[key].add(now, value)

    @property
    def ready(self):          # all three ready (kept for the A/B views and old readers)
        return all(m.ready for m in self.metrics.values())

    def mean(self, key):
        return self.metrics[key].mean()

    def missing(self):
        return [key for key, m in self.metrics.items() if not m.ready]

    def seconds_collected(self, now):
        started = [now - m.start for m in self.metrics.values() if m.start is not None]
        return min(BASELINE_SEC, max(started)) if started else None


def evaluate_composure(base_blink, base_breath, base_heart, blink, breath, heart):
    """Compare current readings to whichever baselines are ready. All the rules live here.

    Thresholds are unchanged. A flag is True/False only when that measurement's
    baseline is ready AND it has a current reading; otherwise it is None (can't
    tell) and the measurement is not used. blink_low needs both: below 60 % of
    baseline and at least BLINK_MIN_DROP blinks/min lower; with a blink baseline
    under BLINK_MIN_DROP it is None and blink_baseline_too_low is True. Rule:
      - "calibrating"  no baseline is ready yet
      - "elevated"     blink_low is True on its own, or at least two flags are True
      - "calm"         otherwise, but only when at least two measurements were compared
      - "insufficient" otherwise: fewer than two measurements could be compared
    `used` lists the measurements that were compared.
    """
    if base_blink is None and base_breath is None and base_heart is None:
        return {"state": "calibrating", "blink_low": None, "breath_high": None, "hr_high": None,
                "blink_baseline_too_low": False, "used": []}

    def compare(base, current, check):
        return None if base is None or current is None else bool(check(current, base))

    blink_baseline_too_low = base_blink is not None and base_blink < BLINK_MIN_DROP
    blink_low = None if blink_baseline_too_low else compare(
        base_blink, blink, lambda v, b: v < BLINK_LOW_RATIO * b and b - v >= BLINK_MIN_DROP)
    breath_high = compare(base_breath, breath, lambda v, b: v > BREATH_HIGH_RATIO * b)
    hr_high = compare(base_heart, heart, lambda v, b: v > HR_HIGH_RATIO * b)

    flags = {"blink": blink_low, "breath": breath_high, "heart": hr_high}
    used = [key for key in ("heart", "breath", "blink") if flags[key] is not None]
    if blink_low is True or sum(f is True for f in flags.values()) >= 2:
        state = "elevated"
    elif len(used) >= 2:
        state = "calm"
    else:
        state = "insufficient"
    return {"state": state, "blink_low": blink_low, "breath_high": breath_high, "hr_high": hr_high,
            "blink_baseline_too_low": blink_baseline_too_low, "used": used}


# --------------------------------------------------------------------------
# Shared state between the processing thread and the web handlers
# --------------------------------------------------------------------------

def _num(value):
    """Float for JSON, or None. NaN/inf become None (they are not valid JSON)."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def wave_for_json(wave, fs, seconds):
    """The last `seconds` of a waveform, thinned to at most WAVE_POINTS samples.

    Values are the estimator's own samples (every k-th one), not smoothed or
    rescaled. Returns {"fs": samples per second after thinning, "values": [...]}
    or None when there is no waveform yet.
    """
    if wave is None or fs is None or fs <= 0:
        return None
    segment = np.asarray(wave, dtype=float)[-int(seconds * fs):]
    if len(segment) < 2:
        return None
    step = max(1, int(math.ceil(len(segment) / WAVE_POINTS)))
    thinned = segment[::step]
    return {"fs": float(fs) / step,
            "values": [round(float(v), 4) if math.isfinite(v) else None for v in thinned]}


def counts_toward_average(elapsed, status_code):
    """Whether a heart-rate sample may count toward the session's Average BPM: only
    once the 10 s calibration is over (elapsed >= 10 s, measured by frame capture time
    from the session's first frame) and only when the heart signal passed its quality
    check. Live BPM is unaffected."""
    return elapsed is not None and elapsed >= CALIBRATION_SEC and status_code == "good"


def default_readings(source, session_id):
    return {
        "running": False,
        "error": None,
        "session": {"id": session_id, "source": source, "elapsed": None},
        "heart_in_average": False,
        "heart_rate": None,
        "hr_source": None,
        "heart_snr_db": None,
        "signal_quality": None,
        "signal_quality_threshold": vs.RppgHeartRate.GOOD_SQI,   # heart signal is good only above this
        "breathing_rate": None,
        "breathing_channel": None,
        "blink_rate": None,
        "signal_status": "no_face",
        "camera_fps": None,
        "processed_fps": None,
        "face_found": False,
        "shoulders_in_view": False,
        "average_heart_rate": None,
        "pulse_wave": None,
        "breath_wave": None,
        "composure": evaluate_composure(None, None, None, None, None, None),
        "baseline": {"ready": False, "seconds_collected": None, "waiting_for": list(METRICS),
                     "blink_rate": None, "breathing_rate": None, "heart_rate": None,
                     "metrics": {key: MetricBaseline().report() for key in METRICS}},
        "diag": None,
        "updated_at": None,
    }


class SharedState:
    def __init__(self, source):
        self.lock = threading.Lock()
        self.frame_ready = threading.Condition(self.lock)
        self.source = source
        # Webcam mode starts measuring straight away; browser mode waits for the page.
        self.session_id = 1 if source == "webcam" else 0
        self.readings = default_readings(source, self.session_id)
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

    def start_session(self):
        """New session: old readings are cleared at once so the page never sees a stale baseline."""
        with self.lock:
            self.session_id += 1
            running, error = self.readings["running"], self.readings["error"]
            self.readings = default_readings(self.source, self.session_id)
            self.readings.update(running=running, error=error)
            return self.session_id

    def current_session(self):
        with self.lock:
            return self.session_id

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
# Frames from the browser
# --------------------------------------------------------------------------

class BrowserSource:
    """Frames uploaded by the page, behaving like app.CameraSource.

    Each frame carries the time the browser captured it (performance clock,
    seconds). Like CameraSource, the capture time is what the pulse maths uses,
    not the time the frame happened to arrive. Capture times are mapped onto this
    process's monotonic clock once per session, keeping the browser's spacing
    between frames. Frames that are not newer than the last one are dropped.
    read() mirrors and resizes exactly as CameraSource.read() does.
    """

    MAX_WIDTH = vs.CameraSource.MAX_WIDTH

    def __init__(self):
        self.lock = threading.Lock()
        self.new_frame = threading.Condition(self.lock)
        self.frame = None
        self.timestamp = None
        self.frame_id = 0
        self.last_read_id = 0
        self.full_frame = None
        self.arrival_times = deque(maxlen=60)
        self.session_id = None
        self.offset = 0.0
        self.last_timestamp = -math.inf
        self.dropped = 0          # frames rejected for arriving out of capture order (diagnostics)

    def push(self, frame, capture_time, session_id):
        with self.new_frame:
            if session_id != self.session_id:
                self.session_id = session_id
                self.offset = time.monotonic() - capture_time
            t = capture_time + self.offset
            if t <= self.last_timestamp:
                self.dropped += 1
                return False
            self.last_timestamp = t
            self.frame = frame
            self.timestamp = t
            self.frame_id += 1
            self.arrival_times.append(t)
            self.new_frame.notify_all()
            return True

    def read(self, timeout=1.0):
        """Newest frame not seen yet and its capture time, or (None, None) after `timeout`."""
        with self.new_frame:
            if not self.new_frame.wait_for(lambda: self.frame_id != self.last_read_id,
                                           timeout=timeout):
                return None, None
            self.last_read_id = self.frame_id
            frame, timestamp = self.frame, self.timestamp
        frame = cv2.flip(frame, 1)             # mirror view, as CameraSource does
        self.full_frame = frame
        if frame.shape[1] > self.MAX_WIDTH:
            scale = 640.0 / frame.shape[1]
            frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        return frame, timestamp

    @property
    def fps(self):
        with self.lock:
            return vs.rate_from_times(self.arrival_times)

    def release(self):
        pass


# --------------------------------------------------------------------------
# Processing loop: copied from app.main(), no window
# --------------------------------------------------------------------------

def signal_status(face_found, bpm, rppg_hr, heart):
    """app.py's status decision, as a short code plus the (text, color) app.py draws."""
    if not face_found:
        return "no_face", ("No face detected", vs.RED)
    if rppg_hr is not None:
        if bpm is None:
            return "measuring", ("Measuring... hold still", vs.GRAY)
        if rppg_hr.sqi is None or rppg_hr.sqi <= vs.RppgHeartRate.GOOD_SQI:   # good only when SQI > GOOD_SQI
            quality = f" (quality {rppg_hr.sqi:.2f})" if rppg_hr.sqi is not None else ""
            return "weak", ("Weak signal, hold still" + quality, vs.YELLOW)
        return "good", (f"Signal good (quality {rppg_hr.sqi:.2f})", vs.GREEN)
    if heart.snr_db is None:
        return "measuring", ("Measuring... hold still", vs.GRAY)
    if not heart.signal_ok:
        return "weak", ("Hold still, good light", vs.YELLOW)
    return "good", ("Signal good", vs.GREEN)


class Session:
    """Everything app.main() creates per run, rebuilt when the page starts calibrating."""

    def __init__(self, args, session_id):
        self.id = session_id
        self.heart = HeartRateEstimator()                 # used with --hr colour
        self.breathing = RespirationEstimator(channel_names=("chest", "head"))
        self.blinks = BlinkCounter()
        self.chest = vs.ChestMotion()
        self.motion = vs.MotionPulseTracker()
        self.average = vs.AverageBpmMonitor(args.avg_seconds)
        self.baseline = Baseline()
        self.last_update = None
        self.last_face_time = -1e9
        self.processed_times = deque(maxlen=60)
        self.bpm = self.resp_rate = self.blink_rate = None
        self.face_ticks = deque()      # (time, face found) per vitals update, last 60 s (diagnostics)
        self.latency_ms = None         # capture → published result, smoothed (diagnostics)
        self.started = None            # capture time of this session's first frame (calibration clock)


def processing_loop(args, shared, stop, source):
    if not os.path.exists(vs.MODEL_PATH):
        # create_landmarker() would download it; this server must not download at runtime.
        shared.set_readings(error=f"Missing {os.path.basename(vs.MODEL_PATH)}; place the model "
                                  "file next to app.py.")
        return

    rppg_hr = landmarker = None
    try:
        if source is None:
            source = vs.CameraSource(args.camera, args.width, args.height, args.backend)
        landmarker = vs.create_landmarker()
        rppg_hr = vs.RppgHeartRate(args.rppg_model) if args.hr == "rppg" else None
        rppg_session = None          # session whose frames the open-rppg model has seen
        s = None

        # One clock for the whole run: MediaPipe needs strictly increasing timestamps.
        t0 = None
        last_timestamp_ms = -1
        shared.set_readings(running=True)

        while not stop.is_set():
            frame, arrived = source.read()
            if frame is None:
                if args.source == "webcam":
                    shared.set_readings(error="No frames from the camera. Is another app using it?")
                    break
                continue                              # browser paused or not started yet

            session_id = shared.current_session()
            if session_id == 0:
                continue                              # page hasn't pressed Start Calibrating
            if s is None or s.id != session_id:
                s = Session(args, session_id)
                if rppg_hr is not None and rppg_session not in (None, session_id):
                    # The library has no reset; a fresh model drops the old session's pulse.
                    rppg_hr.close()
                    rppg_hr = vs.RppgHeartRate(args.rppg_model)
                rppg_session = session_id

            if t0 is None:
                t0 = arrived
            now = arrived - t0
            if s.last_update is None:
                s.last_update = now
            if s.started is None:
                s.started = now                       # calibration starts with the first frame
            s.processed_times.append(now)

            timestamp_ms = max(int(now * 1000), last_timestamp_ms + 1)
            last_timestamp_ms = timestamp_ms
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms)
            if rppg_hr is not None:
                rppg_hr.add_frame(rgb, arrived)      # rgb is never drawn on, so it stays clean

            face_found = bool(result.face_landmarks)
            if face_found:
                if now - s.last_face_time > vs.FACE_LOST_RESET_SEC:
                    s.heart.reset()
                    s.breathing.reset()
                    s.chest.reset()
                    s.motion.reset()
                s.last_face_time = now

                h, w = frame.shape[:2]
                points = vs.to_pixels(result.face_landmarks[0], w, h)
                polygons = [vs.region_polygon(points, vs.FOREHEAD, shrink=0.8),
                            vs.region_polygon(points, vs.LEFT_CHEEK),
                            vs.region_polygon(points, vs.RIGHT_CHEEK)]
                # Sample colors before drawing anything on the frame.
                if rppg_hr is None:
                    colors = [vs.region_mean_rgb(frame, polygon) for polygon in polygons]
                    if all(c is not None for c in colors):
                        s.heart.add(now, np.concatenate(colors))

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                chest_y = s.chest.update(gray, points)
                head_y = float(points[:, 1].mean())
                s.breathing.add(now, [chest_y, head_y])

                ear = (vs.eye_aspect_ratio(points, vs.LEFT_EYE)
                       + vs.eye_aspect_ratio(points, vs.RIGHT_EYE)) / 2
                s.blinks.update(now, ear)

                # Motion tracking runs on the full-resolution frame, so scale the landmarks up.
                full = source.full_frame
                to_full = np.array([full.shape[1] / w, full.shape[0] / h], dtype=np.float32)
                s.motion.update(now, cv2.cvtColor(full, cv2.COLOR_BGR2GRAY), points * to_full)

                if rppg_hr is None:
                    cv2.polylines(frame, polygons, True, vs.GREEN, 1)
                elif rppg_hr.box is not None:
                    (top, bottom), (left, right) = rppg_hr.box
                    cv2.rectangle(frame, (int(left), int(top)), (int(right), int(bottom)),
                                  vs.GREEN, 1)
                if s.chest.box is not None:
                    x0, y0, x1, y1 = s.chest.box
                    cv2.rectangle(frame, (x0, y0), (x1, y1), vs.BLUE, 1)
                for region in s.motion.regions.values():      # back to display size
                    outlines = [(outline / to_full).astype(np.int32) for outline in region.outlines]
                    cv2.polylines(frame, outlines, True, vs.MAGENTA, 1)
                    for x, y in region.points / to_full:
                        cv2.circle(frame, (int(x), int(y)), 1, vs.MAGENTA, -1)

            ticked = False
            if now - s.last_update >= vs.UPDATE_EVERY_SEC:
                s.last_update = now
                ticked = True
                if rppg_hr is None:
                    s.bpm = s.heart.update()
                s.resp_rate = s.breathing.update(now)    # no reading once the face is gone
                s.blink_rate = s.blinks.rate_per_min(now)
            if rppg_hr is not None:
                s.bpm = rppg_hr.update(now)          # updates itself once a second
            bpm, resp_rate, blink_rate = s.bpm, s.resp_rate, s.blink_rate

            status_code, status = signal_status(face_found, bpm, rppg_hr, s.heart)

            live_bpm = bpm if face_found else None
            s.average.update(now, live_bpm)          # pauses while there is no reading

            # Dashboard, identical to app.py.
            hr_source = rppg_hr.model_name if rppg_hr is not None else "colour"
            resp_text = (f"{resp_rate:.1f} /min ({s.breathing.channel_name})"
                         if resp_rate is not None else "--")
            blink_text = f"{blink_rate:.0f} /min" if blink_rate is not None else "--"
            fps = vs.rate_from_times(s.processed_times)
            camera_fps = source.fps
            fps_text = f"Camera {camera_fps:.0f} fps, processed {fps:.0f} fps"
            rows = [("Breathing", resp_text), ("Blinks", blink_text)]
            notes = [fps_text + ("  (need 15+)" if fps < 15 else "")]
            if face_found and s.chest.box is None:
                notes.append("Tip: sit back so your shoulders show")
            if face_found:
                head_n = len(s.motion.regions["head"].points)
                neck_n = len(s.motion.regions["neck"].points)
                notes.append(f"Motion points: head {head_n}, neck {neck_n}")

            if rppg_hr is not None:
                pulse_wave, pulse_fs = rppg_hr.waveform, rppg_hr.fs
            else:
                pulse_wave, pulse_fs = s.heart.waveform, HR_FS

            h, w = frame.shape[:2]
            display = frame
            if w != vs.DISPLAY_WIDTH:
                display = cv2.resize(frame, (vs.DISPLAY_WIDTH, round(h * vs.DISPLAY_WIDTH / w)),
                                     interpolation=cv2.INTER_LINEAR)
            vs.draw_dashboard(display, now, live_bpm, hr_source, s.average, rows, status, notes,
                              pulse_wave, pulse_fs, s.breathing.waveform)

            ok, jpeg = cv2.imencode(".jpg", display, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                shared.set_jpeg(jpeg.tobytes())

            # The blink rate is a count over the last 60 s. Until 60 s have passed it is
            # extrapolated from a few seconds and swings wildly (one blink in 10 s reads as
            # 6/min), so only full-window blink rates go into the baseline.
            blink_window_full = (s.blinks.start is not None
                                 and now - s.blinks.start >= s.blinks.window_sec)
            if ticked:
                # Each baseline takes a sample only when ITS OWN existing validity rule passes:
                #   heart:  a live reading with the heart signal "good" (unchanged rule)
                #   breath: the breathing estimator produced a rate (its own 20 s + confidence
                #           checks), with a face in view; no longer blocked by a weak heart signal
                #   blink:  a full 60 s blink window with a face in view (unchanged rule)
                s.baseline.add(
                    now,
                    heart=live_bpm if status_code == "good" else None,
                    breath=resp_rate if (resp_rate is not None and face_found) else None,
                    blink=blink_rate if (blink_window_full and face_found) else None,
                )
                s.face_ticks.append((now, face_found))
                while s.face_ticks and now - s.face_ticks[0][0] > 60.0:
                    s.face_ticks.popleft()
            composure = evaluate_composure(
                s.baseline.mean("blink"), s.baseline.mean("breath"), s.baseline.mean("heart"),
                blink_rate, resp_rate, live_bpm)

            if shared.current_session() != s.id:
                continue          # a new session started mid-frame; don't publish stale values
            latency = (time.monotonic() - arrived) * 1000.0     # capture → this result
            s.latency_ms = latency if s.latency_ms is None else s.latency_ms * 0.8 + latency * 0.2
            face_ratio = (sum(1 for _, f in s.face_ticks if f) / len(s.face_ticks)) if s.face_ticks else None
            elapsed = now - s.started               # this sample's capture time within the session
            shared.set_readings(
                session={"id": s.id, "source": args.source, "elapsed": round(elapsed, 3)},
                heart_rate=_num(live_bpm),
                heart_in_average=live_bpm is not None and counts_toward_average(elapsed, status_code),
                hr_source=hr_source,
                heart_snr_db=_num(s.heart.snr_db) if rppg_hr is None else None,
                signal_quality=_num(rppg_hr.sqi) if rppg_hr is not None else None,
                signal_quality_threshold=vs.RppgHeartRate.GOOD_SQI,
                breathing_rate=_num(resp_rate),
                breathing_channel=s.breathing.channel_name if resp_rate is not None else None,
                blink_rate=_num(blink_rate),
                signal_status=status_code,
                camera_fps=_num(camera_fps),
                processed_fps=_num(fps),
                face_found=face_found,
                shoulders_in_view=bool(face_found and s.chest.box is not None),
                average_heart_rate={
                    "duration_sec": _num(s.average.duration),
                    "recorded_sec": _num(s.average.recorded_sec),
                    "progress": _num(s.average.progress),
                    "running_average": _num(s.average.running_average),
                    "done": s.average.done,
                    "result": _num(s.average.result),
                    "paused": s.average.paused,
                    "readings": len(s.average.readings),
                },
                pulse_wave=wave_for_json(pulse_wave, pulse_fs, 6) if face_found else None,
                breath_wave=wave_for_json(s.breathing.waveform, RESP_FS, 30),
                composure=composure,
                baseline={"ready": s.baseline.ready,
                          "seconds_collected": _num(s.baseline.seconds_collected(now)),
                          "waiting_for": s.baseline.missing(),
                          "blink_rate": _num(s.baseline.mean("blink")),
                          "breathing_rate": _num(s.baseline.mean("breath")),
                          "heart_rate": _num(s.baseline.mean("heart")),
                          "metrics": {k: m.report() for k, m in s.baseline.metrics.items()}},
                # Read-only diagnostics. breathing_snr_db is the confidence of the most
                # recent ACCEPTED breathing estimate (the estimator keeps it until the next one).
                diag={
                    "breathing_snr_db": _num(s.breathing.snr_db) if resp_rate is not None else None,
                    "breathing_buffer_sec": _num(s.breathing.buffer.duration()),
                    "blink_window_sec": _num(min(s.blinks.window_sec, now - s.blinks.start)) if s.blinks.start is not None else None,
                    "face_ratio_60s": _num(face_ratio),
                    "frame_latency_ms": _num(s.latency_ms),
                    "frames_dropped": getattr(source, "dropped", None),
                },
                updated_at=time.monotonic(),
            )
    except BaseException as exc:   # includes SystemExit from CameraSource / RppgHeartRate
        shared.set_readings(error=f"{type(exc).__name__}: {exc}")
        print(f"Processing stopped: {type(exc).__name__}: {exc}")
    finally:
        shared.set_readings(running=False)
        if source is not None:
            source.release()
        if rppg_hr is not None:
            rppg_hr.close()
        if landmarker is not None:
            landmarker.close()


# --------------------------------------------------------------------------
# Web server
# --------------------------------------------------------------------------

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Only this server's own files may load; no inline scripts, no outside hosts.
# media-src/blob: lets the page show its own camera stream.
SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; img-src 'self' blob: data:; "
                                "media-src 'self' blob:; script-src 'self'; style-src 'self'; "
                                "connect-src 'self'; frame-ancestors 'none'; "
                                "base-uri 'none'; form-action 'none'"),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # Camera only for this page itself; never for embedded content.
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
}
CLIENT_HEADER = "X-Cuore-Client"   # custom header: other sites can't send it without CORS

# ----- opt-in home Wi-Fi mode (--lan) -----
# Lets a phone on the same Wi-Fi use this computer's CUORE server. Off by default.
# Video from a paired phone comes here over the local network, is processed in
# memory like any other frame, and is not sent anywhere else.
PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L: easy to type on a phone
PAIR_LEN = 8                                          # 31^8 ≈ 8.5e11 codes
PAIR_FAILS_PER_MIN = 10                               # per device address
PAIR_FAILS_TOTAL = 50                                 # then pairing stops until restart
PAIR_COOKIE = "cuore_pair"
TLS_DIR = os.path.join(os.path.expanduser("~"), ".cuore", "tls")


def lan_address():
    """This computer's IPv4 address on the local network. Connecting a UDP socket
    sends no packet; it only asks the OS which interface it would use. The target
    is a documentation-only address that is never routed."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.0.2.1", 9))
        except OSError as e:
            raise SystemExit(f"--lan: no network connection found ({e}).") from e
        ip = s.getsockname()[0]
    addr = ipaddress.ip_address(ip)
    if not addr.is_private or addr.is_loopback:
        raise SystemExit(f"--lan only runs on a private home or office network; this computer's address is {ip}.")
    return ip


def tls_files(ip):
    """A self-signed certificate for this address, made once with the system's openssl
    and kept in ~/.cuore/tls (never in the project). Phones only allow the camera on
    https pages, which is why LAN mode needs one."""
    os.makedirs(TLS_DIR, mode=0o700, exist_ok=True)
    cert = os.path.join(TLS_DIR, f"cert-{ip}.pem")
    key = os.path.join(TLS_DIR, f"key-{ip}.pem")
    fresh = os.path.exists(cert) and time.time() - os.path.getmtime(cert) < 360 * 86400
    if fresh and os.path.exists(key):
        return cert, key
    openssl = shutil.which("openssl")
    if openssl is None:
        raise SystemExit("--lan needs the openssl command to create a certificate. Install OpenSSL and try again.")
    old = os.umask(0o077)
    try:
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "365",
                        "-keyout", key, "-out", cert, "-subj", "/CN=CUORE on this computer",
                        "-addext", f"subjectAltName=IP:{ip}"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
    except subprocess.CalledProcessError as e:
        raise SystemExit("--lan: openssl couldn't create the certificate: "
                         + e.stderr.decode(errors="replace").strip()) from e
    finally:
        os.umask(old)
    os.chmod(key, 0o600)
    return cert, key


class Pairing:
    """One code per server run. A device that enters it gets a random session token
    in an HttpOnly, Secure, SameSite=Strict cookie; the code itself is never stored
    in the browser. Failed attempts are rate limited and logged without the code."""

    def __init__(self):
        self.code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(PAIR_LEN))
        self.tokens = set()
        self.fails = {}
        self.total_fails = 0
        self.lock = threading.Lock()

    @property
    def display(self):
        return f"{self.code[:4]}-{self.code[4:]}"

    def try_pair(self, device, attempt):
        now = time.monotonic()
        with self.lock:
            recent = [t for t in self.fails.get(device, []) if now - t < 60.0]
            self.fails[device] = recent
            if len(recent) >= PAIR_FAILS_PER_MIN or self.total_fails >= PAIR_FAILS_TOTAL:
                return None, "locked"
            cleaned = "".join(ch for ch in str(attempt).upper() if ch.isalnum())[:PAIR_LEN * 2]
            if hmac.compare_digest(cleaned.encode(), self.code.encode()):
                token = secrets.token_urlsafe(32)
                self.tokens.add(token)
                return token, "ok"
            recent.append(now)
            self.total_fails += 1
            return None, "wrong"

    def is_paired(self, token):
        if not token:
            return False
        with self.lock:
            return any(hmac.compare_digest(token, t) for t in self.tokens)


def needs_pairing(path):
    """Readings, frames and video need a paired device; the pages themselves don't."""
    return (path.startswith("/api/") and path != "/api/pair") or path == "/video"


def create_app(shared, port, browser_source, lan=None):
    web = Flask(__name__, static_folder=WEB_DIR, static_url_path="/static")
    web.config["MAX_CONTENT_LENGTH"] = MAX_FRAME_BYTES
    if lan:
        allowed_hosts = {f"{lan['ip']}:{port}"}
        allowed_origins = {f"https://{lan['ip']}:{port}"}
    else:
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        allowed_origins = {f"http://{host}" for host in allowed_hosts}

    @web.before_request
    def local_host_only():
        # Blocks DNS rebinding: a page on another domain pointed at this server
        # sends its own Host header and is refused here.
        if request.host not in allowed_hosts:
            abort(403)
        # State-changing requests must come from this page (CSRF): same origin and
        # a custom header, which a cross-site form or fetch cannot add.
        if request.method == "POST":
            if (request.headers.get("Origin") not in allowed_origins
                    or request.headers.get(CLIENT_HEADER) != "1"):
                abort(403)
        # LAN mode: every device, this computer included, pairs before it gets data.
        if lan and needs_pairing(request.path) and not lan["pairing"].is_paired(request.cookies.get(PAIR_COOKIE)):
            abort(401)

    @web.post("/api/pair")
    def pair():
        if not lan:
            abort(404)
        body = request.get_json(silent=True) or {}
        token, result = lan["pairing"].try_pair(request.remote_addr, body.get("code", ""))
        if result == "locked":
            print(f"CUORE: pairing refused for {request.remote_addr} (too many attempts)", flush=True)
            return jsonify({"paired": False, "error": "Too many attempts. Wait a minute and try again."}), 429
        if token is None:
            print(f"CUORE: wrong pairing code from {request.remote_addr}", flush=True)
            return jsonify({"paired": False, "error": "That code doesn't match the one in the CUORE terminal."}), 403
        print(f"CUORE: device paired ({request.remote_addr})", flush=True)
        response = jsonify({"paired": True})
        response.set_cookie(PAIR_COOKIE, token, httponly=True, secure=True, samesite="Strict", path="/")
        response.headers["Cache-Control"] = "no-store"
        return response

    @web.after_request
    def security_headers(response):
        response.headers.update(SECURITY_HEADERS)
        return response

    def page(name):
        response = send_from_directory(WEB_DIR, name)
        response.headers["Cache-Control"] = "no-store"
        return response

    @web.get("/")
    def home():
        return page("home.html")          # product homepage

    @web.get("/app")
    def index():
        return page("index.html")         # the measurement app

    @web.get("/api/readings")
    def readings():
        response = jsonify(shared.get_readings())
        response.headers["Cache-Control"] = "no-store"
        return response

    @web.post("/api/session/start")
    def session_start():
        return jsonify({"session_id": shared.start_session(), "source": shared.source})

    @web.post("/api/frame")
    def frame_upload():
        if browser_source is None:
            abort(404)                                # webcam mode: Python owns the camera
        if request.mimetype != "image/jpeg":
            abort(415)
        try:
            session_id = int(request.headers.get("X-Session", ""))
            capture_time = float(request.headers.get("X-Capture-Time", ""))
        except ValueError:
            abort(400)
        if not math.isfinite(capture_time) or capture_time < 0:
            abort(400)
        if session_id != shared.current_session():
            abort(409)                                # frame from an old session
        data = np.frombuffer(request.get_data(cache=False), dtype=np.uint8)
        frame = cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None
        if frame is None:
            abort(400)
        if max(frame.shape[:2]) > MAX_FRAME_SIDE or min(frame.shape[:2]) < 64:
            abort(400)
        browser_source.push(frame, capture_time, session_id)
        return ("", 204)

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
REQUIRED_FROM_APP = ("CameraSource", "RppgHeartRate", "ChestMotion", "MotionPulseTracker",
                     "AverageBpmMonitor", "draw_dashboard", "DISPLAY_WIDTH",
                     "create_landmarker", "to_pixels", "region_polygon", "region_mean_rgb",
                     "eye_aspect_ratio", "rate_from_times", "MODEL_PATH",
                     "FACE_LOST_RESET_SEC", "UPDATE_EVERY_SEC")


def check_app_version():
    missing = [name for name in REQUIRED_FROM_APP if not hasattr(vs, name)]
    if missing:
        raise SystemExit(f"{vs.__file__} is missing {', '.join(missing)}; server.py expects "
                         "the app.py with the dashboard and AverageBpmMonitor.")


def parse_args():
    parser = argparse.ArgumentParser(description="Serve live vital-sign readings on 127.0.0.1")
    parser.add_argument("--source", choices=["browser", "webcam"], default="browser",
                        help="browser: the page opens the camera (default); "
                             "webcam: Python opens it, as app.py does")
    parser.add_argument("--camera", type=int, default=0, help="webcam index (--source webcam)")
    parser.add_argument("--width", type=int, help="ask the camera for this width (optional)")
    parser.add_argument("--height", type=int, help="ask the camera for this height (optional)")
    parser.add_argument("--backend", choices=["auto", "dshow", "msmf"], default="auto",
                        help="Windows camera system: dshow (DirectShow) or msmf (Media Foundation)")
    parser.add_argument("--hr", choices=["rppg", "colour"], default="rppg",
                        help="heart rate source: rppg (open-rppg library) or colour (this app's own)")
    parser.add_argument("--rppg-model", default="FacePhys.rlap",
                        help="open-rppg model name, e.g. FacePhys.rlap, ME-flow.rlap")
    parser.add_argument("--avg-seconds", type=float, default=120,
                        help="how many seconds of heart rate readings the average uses (default 120)")
    # 5000 is taken by macOS AirPlay Receiver, which answers with an empty 403.
    parser.add_argument("--port", type=int, default=5001, help="port on 127.0.0.1")
    parser.add_argument("--lan", action="store_true",
                        help="home Wi-Fi mode: serve https on this computer's local network address so a "
                             "phone on the same Wi-Fi can pair and measure. Video comes to this computer "
                             "only. Off by default.")
    args = parser.parse_args()
    if args.avg_seconds < 10:
        parser.error("--avg-seconds must be at least 10")
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    return args


def main():
    args = parse_args()
    check_app_version()
    shared = SharedState(args.source)
    browser_source = BrowserSource() if args.source == "browser" else None
    stop = threading.Event()
    worker = threading.Thread(target=processing_loop,
                              args=(args, shared, stop, browser_source), daemon=True)
    host, ssl_context, lan = HOST, None, None
    if args.lan:
        ip = lan_address()
        ssl_context = tls_files(ip)
        lan = {"ip": ip, "pairing": Pairing()}
        host = ip                                    # this network only, not every interface
    worker.start()
    if lan:
        url = f"https://{lan['ip']}:{args.port}/app"
        print("\nCUORE · home Wi-Fi mode\n"
              f"  On your phone or this computer (same Wi-Fi), open:  {url}\n"
              f"  Pairing code:  {lan['pairing'].display}\n"
              "  The browser will warn that the certificate isn't trusted: it was made on this computer\n"
              "  for this address. Safari: Show Details > visit this website. Chrome: Advanced > Proceed.\n"
              "  Video from paired devices comes to this computer over your Wi-Fi, is processed in\n"
              "  memory here, and is not sent anywhere else. Ctrl+C stops the server.\n", flush=True)
    else:
        print(f"Open http://{HOST}:{args.port}/  (Ctrl+C to stop)")
    try:
        create_app(shared, args.port, browser_source, lan).run(
            host=host, port=args.port, debug=False, threaded=True, use_reloader=False, ssl_context=ssl_context)
    finally:
        stop.set()
        worker.join(timeout=5.0)


if __name__ == "__main__":
    main()
