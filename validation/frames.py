"""Frame sources for the validation scripts: a synthetic face video or a recorded video file.

Both yield (time in seconds, raw BGR frame) exactly as a camera would deliver
them, before the app mirrors or resizes anything. The synthetic video is
fully deterministic, so every run sees the same pixels and timestamps.

Synthetic video:
  - A public-domain photo (scikit-image "astronaut", NASA) as the face.
  - The skin inside the face oval brightens and darkens with a pulse at
    TRUE_BPM (green strongest, like real blood flow).
  - The whole picture moves up and down 1.2 px at TRUE_BREATHS_PER_MIN.
  - Slow lighting drift, sensor noise, and uneven frame spacing around 30 fps.
"""
import cv2
import numpy as np

TRUE_BPM = 72.0
TRUE_BREATHS_PER_MIN = 15.0
WIDTH, HEIGHT = 640, 480


def _base_image():
    from skimage import data                     # only needed for the synthetic video
    rgb = data.astronaut()                        # 512 x 512, public domain (NASA)
    crop = rgb[20:380, 25:505]                    # 4:3 crop with face and shoulders
    bgr = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
    return cv2.resize(bgr, (WIDTH, HEIGHT), interpolation=cv2.INTER_CUBIC).astype(np.float32)


def _face_mask():
    mask = np.zeros((HEIGHT, WIDTH), np.float32)
    cv2.ellipse(mask, (267, 139), (68, 80), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(mask, (31, 31), 0)[..., None]


def exact_time(t):
    """Round to 1/1024 s (about 1 ms, like a camera clock). Such times survive the
    seconds -> milliseconds -> seconds trip of the frame header without rounding, so
    the desktop and backend replays see bit-identical timestamps."""
    return round(float(t) * 1024.0) / 1024.0


def synthetic_times(seconds, fps=30.0, seed=7):
    rng = np.random.default_rng(seed)
    t = np.cumsum(rng.uniform(0.85, 1.15, int(seconds * fps * 1.2)) / fps)
    return [exact_time(x) for x in t[t < seconds]]


def synthetic_frames(seconds=100.0, seed=7):
    base = _base_image()
    mask = _face_mask()
    gain_bgr = np.array([0.5, 1.0, 0.3], np.float32) * 0.008     # B, G, R
    f_hr = TRUE_BPM / 60.0
    f_resp = TRUE_BREATHS_PER_MIN / 60.0
    for i, t in enumerate(synthetic_times(seconds, seed=seed)):
        pulse = np.sin(2 * np.pi * f_hr * t) + 0.3 * np.sin(4 * np.pi * f_hr * t + 0.5)
        light = 1.0 + 0.01 * np.sin(2 * np.pi * 0.1 * t)
        img = base * light * (1.0 + mask * gain_bgr * pulse)
        shift = 1.2 * np.sin(2 * np.pi * f_resp * t)
        img = cv2.warpAffine(img, np.float32([[1, 0, 0], [0, 1, shift]]), (WIDTH, HEIGHT),
                             flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        noise = np.random.default_rng(seed * 100003 + i).normal(0, 1.0, img.shape)
        yield float(t), np.clip(img + noise, 0, 255).astype(np.uint8)


def video_frames(path, seconds=None):
    """Frames and timestamps from a recorded video file."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"Could not open video {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    i, last = 0, -1.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if t <= last:                                # some containers report 0 or repeats
            t = last + 1.0 / fps if last >= 0 else i / fps
        last = t
        if seconds is not None and t > seconds:
            break
        yield exact_time(t), frame
        i += 1
    cap.release()


def frames_from_args(args):
    if args.video:
        return video_frames(args.video, args.seconds)
    return synthetic_frames(args.seconds)
