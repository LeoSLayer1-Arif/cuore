"""Synthetic-signal checks for vitals.py. No camera needed.

Run:  python test_vitals.py
"""
import numpy as np

from vitals import BlinkCounter, HeartRateEstimator, RespirationEstimator

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
        pulse = 1 + pulse_gain * np.sin(2 * np.pi * f * t)
        # One R, G, B triple per face region (forehead, left cheek, right cheek).
        regions = [base * light * pulse + rng.normal(0, 0.05, 3) for _ in range(3)]
        est.add(t, np.concatenate(regions))
        if int(t * 2) != int((t - 1 / 30) * 2):             # update about twice a second
            est.update()
    bpm = est.update()
    assert bpm is not None, "no heart rate produced"
    assert abs(bpm - true_bpm) < 3, f"heart rate {bpm:.1f}, expected {true_bpm}"
    print(f"heart rate   OK: {bpm:.1f} BPM (true {true_bpm})")


def test_respiration(true_rate=15.0):
    f = true_rate / 60.0
    est = RespirationEstimator(channel_names=("chest", "head"))
    for t in jittered_times(45):
        chest = 3.0 * np.sin(2 * np.pi * f * t) + rng.normal(0, 0.1)
        head = 240.0 + 0.5 * np.sin(2 * np.pi * f * t) + rng.normal(0, 0.3)
        est.add(t, [chest, head])
    rate = est.update()
    assert rate is not None, "no breathing rate produced"
    assert abs(rate - true_rate) < 2, f"breathing {rate:.1f}, expected {true_rate}"
    print(f"breathing    OK: {rate:.1f}/min (true {true_rate}, from {est.channel_name})")


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


if __name__ == "__main__":
    test_heart_rate()
    test_respiration()
    test_blinks()
    print("All checks passed.")
