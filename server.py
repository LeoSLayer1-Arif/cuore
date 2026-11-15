"""Cuore web server.

Serves the website and streams the live measurements from the Python
pipeline (camera, face tracking, heart rate, breathing, blinks) to it.

    python server.py                 # then open http://127.0.0.1:8000
    python server.py --camera 1 --avg-seconds 60

The camera only opens when the user clicks "Start Calibrating" on the site
and is released again on Stop.

Endpoints:
    POST /api/start    open the camera and begin calibration
    POST /api/stop     release the camera
    POST /api/reset    restart calibration and the average
    GET  /api/state    one JSON snapshot
    GET  /api/stream   Server-Sent Events, a JSON snapshot about 5 times a second
    GET  /video        MJPEG camera preview with the skin regions outlined
"""
import argparse
import asyncio
import json
import os
import threading
from collections import deque

import cv2
import mediapipe as mp
import numpy as np
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import app as pipeline
from vitals import HR_FS, BlinkCounter, HeartRateEstimator, RespirationEstimator

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
OUTLINE = (255, 170, 120)      # soft blue (BGR) for the skin regions on the preview
WAVE_POINTS = 150              # samples sent per waveform


def downsample(wave, fs, seconds, points=WAVE_POINTS):
    """Last `seconds` of a waveform, normalised to -1..1 and thinned to `points` samples."""
    if wave is None or len(wave) < 8:
        return []
    wave = np.asarray(wave, dtype=float)[-int(seconds * fs):]
    wave = wave - wave.mean()
    peak = np.abs(wave).max()
    if peak < 1e-9:
        return []
    idx = np.linspace(0, len(wave) - 1, min(points, len(wave))).astype(int)
    return [round(float(v), 3) for v in wave[idx] / peak]


class Monitor:
    """Runs the measurement loop on a background thread and keeps the latest results."""

    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.thread = None
        self.stop_event = threading.Event()
        self.reset_event = threading.Event()
        self.jpeg = None
        self.state = self._idle_state("idle")

    def _idle_state(self, phase, error=None):
        return {"phase": phase, "error": error, "face": False, "bpm": None, "quality": None,
                "signal": "none", "elapsed": 0.0, "breathing": None, "blinks": None,
                "calibration": {"done_sec": 0, "total_sec": pipeline.AverageBpmMonitor.CALIBRATION_SEC},
                "measure": {"done_sec": 0, "total_sec": self.args.avg_seconds, "paused": False},
                "average": None, "running_average": None, "pulse": [], "breath": [], "fps": 0}

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    @property
    def running(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self):
        if self.running:
            return
        self.stop_event.clear()
        self.reset_event.clear()
        with self.lock:
            self.jpeg = None
            self.state = self._idle_state("starting")
        self.thread = threading.Thread(target=self._run_guarded, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=5.0)
        with self.lock:
            self.jpeg = None
            self.state = self._idle_state("idle")

    def reset(self):
        self.reset_event.set()

    def _run_guarded(self):
        try:
            self._run()
        except BaseException as exc:          # SystemExit from CameraSource is expected here
            message = str(exc) or exc.__class__.__name__
            with self.lock:
                self.state = self._idle_state("error", message)

    def _run(self):
        args = self.args
        if args.screen:
            source = pipeline.ScreenSource(args.screen)
        else:
            source = pipeline.CameraSource(args.camera, args.width, args.height, args.backend)
        landmarker = pipeline.create_landmarker()
        heart = HeartRateEstimator()
        rppg_hr = pipeline.RppgHeartRate(args.rppg_model) if args.hr == "rppg" else None
        breathing = RespirationEstimator(channel_names=("chest", "head"))
        blinks = BlinkCounter()
        chest = pipeline.ChestMotion()
        average = pipeline.AverageBpmMonitor(args.avg_seconds)

        t0 = None
        last_ts_ms = -1
        last_update = 0.0
        last_face_time = -1e9
        times = deque(maxlen=60)
        last_publish = 0.0
        bpm = resp_rate = blink_rate = None
        try:
            while not self.stop_event.is_set():
                if self.reset_event.is_set():
                    self.reset_event.clear()
                    average.reset()
                frame, arrived = source.read()
                if frame is None:
                    raise RuntimeError("No frames from the camera. Is another app using it?")
                if t0 is None:
                    t0 = arrived
                now = arrived - t0
                times.append(now)

                ts_ms = max(int(now * 1000), last_ts_ms + 1)
                last_ts_ms = ts_ms
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = landmarker.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms)
                if rppg_hr is not None:
                    rppg_hr.add_frame(rgb, arrived)

                face_found = bool(result.face_landmarks)
                if face_found:
                    if now - last_face_time > pipeline.FACE_LOST_RESET_SEC:
                        heart.reset()
                        breathing.reset()
                        chest.reset()
                    last_face_time = now
                    h, w = frame.shape[:2]
                    points = pipeline.to_pixels(result.face_landmarks[0], w, h)
                    polygons = [pipeline.region_polygon(points, pipeline.FOREHEAD, shrink=0.8),
                                pipeline.region_polygon(points, pipeline.LEFT_CHEEK),
                                pipeline.region_polygon(points, pipeline.RIGHT_CHEEK)]
                    if rppg_hr is None:
                        colors = [pipeline.region_mean_rgb(frame, p) for p in polygons]
                        if all(c is not None for c in colors):
                            heart.add(now, np.concatenate(colors))
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    chest_y = chest.update(gray, points)
                    breathing.add(now, [chest_y, float(points[:, 1].mean())])
                    ear = (pipeline.eye_aspect_ratio(points, pipeline.LEFT_EYE)
                           + pipeline.eye_aspect_ratio(points, pipeline.RIGHT_EYE)) / 2
                    blinks.update(now, ear)
                    cv2.polylines(frame, polygons, True, OUTLINE, 2, cv2.LINE_AA)

                if now - last_update >= pipeline.UPDATE_EVERY_SEC:
                    last_update = now
                    if rppg_hr is None:
                        bpm = heart.update()
                    resp_rate = breathing.update()
                    blink_rate = blinks.rate_per_min(now)
                if rppg_hr is not None:
                    bpm = rppg_hr.update(now)

                live_bpm = bpm if face_found else None
                average.update(now, live_bpm)

                if rppg_hr is not None:
                    quality = rppg_hr.sqi
                    good = quality is not None and quality >= pipeline.RppgHeartRate.GOOD_SQI
                    wave, wave_fs = rppg_hr.waveform, rppg_hr.fs
                else:
                    quality = heart.snr_db
                    good = heart.signal_ok
                    wave, wave_fs = heart.waveform, HR_FS
                if not face_found:
                    signal = "no_face"
                elif live_bpm is None:
                    signal = "measuring"
                else:
                    signal = "good" if good else "weak"

                if average.done:
                    phase = "done"
                elif average.calibrating:
                    phase = "calibrating"
                else:
                    phase = "measuring"

                ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if now - last_publish >= 0.1 or average.done:
                    last_publish = now
                    state = {
                        "phase": phase, "error": None, "face": face_found,
                        "bpm": round(live_bpm) if live_bpm is not None else None,
                        "quality": round(float(quality), 2) if quality is not None else None,
                        "signal": signal, "elapsed": round(now, 1),
                        "breathing": round(resp_rate, 1) if resp_rate is not None else None,
                        "blinks": round(blink_rate) if blink_rate is not None else None,
                        "calibration": {"done_sec": min(average.calibrated_sec, average.calibration),
                                        "total_sec": average.calibration},
                        "measure": {"done_sec": average.recorded_sec, "total_sec": average.duration,
                                    "paused": average.paused},
                        "average": round(average.result) if average.done else None,
                        "running_average": (round(average.running_average)
                                            if average.running_average is not None else None),
                        "pulse": downsample(wave, wave_fs, 6),
                        "breath": downsample(breathing.waveform, 10.0, 30),
                        "fps": round(pipeline.rate_from_times(times)),
                    }
                    with self.lock:
                        self.state = state
                        if ok:
                            self.jpeg = buf.tobytes()
        finally:
            source.release()
            if rppg_hr is not None:
                rppg_hr.close()
            landmarker.close()


def parse_args():
    p = argparse.ArgumentParser(description="Cuore web server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--camera", type=int, default=0, help="webcam index")
    p.add_argument("--width", type=int)
    p.add_argument("--height", type=int)
    p.add_argument("--backend", choices=["auto", "dshow", "msmf"], default="auto")
    p.add_argument("--screen", type=int, nargs=4, metavar=("LEFT", "TOP", "WIDTH", "HEIGHT"))
    p.add_argument("--hr", choices=["rppg", "colour"], default="rppg")
    p.add_argument("--rppg-model", default="FacePhys.rlap")
    p.add_argument("--avg-seconds", type=float, default=60)
    args = p.parse_args()
    if args.avg_seconds < 10:
        p.error("--avg-seconds must be at least 10")
    return args


def create_app(args):
    monitor = Monitor(args)
    api = FastAPI(title="Cuore")

    @api.post("/api/start")
    def start():
        monitor.start()
        return {"ok": True}

    @api.post("/api/stop")
    def stop():
        monitor.stop()
        return {"ok": True}

    @api.post("/api/reset")
    def reset():
        monitor.reset()
        return {"ok": True}

    @api.get("/api/state")
    def state():
        return monitor.snapshot()

    @api.get("/api/stream")
    async def stream():
        async def events():
            while True:
                yield f"data: {json.dumps(monitor.snapshot())}\n\n"
                await asyncio.sleep(0.2)
        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    @api.get("/video")
    async def video():
        async def frames():
            last = None
            while True:
                with monitor.lock:
                    jpeg = monitor.jpeg
                if jpeg is not None and jpeg is not last:
                    last = jpeg
                    yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                           + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                await asyncio.sleep(0.04)
        return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                                 headers={"Cache-Control": "no-store"})

    @api.get("/")
    def index():
        return FileResponse(os.path.join(WEB_DIR, "index.html"))

    api.mount("/static", StaticFiles(directory=os.path.join(WEB_DIR, "static")), name="static")
    return api


if __name__ == "__main__":
    cli = parse_args()
    uvicorn.run(create_app(cli), host=cli.host, port=cli.port, log_level="warning")
