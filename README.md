# rPPG Stress Meter

Camera-based heart rate, breathing rate, blink rate and a heuristic stress score. It reads the tiny color changes that blood flow causes in facial skin (remote photoplethysmography, rPPG). It works on a webcam or on a region of your screen, such as a Zoom tile.

**Status:** written and reviewed, but not yet run on a real webcam. Expect small fixes during the first hour. It is a screening demo, not a medical device.

## Project structure

| File | Purpose |
|---|---|
| `vitals.py` | Signal processing (NumPy/SciPy only, no camera needed) |
| `app.py` | Camera or screen capture, face tracking, on-screen display |
| `test_vitals.py` | Synthetic-signal checks for `vitals.py` |
| `requirements.txt` | Dependencies |

## How it works

1. **Find the face.** MediaPipe Face Landmarker places 478 points on the face in every frame.
2. **Pick skin areas.** The forehead and both cheeks have strong blood flow and little hair.
3. **Average the color.** Each frame gives one mean red, green and blue value for those areas.
4. **Even out the timing.** Webcam frames arrive at uneven intervals, so samples are interpolated onto an even 30 Hz grid.
5. **Extract the pulse with POS.** The Plane-Orthogonal-to-Skin algorithm (Wang et al., 2017) combines the three channels to cancel lighting and motion changes and keep the blood-flow color change.
6. **Filter.** Only 0.7-3.5 Hz is kept (42-210 BPM).
7. **Find the rate.** An FFT finds the strongest frequency. That frequency x 60 is the BPM. Readings from a noisy signal are dropped, and the median of the last 5 good readings is shown.
8. **Breathing.** Breathing moves the head up and down slightly. Filtering that motion to 0.1-0.5 Hz gives 6-30 breaths per minute.
9. **Blinks.** The eye aspect ratio (eye height / eye width) drops during a blink. The threshold adapts to each person's open-eye level.
10. **Stress score.** The first 30 seconds of heart rate readings set a relaxed baseline. The score then rises as heart rate, breathing and blink rate go above it. The weights are hand-picked for a demo and are not clinically validated.

The calibration clock starts at the first heart rate reading, about 5 seconds after launch, so the first score appears around 35 seconds.

## Setup

Use Python 3.10-3.12. MediaPipe can lag behind the newest Python versions. If `pip install` fails on 3.12, use 3.10 or 3.11.

```bash
cd rppg-stress-meter
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python test_vitals.py           # optional: checks the math with fake signals
python app.py
```

On first run the app downloads the face model (a few MB). On macOS, allow camera access for your terminal.

Sit still facing a window or lamp for 30 seconds while it calibrates. Keys: `q` or Esc quits, `r` restarts the average heart rate recording.

The dashboard shows the live heart rate next to an **average heart rate** card. The first 10 seconds of readings are a calibration period and are left out of the average. After that, the average records one reading per second for 1 minute, pausing while no face or reading is available, then shows the final value until you press `r` (which also restarts calibration). Change the length with `--avg-seconds`, e.g. `python app.py --avg-seconds 90`. The pulse graph is in the top-right corner and the breathing graph along the bottom.

To use an external webcam, pass its index: `python app.py --camera 1` (run `python find_cameras.py` to list cameras).

### Reading someone on a video call

Find the pixel position of their video tile and run:

```bash
python app.py --screen 100 100 640 480    # left top width height
```

Keep the app window off that region, or it will capture its own overlay. Video calls compress the image and weaken the signal, so ask the other person to sit in good light.

## Checking accuracy

Buy a fingertip pulse oximeter (about $15) and wear it while the app runs. After about 10 seconds the two numbers should be within roughly 5 BPM.

## Troubleshooting

| Problem | Fix |
|---|---|
| Reading unstable or wrong | Face steady daylight or a lamp. Avoid flickering overhead lights and backlighting. |
| FPS below 15 | Close other apps. |
| Reads double or half your pulse | Narrow `HR_BAND_HZ` in `vitals.py`, for example to `(0.8, 2.5)` for people at rest. |
| "Hold still" never goes away | Lower `min_snr_db` from -3.0 to -6.0 in `HeartRateEstimator`. |
| Error about `mediapipe.tasks` | Old MediaPipe. Run `pip install -U mediapipe`. |
| `import cv2` misbehaves | MediaPipe installs `opencv-contrib-python`, which can clash with `opencv-python`. Uninstall both, then install one. |
| Green outlines sit on hair or background | Adjust the landmark lists `FOREHEAD`, `LEFT_CHEEK`, `RIGHT_CHEEK` in `app.py`. |
| Breathing rate is erratic | Expected for the first 30 seconds. It comes from tiny head motion and is the weakest signal. |

## Limitations and ethics

- Not a medical device. Do not use it for diagnosis.
- Accuracy drops with motion, dim or flickering light, video compression, and darker skin tones, where the color signal is weaker.
- The stress score is a heuristic. A rising score means "different from your own baseline", not "stressed".
- Get consent before measuring anyone, especially over a video call.

## Stretch goals

- **Heart rate variability:** find beats in `heart.waveform` with `scipy.signal.find_peaks`, then compute RMSSD of the beat-to-beat intervals. HRV is a better stress signal than raw heart rate.
- **CSV logging:** save the app's readings next to the oximeter's and chart the difference.

## References

- Wang, Stuijk, de Haan. "Algorithmic Principles of Remote PPG." IEEE Trans. Biomedical Engineering, 2017 (the POS algorithm).
- Soukupova, Cech. "Real-Time Eye Blink Detection using Facial Landmarks." 2016 (eye aspect ratio).
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)

## Source code

### requirements.txt

```text
mediapipe
opencv-python
numpy
scipy
mss
```

### vitals.py

```python
"""Signal processing for camera-based vital signs (remote photoplethysmography).

Everything here is pure NumPy/SciPy, so it can be tested without a camera.
"""
from collections import deque

import numpy as np
from scipy.signal import butter, sosfiltfilt

HR_BAND_HZ = (0.7, 3.5)    # 42-210 beats per minute
RESP_BAND_HZ = (0.1, 0.5)  # 6-30 breaths per minute
HR_FS = 30.0               # resampling rate for the pulse signal (Hz)
RESP_FS = 10.0             # resampling rate for the breathing signal (Hz)

def resample_uniform(t, x, fs):
    """Webcams deliver frames at uneven intervals. Interpolate onto an even grid."""
    t = np.asarray(t, dtype=float)
    x = np.asarray(x, dtype=float)
    t_uniform = np.arange(t[0], t[-1], 1.0 / fs)
    if x.ndim == 1:
        return t_uniform, np.interp(t_uniform, t, x)
    columns = [np.interp(t_uniform, t, x[:, i]) for i in range(x.shape[1])]
    return t_uniform, np.stack(columns, axis=1)

def bandpass(x, fs, low, high, order=3):
    """Zero-phase Butterworth bandpass filter."""
    sos = butter(order, [low, high], btype="band", fs=fs, output="sos")
    return sosfiltfilt(sos, x)

def pos_pulse(rgb, fs=HR_FS, win_sec=1.6):
    """Plane-Orthogonal-to-Skin (POS) algorithm, Wang et al., IEEE TBME 2017.

    rgb: array of shape (N, 3) holding mean skin R, G, B per frame.
    Returns a 1-D pulse signal of length N. POS cancels most lighting and
    motion changes that affect all three color channels together.
    """
    n = rgb.shape[0]
    win = int(round(win_sec * fs))
    projection = np.array([[0.0, 1.0, -1.0],
                           [-2.0, 1.0, 1.0]])
    pulse = np.zeros(n)
    for start in range(0, n - win + 1):
        block = rgb[start:start + win].T                  # shape (3, win)
        mean = block.mean(axis=1, keepdims=True)
        if np.any(mean <= 0):
            continue
        s = projection @ (block / mean)                   # shape (2, win)
        alpha = s[0].std() / (s[1].std() + 1e-9)
        h = s[0] + alpha * s[1]
        pulse[start:start + win] += h - h.mean()          # overlap-add
    return pulse

def dominant_frequency(x, fs, low, high, peak_width_hz):
    """Return (peak frequency in Hz, signal-to-noise ratio in dB) within a band."""
    n = len(x)
    nfft = max(4096, 1 << int(np.ceil(np.log2(n))))       # zero-pad for finer resolution
    spectrum = np.abs(np.fft.rfft((x - x.mean()) * np.hanning(n), n=nfft)) ** 2
    freqs = np.fft.rfftfreq(nfft, 1.0 / fs)
    in_band = (freqs >= low) & (freqs <= high)
    f, p = freqs[in_band], spectrum[in_band]
    peak = f[np.argmax(p)]
    near_peak = np.abs(f - peak) <= peak_width_hz
    snr = p[near_peak].sum() / (p[~near_peak].sum() + 1e-12)
    return float(peak), float(10.0 * np.log10(snr + 1e-12))

class RollingBuffer:
    """Keeps (timestamp, value) pairs from the last `window_sec` seconds."""

    def __init__(self, window_sec):
        self.window_sec = window_sec
        self.t = deque()
        self.x = deque()

    def add(self, t, value):
        self.t.append(t)
        self.x.append(value)
        while self.t and t - self.t[0] > self.window_sec:
            self.t.popleft()
            self.x.popleft()

    def duration(self):
        return self.t[-1] - self.t[0] if len(self.t) > 1 else 0.0

    def arrays(self):
        return np.array(self.t), np.array(self.x)

    def clear(self):
        self.t.clear()
        self.x.clear()

class HeartRateEstimator:
    def __init__(self, window_sec=10.0, min_sec=5.0, smooth_n=5, min_snr_db=-3.0):
        self.buffer = RollingBuffer(window_sec)
        self.min_sec = min_sec
        self.min_snr_db = min_snr_db
        self.history = deque(maxlen=smooth_n)
        self.bpm = None
        self.snr_db = None
        self.waveform = None

    def add(self, t, rgb):
        self.buffer.add(t, rgb)

    def reset(self):
        self.buffer.clear()
        self.history.clear()
        self.bpm = self.snr_db = self.waveform = None

    def update(self):
        if self.buffer.duration() < self.min_sec:
            return self.bpm
        t, rgb = self.buffer.arrays()
        _, rgb_uniform = resample_uniform(t, rgb, HR_FS)
        if len(rgb_uniform) < 64:
            return self.bpm
        pulse = bandpass(pos_pulse(rgb_uniform, HR_FS), HR_FS, *HR_BAND_HZ)
        freq, self.snr_db = dominant_frequency(pulse, HR_FS, *HR_BAND_HZ, peak_width_hz=0.15)
        self.waveform = pulse
        if self.snr_db >= self.min_snr_db:     # ignore readings from a noisy signal
            self.history.append(freq * 60.0)
        self.bpm = float(np.median(self.history)) if self.history else None
        return self.bpm

    @property
    def signal_ok(self):
        return self.snr_db is not None and self.snr_db >= self.min_snr_db

class RespirationEstimator:
    """Breathing rate from the small up-and-down head motion it causes."""

    def __init__(self, window_sec=30.0, min_sec=15.0, smooth_n=5, min_snr_db=-3.0):
        self.buffer = RollingBuffer(window_sec)
        self.min_sec = min_sec
        self.min_snr_db = min_snr_db
        self.history = deque(maxlen=smooth_n)
        self.rate = None

    def add(self, t, head_y):
        self.buffer.add(t, head_y)

    def reset(self):
        self.buffer.clear()
        self.history.clear()
        self.rate = None

    def update(self):
        if self.buffer.duration() < self.min_sec:
            return self.rate
        t, y = self.buffer.arrays()
        _, y_uniform = resample_uniform(t, y, RESP_FS)
        if len(y_uniform) < 64:
            return self.rate
        motion = bandpass(y_uniform, RESP_FS, *RESP_BAND_HZ)
        freq, snr_db = dominant_frequency(motion, RESP_FS, *RESP_BAND_HZ, peak_width_hz=0.03)
        if snr_db >= self.min_snr_db:
            self.history.append(freq * 60.0)
        self.rate = float(np.median(self.history)) if self.history else None
        return self.rate

class BlinkCounter:
    """Counts blinks from the eye aspect ratio (EAR) with a per-person threshold."""

    def __init__(self, closed_ratio=0.75, min_frames=2, max_frames=15, window_sec=60.0):
        self.closed_ratio = closed_ratio
        self.min_frames = min_frames      # shorter dips are landmark noise
        self.max_frames = max_frames      # longer closures are not blinks
        self.window_sec = window_sec
        self.ear_history = deque(maxlen=300)
        self.closed_frames = 0
        self.blink_times = deque()
        self.start = None

    def reset(self):
        self.__init__(self.closed_ratio, self.min_frames, self.max_frames, self.window_sec)

    def update(self, t, ear):
        if self.start is None:
            self.start = t
        self.ear_history.append(ear)
        open_level = np.percentile(self.ear_history, 90)   # this person's open-eye EAR
        if ear < self.closed_ratio * open_level:
            self.closed_frames += 1
        else:
            if self.min_frames <= self.closed_frames <= self.max_frames:
                self.blink_times.append(t)
            self.closed_frames = 0
        while self.blink_times and t - self.blink_times[0] > self.window_sec:
            self.blink_times.popleft()

    def rate_per_min(self, t):
        if self.start is None:
            return None
        elapsed = min(self.window_sec, t - self.start)
        if elapsed < 10.0:
            return None
        return len(self.blink_times) * 60.0 / elapsed

class StressScore:
    """Heuristic 0-100 score: how far the person has moved from their own baseline.

    The first `calibration_sec` seconds record a relaxed baseline. The weights
    below are hand-picked for a demo, not clinically validated.
    """

    RELAXED_SCORE = 30.0
    WEIGHTS = {"hr": 2.0, "resp": 1.5, "blink": 0.5}  # points per unit above baseline

    def __init__(self, calibration_sec=30.0):
        self.calibration_sec = calibration_sec
        self.reset()

    def reset(self):
        self.samples = {"hr": [], "resp": [], "blink": []}
        self.baseline = None
        self.start = None

    def calibration_progress(self, t):
        if self.start is None:
            return 0.0
        return min(1.0, (t - self.start) / self.calibration_sec)

    def update(self, t, hr, resp, blink):
        current = {"hr": hr, "resp": resp, "blink": blink}
        if hr is None and self.start is None:
            return None                 # wait for the first heart rate reading
        if self.start is None:
            self.start = t
        if self.baseline is None:
            for key, value in current.items():
                if value is not None:
                    self.samples[key].append(value)
            if t - self.start < self.calibration_sec or not self.samples["hr"]:
                return None
            self.baseline = {k: (float(np.median(v)) if v else None)
                             for k, v in self.samples.items()}
        if hr is None:
            return None                 # no current heart rate, so no meaningful score
        score = self.RELAXED_SCORE
        for key, weight in self.WEIGHTS.items():
            if current[key] is not None and self.baseline[key] is not None:
                score += weight * (current[key] - self.baseline[key])
        return float(np.clip(score, 0.0, 100.0))
```

### app.py

```python
"""Live camera-based vital signs and stress meter.

Usage:
    python app.py                                # default webcam
    python app.py --camera 1                     # another webcam
    python app.py --screen 100 100 640 480       # read a region of the screen (e.g. a Zoom tile)

Keys: q or Esc = quit, r = recalibrate baseline.
"""
import argparse
import os
import time
import urllib.request
from collections import deque

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

from vitals import (HR_FS, BlinkCounter, HeartRateEstimator,
                    RespirationEstimator, StressScore)

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

UPDATE_EVERY_SEC = 0.5   # how often to recompute the vitals
FACE_LOST_RESET_SEC = 1.0
MAX_READ_FAILURES = 30   # consecutive failed webcam reads before giving up

def parse_args():
    parser = argparse.ArgumentParser(description="Camera-based heart rate and stress meter")
    parser.add_argument("--camera", type=int, default=0, help="webcam index")
    parser.add_argument("--screen", type=int, nargs=4, metavar=("LEFT", "TOP", "WIDTH", "HEIGHT"),
                        help="capture a screen region instead of the webcam")
    parser.add_argument("--calibration", type=float, default=30.0,
                        help="seconds of relaxed baseline before the stress score starts")
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

class FrameSource:
    def __init__(self, args):
        self.sct = None
        self.cap = None
        if args.screen:
            import mss
            self.sct = mss.mss()
            left, top, width, height = args.screen
            self.region = {"left": left, "top": top, "width": width, "height": height}
        else:
            self.cap = cv2.VideoCapture(args.camera)
            if not self.cap.isOpened():
                raise SystemExit(f"Could not open camera {args.camera}")
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)

    def read(self):
        """Return a BGR frame, or None if the source produced nothing this time."""
        if self.sct is not None:
            image = np.array(self.sct.grab(self.region))
            return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
        ok, frame = self.cap.read()
        return cv2.flip(frame, 1) if ok else None   # mirror the webcam view

    def release(self):
        if self.cap is not None:
            self.cap.release()
        if self.sct is not None:
            self.sct.close()

def to_pixels(landmarks, width, height):
    return np.array([[lm.x * width, lm.y * height] for lm in landmarks], dtype=np.float32)

def region_polygon(points, indices, shrink=1.0):
    """Convex hull of some landmarks, optionally shrunk toward its center to avoid hair and brows."""
    hull = cv2.convexHull(points[indices]).reshape(-1, 2)
    if shrink < 1.0:
        center = hull.mean(axis=0)
        hull = center + (hull - center) * shrink
    return hull.astype(np.int32)

def mean_skin_rgb(frame, polygons):
    mask = np.zeros(frame.shape[:2], dtype=np.uint8)
    for polygon in polygons:
        cv2.fillConvexPoly(mask, polygon, 255)
    b, g, r, _ = cv2.mean(frame, mask=mask)
    return np.array([r, g, b])

def eye_aspect_ratio(points, indices):
    p = points[indices]
    vertical = np.linalg.norm(p[1] - p[5]) + np.linalg.norm(p[2] - p[4])
    horizontal = np.linalg.norm(p[0] - p[3])
    return vertical / (2.0 * horizontal + 1e-6)

def draw_waveform(frame, waveform, x, y, width, height):
    cv2.rectangle(frame, (x, y), (x + width, y + height), (40, 40, 40), -1)
    if waveform is None or len(waveform) < 2:
        return
    segment = waveform[-int(5 * HR_FS):]                  # last 5 seconds
    span = segment.max() - segment.min()
    normalized = (segment - segment.min()) / (span + 1e-9)
    xs = x + np.linspace(0, width, len(segment))
    ys = y + height - normalized * height
    points = np.stack([xs, ys], axis=1).astype(np.int32)
    cv2.polylines(frame, [points], False, (80, 80, 255), 2)

def draw_hud(frame, lines, waveform):
    panel_height = 30 + 28 * len(lines)
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (330, panel_height), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)
    for i, (text, color) in enumerate(lines):
        cv2.putText(frame, text, (10, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
    h, w = frame.shape[:2]
    draw_waveform(frame, waveform, 10, h - 90, w - 20, 80)

def fmt(value, unit):
    return f"{value:.0f} {unit}" if value is not None else "--"

def main():
    args = parse_args()
    source = FrameSource(args)
    landmarker = create_landmarker()
    heart = HeartRateEstimator()
    breathing = RespirationEstimator()
    blinks = BlinkCounter()
    stress = StressScore(args.calibration)

    # perf_counter has sub-millisecond resolution on every OS. time.monotonic
    # ticks only every ~15 ms on Windows, which gives frames identical timestamps.
    t0 = time.perf_counter()
    last_timestamp_ms = -1
    last_update = 0.0
    last_face_time = 0.0
    read_failures = 0
    frame_times = deque(maxlen=30)
    bpm = resp_rate = blink_rate = score = None

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    try:
        while True:
            frame = source.read()
            if frame is None:
                # Some webcams drop a frame or two at startup. Only quit if it keeps failing.
                read_failures += 1
                if read_failures >= MAX_READ_FAILURES:
                    print("Camera stopped delivering frames.")
                    break
                time.sleep(0.01)
                continue
            read_failures = 0
            now = time.perf_counter() - t0
            frame_times.append(now)

            # MediaPipe needs strictly increasing timestamps in milliseconds.
            timestamp_ms = max(int(now * 1000), last_timestamp_ms + 1)
            last_timestamp_ms = timestamp_ms
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms)

            face_found = bool(result.face_landmarks)
            if face_found:
                if now - last_face_time > FACE_LOST_RESET_SEC:
                    heart.reset()          # a gap would corrupt the signal, start fresh
                    breathing.reset()
                last_face_time = now

                h, w = frame.shape[:2]
                points = to_pixels(result.face_landmarks[0], w, h)
                polygons = [region_polygon(points, FOREHEAD, shrink=0.8),
                            region_polygon(points, LEFT_CHEEK),
                            region_polygon(points, RIGHT_CHEEK)]
                # Sample colors before drawing anything on the frame.
                heart.add(now, mean_skin_rgb(frame, polygons))
                breathing.add(now, float(points[:, 1].mean()))
                ear = (eye_aspect_ratio(points, LEFT_EYE) + eye_aspect_ratio(points, RIGHT_EYE)) / 2
                blinks.update(now, ear)
                cv2.polylines(frame, polygons, True, (0, 255, 0), 1)
            elif last_face_time > 0 and now - last_face_time > FACE_LOST_RESET_SEC:
                # Face gone for a while: drop old readings instead of showing stale numbers.
                heart.reset()
                breathing.reset()
                bpm = resp_rate = None

            if now - last_update >= UPDATE_EVERY_SEC:
                last_update = now
                bpm = heart.update()
                resp_rate = breathing.update()
                blink_rate = blinks.rate_per_min(now)
                score = stress.update(now, bpm, resp_rate, blink_rate)

            fps = (len(frame_times) - 1) / (frame_times[-1] - frame_times[0] + 1e-9)
            white, gray, red, yellow = (255, 255, 255), (170, 170, 170), (80, 80, 255), (0, 220, 255)
            if not face_found:
                status = ("No face detected", red)
            elif not heart.signal_ok:
                status = ("Hold still, good light", yellow)
            else:
                status = ("Signal good", (0, 255, 0))
            if stress.baseline is None:
                progress = stress.calibration_progress(now) * 100
                stress_line = (f"Stress: calibrating {progress:.0f}%", gray)
            elif score is None:
                stress_line = ("Stress: --", gray)
            else:
                stress_line = (f"Stress: {score:.0f}/100", red if score > 60 else white)

            lines = [
                (f"Heart rate: {fmt(bpm, 'BPM')}", white),
                (f"Breathing:  {fmt(resp_rate, '/min')}", white),
                (f"Blinks:     {fmt(blink_rate, '/min')}", white),
                stress_line,
                status,
                (f"FPS: {fps:.0f}" + ("  (need 15+)" if fps < 15 else ""), gray),
            ]
            draw_hud(frame, lines, heart.waveform)
            cv2.imshow(WINDOW, frame)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("r"):
                stress.reset()
            if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break                      # window closed with the X button
    finally:
        source.release()
        landmarker.close()
        cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
```

### test_vitals.py

```python
"""Synthetic-signal checks for vitals.py. No camera needed.

Run:  python test_vitals.py
"""
import numpy as np

from vitals import (BlinkCounter, HeartRateEstimator, RespirationEstimator,
                    StressScore)

rng = np.random.default_rng(0)


def jittered_times(seconds, fps=30.0):
    """Frame timestamps with webcam-like uneven spacing."""
    t = np.cumsum(rng.uniform(0.7, 1.3, int(seconds * fps)) / fps)
    return t[t < seconds]


def test_heart_rate(true_bpm=72.0):
    f = true_bpm / 60.0
    est = HeartRateEstimator()
    base = np.array([180.0, 120.0, 100.0])           # mean skin R, G, B
    pulse_gain = np.array([0.3, 1.0, 0.5]) * 0.002   # green carries most of the pulse
    for t in jittered_times(20):
        light = 1.0 + 0.02 * np.sin(2 * np.pi * 0.2 * t)   # slow lighting drift
        rgb = base * light * (1 + pulse_gain * np.sin(2 * np.pi * f * t))
        est.add(t, rgb + rng.normal(0, 0.05, 3))
        if int(t * 2) != int((t - 1 / 30) * 2):             # update about twice a second
            est.update()
    bpm = est.update()
    assert bpm is not None, "no heart rate produced"
    assert abs(bpm - true_bpm) < 3, f"heart rate {bpm:.1f}, expected {true_bpm}"
    print(f"heart rate   OK: {bpm:.1f} BPM (true {true_bpm})")


def test_respiration(true_rate=15.0):
    f = true_rate / 60.0
    est = RespirationEstimator()
    for t in jittered_times(45):
        est.add(t, 240.0 + 1.5 * np.sin(2 * np.pi * f * t) + rng.normal(0, 0.1))
    rate = est.update()
    assert rate is not None, "no breathing rate produced"
    assert abs(rate - true_rate) < 2, f"breathing {rate:.1f}, expected {true_rate}"
    print(f"breathing    OK: {rate:.1f}/min (true {true_rate})")


def test_blinks():
    counter = BlinkCounter()
    fps = 30.0
    for i in range(int(60 * fps)):
        t = i / fps
        closing = i >= 90 and (i % 90) < 3             # a 3-frame blink every 3 s
        counter.update(t, 0.10 if closing else 0.30 + rng.normal(0, 0.003))
    rate = counter.rate_per_min(59.9)
    assert rate is not None and 17 <= rate <= 21, f"blink rate {rate}, expected about 19"
    print(f"blinks       OK: {rate:.1f}/min (true 19)")


def test_stress():
    score = StressScore(calibration_sec=30.0)
    result = None
    for i in range(80):                                  # 40 s at 70 BPM: calibration
        result = score.update(i * 0.5, 70.0, 15.0, 15.0)
    assert result is not None and abs(result - 30.0) < 1e-6, f"relaxed score {result}"
    result = score.update(41.0, 90.0, 15.0, 15.0)        # heart rate +20 BPM
    assert abs(result - 70.0) < 1e-6, f"raised score {result}, expected 70"
    assert score.update(41.5, None, 15.0, 15.0) is None, "score should be None without heart rate"
    print("stress score OK: 30 at baseline, 70 at +20 BPM")


if __name__ == "__main__":
    test_heart_rate()
    test_respiration()
    test_blinks()
    test_stress()
    print("All checks passed.")
```

