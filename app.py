"""Live camera-based heart rate and breathing rate.

Usage:
    python app.py                                # default webcam
    python app.py --camera 1                     # another webcam
    python app.py --screen 100 100 640 480       # read a region of the screen (e.g. a Zoom tile)

Press q or Esc to quit.
"""
import argparse
import csv
import os
import sys
import threading
import time
import urllib.request
from collections import deque

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

from vitals import HR_FS, RESP_FS, BlinkCounter, HeartRateEstimator, RespirationEstimator

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
             "face_landmarker/float16/1/face_landmarker.task")
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_landmarker.task")
WINDOW = "Vital Signs Camera"

# MediaPipe Face Mesh landmark indices (478-point model).
FOREHEAD = [10, 338, 297, 332, 151, 9, 103, 67, 109]
LEFT_CHEEK = [117, 118, 101, 36, 205, 187, 123, 116]
RIGHT_CHEEK = [346, 347, 330, 266, 425, 411, 352, 345]
LEFT_EYE = [33, 160, 158, 133, 153, 144]     # p1..p6 for the eye aspect ratio
RIGHT_EYE = [362, 385, 387, 263, 373, 380]
FACE_TOP, CHIN, FACE_LEFT, FACE_RIGHT = 10, 152, 234, 454

UPDATE_EVERY_SEC = 0.5     # how often to recompute the vitals
CAMERA_WARMUP_SEC = 3.0    # let auto exposure settle, then lock it
ROI_SMOOTHING = 0.6        # 0 = no smoothing; higher = steadier skin regions
FACE_LOST_RESET_SEC = 1.0  # a longer gap would corrupt the signals, so start fresh

WHITE, GRAY = (255, 255, 255), (170, 170, 170)
RED, YELLOW, GREEN, BLUE = (80, 80, 255), (0, 220, 255), (0, 255, 0), (255, 160, 60)


def parse_args():
    parser = argparse.ArgumentParser(description="Camera-based heart rate and breathing rate")
    parser.add_argument("--camera", type=int, default=0, help="webcam index")
    parser.add_argument("--screen", type=int, nargs=4, metavar=("LEFT", "TOP", "WIDTH", "HEIGHT"),
                        help="capture a screen region instead of the webcam")
    parser.add_argument("--auto-exposure", action="store_true",
                        help="leave camera auto exposure and white balance on (old behavior)")
    parser.add_argument("--record", metavar="CSV",
                        help="save raw per-frame signals for offline replay (press m to mark)")
    return parser.parse_args()


def create_landmarker():
    if not os.path.exists(MODEL_PATH):
        print("Downloading face landmark model...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    options = vision.FaceLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
    )
    return vision.FaceLandmarker.create_from_options(options)


def rate_from_times(times):
    times = list(times)
    if len(times) < 2:
        return 0.0
    return (len(times) - 1) / (times[-1] - times[0] + 1e-9)


class CameraSource:
    """Reads the webcam on a background thread and timestamps every frame on arrival.

    Without this, frames queue up inside the camera driver while face tracking
    runs. They then get timestamped late and too far apart, which makes the
    pulse look slower than it is.
    """

    def __init__(self, index, lock_after_sec=None):
        self.lock_after_sec = lock_after_sec
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        self.cap = cv2.VideoCapture(index, backend)
        if not self.cap.isOpened():
            self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            raise SystemExit(f"Could not open camera {index}")
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.cap.set(cv2.CAP_PROP_FPS, 30)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.lock = threading.Lock()
        self.frame = None
        self.timestamp = None
        self.frame_id = 0
        self.last_read_id = 0
        self.arrival_times = deque(maxlen=60)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _lock_camera(self):
        """Turn off auto exposure, auto white balance and auto gain.

        Webcams keep adjusting brightness and color. Each adjustment is a step in
        skin color far larger than the pulse, and slow adjustments land inside
        the heart rate band. Values are backend-specific, so the result is printed.
        """
        exposure = self.cap.get(cv2.CAP_PROP_EXPOSURE)
        self.cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)   # 0.25 = manual (DirectShow, V4L2 via OpenCV)
        self.cap.set(cv2.CAP_PROP_EXPOSURE, exposure)    # keep the level auto had settled on
        self.cap.set(cv2.CAP_PROP_AUTO_WB, 0)
        print("Camera locked: auto_exposure=%s exposure=%s auto_wb=%s gain=%s" % (
            self.cap.get(cv2.CAP_PROP_AUTO_EXPOSURE), self.cap.get(cv2.CAP_PROP_EXPOSURE),
            self.cap.get(cv2.CAP_PROP_AUTO_WB), self.cap.get(cv2.CAP_PROP_GAIN)))

    def _run(self):
        start = time.monotonic()
        locked = self.lock_after_sec is None
        while self.running:
            if not locked and time.monotonic() - start >= self.lock_after_sec:
                self._lock_camera()
                locked = True
            ok, frame = self.cap.read()
            now = time.monotonic()
            if not ok:
                time.sleep(0.01)
                continue
            with self.lock:
                self.frame = frame
                self.timestamp = now
                self.frame_id += 1
                self.arrival_times.append(now)

    def read(self, timeout=3.0):
        """Return the newest frame not seen yet, and the time it arrived."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if self.frame is not None and self.frame_id != self.last_read_id:
                    self.last_read_id = self.frame_id
                    return cv2.flip(self.frame, 1), self.timestamp   # mirror view
            time.sleep(0.002)
        return None, None

    @property
    def fps(self):
        with self.lock:
            return rate_from_times(self.arrival_times)

    def release(self):
        self.running = False
        self.thread.join(timeout=1.0)
        self.cap.release()


class ScreenSource:
    def __init__(self, region):
        import mss
        self.sct = mss.mss()
        left, top, width, height = region
        self.region = {"left": left, "top": top, "width": width, "height": height}
        self.arrival_times = deque(maxlen=60)

    def read(self):
        image = np.array(self.sct.grab(self.region))
        now = time.monotonic()
        self.arrival_times.append(now)
        return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR), now

    @property
    def fps(self):
        return rate_from_times(self.arrival_times)

    def release(self):
        self.sct.close()


class ChestMotion:
    """Up-and-down movement of the chest and shoulders, measured with optical flow.

    Breathing moves the chest far more than the head, so this gives a much
    cleaner breathing signal whenever the shoulders are in view.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self.prev_gray = None
        self.position = 0.0
        self.box = None

    def update(self, gray, points):
        h, w = gray.shape
        chin = points[CHIN]
        face_height = np.linalg.norm(points[CHIN] - points[FACE_TOP])
        face_width = np.linalg.norm(points[FACE_RIGHT] - points[FACE_LEFT])
        x0 = int(max(0, chin[0] - face_width))
        x1 = int(min(w, chin[0] + face_width))
        y0 = int(min(h, chin[1] + 0.3 * face_height))
        y1 = int(min(h, chin[1] + 1.2 * face_height))
        self.box = (x0, y0, x1, y1) if (x1 - x0 >= 40 and y1 - y0 >= 30) else None
        if self.box is not None and self.prev_gray is not None:
            before = self.prev_gray[y0:y1, x0:x1]
            after = gray[y0:y1, x0:x1]
            scale = min(1.0, 160.0 / (x1 - x0))          # shrink for speed
            if scale < 1.0:
                before = cv2.resize(before, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                after = cv2.resize(after, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            flow = cv2.calcOpticalFlowFarneback(before, after, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            self.position += float(np.median(flow[..., 1])) / scale   # vertical, in pixels
        self.prev_gray = gray
        return self.position


def to_pixels(landmarks, width, height):
    return np.array([[lm.x * width, lm.y * height] for lm in landmarks], dtype=np.float32)


def region_polygon(points, indices, shrink=1.0):
    """Convex hull of some landmarks, optionally shrunk toward its center to avoid hair and brows."""
    hull = cv2.convexHull(points[indices]).reshape(-1, 2)
    if shrink < 1.0:
        center = hull.mean(axis=0)
        hull = center + (hull - center) * shrink
    return hull.astype(np.int32)


def region_mean_rgb(frame, polygon):
    """Mean R, G, B of the skin inside a polygon, ignoring shine and shadows."""
    h, w = frame.shape[:2]
    polygon = np.clip(polygon, 0, [w - 1, h - 1]).astype(np.int32)
    x, y, bw, bh = cv2.boundingRect(polygon)
    if bw < 2 or bh < 2:
        return None
    crop = frame[y:y + bh, x:x + bw]
    mask = np.zeros(crop.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(mask, polygon - np.array([x, y], dtype=np.int32), 255)
    pixels = crop[mask > 0].astype(np.float32)          # (k, 3) in BGR order
    if len(pixels) < 20:
        return None
    brightness = pixels.mean(axis=1)
    keep = (pixels.max(axis=1) < 245)                   # drop shiny, overexposed pixels (sweat)
    keep &= brightness > max(30.0, np.percentile(brightness, 10))   # drop shadows, brows, hair
    if keep.sum() >= 20:
        pixels = pixels[keep]
    b, g, r = pixels.mean(axis=0)
    return [r, g, b]


def eye_aspect_ratio(points, indices):
    p = points[indices]
    vertical = np.linalg.norm(p[1] - p[5]) + np.linalg.norm(p[2] - p[4])
    horizontal = np.linalg.norm(p[0] - p[3])
    return vertical / (2.0 * horizontal + 1e-6)


def draw_waveform(frame, waveform, fs, seconds, box, color, label):
    x, y, width, height = box
    cv2.rectangle(frame, (x, y), (x + width, y + height), (40, 40, 40), -1)
    cv2.putText(frame, label, (x + 5, y + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, GRAY, 1)
    if waveform is None or len(waveform) < 2:
        return
    segment = waveform[-int(seconds * fs):]
    span = segment.max() - segment.min()
    normalized = (segment - segment.min()) / (span + 1e-9)
    xs = x + np.linspace(0, width, len(segment))
    ys = y + height - normalized * height
    points = np.stack([xs, ys], axis=1).astype(np.int32)
    cv2.polylines(frame, [points], False, color, 2)


def draw_hud(frame, lines):
    panel_height = 20 + 28 * len(lines)
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (400, panel_height), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)
    for i, (text, color) in enumerate(lines):
        cv2.putText(frame, text, (10, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)


def main():
    args = parse_args()
    lock_after = None if args.auto_exposure else CAMERA_WARMUP_SEC
    source = ScreenSource(args.screen) if args.screen else CameraSource(args.camera, lock_after)
    landmarker = create_landmarker()
    heart = HeartRateEstimator()
    breathing = RespirationEstimator(channel_names=("chest", "head"))
    blinks = BlinkCounter()
    chest = ChestMotion()
    smooth_points = None
    recorder = None
    record_file = None
    mark_next = False
    if args.record:
        record_file = open(args.record, "w", newline="")
        recorder = csv.writer(record_file)
        recorder.writerow(["t"] + [f"{c}{r}" for r in range(3) for c in "rgb"]
                          + ["chest", "head", "mark"])

    t0 = None
    last_timestamp_ms = -1
    last_update = 0.0
    last_face_time = -1e9
    processed_times = deque(maxlen=60)
    bpm = resp_rate = blink_rate = None

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    try:
        while True:
            frame, arrived = source.read()
            if frame is None:
                print("No frames from the camera. Is another app using it?")
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
                if now - last_face_time > FACE_LOST_RESET_SEC:
                    heart.reset()
                    breathing.reset()
                    chest.reset()
                    smooth_points = None
                last_face_time = now

                h, w = frame.shape[:2]
                points = to_pixels(result.face_landmarks[0], w, h)
                # Landmarks jitter by a pixel or two every frame, so the skin regions
                # shimmer and pick up different pixels. Smooth them for the regions
                # only; blink detection keeps the raw points.
                if smooth_points is None:
                    smooth_points = points.copy()
                else:
                    smooth_points = ROI_SMOOTHING * smooth_points + (1 - ROI_SMOOTHING) * points
                polygons = [region_polygon(smooth_points, FOREHEAD, shrink=0.8),
                            region_polygon(smooth_points, LEFT_CHEEK),
                            region_polygon(smooth_points, RIGHT_CHEEK)]
                # Sample colors before drawing anything on the frame.
                colors = [region_mean_rgb(frame, polygon) for polygon in polygons]
                if all(c is not None for c in colors):
                    heart.add(now, np.concatenate(colors))

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                chest_y = chest.update(gray, points)
                head_y = float(points[:, 1].mean())
                breathing.add(now, [chest_y, head_y])
                if recorder is not None and all(c is not None for c in colors):
                    recorder.writerow([f"{now:.4f}"] + [f"{v:.4f}" for c in colors for v in c]
                                      + [f"{chest_y:.4f}", f"{head_y:.4f}", int(mark_next)])
                    mark_next = False

                ear = (eye_aspect_ratio(points, LEFT_EYE) + eye_aspect_ratio(points, RIGHT_EYE)) / 2
                blinks.update(now, ear)

                cv2.polylines(frame, polygons, True, GREEN, 1)
                if chest.box is not None:
                    x0, y0, x1, y1 = chest.box
                    cv2.rectangle(frame, (x0, y0), (x1, y1), BLUE, 1)

            if now - last_update >= UPDATE_EVERY_SEC:
                last_update = now
                bpm = heart.update()
                resp_rate = breathing.update()
                blink_rate = blinks.rate_per_min(now)

            if not face_found:
                status = ("No face detected", RED)
            elif heart.snr_db is None:
                status = ("Measuring... hold still", GRAY)
            elif not heart.signal_ok:
                status = ("Hold still, good light", YELLOW)
            else:
                status = ("Signal good", GREEN)

            hr_text = f"{bpm:.0f} BPM" if bpm is not None else "--"
            resp_text = (f"{resp_rate:.1f} /min ({breathing.channel_name})"
                         if resp_rate is not None else "--")
            blink_text = f"{blink_rate:.0f} /min" if blink_rate is not None else "--"
            fps = rate_from_times(processed_times)
            fps_text = f"Camera {source.fps:.0f} fps, processed {fps:.0f} fps"
            lines = [
                (f"Heart rate: {hr_text}", WHITE),
                (f"Breathing:  {resp_text}", WHITE),
                (f"Blinks:     {blink_text}", WHITE),
                status,
                (fps_text + ("  (need 15+)" if fps < 15 else ""), GRAY),
            ]
            if face_found and chest.box is None:
                lines.append(("Tip: sit back so your shoulders show", GRAY))
            draw_hud(frame, lines)

            h, w = frame.shape[:2]
            draw_waveform(frame, heart.waveform, HR_FS, 5, (10, h - 170, w - 20, 70), RED, "pulse")
            draw_waveform(frame, breathing.waveform, RESP_FS, 30, (10, h - 90, w - 20, 80), BLUE,
                          "breathing")
            cv2.imshow(WINDOW, frame)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("m"):
                mark_next = True        # press m the moment you read the smartwatch
    finally:
        if record_file is not None:
            record_file.close()
        source.release()
        landmarker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
