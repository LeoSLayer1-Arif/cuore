// Signal processing helpers, ported from vitals.py (NumPy/SciPy) to plain JavaScript.
// Each function matches the SciPy/NumPy function named in its comment.

export const HR_BAND_HZ = [0.75, 3.0];   // 45-180 beats per minute
export const RESP_BAND_HZ = [0.1, 0.6];  // 6-36 breaths per minute
export const HR_FS = 30.0;               // resampling rate for the pulse signal (Hz)
export const RESP_FS = 10.0;             // resampling rate for the breathing signal (Hz)

// scipy.signal.butter(3, band, btype="band", fs=fs, output="sos"), precomputed for the
// two fixed sample rates above. Each row is [b0, b1, b2, a0, a1, a2].
const SOS = {
  hr: [
    [0.008598686086321939, 0.017197372172643877, 0.008598686086321939, 1, -1.532373232577131, 0.6128007881399321],
    [1, 0, -1, 1, -1.405080008832269, 0.699090412936612],
    [1, -2, 1, 1, -1.8750968766280283, 0.9011683591342556],
  ],
  resp: [
    [0.002898194633721428, 0.005796389267442856, 0.002898194633721428, 1, -1.6561172859627726, 0.769092400879302],
    [1, 0, -1, 1, -1.7059650539817517, 0.7265425280053609],
    [1, -2, 1, 1, -1.947962261242795, 0.9522118752382963],
  ],
};

export function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}

// np.std (population standard deviation)
export function std(x) {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - m) ** 2;
  return x.length ? Math.sqrt(s / x.length) : 0;
}

// np.percentile with linear interpolation
export function percentile(values, q) {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values) {
  return percentile(values, 50);
}

// Frames arrive at uneven intervals. Interpolate onto an even time grid (np.arange + np.interp).
// t: sample times. columns: one array per channel. Returns one Float64Array per channel.
export function resampleUniform(t, columns, fs) {
  const t0 = t[0];
  const n = Math.max(0, Math.ceil((t[t.length - 1] - t0) * fs));
  const out = columns.map(() => new Float64Array(n));
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ti = t0 + i / fs;
    while (j < t.length - 2 && t[j + 1] <= ti) j++;
    const span = t[j + 1] - t[j];
    const w = span > 0 ? (ti - t[j]) / span : 0;
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      out[c][i] = col[j] + (col[j + 1] - col[j]) * w;
    }
  }
  return out;
}

// Direct-form II transposed second-order sections (scipy.signal.sosfilt) with initial state.
function sosfilt(sos, x, zi) {
  const y = Float64Array.from(x);
  for (let s = 0; s < sos.length; s++) {
    const [b0, b1, b2, , a1, a2] = sos[s];
    let z0 = zi[s][0], z1 = zi[s][1];
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = b0 * xi + z0;
      z0 = b1 * xi - a1 * yi + z1;
      z1 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

// scipy.signal.sosfilt_zi: steady-state filter state for a step input of height 1.
function sosfiltZi(sos) {
  let scale = 1;
  return sos.map(([b0, b1, b2, a0, a1, a2]) => {
    const B0 = b1 - a1 * b0, B1 = b2 - a2 * b0;
    const det = 1 + a1 + a2;
    const zi = [scale * (B0 + B1) / det, scale * ((1 + a1) * B1 - a2 * B0) / det];
    scale *= (b0 + b1 + b2) / (a0 + a1 + a2);
    return zi;
  });
}

// scipy.signal.sosfiltfilt with its default odd-extension padding.
function sosfiltfilt(sos, x) {
  const n = x.length;
  const padlen = Math.min(3 * (2 * sos.length + 1), n - 1);
  const ext = new Float64Array(n + 2 * padlen);
  for (let i = 0; i < padlen; i++) ext[i] = 2 * x[0] - x[padlen - i];
  ext.set(x, padlen);
  for (let i = 0; i < padlen; i++) ext[padlen + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const zi = sosfiltZi(sos);
  const scaled = (v) => zi.map(([a, b]) => [a * v, b * v]);
  const forward = sosfilt(sos, ext, scaled(ext[0])).reverse();
  const backward = sosfilt(sos, forward, scaled(forward[0])).reverse();
  return backward.slice(padlen, padlen + n);
}

// Zero-phase Butterworth bandpass filter for the heart-rate or breathing band.
export function bandpass(x, kind) {
  return sosfiltfilt(SOS[kind], x);
}

// Plane-Orthogonal-to-Skin (POS) algorithm, Wang et al., IEEE TBME 2017.
// r, g, b: mean skin colour per frame. Returns a pulse signal of the same length.
export function posPulse(r, g, b, fs = HR_FS, winSec = 1.6) {
  const n = r.length;
  const win = Math.round(winSec * fs);
  const pulse = new Float64Array(n);
  const s0 = new Float64Array(win), s1 = new Float64Array(win);
  for (let start = 0; start + win <= n; start++) {
    let mr = 0, mg = 0, mb = 0;
    for (let k = start; k < start + win; k++) { mr += r[k]; mg += g[k]; mb += b[k]; }
    mr /= win; mg /= win; mb /= win;
    if (mr <= 0 || mg <= 0 || mb <= 0) continue;
    for (let k = 0; k < win; k++) {
      const rn = r[start + k] / mr, gn = g[start + k] / mg, bn = b[start + k] / mb;
      s0[k] = gn - bn;
      s1[k] = -2 * rn + gn + bn;
    }
    const alpha = std(s0) / (std(s1) + 1e-9);
    let hMean = 0;
    for (let k = 0; k < win; k++) hMean += s0[k] + alpha * s1[k];
    hMean /= win;
    for (let k = 0; k < win; k++) pulse[start + k] += s0[k] + alpha * s1[k] - hMean;  // overlap-add
  }
  return pulse;
}

// In-place iterative radix-2 FFT. re and im have a power-of-two length.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(step * k), wi = Math.sin(step * k);
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// Hann-windowed, zero-padded power spectrum (np.hanning + np.fft.rfft).
export function powerSpectrum(x, fs, nfftMin = 4096) {
  const n = x.length;
  const nfft = Math.max(nfftMin, 1 << Math.ceil(Math.log2(n)));
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  const m = mean(x);
  for (let i = 0; i < n; i++) {
    const w = n > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) : 1;
    re[i] = (x[i] - m) * w;
  }
  fft(re, im);
  const bins = nfft / 2 + 1;
  const freqs = new Float64Array(bins), power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freqs[k] = k * fs / nfft;
    power[k] = re[k] * re[k] + im[k] * im[k];
  }
  return { freqs, power };
}

// scipy.signal.find_peaks with optional `distance` and `prominence`, same algorithm and order.
export function findPeaks(x, { distance = null, prominence = null } = {}) {
  let peaks = [];
  const iMax = x.length - 1;
  for (let i = 1; i < iMax; i++) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < iMax && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push(Math.floor((i + ahead - 1) / 2));   // middle of a flat top
        i = ahead;
      }
    }
  }
  if (distance !== null && peaks.length > 1) {
    const d = Math.ceil(distance);
    const keep = peaks.map(() => true);
    const order = peaks.map((_, i) => i).sort((a, b) => x[peaks[a]] - x[peaks[b]]);
    for (let o = order.length - 1; o >= 0; o--) {
      const j = order[o];
      if (!keep[j]) continue;
      for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = false;
      for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < d; k++) keep[k] = false;
    }
    peaks = peaks.filter((_, i) => keep[i]);
  }
  if (prominence !== null) {
    peaks = peaks.filter((p) => {
      let leftMin = x[p], rightMin = x[p];
      for (let i = p; i >= 0 && x[i] <= x[p]; i--) leftMin = Math.min(leftMin, x[i]);
      for (let i = p; i <= iMax && x[i] <= x[p]; i++) rightMin = Math.min(rightMin, x[i]);
      return x[p] - Math.max(leftMin, rightMin) >= prominence;
    });
  }
  return peaks;
}

// Choose the rate frequency in a band. Returns [frequency Hz, SNR dB]. See vitals.pick_peak.
export function pickPeak(freqs, power, low, high, peakWidthHz, previousHz = null, minRelative = 0.5) {
  const f = [], p = [];
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= low && freqs[i] <= high) { f.push(freqs[i]); p.push(power[i]); }
  }
  const peaks = findPeaks(p);
  let choice;
  if (!peaks.length) {
    choice = p.indexOf(Math.max(...p));
  } else {
    choice = peaks.reduce((best, i) => (p[i] > p[best] ? i : best), peaks[0]);
    if (previousHz !== null) {
      const strong = peaks.filter((i) => p[i] >= minRelative * p[choice]);
      choice = strong.reduce((best, i) =>
        (Math.abs(f[i] - previousHz) < Math.abs(f[best] - previousHz) ? i : best), strong[0]);
    }
  }
  const peak = f[choice];
  let near = 0, far = 0;
  for (let i = 0; i < f.length; i++) {
    if (Math.abs(f[i] - peak) <= peakWidthHz) near += p[i]; else far += p[i];
  }
  return [peak, 10 * Math.log10(near / (far + 1e-12) + 1e-12)];
}

// Refine a rate by timing individual cycles (heartbeats or breaths). See vitals.refine_rate_hz.
export function refineRateHz(signal, fs, freq, maxChange, minCycles) {
  const period = 1 / freq;
  const peaks = findPeaks(signal, {
    distance: Math.max(1, Math.floor(0.6 * period * fs)),
    prominence: 0.3 * std(signal),
  });
  if (peaks.length < minCycles + 1) return freq;
  const times = peaks.map((i) => {
    let offset = 0;
    if (i > 0 && i < signal.length - 1) {               // parabola fit for sub-sample timing
      const a = signal[i - 1], b = signal[i], c = signal[i + 1];
      const denominator = a - 2 * b + c;
      if (denominator !== 0) offset = 0.5 * (a - c) / denominator;
    }
    return (i + offset) / fs;
  });
  const good = [];
  for (let i = 1; i < times.length; i++) {
    const interval = times[i] - times[i - 1];
    if (Math.abs(interval - period) <= 0.3 * period) good.push(interval);
  }
  if (good.length < minCycles) return freq;
  const refined = 1 / mean(good);
  return Math.abs(refined - freq) <= maxChange * freq ? refined : freq;
}
