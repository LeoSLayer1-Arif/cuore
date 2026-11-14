"""Synthetic checks for vitals.py. No camera needed: python -m pytest test_vitals.py

Each test builds a signal with a known heart or breathing rate and checks the
estimator recovers it. If these pass but live readings are wrong, the problem
is in the camera input or the reference measurement, not the math.
"""
import numpy as np
import pytest

from vitals import HeartRateEstimator, RespirationEstimator

SKIN = np.array([150.0, 110.0, 90.0])          # mean R, G, B of skin
PULSE_DIR = np.array([0.33, 0.77, 0.53])       # pulse is strongest in green


def simulate_heart(bpm, fps=25, seconds=20, noise=0.3, seed=0):
    rng = np.random.default_rng(seed)
    est, t = HeartRateEstimator(), 0.0
    for k in range(int(fps * seconds)):
        t += 1 / fps + rng.normal(0, 0.004)    # uneven frame timing
        drift = 1 + 0.02 * np.sin(2 * np.pi * 0.1 * t)
        pulse = 0.4 * np.sin(2 * np.pi * bpm / 60 * t)
        est.add(t, np.concatenate([SKIN * drift + PULSE_DIR * pulse + rng.normal(0, noise, 3)
                                   for _ in range(3)]))
        if k % 12 == 0:
            est.update()
    return est.update()


def simulate_breathing(rate, fps=20, seconds=40, amp_px=0.5, flow_noise=0.05, seed=0):
    rng = np.random.default_rng(seed)
    est, pos, prev = RespirationEstimator(("chest", "head")), 0.0, 0.0
    readings = []
    for k in range(int(fps * seconds)):
        t = k / fps
        true = amp_px * np.sin(2 * np.pi * rate / 60 * t)
        pos += (true - prev) + rng.normal(0, flow_noise)   # summed optical flow
        prev = true
        est.add(t, [pos, 200 + rng.normal(0, 0.4)])
        if k % 10 == 0 and t > 25:
            value = est.update()
            if value:
                readings.append(value)
    return float(np.median(readings))


@pytest.mark.parametrize("bpm", [55, 72, 95, 130])
def test_heart_rate(bpm):
    assert simulate_heart(bpm) == pytest.approx(bpm, abs=3)


@pytest.mark.parametrize("rate", [8, 12, 16, 20])
def test_breathing_rate(rate):
    assert simulate_breathing(rate) == pytest.approx(rate, abs=1)


def test_heart_rate_rejects_pure_noise():
    rng = np.random.default_rng(5)
    est, t = HeartRateEstimator(), 0.0
    for k in range(25 * 20):
        t += 1 / 25
        est.add(t, np.concatenate([SKIN + rng.normal(0, 0.5, 3) for _ in range(3)]))
        if k % 12 == 0:
            est.update()
    est.update()
    assert not est.signal_ok
