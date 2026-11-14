"""Live camera-based heart rate and breathing rate.

Heart rate comes from the open-rppg library (deep-learning rPPG models) by default.
Breathing and blinks are measured by this app.

Usage:
    python app.py                                # default webcam
    python app.py --rppg-model ME-flow.rlap      # try a different open-rppg model
    python app.py --hr colour                    # use the app's own colour-based heart rate
    python app.py --camera 1                     # another webcam (e.g. Camo)
    python app.py --camera 1 --width 1280 --height 720   # ask for a specific size
    python app.py --camera 1 --backend msmf      # use Windows Media Foundation instead of DirectShow
    python app.py --screen 100 100 640 480       # read a region of the screen (e.g. a Zoom tile)

Press q or Esc to quit.
"""
import argparse
import os
import sys
import threading
import time
import urllib.request
from collections import deque

# Makes Media Foundation cameras on Windows open much faster. Must be set before importing cv2.
os.environ.setdefault("OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS", "0")

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
NOSE_BRIDGE_TOP, NOSE_BRIDGE_BOTTOM = 168, 195
JAW_LEFT, JAW_RIGHT = 172, 397

UPDATE_EVERY_SEC = 0.5     # how often to recompute the vitals
FACE_LOST_RESET_SEC = 1.0  # a longer gap would corrupt the signals, so start fresh

WHITE, GRAY = (255, 255, 255), (170, 170, 170)
RED, YELLOW, GREEN, BLUE = (80, 80, 255), (0, 220, 255), (0, 255, 0), (255, 160, 60)
MAGENTA = (255, 0, 255)


def parse_args():
    parser = argparse.ArgumentParser(description="Camera-based heart rate and breathing rate")
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

    MAX_WIDTH = 960   # bigger frames are shrunk to 640 wide so face tracking stays fast
    BACKENDS = {"dshow": cv2.CAP_DSHOW, "msmf": cv2.CAP_MSMF}

    def __init__(self, index, width=None, height=None, backend="auto"):
        self.lock = threading.Lock()
        self.frame = None
        self.full_frame = None   # latest frame at full resolution, mirrored (for motion tracking)
        self.timestamp = None
        self.frame_id = 0
        self.last_read_id = 0
        self.arrival_times = deque(maxlen=60)
        self.running = True
        self.opened = threading.Event()
        self.open_error = None
        # The camera is opened, read and closed all on the background thread.
        # Windows camera objects can misbehave (black frames, 1 fps) when they
        # are created on one thread and read from another, as with Camo.
        self.thread = threading.Thread(target=self._run, args=(index, width, height, backend),
                                       daemon=True)
        self.thread.start()
        if not self.opened.wait(timeout=20) or self.open_error:
            self.running = False
            raise SystemExit(self.open_error or f"Camera {index} took too long to open")

    def _open(self, index, backend):
        if backend != "auto":
            order = [self.BACKENDS[backend]]
        elif sys.platform == "win32":
            order = [cv2.CAP_DSHOW, cv2.CAP_MSMF]
        else:
            order = [cv2.CAP_ANY]
        for api in order:
            cap = cv2.VideoCapture(index, api)
            if cap.isOpened():
                return cap
            cap.release()
        return None

    def _run(self, index, width, height, backend):
        cap = self._open(index, backend)
        if cap is None:
            self.open_error = f"Could not open camera {index}"
            self.opened.set()
            return
        # Use the camera's own default format unless a size is asked for.
        # Forcing a size some cameras don't support can give black frames.
        if width and height:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        print(f"Opened camera {index} with {cap.getBackendName()}: "
              f"{int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
        self.opened.set()
        while self.running:
            ok, frame = cap.read()
            now = time.monotonic()
            if not ok:
                time.sleep(0.01)
                continue
            with self.lock:
                self.frame = frame
                self.timestamp = now
                self.frame_id += 1
                self.arrival_times.append(now)
        cap.release()

    def read(self, timeout=3.0):
        """Return the newest frame not seen yet, and the time it arrived."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if self.frame is not None and self.frame_id != self.last_read_id:
                    self.last_read_id = self.frame_id
                    frame, timestamp = self.frame.copy(), self.timestamp
                    break
            time.sleep(0.002)
        else:
            return None, None
        frame = cv2.flip(frame, 1)             # mirror view
        self.full_frame = frame                # full resolution, used by MotionPulseTracker
        if frame.shape[1] > self.MAX_WIDTH:
            scale = 640.0 / frame.shape[1]
            frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        return frame, timestamp

    @property
    def fps(self):
        with self.lock:
            return rate_from_times(self.arrival_times)

    def release(self):
        self.running = False                  # the background thread closes the camera
        self.thread.join(timeout=2.0)


class ScreenSource:
    def __init__(self, region):
        import mss
        self.sct = mss.mss()
        left, top, width, height = region
        self.region = {"left": left, "top": top, "width": width, "height": height}
        self.arrival_times = deque(maxlen=60)
        self.full_frame = None

    def read(self):
        image = np.array(self.sct.grab(self.region))
        now = time.monotonic()
        self.arrival_times.append(now)
        self.full_frame = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
        return self.full_frame, now

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
            self.position += self._vertical_movement(after, flow[..., 1]) / scale   # in pixels
        self.prev_gray = gray
        return self.position

    @staticmethod
    def _vertical_movement(image, dy):
        """Typical up/down movement in the box, using only pixels where it can be seen.

        Up/down movement is only visible where brightness changes from top to
        bottom: the shoulder line, collar and shirt folds. Plain fabric and
        still background report almost zero and used to drown out the
        breathing, so only the 30% of pixels with the strongest vertical edges
        are used. The top and bottom 10% of those are dropped as outliers.
        """
        edges = np.abs(cv2.Sobel(image, cv2.CV_32F, 0, 1, ksize=3))
        values = dy[edges >= np.percentile(edges, 70)]
        if values.size < 20:
            return float(np.median(dy))
        low, high = np.percentile(values, [10, 90])
        values = values[(values >= low) & (values <= high)]
        return float(values.mean())


class _MotionRegion:
    """Tracked points and their movement history for one region (head or neck)."""

    def __init__(self):
        self.points = np.empty((0, 2), dtype=np.float32)   # current position of each point
        self.ids = []                                       # one id per point
        self.history = {}                                   # id -> (times, x, y) deques
        self.last_detect = -1e9
        self.outlines = []                                  # polygons for drawing

    def clear(self):
        self.__init__()

    def keep(self, keep_mask, new_points, t):
        """Keep the points flagged True at their new positions, drop the rest."""
        kept_ids = []
        for point_id, keep, (x, y) in zip(self.ids, keep_mask, new_points):
            if keep:
                times, xs, ys = self.history[point_id]
                times.append(t)
                xs.append(float(x))
                ys.append(float(y))
                kept_ids.append(point_id)
            else:
                del self.history[point_id]                  # a lost point ends its trajectory
        self.ids = kept_ids
        self.points = new_points[keep_mask].astype(np.float32).reshape(-1, 2)


class MotionPulseTracker:
    """Follows tiny skin movements on the head and neck, for a motion-based heart rate.

    Each heartbeat makes the head bob very slightly (ballistocardiography,
    Balakrishnan et al., CVPR 2013) and makes the carotid artery move the
    skin on the side of the neck. This class only records how individual
    skin points move; turning that into a heart rate happens in vitals.py.

    Face landmarks are used only to decide WHERE to look (the regions).
    The movement itself comes from optical flow on the full-resolution
    image, never from the landmarks, because landmarks jitter by more than
    the pulse moves.

    - Head region: forehead plus the bridge of the nose. Eyes, mouth and jaw
      are left out because blinking and talking move them.
    - Neck region: a box below the chin, about as wide as the jaw, from 0.1
      to 0.5 face-heights below the chin. Skipped if it's out of the picture.
    """

    HISTORY_SEC = 12.0      # keep 12 s of movement per point (the estimator uses 10 s)
    MAX_POINTS = 80         # per region
    MIN_POINTS = 20         # re-detect sooner if fewer remain
    REDETECT_SEC = 3.0      # top up with new points every 3 s
    FB_MAX_ERROR = 0.5      # pixels; forward-backward check, see _track
    OUTLIER_PX = 1.5        # pixels; a point moving this much differently from the rest is dropped
    LK_PARAMS = dict(winSize=(21, 21), maxLevel=3,
                     criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))

    def __init__(self):
        self.regions = {"head": _MotionRegion(), "neck": _MotionRegion()}
        self.prev_gray = None
        self.next_id = 0

    def reset(self):
        for region in self.regions.values():
            region.clear()
        self.prev_gray = None

    def update(self, t, gray, points):
        """gray: full-resolution greyscale frame. points: face landmarks in that frame's pixels."""
        masks = {"head": self._head_mask(gray.shape, points),
                 "neck": self._neck_mask(gray.shape, points)}
        for name, region in self.regions.items():
            mask, outlines = masks[name]
            if mask is None:
                region.clear()                           # region not visible
                continue
            region.outlines = outlines
            if self.prev_gray is not None and len(region.points):
                self._track(region, gray, mask, t)
            if len(region.points) < self.MIN_POINTS or t - region.last_detect >= self.REDETECT_SEC:
                self._detect(region, gray, mask, t)
            self._trim(region, t)
        self.prev_gray = gray

    def trajectories(self, name):
        """Movement history of every point in a region: list of (times, x, y) arrays."""
        return [(np.array(times), np.array(xs), np.array(ys))
                for times, xs, ys in self.regions[name].history.values()]

    # ----- regions -----

    @staticmethod
    def _hull(points):
        return cv2.convexHull(points.astype(np.float32)).reshape(-1, 2).astype(np.int32)

    def _head_mask(self, shape, points):
        h, w = shape
        face_width = np.linalg.norm(points[FACE_RIGHT] - points[FACE_LEFT])
        forehead = points[FOREHEAD]
        center = forehead.mean(axis=0)
        forehead = self._hull(center + (forehead - center) * 0.8)      # keep clear of hair and brows
        top, bottom = points[NOSE_BRIDGE_TOP], points[NOSE_BRIDGE_BOTTOM]
        along = bottom - top
        length = np.linalg.norm(along)
        if length < 1:
            return None, []
        side = np.array([-along[1], along[0]]) / length * 0.06 * face_width
        bridge = np.array([top - side, top + side, bottom + side, bottom - side]).astype(np.int32)
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillConvexPoly(mask, forehead, 255)
        cv2.fillConvexPoly(mask, bridge, 255)
        for eye in (LEFT_EYE, RIGHT_EYE):                               # cut out the eyes
            eye_points = points[eye]
            eye_center = eye_points.mean(axis=0)
            cv2.fillConvexPoly(mask, self._hull(eye_center + (eye_points - eye_center) * 1.6), 0)
        if cv2.countNonZero(mask) < 200:
            return None, []
        return mask, [forehead, bridge]

    def _neck_mask(self, shape, points):
        h, w = shape
        chin = points[CHIN]
        face_height = np.linalg.norm(points[CHIN] - points[FACE_TOP])
        jaw_width = np.linalg.norm(points[JAW_RIGHT] - points[JAW_LEFT])
        x0 = int(max(0, chin[0] - jaw_width / 2))
        x1 = int(min(w, chin[0] + jaw_width / 2))
        y0 = int(max(0, chin[1] + 0.1 * face_height))
        y1 = int(min(h, chin[1] + 0.5 * face_height))
        if x1 - x0 < 30 or y1 - y0 < 20:
            return None, []
        mask = np.zeros((h, w), dtype=np.uint8)
        mask[y0:y1, x0:x1] = 255
        box = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.int32)
        return mask, [box]

    # ----- tracking -----

    def _track(self, region, gray, mask, t):
        """Follow every point from the previous frame to this one with Lucas-Kanade optical flow.

        Each point is tracked forwards, then the result is tracked backwards.
        If it doesn't land within half a pixel of where it started, the
        tracking was unreliable and the point is dropped. Points that fail,
        jump differently from the rest, or leave the region are also dropped.
        """
        h, w = gray.shape
        p0 = region.points.reshape(-1, 1, 2)
        p1, status, _ = cv2.calcOpticalFlowPyrLK(self.prev_gray, gray, p0, None, **self.LK_PARAMS)
        p0_back, status_back, _ = cv2.calcOpticalFlowPyrLK(gray, self.prev_gray, p1, None,
                                                           **self.LK_PARAMS)
        p1 = p1.reshape(-1, 2)
        forward_backward = np.linalg.norm(p0.reshape(-1, 2) - p0_back.reshape(-1, 2), axis=1)
        keep = (status.ravel() == 1) & (status_back.ravel() == 1)
        keep &= forward_backward < self.FB_MAX_ERROR
        moves = p1 - region.points
        if keep.sum() >= 3:
            typical = np.median(moves[keep], axis=0)
            keep &= np.linalg.norm(moves - typical, axis=1) < self.OUTLIER_PX
        xi = np.round(p1[:, 0]).astype(int)
        yi = np.round(p1[:, 1]).astype(int)
        inside = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
        keep &= inside
        near_region = cv2.dilate(mask, np.ones((15, 15), np.uint8))   # allow a little drift
        keep[inside] &= near_region[yi[inside], xi[inside]] > 0
        region.keep(keep, p1, t)

    def _detect(self, region, gray, mask, t):
        """Add new trackable points (corners in the skin texture) without disturbing existing ones."""
        region.last_detect = t
        wanted = self.MAX_POINTS - len(region.points)
        if wanted <= 0:
            return
        detect_mask = mask.copy()
        for x, y in region.points:                                     # keep new points apart
            cv2.circle(detect_mask, (int(x), int(y)), 6, 0, -1)
        found = cv2.goodFeaturesToTrack(gray, maxCorners=wanted, qualityLevel=0.01,
                                        minDistance=6, mask=detect_mask, blockSize=7)
        if found is None:
            return
        found = cv2.cornerSubPix(gray, found.astype(np.float32), (5, 5), (-1, -1),
                                 (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
        for x, y in found.reshape(-1, 2):
            region.ids.append(self.next_id)
            region.history[self.next_id] = (deque([t]), deque([float(x)]), deque([float(y)]))
            self.next_id += 1
        region.points = np.vstack([region.points, found.reshape(-1, 2)]).astype(np.float32)

    def _trim(self, region, t):
        for times, xs, ys in region.history.values():
            while times and t - times[0] > self.HISTORY_SEC:
                times.popleft()
                xs.popleft()
                ys.popleft()


class RppgHeartRate:
    """Heart rate from the open-rppg library.

    The app keeps its own camera. Each frame is handed to the library with
    Model.update_frame(); the library finds the face itself, runs its neural
    network on a background thread, and Model.hr() reads the heart rate from
    the pulse signal collected so far.
    """

    WINDOW_SEC = 10       # heart rate from the last 10 seconds of pulse signal
    WAVE_SEC = 6          # pulse wave shown on screen
    UPDATE_EVERY_SEC = 1.0
    GOOD_SQI = 0.5        # the library's signal quality index, 0 (noise) to 1 (clean)

    def __init__(self, model_name):
        import rppg                              # only needed in this mode
        if model_name not in rppg.main.supported_models:
            raise SystemExit(f"Unknown open-rppg model '{model_name}'. Choose one of: "
                             + ", ".join(rppg.main.supported_models))
        print(f"Loading open-rppg model {model_name}...")
        self.model_name = model_name
        self.model = rppg.Model(model_name)
        self.model.__enter__()                   # starts the library's processing thread
        self.bpm = None
        self.sqi = None
        self.waveform = None
        self.last_update = -1e9

    @property
    def fs(self):
        return float(self.model.fps)

    @property
    def box(self):
        """Face box the library is using: ((top, bottom), (left, right)) or None."""
        return self.model.box

    def add_frame(self, rgb, t):
        """rgb: a frame in RGB order that is not changed afterwards. t: time in seconds."""
        self.model.update_frame(rgb, t)

    def update(self, now):
        if now - self.last_update < self.UPDATE_EVERY_SEC:
            return self.bpm
        self.last_update = now
        try:
            result = self.model.hr(start=-self.WINDOW_SEC, return_hrv=False)
            wave, _ = self.model.bvp(start=-self.WAVE_SEC)
        except Exception:
            return self.bpm                      # not enough signal yet
        if result and result.get("hr") is not None:
            self.bpm = float(result["hr"])
            self.sqi = float(result["SQI"]) if result.get("SQI") is not None else None
        else:
            self.bpm = self.sqi = None
        self.waveform = np.asarray(wave, dtype=float) if len(wave) else None
        return self.bpm

    def close(self):
        self.model.__exit__(None, None, None)


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
    if args.screen:
        source = ScreenSource(args.screen)
    else:
        source = CameraSource(args.camera, args.width, args.height, args.backend)
    landmarker = create_landmarker()
    heart = HeartRateEstimator()                 # used with --hr colour
    rppg_hr = RppgHeartRate(args.rppg_model) if args.hr == "rppg" else None
    breathing = RespirationEstimator(channel_names=("chest", "head"))
    blinks = BlinkCounter()
    chest = ChestMotion()
    motion = MotionPulseTracker()                # head and neck movement (experimental)

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
            if rppg_hr is not None:
                rppg_hr.add_frame(rgb, arrived)      # rgb is never drawn on, so it stays clean

            face_found = bool(result.face_landmarks)
            if face_found:
                if now - last_face_time > FACE_LOST_RESET_SEC:
                    heart.reset()
                    breathing.reset()
                    chest.reset()
                    motion.reset()
                last_face_time = now

                h, w = frame.shape[:2]
                points = to_pixels(result.face_landmarks[0], w, h)
                polygons = [region_polygon(points, FOREHEAD, shrink=0.8),
                            region_polygon(points, LEFT_CHEEK),
                            region_polygon(points, RIGHT_CHEEK)]
                # Sample colors before drawing anything on the frame.
                if rppg_hr is None:
                    colors = [region_mean_rgb(frame, polygon) for polygon in polygons]
                    if all(c is not None for c in colors):
                        heart.add(now, np.concatenate(colors))

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                chest_y = chest.update(gray, points)
                head_y = float(points[:, 1].mean())
                breathing.add(now, [chest_y, head_y])

                ear = (eye_aspect_ratio(points, LEFT_EYE) + eye_aspect_ratio(points, RIGHT_EYE)) / 2
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

            if now - last_update >= UPDATE_EVERY_SEC:
                last_update = now
                if rppg_hr is None:
                    bpm = heart.update()
                resp_rate = breathing.update()
                blink_rate = blinks.rate_per_min(now)
            if rppg_hr is not None:
                bpm = rppg_hr.update(now)            # updates itself once a second

            if not face_found:
                status = ("No face detected", RED)
            elif rppg_hr is not None:
                if bpm is None:
                    status = ("Measuring... hold still", GRAY)
                elif rppg_hr.sqi is None or rppg_hr.sqi < RppgHeartRate.GOOD_SQI:
                    quality = f" (quality {rppg_hr.sqi:.2f})" if rppg_hr.sqi is not None else ""
                    status = ("Weak signal, hold still" + quality, YELLOW)
                else:
                    status = (f"Signal good (quality {rppg_hr.sqi:.2f})", GREEN)
            elif heart.snr_db is None:
                status = ("Measuring... hold still", GRAY)
            elif not heart.signal_ok:
                status = ("Hold still, good light", YELLOW)
            else:
                status = ("Signal good", GREEN)

            hr_source = rppg_hr.model_name if rppg_hr is not None else "colour"
            hr_text = (f"{bpm:.0f} BPM ({hr_source})"
                       if bpm is not None and face_found else "--")
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
            if face_found:
                head_n = len(motion.regions["head"].points)
                neck_n = len(motion.regions["neck"].points)
                lines.append((f"Motion points: head {head_n}, neck {neck_n}", GRAY))
            draw_hud(frame, lines)

            h, w = frame.shape[:2]
            if rppg_hr is not None:
                pulse_wave, pulse_fs = rppg_hr.waveform, rppg_hr.fs
            else:
                pulse_wave, pulse_fs = heart.waveform, HR_FS
            draw_waveform(frame, pulse_wave, pulse_fs, 5, (10, h - 170, w - 20, 70), RED, "pulse")
            draw_waveform(frame, breathing.waveform, RESP_FS, 30, (10, h - 90, w - 20, 80), BLUE,
                          "breathing")
            cv2.imshow(WINDOW, frame)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
    finally:
        source.release()
        if rppg_hr is not None:
            rppg_hr.close()
        landmarker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
