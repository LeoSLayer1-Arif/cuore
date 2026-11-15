"""Records every intermediate value of the measurement code while it runs.

The recorder wraps (does not change) the functions in vitals.py and app.py,
so the same numbers can be captured from the original desktop app and from
the phone backend and then compared one by one.
"""
import hashlib
import pickle

import numpy as np


def _copy(value):
    if isinstance(value, np.ndarray):
        return value.copy()
    if isinstance(value, (list, tuple)):
        return type(value)(_copy(v) for v in value)
    return value


class Recorder:
    def __init__(self, app_module, vitals_module):
        self.app = app_module
        self.vitals = vitals_module
        self.frames = []        # one dict per processed frame
        self.calls = []         # (estimator, function name, inputs, output) per signal call
        self.rgb = []           # (frame index, region RGB list) from region_mean_rgb
        self.rppg = {"frames": [], "updates": [], "final": None}
        self._context = None
        self._frame_index = -1

    # ----- wrapping -----

    def install(self):
        v, a = self.vitals, self.app
        for name in ("resample_uniform", "bandpass", "pos_pulse", "power_spectrum",
                     "pick_peak", "refine_rate_hz"):
            setattr(v, name, self._wrap_signal(name, getattr(v, name)))
        a.region_mean_rgb = self._wrap_rgb(a.region_mean_rgb)
        for cls, tag in ((v.HeartRateEstimator, "hr"), (v.RespirationEstimator, "resp")):
            cls.update = self._wrap_context(tag, cls.update)
        rp = a.RppgHeartRate
        original_add, original_update, original_close = rp.add_frame, rp.update, rp.close
        recorder = self

        def add_frame(obj, rgb, t):
            recorder.rppg["frames"].append((t, hashlib.sha1(rgb.tobytes()).hexdigest()))
            return original_add(obj, rgb, t)

        def update(obj, now):
            bpm = original_update(obj, now)
            recorder.rppg["updates"].append((now, bpm, obj.sqi))
            return bpm

        def close(obj):
            original_close(obj)              # waits until every frame has been through the model
            if not obj.model.has_signal:
                return                       # e.g. the server's unused spare pipeline
            bvp, ts = obj.model.bvp()
            raw, _ = obj.model.bvp(raw=True)
            hr = obj.model.hr(start=-obj.WINDOW_SEC, return_hrv=False)
            hr_all = obj.model.hr(return_hrv=False)
            recorder.rppg["final"] = {"bvp": np.asarray(bvp), "raw": np.asarray(raw),
                                      "ts": np.asarray(ts), "hr_last10": hr, "hr_all": hr_all,
                                      "n_signal": obj.model.n_signal}

        rp.add_frame, rp.update, rp.close = add_frame, update, close

    def _wrap_signal(self, name, func):
        def wrapped(*args, **kwargs):
            out = func(*args, **kwargs)
            self.calls.append((self._frame_index, self._context, name,
                               _copy(args), _copy(kwargs), _copy(out)))
            return out
        return wrapped

    def _wrap_context(self, tag, method):
        def wrapped(obj, *args, **kwargs):
            previous, self._context = self._context, tag
            try:
                return method(obj, *args, **kwargs)
            finally:
                self._context = previous
        return wrapped

    def _wrap_rgb(self, func):
        def wrapped(frame, polygon):
            out = func(frame, polygon)
            self.rgb.append((self._frame_index, _copy(out)))
            return out
        return wrapped

    # ----- per-frame snapshot -----

    def begin_frame(self):
        self._frame_index += 1

    def snapshot(self, now, live_bpm, hr_source, avg, rows, status, pulse_wave, pulse_fs,
                 breath_wave):
        self.frames.append({
            "now": now, "live_bpm": live_bpm, "hr_source": hr_source,
            "status": status[0], "rows": [tuple(r) for r in rows],
            "avg": {"readings": list(avg.readings), "result": avg.result,
                    "paused": avg.paused, "calibration_samples": avg.calibration_samples},
            "pulse_wave": None if pulse_wave is None else np.array(pulse_wave, dtype=float),
            "pulse_fs": pulse_fs,
            "breath_wave": None if breath_wave is None else np.array(breath_wave, dtype=float),
        })

    def save(self, path, meta):
        with open(path, "wb") as f:
            pickle.dump({"meta": meta, "frames": self.frames, "calls": self.calls,
                         "rgb": self.rgb, "rppg": self.rppg}, f)
