"""Compare two recordings made by replay_desktop.py or replay_backend.py, value by value.

    python validation/compare.py results/orig_colour.pkl results/backend_colour.pkl

Checked, in pipeline order:
  RGB values per face region, every signal-processing call in vitals.py
  (resampling, POS pulse, bandpass filter, power spectrum, peak pick, beat
  timing) with its inputs and outputs, then per frame: live BPM, status,
  info rows, pulse and breathing waveforms, and the average BPM monitor.
  For open-rppg: the frames and timestamps handed to the model, the final
  pulse signal and heart rate.

Exit code 0 only if everything that should match exactly does.
"""
import argparse
import pickle
import sys

import numpy as np


def max_diff(a, b):
    """Largest absolute difference between two nested values. inf if their shapes differ."""
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return float("inf")
        return max([max_diff(a[k], b[k]) for k in a] or [0.0])
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        if len(a) != len(b):
            return float("inf")
        return max([max_diff(x, y) for x, y in zip(a, b)] or [0.0])
    if a is None or b is None:
        return 0.0 if a is None and b is None else float("inf")
    if isinstance(a, str) or isinstance(b, str):
        return 0.0 if a == b else float("inf")
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if a.shape != b.shape:
        return float("inf")
    if a.size == 0:
        return 0.0
    both_nan = np.isnan(a) & np.isnan(b)
    return float(np.max(np.where(both_nan, 0.0, np.abs(a - b))))


class Report:
    def __init__(self):
        self.failed = False

    def check(self, label, diff, tolerance=0.0, required=True):
        ok = diff <= tolerance
        mark = "OK  " if ok else ("FAIL" if required else "info")
        if not ok and required:
            self.failed = True
        shown = "identical" if diff == 0 else f"max difference {diff:.3g}"
        print(f"  [{mark}] {label}: {shown}" + (f" (tolerance {tolerance:g})" if tolerance else ""))


def compare(a, b, frame_keys, timing_dependent=()):
    r = Report()
    fa, fb = a["frames"], b["frames"]
    print(f"A: {a['meta'].get('runner')} {a['meta'].get('code_dir', '')}  ({len(fa)} frames)")
    print(f"B: {b['meta'].get('runner')} {b['meta'].get('code_dir', '')}  ({len(fb)} frames)")

    print("\nInputs to the measurement code")
    r.check("number of processed frames", 0.0 if len(fa) == len(fb) else float("inf"))
    r.check("frame times", max_diff([f["now"] for f in fa], [f["now"] for f in fb]))

    print("\nColour path (vitals.py)")
    r.check(f"region RGB values ({len(a['rgb'])} samples)",
            max_diff([x for x in a["rgb"]], [x for x in b["rgb"]]))
    names = sorted({c[2] for c in a["calls"]} | {c[2] for c in b["calls"]})
    for context in ("hr", "resp"):
        for name in names:
            ca = [c for c in a["calls"] if c[1] == context and c[2] == name]
            cb = [c for c in b["calls"] if c[1] == context and c[2] == name]
            if not ca and not cb:
                continue
            label = f"{'heart' if context == 'hr' else 'breathing'} {name} ({len(ca)} calls)"
            if len(ca) != len(cb):
                r.check(label + f" vs {len(cb)} calls", float("inf"))
                continue
            r.check(label + " inputs", max_diff([c[3:5] for c in ca], [c[3:5] for c in cb]))
            r.check(label + " outputs", max_diff([c[5] for c in ca], [c[5] for c in cb]))

    print("\nPer-frame results")
    n = min(len(fa), len(fb))
    for key in frame_keys:
        r.check(key, max_diff([fa[i][key] for i in range(n)], [fb[i][key] for i in range(n)]),
                required=key not in timing_dependent)
    r.check("average BPM monitor (readings, result, paused, calibration)",
            max_diff([fa[i]["avg"] for i in range(n)], [fb[i]["avg"] for i in range(n)]),
            required="avg" not in timing_dependent)
    fin_a, fin_b = fa[-1]["avg"], fb[-1]["avg"]
    print(f"  final average: A {fin_a['result']}  B {fin_b['result']} "
          f"({len(fin_a['readings'])} / {len(fin_b['readings'])} readings)")
    return r


def compare_rppg(a, b, r):
    ra, rb = a["rppg"], b["rppg"]
    if not ra["frames"] and not rb["frames"]:
        return
    print("\nopen-rppg path")
    same_frames = [h for _, h in ra["frames"]] == [h for _, h in rb["frames"]]
    r.check(f"frames given to the model ({len(ra['frames'])}, compared by SHA-1)",
            0.0 if same_frames else float("inf"))
    # Absolute times differ (each run has its own clock); compare times since the first frame.
    ta = np.array([t for t, _ in ra["frames"]]); tb = np.array([t for t, _ in rb["frames"]])
    r.check("frame timestamps given to the model (relative)",
            max_diff(ta - ta[0], tb - tb[0]), tolerance=1e-6)
    if ra["final"] and rb["final"]:
        A, B = ra["final"], rb["final"]
        r.check("model output samples", 0.0 if A["n_signal"] == B["n_signal"] else float("inf"))
        r.check("final pulse signal (filtered BVP)", max_diff(A["bvp"], B["bvp"]), tolerance=1e-4)
        r.check("final raw model output", max_diff(A["raw"], B["raw"]), tolerance=1e-4)
        hr = lambda rec, key: (rec[key] or {}).get("hr")
        r.check("heart rate of the last 10 s", max_diff(hr(A, "hr_last10"), hr(B, "hr_last10")),
                tolerance=1e-6)
        r.check("heart rate of the whole recording", max_diff(hr(A, "hr_all"), hr(B, "hr_all")),
                tolerance=1e-6)
        print(f"  final HR (last 10 s): A {hr(A, 'hr_last10')}  B {hr(B, 'hr_last10')}")
    # The live readings depend on how far the model's background thread had got
    # when hr() was called, which varies between any two runs (even of the same
    # code), so they are shown for information only.
    ua = [u[1] for u in ra["updates"] if u[1] is not None]
    ub = [u[1] for u in rb["updates"] if u[1] is not None]
    if ua and ub:
        print(f"  live readings (info, timing-dependent): A median {np.median(ua):.2f} "
              f"range {min(ua):.2f}-{max(ua):.2f};  B median {np.median(ub):.2f} "
              f"range {min(ub):.2f}-{max(ub):.2f}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("a")
    p.add_argument("b")
    args = p.parse_args()
    a = pickle.load(open(args.a, "rb"))
    b = pickle.load(open(args.b, "rb"))
    rppg = bool(a["rppg"]["frames"])
    if rppg:
        # Per-frame values in rppg mode come from the timing-dependent live readings.
        keys = ["rows", "breath_wave", "live_bpm", "status"]
        timing = ("live_bpm", "status", "avg")
    else:
        keys = ["live_bpm", "status", "rows", "pulse_wave", "pulse_fs", "breath_wave"]
        timing = ()
    report = compare(a, b, keys, timing)
    if rppg:
        print("  (rppg mode: live BPM, status and average depend on background-thread timing; "
              "the comparison of the model itself is below)")
    compare_rppg(a, b, report)
    print("\nRESULT:", "FAIL" if report.failed else "PASS")
    sys.exit(1 if report.failed else 0)


if __name__ == "__main__":
    main()
