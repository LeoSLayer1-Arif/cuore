"""Browser dashboard for the vital signs camera.

Runs the same camera and vitals pipeline as app.py, but shows the results in a
web page instead of an OpenCV window. The camera is read on this computer, so
open the page in a browser on the same machine.

Usage:
    python web.py                                # default webcam, http://127.0.0.1:8000
    python web.py --port 5000                    # another port
    python web.py --hr colour                    # use the app's own colour-based heart rate
    python web.py --camera 1 --width 1280 --height 720
    python web.py --screen 100 100 640 480       # read a region of the screen (e.g. a Zoom tile)

All camera and heart rate options are the same as for app.py.
Press Ctrl+C in the terminal to stop the server.
"""
import app as core   # first: sets the OpenCV environment variable before cv2 is imported

import argparse
import json
import os
import threading
import time
import traceback
from collections import deque

import cv2
import mediapipe as mp
import numpy as np
from flask import Flask, Response, abort, jsonify, request, send_from_directory

from vitals import HR_FS, RESP_FS, BlinkCounter, HeartRateEstimator, RespirationEstimator

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
JPEG_QUALITY = 80
STREAM_EVERY_SEC = 0.2      # how often the page receives new readings
PULSE_GRAPH_SEC = 5
BREATH_GRAPH_SEC = 30

# Same overlay colours as the desktop app (BGR).
GREEN, BLUE, MAGENTA = core.GREEN, core.BLUE, core.MAGENTA


def parse_args():
    parser = argparse.ArgumentParser(description="Camera-based vital signs in the browser")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to serve on (default 127.0.0.1, this computer only)")
    parser.add_argument("--port", type=int, default=8000, help="port to serve on (default 8000)")
    parser.add_argument("--camera", type=int, default=0, help="webcam index")
    parser.add_argument("--width", type=int, help="ask the camera for this width (optional)")
    parser.add_argument("--height", type=int, help="ask the camera for this height (optional)")
    parser.add_argument("--backend", choices=["auto", "dshow", "msmf"], default="auto",
                        help="Windows camera system: dshow (DirectShow) or msmf (Media Foundation)")
    parser.add_argument("--screen", type=int, nargs=4, metavar=("LEFT", "TOP", "WIDTH", "HEIGHT"),
                        help="capture a screen region instead of the webcam")
    parser.add_argument("--hr", choices=["rppg", "colour"], default="rppg",
                        help="heart rate source: rppg (open-rppg library) or colour (this app's own)")
    parser.add_argument("--rppg-model", default="FacePhys.rlap",
                        help="open-rppg model name, e.g. FacePhys.rlap, ME-flow.rlap, PhysFormer.pure")
    parser.add_argument("--avg-seconds", type=float, default=60,
                        help="how many seconds of heart rate readings the average uses (default 60)")
    args = parser.parse_args()
    if args.avg_seconds < 10:
        parser.error("--avg-seconds must be at least 10")
    return args


# ----- turning readings into JSON -----

def num(value, digits=1):
    """A finite number rounded for display, or None (JSON has no NaN)."""
    if value is None:
        return None
    value = float(value)
    return round(value, digits) if np.isfinite(value) else None


def wave_payload(waveform, fs, seconds):
    """The last `seconds` of a signal, scaled to 0..1 the same way the desktop graphs are."""
    if waveform is None or not fs or fs <= 0 or len(waveform) < 2:
        return None
    segment = np.asarray(waveform[-int(seconds * fs):], dtype=float)
    segment = segment[np.isfinite(segment)]
    if len(segment) < 2:
        return None
    low, high = np.percentile(segment, [2, 98])          # ignore single spikes when scaling
    normalized = np.clip((segment - low) / (high - low + 1e-9), 0, 1)
    return {"fs": float(fs), "seconds": seconds, "values": np.round(normalized, 3).tolist()}


def average_payload(avg):
    """Same states and wording as the average card in app.py."""
    if avg.done:
        phase, value = "done", avg.result
        footer = f"{len(avg.readings)} readings"
    else:
        if avg.paused:
            phase = "paused"
        elif avg.calibrating:
            phase = "calibrating"
        else:
            phase = "recording"
        value = avg.running_average
        if avg.calibrating and avg.calibration_samples == 0:
            footer = "Waiting for heart rate..."
        elif avg.calibrating:
            footer = (f"Calibrating {core.format_duration(avg.calibrated_sec)} / "
                      f"{core.format_duration(avg.calibration)}")
        elif not avg.readings:
            footer = "Calibrated, recording..."
        else:
            footer = (f"Recording {core.format_duration(avg.recorded_sec)} / "
                      f"{core.format_duration(avg.duration)}")
    return {
        "phase": phase,
        "value": num(value, 0),
        "progress": num(avg.progress, 3),
        "duration": avg.duration,
        "duration_text": core.format_duration(avg.duration),
        "readings": len(avg.readings),
        "footer": footer,
    }


class VitalsEngine:
    """Runs the camera and vitals pipeline from app.py on a background thread.

    The loop is the same as app.main(), except that instead of drawing the
    dashboard into an OpenCV window it keeps the latest camera frame (as JPEG,
    with the measurement regions drawn on) and the latest readings (as a dict)
    for the web server to hand out.
    """

    def __init__(self, args):
        self.args = args
        if args.screen:
            self.source = core.ScreenSource(args.screen)
        else:
            self.source = core.CameraSource(args.camera, args.width, args.height, args.backend)
        self.landmarker = core.create_landmarker()
        self.heart = HeartRateEstimator()                 # used with --hr colour
        self.rppg_hr = core.RppgHeartRate(args.rppg_model) if args.hr == "rppg" else None
        self.breathing = RespirationEstimator(channel_names=("chest", "head"))
        self.blinks = BlinkCounter()
        self.chest = core.ChestMotion()
        self.motion = core.MotionPulseTracker()
        self.average = core.AverageBpmMonitor(args.avg_seconds)

        self.lock = threading.Lock()
        self.new_frame = threading.Condition(self.lock)
        self.jpeg = None
        self.jpeg_id = 0
        self.state = {"ready": False, "error": None}
        self.reset_requested = threading.Event()
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)

    # ----- used by the web server -----

    def start(self):
        self.thread.start()

    def stop(self):
        self.running = False
        self.thread.join(timeout=5.0)

    def request_average_reset(self):
        self.reset_requested.set()                       # handled on the processing thread

    def snapshot(self):
        with self.lock:
            return self.state

    def wait_for_frame(self, last_id, timeout=5.0):
        """Block until a frame newer than last_id exists. Returns (jpeg, id) or (None, last_id)."""
        with self.new_frame:
            self.new_frame.wait_for(lambda: self.jpeg_id != last_id or not self.running, timeout)
            if self.jpeg_id == last_id:
                return None, last_id
            return self.jpeg, self.jpeg_id

    # ----- processing thread -----

    def _run(self):
        try:
            self._loop()
        except Exception as exc:                          # show the problem on the page
            traceback.print_exc()
            self._set_error(f"Processing stopped: {exc}")
        finally:
            self.running = False
            with self.new_frame:
                self.new_frame.notify_all()
            self.source.release()
            if self.rppg_hr is not None:
                self.rppg_hr.close()
            self.landmarker.close()

    def _set_error(self, message):
        with self.lock:
            self.state = {**self.state, "error": message}

    def _loop(self):
        heart, rppg_hr, breathing, blinks = self.heart, self.rppg_hr, self.breathing, self.blinks
        chest, motion, average, source = self.chest, self.motion, self.average, self.source

        t0 = None
        last_timestamp_ms = -1
        last_update = 0.0
        last_face_time = -1e9
        processed_times = deque(maxlen=60)
        bpm = resp_rate = blink_rate = None

        while self.running:
            frame, arrived = source.read()
            if frame is None:
                self._set_error("No frames from the camera. Is another app using it?")
                break
            if t0 is None:
                t0 = arrived
            now = arrived - t0
            processed_times.append(now)

            if self.reset_requested.is_set():
                self.reset_requested.clear()
                average.reset()

            # MediaPipe needs strictly increasing timestamps in milliseconds.
            timestamp_ms = max(int(now * 1000), last_timestamp_ms + 1)
            last_timestamp_ms = timestamp_ms
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = self.landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms)
            if rppg_hr is not None:
                rppg_hr.add_frame(rgb, arrived)      # rgb is never drawn on, so it stays clean

            face_found = bool(result.face_landmarks)
            if face_found:
                if now - last_face_time > core.FACE_LOST_RESET_SEC:
                    heart.reset()
                    breathing.reset()
                    chest.reset()
                    motion.reset()
                last_face_time = now

                h, w = frame.shape[:2]
                points = core.to_pixels(result.face_landmarks[0], w, h)
                polygons = [core.region_polygon(points, core.FOREHEAD, shrink=0.8),
                            core.region_polygon(points, core.LEFT_CHEEK),
                            core.region_polygon(points, core.RIGHT_CHEEK)]
                # Sample colours before drawing anything on the frame.
                if rppg_hr is None:
                    colors = [core.region_mean_rgb(frame, polygon) for polygon in polygons]
                    if all(c is not None for c in colors):
                        heart.add(now, np.concatenate(colors))

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                chest_y = chest.update(gray, points)
                head_y = float(points[:, 1].mean())
                breathing.add(now, [chest_y, head_y])

                ear = (core.eye_aspect_ratio(points, core.LEFT_EYE)
                       + core.eye_aspect_ratio(points, core.RIGHT_EYE)) / 2
                blinks.update(now, ear)

                # Motion tracking runs on the full-resolution frame, so scale the landmarks up.
                full = source.full_frame
                to_full = np.array([full.shape[1] / w, full.shape[0] / h], dtype=np.float32)
                motion.update(now, cv2.cvtColor(full, cv2.COLOR_BGR2GRAY), points * to_full)

                if rppg_hr is None:
                    cv2.polylines(frame, polygons, True, GREEN, 1)
                elif rppg_hr.box is not None:
                    (top, bottom), (left, right) = rppg_hr.box
                    cv2.rectangle(frame, (int(left), int(top)), (int(right), int(bottom)), GREEN, 1)
                if chest.box is not None:
                    x0, y0, x1, y1 = chest.box
                    cv2.rectangle(frame, (x0, y0), (x1, y1), BLUE, 1)
                for region in motion.regions.values():        # back to display size
                    outlines = [(outline / to_full).astype(np.int32) for outline in region.outlines]
                    cv2.polylines(frame, outlines, True, MAGENTA, 1)
                    for x, y in region.points / to_full:
                        cv2.circle(frame, (int(x), int(y)), 1, MAGENTA, -1)

            if now - last_update >= core.UPDATE_EVERY_SEC:
                last_update = now
                if rppg_hr is None:
                    bpm = heart.update()
                resp_rate = breathing.update()
                blink_rate = blinks.rate_per_min(now)
            if rppg_hr is not None:
                bpm = rppg_hr.update(now)            # updates itself once a second

            live_bpm = bpm if face_found else None
            average.update(now, live_bpm)            # pauses while there is no reading

            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            state = self._build_state(now, face_found, live_bpm, resp_rate, blink_rate,
                                      rate_fps=core.rate_from_times(processed_times))
            with self.new_frame:
                if ok:
                    self.jpeg = encoded.tobytes()
                    self.jpeg_id += 1
                self.state = state
                self.new_frame.notify_all()

    def _status(self, face_found, bpm):
        """(text, level) with the same wording as the desktop app. level: bad, idle, warn, ok."""
        rppg_hr, heart = self.rppg_hr, self.heart
        if not face_found:
            return "No face detected", "bad"
        if rppg_hr is not None:
            if bpm is None:
                return "Measuring... hold still", "idle"
            if rppg_hr.sqi is None or rppg_hr.sqi < core.RppgHeartRate.GOOD_SQI:
                return "Weak signal, hold still", "warn"
            return "Signal good", "ok"
        if heart.snr_db is None:
            return "Measuring... hold still", "idle"
        if not heart.signal_ok:
            return "Hold still, good light", "warn"
        return "Signal good", "ok"

    def _build_state(self, now, face_found, bpm, resp_rate, blink_rate, rate_fps):
        rppg_hr = self.rppg_hr
        status_text, status_level = self._status(face_found, bpm)
        tips = []
        if rate_fps < 15:
            tips.append("Processing is below 15 fps, so readings may be off. "
                        "Close other apps or use a smaller camera size.")
        if face_found and self.chest.box is None:
            tips.append("Sit back so your shoulders show. Breathing is measured from the chest.")
        if rppg_hr is not None:
            pulse = wave_payload(rppg_hr.waveform, rppg_hr.fs, PULSE_GRAPH_SEC)
            quality = num(rppg_hr.sqi, 2) if face_found else None
        else:
            pulse = wave_payload(self.heart.waveform, HR_FS, PULSE_GRAPH_SEC)
            quality = None
        return {
            "ready": True,
            "error": None,
            "time": num(now, 2),
            "face_found": face_found,
            "status": {"text": status_text, "level": status_level},
            "heart": {
                "bpm": num(bpm, 0),
                "source": rppg_hr.model_name if rppg_hr is not None else "colour",
                "quality": quality,
                "good_quality": core.RppgHeartRate.GOOD_SQI,
            },
            "average": average_payload(self.average),
            "breathing": {
                "rate": num(resp_rate, 1),
                "channel": self.breathing.channel_name if resp_rate is not None else None,
            },
            "blinks": {"rate": num(blink_rate, 0)},
            "fps": {"camera": num(self.source.fps, 0), "processed": num(rate_fps, 0)},
            "motion_points": {name: len(region.points)
                              for name, region in self.motion.regions.items()},
            "tips": tips,
            "pulse": pulse,
            "breath": wave_payload(self.breathing.waveform, RESP_FS, BREATH_GRAPH_SEC),
        }


# ----- web server -----

def create_server(engine):
    server = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")

    @server.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @server.get("/api/state")
    def state():
        return jsonify(engine.snapshot())

    @server.get("/api/stream")
    def stream():
        """Server-sent events: the latest readings, several times a second."""
        def events():
            while True:
                running = engine.running
                yield f"data: {json.dumps(engine.snapshot())}\n\n"
                if not running:
                    return
                time.sleep(STREAM_EVERY_SEC)
        return Response(events(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @server.get("/video.mjpg")
    def video():
        """The camera picture with the measurement regions drawn on, as an MJPEG stream."""
        def frames():
            last_id = 0
            while True:
                jpeg, last_id = engine.wait_for_frame(last_id)
                if jpeg is None:
                    if not engine.running:
                        return
                    continue
                yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                       + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
        return Response(frames(), mimetype="multipart/x-mixed-replace; boundary=frame",
                        headers={"Cache-Control": "no-cache"})

    @server.post("/api/average/reset")
    def reset_average():
        # A custom header can't be sent by a plain cross-site form, so other
        # websites open in the browser can't trigger this.
        if request.headers.get("X-Cuore") != "1":
            abort(403)
        engine.request_average_reset()
        return jsonify(ok=True)

    return server


def main():
    args = parse_args()
    engine = VitalsEngine(args)
    engine.start()
    server = create_server(engine)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"Warning: serving on {args.host}. Anyone on your network can open the page "
              "and see your camera.")
    print(f"Open http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:"
          f"{args.port} in your browser. Press Ctrl+C to stop.")
    try:
        server.run(host=args.host, port=args.port, threaded=True, debug=False,
                   use_reloader=False)
    finally:
        engine.stop()


if __name__ == "__main__":
    main()
