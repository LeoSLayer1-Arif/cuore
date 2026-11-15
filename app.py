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
    python app.py --avg-seconds 90               # average heart rate over 90 s instead of 120 s

Press q or Esc to quit. Press r to restart the average heart rate recording.
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

# Dashboard look (BGR). The UI is drawn on a copy of the frame scaled to DISPLAY_WIDTH,
# so text and graphs stay sharp and the layout is the same for every camera size.
DISPLAY_WIDTH = 1024
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_NUM = cv2.FONT_HERSHEY_DUPLEX
PANEL_BG = (30, 26, 24)
PANEL_BORDER = (78, 70, 66)
GRID = (70, 64, 60)
TEXT = (235, 235, 235)
TEXT_DIM = (165, 160, 155)
TEXT_FAINT = (120, 115, 110)
PULSE_COLOR = (110, 90, 255)      # coral
AVG_COLOR = (191, 212, 45)        # teal
BREATH_COLOR = (250, 165, 96)     # sky blue


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
    parser.add_argument("--avg-seconds", type=float, default=120,
                        help="how many seconds of heart rate readings the average uses (default 120)")
    args = parser.parse_args()
    if args.avg_seconds < 10:
        parser.error("--avg-seconds must be at least 10")
    return args


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
    GOOD_SQI = 0.22       # the library's signal quality index, 0 (noise) to 1 (clean); good only when SQI > 0.22

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


class AverageBpmMonitor:
    """Records the live heart rate for a fixed period and reports the average.

    One reading is taken per second while a heart rate is shown. When there
    is no reading (no face, or still measuring) the recording pauses instead
    of counting the gap, so the result always covers `duration` seconds of
    real readings. Once complete, the final average is kept until reset().
    """

    SAMPLE_EVERY_SEC = 1.0

    def __init__(self, duration_sec):
        self.duration = float(duration_sec)
        self.reset()

    def reset(self):
        self.readings = []
        self.last_sample = -1e9
        self.paused = False
        self.result = None

    @property
    def done(self):
        return self.result is not None

    @property
    def recorded_sec(self):
        return len(self.readings) * self.SAMPLE_EVERY_SEC

    @property
    def progress(self):
        return min(1.0, self.recorded_sec / self.duration)

    @property
    def running_average(self):
        return float(np.mean(self.readings)) if self.readings else None

    def update(self, now, bpm):
        """now: time in seconds. bpm: the live heart rate, or None when there isn't one."""
        if self.done:
            return
        self.paused = bpm is None
        if bpm is None or now - self.last_sample < self.SAMPLE_EVERY_SEC:
            return
        self.last_sample = now
        self.readings.append(float(bpm))
        if self.recorded_sec >= self.duration:
            self.result = self.running_average


# ----- dashboard drawing -----

def put_text(img, text, org, scale, color, thickness=1, font=FONT):
    cv2.putText(img, text, (int(org[0]), int(org[1])), font, scale, color, thickness, cv2.LINE_AA)


def text_width(text, scale, thickness=1, font=FONT):
    return cv2.getTextSize(text, font, scale, thickness)[0][0]


def rounded_rect(img, x0, y0, x1, y1, radius, color, thickness=-1):
    """Rectangle with rounded corners. thickness=-1 fills it."""
    r = int(max(0, min(radius, (x1 - x0) // 2, (y1 - y0) // 2)))
    if thickness < 0:
        cv2.rectangle(img, (x0 + r, y0), (x1 - r, y1), color, -1)
        cv2.rectangle(img, (x0, y0 + r), (x1, y1 - r), color, -1)
        for cx, cy in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
            cv2.circle(img, (cx, cy), r, color, -1, cv2.LINE_AA)
        return
    line = dict(color=color, thickness=thickness, lineType=cv2.LINE_AA)
    cv2.line(img, (x0 + r, y0), (x1 - r, y0), **line)
    cv2.line(img, (x0 + r, y1), (x1 - r, y1), **line)
    cv2.line(img, (x0, y0 + r), (x0, y1 - r), **line)
    cv2.line(img, (x1, y0 + r), (x1, y1 - r), **line)
    for center, angle in (((x0 + r, y0 + r), 180), ((x1 - r, y0 + r), 270),
                          ((x1 - r, y1 - r), 0), ((x0 + r, y1 - r), 90)):
        cv2.ellipse(img, center, (r, r), angle, 0, 90, **line)


def blend(img, box, alpha, draw):
    """Run draw(overlay, (left, top)) on a copy of a region, then mix it back in with alpha."""
    x, y, w, h = box
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(img.shape[1], int(x + w)), min(img.shape[0], int(y + h))
    if x1 <= x0 or y1 <= y0:
        return
    roi = img[y0:y1, x0:x1]
    overlay = roi.copy()
    draw(overlay, (x0, y0))
    cv2.addWeighted(overlay, alpha, roi, 1 - alpha, 0, dst=roi)


def draw_panel(img, box, radius=14, alpha=0.78):
    """Semi-transparent dark card with a thin border."""
    x, y, w, h = box
    blend(img, box, alpha,
          lambda ov, o: rounded_rect(ov, x - o[0], y - o[1], x + w - 1 - o[0], y + h - 1 - o[1],
                                     radius, PANEL_BG))
    rounded_rect(img, x, y, x + w - 1, y + h - 1, radius, PANEL_BORDER, 1)


def dashed_line(img, p0, p1, color, dash=4, gap=5):
    p0, p1 = np.array(p0, dtype=float), np.array(p1, dtype=float)
    length = np.linalg.norm(p1 - p0)
    if length < 1:
        return
    direction = (p1 - p0) / length
    for start in np.arange(0, length, dash + gap):
        a = p0 + direction * start
        b = p0 + direction * min(start + dash, length)
        cv2.line(img, tuple(np.round(a).astype(int)), tuple(np.round(b).astype(int)),
                 color, 1, cv2.LINE_AA)


def format_duration(seconds):
    seconds = int(round(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def draw_graph(img, waveform, fs, seconds, box, color, title, value_text=None):
    """Card with a scrolling signal: title, live value, grid, time axis, glow line and area fill."""
    x, y, w, h = box
    draw_panel(img, box)
    put_text(img, title, (x + 16, y + 26), 0.5, TEXT_DIM, 1)
    if value_text:
        put_text(img, value_text, (x + w - 16 - text_width(value_text, 0.6, 1, FONT_NUM), y + 27),
                 0.6, color, 1, FONT_NUM)

    left, top, right, bottom = x + 16, y + 42, x + w - 16, y + h - 30
    plot_w, plot_h = right - left, bottom - top

    # Grid: dashed horizontal lines, one vertical line per time tick, labelled underneath.
    for i in range(1, 4):
        gy = top + plot_h * i / 4
        dashed_line(img, (left, gy), (right, gy), GRID)
    step = 1 if seconds <= 10 else 5
    for s in range(0, int(seconds) + 1, step):
        gx = right - plot_w * s / seconds
        if s:
            dashed_line(img, (gx, top), (gx, bottom), GRID)
        label = "now" if s == 0 else f"-{s}s"
        lw = text_width(label, 0.38)
        lx = min(max(gx - lw / 2, left), right - lw)
        put_text(img, label, (lx, bottom + 18), 0.38, TEXT_FAINT)
    cv2.line(img, (left, bottom), (right, bottom), PANEL_BORDER, 1, cv2.LINE_AA)

    if waveform is None or len(waveform) < 2:
        msg = "waiting for signal..."
        put_text(img, msg, (left + (plot_w - text_width(msg, 0.45)) / 2, top + plot_h / 2 + 5),
                 0.45, TEXT_FAINT)
        return

    segment = np.asarray(waveform[-int(seconds * fs):], dtype=float)
    n = len(segment)
    # Newest sample sits on the right edge; a short history only fills part of the width.
    xs = right - (n - 1 - np.arange(n)) / fs / seconds * plot_w
    low, high = np.percentile(segment, [2, 98])           # ignore single spikes when scaling
    normalized = np.clip((segment - low) / (high - low + 1e-9), 0, 1)
    pad = 0.12 * plot_h
    ys = bottom - pad - normalized * (plot_h - 2 * pad)

    SHIFT = 3                                             # sub-pixel drawing for a smooth line
    points = np.round(np.stack([xs, ys], axis=1) * (1 << SHIFT)).astype(np.int32)
    base = [[points[-1, 0], bottom << SHIFT], [points[0, 0], bottom << SHIFT]]
    area = np.vstack([points, np.array(base, dtype=np.int32)])

    def glow_and_fill(ov, o):
        offset = np.array(o, dtype=np.int32) * (1 << SHIFT)
        cv2.fillPoly(ov, [area - offset], color, cv2.LINE_AA, SHIFT)
        cv2.polylines(ov, [points - offset], False, color, 7, cv2.LINE_AA, SHIFT)

    blend(img, (left, top, plot_w + 1, plot_h + 1), 0.18, glow_and_fill)
    cv2.polylines(img, [points], False, color, 2, cv2.LINE_AA, SHIFT)
    end = (int(xs[-1]), int(ys[-1]))
    blend(img, (end[0] - 9, end[1] - 9, 19, 19), 0.35,
          lambda ov, o: cv2.circle(ov, (end[0] - o[0], end[1] - o[1]), 8, color, -1, cv2.LINE_AA))
    cv2.circle(img, end, 4, color, -1, cv2.LINE_AA)
    cv2.circle(img, end, 4, TEXT, 1, cv2.LINE_AA)


def draw_big_value(img, x, baseline, value, color, unit="BPM"):
    put_text(img, value, (x, baseline), 1.5, color, 2, FONT_NUM)
    put_text(img, unit, (x + text_width(value, 1.5, 2, FONT_NUM) + 8, baseline), 0.5, TEXT_DIM)


def draw_live_card(img, box, bpm, source_name):
    x, y, w, h = box
    draw_panel(img, box)
    put_text(img, "HEART RATE", (x + 14, y + 24), 0.45, TEXT_DIM)
    put_text(img, "LIVE", (x + w - 14 - text_width("LIVE", 0.4), y + 24), 0.4, PULSE_COLOR)
    draw_big_value(img, x + 14, y + 68, f"{bpm:.0f}" if bpm is not None else "--",
                   PULSE_COLOR if bpm is not None else TEXT_FAINT)
    put_text(img, source_name, (x + 14, y + h - 12), 0.4, TEXT_FAINT)


def draw_average_card(img, box, avg, now):
    x, y, w, h = box
    draw_panel(img, box)
    put_text(img, f"AVERAGE ({format_duration(avg.duration)})", (x + 14, y + 24), 0.45, TEXT_DIM)
    if avg.done:
        tag, tag_color = "FINAL", AVG_COLOR
        value, value_color = f"{avg.result:.0f}", AVG_COLOR
        footer = f"{len(avg.readings)} readings  |  R: restart"
    else:
        tag, tag_color = ("PAUSED", TEXT_FAINT) if avg.paused else ("REC", PULSE_COLOR)
        running = avg.running_average
        value = f"{running:.0f}" if running is not None else "--"
        value_color = TEXT_DIM if running is not None else TEXT_FAINT
        if not avg.readings:
            footer = "waiting for heart rate..."
        else:
            footer = (f"recording {format_duration(avg.recorded_sec)} / "
                      f"{format_duration(avg.duration)}")
    tag_x = x + w - 14 - text_width(tag, 0.4)
    put_text(img, tag, (tag_x, y + 24), 0.4, tag_color)
    if tag == "REC" and int(now * 2) % 2 == 0:                  # blinking recording dot
        cv2.circle(img, (tag_x - 9, y + 20), 4, PULSE_COLOR, -1, cv2.LINE_AA)
    draw_big_value(img, x + 14, y + 68, value, value_color)

    bar_x0, bar_x1, bar_y = x + 14, x + w - 14, y + 80
    rounded_rect(img, bar_x0, bar_y, bar_x1, bar_y + 4, 2, GRID)
    filled = int(bar_x0 + (bar_x1 - bar_x0) * avg.progress)
    if filled > bar_x0 + 4:
        rounded_rect(img, bar_x0, bar_y, filled, bar_y + 4, 2, AVG_COLOR)
    put_text(img, footer, (x + 14, y + h - 10), 0.4, TEXT_FAINT)


def draw_info_panel(img, x, y, min_width, rows, status, notes):
    """rows: (label, value) pairs. status: (text, color). notes: small grey lines."""
    line_h, value_x = 24, 110
    widths = [value_x + text_width(v, 0.5) for _, v in rows]
    widths += [22 + text_width(status[0], 0.5)] + [text_width(n, 0.42) for n in notes]
    w = max(min_width, max(widths) + 28)
    h = 14 + line_h * (len(rows) + 1) + 20 * len(notes) + 6
    draw_panel(img, (x, y, w, h))
    ty = y + 30
    for label, value in rows:
        put_text(img, label, (x + 14, ty), 0.45, TEXT_DIM)
        put_text(img, value, (x + 14 + value_x, ty), 0.5, TEXT)
        ty += line_h
    cv2.circle(img, (x + 20, ty - 5), 5, status[1], -1, cv2.LINE_AA)
    put_text(img, status[0], (x + 34, ty), 0.5, status[1])
    ty += line_h - 2
    for note in notes:
        put_text(img, note, (x + 14, ty), 0.42, TEXT_FAINT)
        ty += 20


def draw_dashboard(img, now, bpm, hr_source, avg, rows, status, notes,
                   pulse_wave, pulse_fs, breath_wave):
    """Top left: live and average heart rate cards with details below.
    Top right: pulse graph. Bottom: breathing graph."""
    h, w = img.shape[:2]
    margin, gap = 12, 10
    card_h = 110
    live_box = (margin, margin, 190, card_h)
    avg_box = (margin + 190 + gap, margin, 240, card_h)
    draw_live_card(img, live_box, bpm, hr_source)
    draw_average_card(img, avg_box, avg, now)
    draw_info_panel(img, margin, margin + card_h + gap, 190 + gap + 240, rows, status, notes)

    graph_w = 440
    draw_graph(img, pulse_wave, pulse_fs, 5, (w - margin - graph_w, margin, graph_w, 190),
               PULSE_COLOR, "PULSE",
               f"{bpm:.0f} BPM" if bpm is not None else None)
    draw_graph(img, breath_wave, RESP_FS, 30, (margin, h - margin - 130, w - 2 * margin, 130),
               BREATH_COLOR, "BREATHING")


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
    average = AverageBpmMonitor(args.avg_seconds)

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
                elif rppg_hr.sqi is None or rppg_hr.sqi <= RppgHeartRate.GOOD_SQI:
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

            live_bpm = bpm if face_found else None
            average.update(now, live_bpm)                # pauses while there is no reading

            hr_source = rppg_hr.model_name if rppg_hr is not None else "colour"
            resp_text = (f"{resp_rate:.1f} /min ({breathing.channel_name})"
                         if resp_rate is not None else "--")
            blink_text = f"{blink_rate:.0f} /min" if blink_rate is not None else "--"
            fps = rate_from_times(processed_times)
            fps_text = f"Camera {source.fps:.0f} fps, processed {fps:.0f} fps"
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

            # Draw the dashboard on an enlarged copy so the text and graphs are sharp.
            h, w = frame.shape[:2]
            display = frame
            if w != DISPLAY_WIDTH:
                display = cv2.resize(frame, (DISPLAY_WIDTH, round(h * DISPLAY_WIDTH / w)),
                                     interpolation=cv2.INTER_LINEAR)
            draw_dashboard(display, now, live_bpm, hr_source, average, rows, status, notes,
                           pulse_wave, pulse_fs, breathing.waveform)
            cv2.imshow(WINDOW, display)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("r"):
                average.reset()
    finally:
        source.release()
        if rppg_hr is not None:
            rppg_hr.close()
        landmarker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
