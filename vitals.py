"""Signal processing for camera-based heart rate and breathing rate.

Everything here is pure NumPy/SciPy, so it can be tested without a camera.
"""
from collections import deque

import numpy as np
from scipy.signal import butter, detrend, find_peaks, sosfiltfilt

HR_BAND_HZ = (0.75, 3.0)   # 45-180 beats per minute
# 5.1-36 breaths per minute. The band starts below 6/min so that slow breathing
# at 6/min (the guided exercise) isn't on the band edge, where it was missed.
RESP_BAND_HZ = (0.085, 0.6)
HR_FS = 30.0               # resampling rate for the pulse signal (Hz)
RESP_FS = 10.0             # resampling rate for the breathing signal (Hz)


def resample_uniform(t, x, fs):
    """Frames arrive at uneven intervals. Interpolate onto an even time grid."""
    t = np.asarray(t, dtype=float)
    x = np.asarray(x, dtype=float)
    t_uniform = np.arange(t[0], t[-1], 1.0 / fs)
    if x.ndim == 1:
        return t_uniform, np.interp(t_uniform, t, x)
    columns = [np.interp(t_uniform, t, x[:, i]) for i in range(x.shape[1])]
    return t_uniform, np.stack(columns, axis=1)


def bandpass(x, fs, low, high, order=3, padlen=None):
    """Zero-phase Butterworth bandpass filter.

    padlen=None keeps SciPy's default (short) padding, used for heart rate.
    Breathing passes a longer padlen: at a 0.1 Hz cutoff the filter rings for
    several seconds, and the default padding left those edge transients inside
    a 30 s window.
    """
    sos = butter(order, [low, high], btype="band", fs=fs, output="sos")
    if padlen is None:
        return sosfiltfilt(sos, x)
    return sosfiltfilt(sos, x, padlen=min(int(padlen), len(x) - 1))


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


def power_spectrum(x, fs, nfft_min=4096):
    """Hann-windowed, zero-padded power spectrum."""
    n = len(x)
    nfft = max(nfft_min, 1 << int(np.ceil(np.log2(n))))
    spectrum = np.abs(np.fft.rfft((x - x.mean()) * np.hanning(n), n=nfft)) ** 2
    return np.fft.rfftfreq(nfft, 1.0 / fs), spectrum


def pick_peak(freqs, power, low, high, peak_width_hz, previous_hz=None, min_relative=0.5,
              max_jump_hz=None):
    """Choose the rate frequency in a band. Returns (frequency Hz, SNR dB).

    - Only true local peaks count. A maximum sitting on the band edge is
      usually leakage from slow drift, which made readings come out too low.
    - If several peaks are strong (at least `min_relative` of the biggest),
      the one closest to the previous reading wins, so a brief motion
      artifact can't make the reading jump.
    - max_jump_hz limits that preference to peaks near the previous reading.
      Without it, a wrong first reading could keep winning against a much
      stronger true peak anywhere in the band. None keeps the old behavior.
    """
    in_band = (freqs >= low) & (freqs <= high)
    f, p = freqs[in_band], power[in_band]
    peaks, _ = find_peaks(p)
    if len(peaks) == 0:
        choice = int(np.argmax(p))
    else:
        choice = int(peaks[np.argmax(p[peaks])])
        if previous_hz is not None:
            strong = peaks[p[peaks] >= min_relative * p[choice]]
            if max_jump_hz is not None:
                strong = strong[np.abs(f[strong] - previous_hz) <= max_jump_hz]
            if len(strong):
                choice = int(strong[np.argmin(np.abs(f[strong] - previous_hz))])
    peak = f[choice]
    near_peak = np.abs(f - peak) <= peak_width_hz
    snr = p[near_peak].sum() / (p[~near_peak].sum() + 1e-12)
    return float(peak), float(10.0 * np.log10(snr + 1e-12))


def refine_rate_hz(signal, fs, freq, max_change, min_cycles):
    """Refine a rate by timing the individual cycles (heartbeats or breaths).

    The FFT peak can sit slightly too low: background noise is stronger at
    low frequencies and tilts the peak that way, and a 10 s window can only
    resolve about 6 BPM. Timing each beat avoids both problems.

    Gaps far from the expected length (a missed or doubled beat) are skipped
    rather than averaged in, because a missed beat would drag the rate down.
    Falls back to `freq` if there are too few clean cycles or the result
    disagrees with it by more than `max_change` (a fraction, e.g. 0.15).
    """
    period = 1.0 / freq
    peaks, _ = find_peaks(signal, distance=max(1, int(0.6 * period * fs)),
                          prominence=0.3 * signal.std())
    if len(peaks) < min_cycles + 1:
        return freq
    times = []
    for i in peaks:
        offset = 0.0
        if 0 < i < len(signal) - 1:                   # fit a parabola for sub-sample timing
            a, b, c = signal[i - 1], signal[i], signal[i + 1]
            denominator = a - 2.0 * b + c
            if denominator != 0:
                offset = 0.5 * (a - c) / denominator
        times.append((i + offset) / fs)
    intervals = np.diff(times)
    good = intervals[np.abs(intervals - period) <= 0.3 * period]
    if len(good) < min_cycles:
        return freq
    refined = 1.0 / good.mean()
    return refined if abs(refined - freq) <= max_change * freq else freq


def clip_jumps(x, limit=6.0):
    """Cap sample-to-sample steps at `limit` robust standard deviations.

    Shifting in the chair moves the chest a few pixels within a frame or two.
    Removing a linear trend can't undo a step like that, and the step would
    swamp the breathing. Breathing moves the chest smoothly, so its steps
    normally stay well inside the cap.
    """
    steps = np.diff(x)
    median = np.median(steps)
    spread = 1.4826 * np.median(np.abs(steps - median))   # robust standard deviation
    if spread < 1e-9:              # most steps identical (e.g. the chest was out of view)
        return x
    steps = np.clip(steps, median - limit * spread, median + limit * spread)
    return np.concatenate([[x[0]], x[0] + np.cumsum(steps)])


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


class SmoothedRate:
    """Median of the last few good readings. Forgets them after a run of bad ones."""

    def __init__(self, smooth_n=3, max_bad_updates=4):
        self.history = deque(maxlen=smooth_n)
        self.max_bad_updates = max_bad_updates   # 4 updates x 0.5 s = 2 s of bad signal
        self.bad_updates = 0

    def add(self, value):
        self.history.append(value)
        self.bad_updates = 0

    def miss(self):
        self.bad_updates += 1
        if self.bad_updates >= self.max_bad_updates:
            self.history.clear()                 # old readings are stale, show "--"

    def clear(self):
        self.history.clear()
        self.bad_updates = 0

    @property
    def value(self):
        return float(np.median(self.history)) if self.history else None


class HeartRateEstimator:
    """Heart rate from the mean skin color of several face regions.

    Each region gets its own POS pulse signal. Their spectra are normalized and
    added together, so the heartbeat (present in every region) adds up while
    noise (different in each region) does not.
    """

    def __init__(self, window_sec=10.0, min_sec=6.0, min_snr_db=-3.0,
                 min_regions_agree=2, agree_hz=0.1):
        self.buffer = RollingBuffer(window_sec)
        self.min_regions_agree = min_regions_agree   # of the 3 face regions
        self.agree_hz = agree_hz                     # 0.1 Hz = 6 BPM
        self.regions_agree = None
        self.min_sec = min_sec
        self.min_snr_db = min_snr_db
        self.rate = SmoothedRate(smooth_n=3)
        self.snr_db = None
        self.waveform = None

    def add(self, t, region_rgbs):
        """region_rgbs: flat list [R1, G1, B1, R2, G2, B2, ...], one triple per region."""
        self.buffer.add(t, region_rgbs)

    def reset(self):
        self.buffer.clear()
        self.rate.clear()
        self.snr_db = self.waveform = None
        self.regions_agree = None

    def update(self):
        if self.buffer.duration() < self.min_sec:
            return self.rate.value
        t, x = self.buffer.arrays()
        _, x_uniform = resample_uniform(t, x, HR_FS)
        if len(x_uniform) < 64:
            return self.rate.value
        rgb = x_uniform.reshape(len(x_uniform), -1, 3)    # (samples, regions, 3)
        low, high = HR_BAND_HZ
        combined = None
        region_peaks = []
        waveform = np.zeros(len(rgb))
        for region in range(rgb.shape[1]):
            pulse = bandpass(pos_pulse(rgb[:, region, :], HR_FS), HR_FS, low, high)
            freqs, power = power_spectrum(pulse, HR_FS)
            total = power[(freqs >= low) & (freqs <= high)].sum()
            if total <= 0:
                continue
            combined = power / total if combined is None else combined + power / total
            region_peaks.append(pick_peak(freqs, power, low, high, peak_width_hz=0.15)[0])
            waveform += pulse / (pulse.std() + 1e-9)
        if combined is None:
            return self.rate.value
        previous = self.rate.value / 60.0 if self.rate.value else None
        freq, self.snr_db = pick_peak(freqs, combined, low, high, peak_width_hz=0.15,
                                      previous_hz=previous, min_relative=0.7,
                                      max_jump_hz=0.15)
        self.waveform = waveform
        # The pulse is in every region; noise usually isn't. Require agreement.
        self.regions_agree = int(sum(abs(f - freq) <= self.agree_hz for f in region_peaks))
        if self.snr_db >= self.min_snr_db and self.regions_agree >= self.min_regions_agree:
            self.rate.add(freq * 60.0)
        else:
            self.rate.miss()
        return self.rate.value

    @property
    def signal_ok(self):
        return (self.snr_db is not None and self.snr_db >= self.min_snr_db
                and (self.regions_agree or 0) >= self.min_regions_agree)


class RespirationEstimator:
    """Breathing rate from several motion signals (e.g. chest and head).

    `channel_names` lists the signals in order of trust, most trusted first.
    For each signal it finds the strongest breathing frequency. The first
    signal (the chest) is used whenever it passes its own check, because
    head sway can look like a slow breath; the others are a fallback, used
    only when the first fails. The rate is then refined by timing the actual
    breaths, which is more precise than the FFT alone, whose resolution over
    a 30 s window is about 2 breaths per minute.
    """

    def __init__(self, channel_names, window_sec=30.0, min_sec=20.0, min_snr_db=-3.0,
                 stale_sec=1.0):
        self.channel_names = channel_names
        self.buffer = RollingBuffer(window_sec)
        self.min_sec = min_sec
        self.min_snr_db = min_snr_db
        self.stale_sec = stale_sec      # no new samples for longer than this: no reading
        self.rate = SmoothedRate(smooth_n=3)
        self.snr_db = None
        self.waveform = None
        self.channel = None

    def add(self, t, values):
        """values: one number per channel, in the order of `channel_names`."""
        self.buffer.add(t, values)

    def reset(self):
        self.buffer.clear()
        self.rate.clear()
        self.snr_db = self.waveform = self.channel = None

    @property
    def channel_name(self):
        return self.channel_names[self.channel] if self.channel is not None else None

    def update(self, now=None):
        """now: the current time, on the same clock as add(). When no sample has
        arrived for over `stale_sec` (the face left the frame), the old reading is
        dropped instead of being recomputed from the same old samples."""
        if now is not None and (not self.buffer.t or now - self.buffer.t[-1] > self.stale_sec):
            self.rate.clear()
            self.snr_db = self.waveform = self.channel = None
            return None
        if self.buffer.duration() < self.min_sec:
            return self.rate.value
        t, x = self.buffer.arrays()
        _, x_uniform = resample_uniform(t, x, RESP_FS)
        if len(x_uniform) < 64:
            return self.rate.value
        previous = self.rate.value / 60.0 if self.rate.value else None
        found = []
        for channel in range(x_uniform.shape[1]):
            raw = x_uniform[:, channel]
            if raw.std() < 1e-6:                         # this signal isn't available
                continue
            # A posture shift is a sudden jump; cap it first. Summed optical flow
            # also drifts like a random walk, so remove the trend, then filter with
            # padding long enough for the low cutoff.
            raw = detrend(clip_jumps(raw), type="linear")
            filtered = bandpass(raw, RESP_FS, *RESP_BAND_HZ, padlen=10 * RESP_FS)
            freqs, power = power_spectrum(filtered, RESP_FS, nfft_min=8192)
            freq, snr = pick_peak(freqs, power, *RESP_BAND_HZ, peak_width_hz=0.05,
                                  previous_hz=previous, min_relative=0.7,
                                  max_jump_hz=0.05)
            found.append((freq, snr, filtered, channel))
        if not found:
            self.rate.miss()
            return self.rate.value
        first = next((f for f in found if f[3] == 0), None)
        if first is not None and first[1] >= self.min_snr_db:
            best = first                                 # the chest passed its check: use it
        else:
            best = max(found, key=lambda f: f[1])        # fallback: the clearest other signal
        if best[1] < self.min_snr_db:
            self.rate.miss()
            return self.rate.value
        freq, self.snr_db, self.waveform, self.channel = best
        freq = refine_rate_hz(self.waveform, RESP_FS, freq, max_change=0.25, min_cycles=2)
        self.rate.add(60.0 * freq)
        return self.rate.value


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
