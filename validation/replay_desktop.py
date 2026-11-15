"""Run the desktop app's main() on recorded or synthetic frames instead of a webcam.

main() itself runs unmodified. Only the webcam (CameraSource) and the
on-screen window (cv2.imshow etc.) are replaced, so this captures what the
original program computes for a given sequence of frames and timestamps.

    python validation/replay_desktop.py --code-dir . --hr colour --out results/new_colour.pkl
    python validation/replay_desktop.py --code-dir /path/to/old/checkout --hr colour --out old.pkl

--code-dir is the folder holding the app.py and vitals.py to test.
"""
import argparse
import importlib
import os
import sys
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--code-dir", required=True)
    p.add_argument("--hr", choices=["rppg", "colour"], default="colour")
    p.add_argument("--rppg-model", default="FacePhys.rlap")
    p.add_argument("--avg-seconds", type=float, default=60)
    p.add_argument("--video", help="recorded video file (default: synthetic face video)")
    p.add_argument("--seconds", type=float, default=100.0)
    p.add_argument("--out", required=True)
    return p.parse_args()


def main():
    args = parse_args()
    code_dir = os.path.abspath(args.code_dir)
    sys.path.insert(0, HERE)
    sys.path.insert(0, code_dir)
    import cv2
    app = importlib.import_module("app")
    vitals = importlib.import_module("vitals")
    assert os.path.dirname(os.path.abspath(app.__file__)) == code_dir, app.__file__
    from frames import frames_from_args
    from record import Recorder

    recorder = Recorder(app, vitals)
    recorder.install()
    frames = frames_from_args(args)
    t_base = 1000.0                                  # a monotonic-clock-like start time

    class ReplaySource:
        """Stands in for CameraSource: same mirroring and resizing, frames from a file."""

        def __init__(self, *unused):
            self.arrival_times = deque(maxlen=60)
            self.full_frame = None

        def read(self, timeout=3.0):
            try:
                t, frame = next(frames)
            except StopIteration:
                return None, None
            recorder.begin_frame()
            arrived = t_base + t
            self.arrival_times.append(arrived)
            frame = cv2.flip(frame, 1)               # identical to the original CameraSource.read
            self.full_frame = frame
            if frame.shape[1] > 960:
                scale = 640.0 / frame.shape[1]
                frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            return frame, arrived

        @property
        def fps(self):
            return app.rate_from_times(self.arrival_times)

        def release(self):
            pass

    app.CameraSource = ReplaySource
    original_dashboard = app.draw_dashboard

    def draw_dashboard(img, now, bpm, hr_source, avg, rows, status, notes,
                       pulse_wave, pulse_fs, breath_wave):
        recorder.snapshot(now, bpm, hr_source, avg, rows, status, pulse_wave, pulse_fs,
                          breath_wave)
        return original_dashboard(img, now, bpm, hr_source, avg, rows, status, notes,
                                  pulse_wave, pulse_fs, breath_wave)

    app.draw_dashboard = draw_dashboard
    app.cv2.namedWindow = lambda *a, **k: None
    app.cv2.imshow = lambda *a, **k: None
    app.cv2.waitKey = lambda *a, **k: -1
    app.cv2.destroyAllWindows = lambda *a, **k: None

    sys.argv = ["app.py", "--hr", args.hr, "--rppg-model", args.rppg_model,
                "--avg-seconds", str(args.avg_seconds)]
    start = time.perf_counter()
    app.main()
    elapsed = time.perf_counter() - start
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    recorder.save(args.out, {"code_dir": code_dir, "hr": args.hr, "video": args.video,
                             "frames": len(recorder.frames), "elapsed_s": elapsed,
                             "runner": "desktop main()"})
    print(f"{len(recorder.frames)} frames in {elapsed:.1f} s -> {args.out}")


if __name__ == "__main__":
    main()
