"""Serve the live vital-sign readings to a browser on this machine.

Runs the same capture-and-process loop as app.py's main() on a background
thread (webcam only, no --screen), and serves:

    GET /              the web UI (web/index.html, web/app.js, web/app.css)
    GET /static/...    the UI's files
    GET /api/readings  latest readings as JSON
    GET /video         MJPEG stream of the annotated frames (same image as app.py's window)

Usage:
    python server.py                 # default webcam on http://127.0.0.1:5001/
    python server.py --hr colour     # the app's own colour-based heart rate
    python server.py --avg-seconds 90 --camera 1 --port 5002

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
from flask import Flask, Response, abort, jsonify, request, send_from_directory

import app as vs
from vitals import HR_FS, RESP_FS, BlinkCounter, HeartRateEstimator, RespirationEstimator

HOST = "127.0.0.1"
JPEG_QUALITY = 80


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
    is missing (we can't say either way). blink_low needs both: below 60% of
    baseline and at least BLINK_MIN_DROP blinks/min lower. Rule:
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

    blink_low = compare(blink, lambda v: v < BLINK_LOW_RATIO * base_blink
                        and base_blink - v >= BLINK_MIN_DROP)
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
            "hr_source": None,
            "heart_snr_db": None,
            "signal_quality": None,
            "breathing_rate": None,
            "breathing_channel": None,
            "blink_rate": None,
            "signal_status": "no_face",
            "camera_fps": None,
            "processed_fps": None,
            "face_found": False,
            "shoulders_in_view": False,
            "average_heart_rate": None,
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

def signal_status(face_found, bpm, rppg_hr, heart):
    """app.py's status decision, as a short code plus the (text, color) app.py draws."""
    if not face_found:
        return "no_face", ("No face detected", vs.RED)
    if rppg_hr is not None:
        if bpm is None:
            return "measuring", ("Measuring... hold still", vs.GRAY)
        if rppg_hr.sqi is None or rppg_hr.sqi < vs.RppgHeartRate.GOOD_SQI:
            quality = f" (quality {rppg_hr.sqi:.2f})" if rppg_hr.sqi is not None else ""
            return "weak", ("Weak signal, hold still" + quality, vs.YELLOW)
        return "good", (f"Signal good (quality {rppg_hr.sqi:.2f})", vs.GREEN)
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

    source = rppg_hr = landmarker = None
    try:
        source = vs.CameraSource(args.camera, args.width, args.height, args.backend)
        landmarker = vs.create_landmarker()
        heart = HeartRateEstimator()                 # used with --hr colour
        rppg_hr = vs.RppgHeartRate(args.rppg_model) if args.hr == "rppg" else None
        breathing = RespirationEstimator(channel_names=("chest", "head"))
        blinks = BlinkCounter()
        chest = vs.ChestMotion()
        motion = vs.MotionPulseTracker()
        average = vs.AverageBpmMonitor(args.avg_seconds)
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
            if rppg_hr is not None:
                rppg_hr.add_frame(rgb, arrived)      # rgb is never drawn on, so it stays clean

            face_found = bool(result.face_landmarks)
            if face_found:
                if now - last_face_time > vs.FACE_LOST_RESET_SEC:
                    heart.reset()
                    breathing.reset()
                    chest.reset()
                    motion.reset()
                last_face_time = now

                h, w = frame.shape[:2]
                points = vs.to_pixels(result.face_landmarks[0], w, h)
                polygons = [vs.region_polygon(points, vs.FOREHEAD, shrink=0.8),
                            vs.region_polygon(points, vs.LEFT_CHEEK),
                            vs.region_polygon(points, vs.RIGHT_CHEEK)]
                # Sample colors before drawing anything on the frame.
                if rppg_hr is None:
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

                # Motion tracking runs on the full-resolution frame, so scale the landmarks up.
                full = source.full_frame
                to_full = np.array([full.shape[1] / w, full.shape[0] / h], dtype=np.float32)
                motion.update(now, cv2.cvtColor(full, cv2.COLOR_BGR2GRAY), points * to_full)

                if rppg_hr is None:
                    cv2.polylines(frame, polygons, True, vs.GREEN, 1)
                elif rppg_hr.box is not None:
                    (top, bottom), (left, right) = rppg_hr.box
                    cv2.rectangle(frame, (int(left), int(top)), (int(right), int(bottom)),
                                  vs.GREEN, 1)
                if chest.box is not None:
                    x0, y0, x1, y1 = chest.box
                    cv2.rectangle(frame, (x0, y0), (x1, y1), vs.BLUE, 1)
                for region in motion.regions.values():        # back to display size
                    outlines = [(outline / to_full).astype(np.int32) for outline in region.outlines]
                    cv2.polylines(frame, outlines, True, vs.MAGENTA, 1)
                    for x, y in region.points / to_full:
                        cv2.circle(frame, (int(x), int(y)), 1, vs.MAGENTA, -1)

            ticked = False
            if now - last_update >= vs.UPDATE_EVERY_SEC:
                last_update = now
                ticked = True
                if rppg_hr is None:
                    bpm = heart.update()
                resp_rate = breathing.update()
                blink_rate = blinks.rate_per_min(now)
            if rppg_hr is not None:
                bpm = rppg_hr.update(now)            # updates itself once a second

            status_code, status = signal_status(face_found, bpm, rppg_hr, heart)

            live_bpm = bpm if face_found else None
            average.update(now, live_bpm)            # pauses while there is no reading

            # Dashboard, identical to app.py.
            hr_source = rppg_hr.model_name if rppg_hr is not None else "colour"
            resp_text = (f"{resp_rate:.1f} /min ({breathing.channel_name})"
                         if resp_rate is not None else "--")
            blink_text = f"{blink_rate:.0f} /min" if blink_rate is not None else "--"
            fps = vs.rate_from_times(processed_times)
            camera_fps = source.fps
            fps_text = f"Camera {camera_fps:.0f} fps, processed {fps:.0f} fps"
            rows = [("Breathing", resp_text), ("Blinks", blink_text)]
            notes = [fps_text + ("  (need 15+)" if fps < 15 else "")]
            if face_found and chest.box is None:
                notes.append("Tip: sit back so your shoulders show")
            if face_found:
                head_n = len(motion.regions["head"].points)
                neck_n = len(motion.regions["neck"].points)
                notes.append(f"Motion points: head {head_n}, neck {neck_n}")

            if rppg_hr is not None:
                pulse_wave, pulse_fs = rppg_hr.waveform, rppg_hr.fs
            else:
                pulse_wave, pulse_fs = heart.waveform, HR_FS

            h, w = frame.shape[:2]
            display = frame
            if w != vs.DISPLAY_WIDTH:
                display = cv2.resize(frame, (vs.DISPLAY_WIDTH, round(h * vs.DISPLAY_WIDTH / w)),
                                     interpolation=cv2.INTER_LINEAR)
            vs.draw_dashboard(display, now, live_bpm, hr_source, average, rows, status, notes,
                              pulse_wave, pulse_fs, breathing.waveform)

            ok, jpeg = cv2.imencode(".jpg", display, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                shared.set_jpeg(jpeg.tobytes())

            if ticked:
                baseline.add(now, status_code, blink_rate, resp_rate, live_bpm)
            composure = evaluate_composure(
                baseline.ready, baseline.mean("blink"), baseline.mean("breath"),
                baseline.mean("heart"), blink_rate, resp_rate, live_bpm)

            shared.set_readings(
                heart_rate=_num(live_bpm),
                hr_source=hr_source,
                heart_snr_db=_num(heart.snr_db) if rppg_hr is None else None,
                signal_quality=_num(rppg_hr.sqi) if rppg_hr is not None else None,
                breathing_rate=_num(resp_rate),
                breathing_channel=breathing.channel_name if resp_rate is not None else None,
                blink_rate=_num(blink_rate),
                signal_status=status_code,
                camera_fps=_num(camera_fps),
                processed_fps=_num(fps),
                face_found=face_found,
                shoulders_in_view=bool(face_found and chest.box is not None),
                average_heart_rate={
                    "duration_sec": _num(average.duration),
                    "recorded_sec": _num(average.recorded_sec),
                    "progress": _num(average.progress),
                    "running_average": _num(average.running_average),
                    "done": average.done,
                    "result": _num(average.result),
                    "paused": average.paused,
                    "readings": len(average.readings),
                },
                composure=composure,
                baseline={"ready": baseline.ready,
                          "seconds_collected": _num(baseline.seconds_collected(now)),
                          "blink_rate": _num(baseline.mean("blink")),
                          "breathing_rate": _num(baseline.mean("breath")),
                          "heart_rate": _num(baseline.mean("heart"))},
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
SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; img-src 'self'; script-src 'self'; "
                                "style-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
                                "base-uri 'none'; form-action 'none'"),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def create_app(shared, port):
    web = Flask(__name__, static_folder=WEB_DIR, static_url_path="/static")
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    @web.before_request
    def local_host_only():
        # Blocks DNS rebinding: a page on another domain pointed at 127.0.0.1
        # sends its own Host header and is refused here.
        if request.host not in allowed_hosts:
            abort(403)

    @web.after_request
    def security_headers(response):
        response.headers.update(SECURITY_HEADERS)
        return response

    @web.get("/")
    def index():
        response = send_from_directory(WEB_DIR, "index.html")
        response.headers["Cache-Control"] = "no-store"
        return response

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
    parser.add_argument("--camera", type=int, default=0, help="webcam index")
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
    args = parser.parse_args()
    if args.avg_seconds < 10:
        parser.error("--avg-seconds must be at least 10")
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
