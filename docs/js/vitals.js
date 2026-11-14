// Heart rate, breathing rate, blink rate and the average heart rate monitor.
// Ported from vitals.py and app.py (AverageBpmMonitor) of the desktop app.
import {
  HR_BAND_HZ, HR_FS, RESP_BAND_HZ, RESP_FS, bandpass, median, percentile, pickPeak,
  posPulse, powerSpectrum, refineRateHz, resampleUniform, std,
} from "./dsp.js";

// Keeps (timestamp, values) pairs from the last `windowSec` seconds.
class RollingBuffer {
  constructor(windowSec) {
    this.windowSec = windowSec;
    this.clear();
  }

  add(t, values) {
    this.t.push(t);
    this.x.push(values);
    let drop = 0;
    while (drop < this.t.length && t - this.t[drop] > this.windowSec) drop++;
    if (drop) { this.t.splice(0, drop); this.x.splice(0, drop); }
  }

  duration() {
    return this.t.length > 1 ? this.t[this.t.length - 1] - this.t[0] : 0;
  }

  // One array per channel.
  columns() {
    const channels = this.x[0].length;
    return Array.from({ length: channels }, (_, c) => this.x.map((row) => row[c]));
  }

  clear() {
    this.t = [];
    this.x = [];
  }
}

// Median of the last few good readings. Forgets them after a run of bad ones.
class SmoothedRate {
  constructor(smoothN = 3, maxBadUpdates = 4) {
    this.smoothN = smoothN;
    this.maxBadUpdates = maxBadUpdates;   // 4 updates x 0.5 s = 2 s of bad signal
    this.clear();
  }

  add(value) {
    this.history.push(value);
    if (this.history.length > this.smoothN) this.history.shift();
    this.badUpdates = 0;
  }

  miss() {
    this.badUpdates++;
    if (this.badUpdates >= this.maxBadUpdates) this.history = [];   // stale, show "--"
  }

  clear() {
    this.history = [];
    this.badUpdates = 0;
  }

  get value() {
    return this.history.length ? median(this.history) : null;
  }
}

// Heart rate from the mean skin colour of several face regions (POS per region,
// normalised spectra added together so the heartbeat adds up and noise does not).
export class HeartRateEstimator {
  constructor(windowSec = 10, minSec = 6, minSnrDb = -3) {
    this.buffer = new RollingBuffer(windowSec);
    this.minSec = minSec;
    this.minSnrDb = minSnrDb;
    this.rate = new SmoothedRate(3);
    this.snrDb = null;
    this.waveform = null;
  }

  // regionRgbs: flat list [R1, G1, B1, R2, G2, B2, ...], one triple per region.
  add(t, regionRgbs) {
    this.buffer.add(t, regionRgbs);
  }

  reset() {
    this.buffer.clear();
    this.rate.clear();
    this.snrDb = this.waveform = null;
  }

  update() {
    if (this.buffer.duration() < this.minSec) return this.rate.value;
    const cols = resampleUniform(this.buffer.t, this.buffer.columns(), HR_FS);
    const n = cols[0].length;
    if (n < 64) return this.rate.value;
    const [low, high] = HR_BAND_HZ;
    let combined = null, freqs = null;
    const waveform = new Float64Array(n);
    for (let c = 0; c + 2 < cols.length; c += 3) {
      const pulse = bandpass(posPulse(cols[c], cols[c + 1], cols[c + 2], HR_FS), "hr");
      const spectrum = powerSpectrum(pulse, HR_FS);
      freqs = spectrum.freqs;
      let total = 0;
      for (let k = 0; k < freqs.length; k++) {
        if (freqs[k] >= low && freqs[k] <= high) total += spectrum.power[k];
      }
      if (total <= 0) continue;
      if (combined === null) combined = new Float64Array(freqs.length);
      for (let k = 0; k < combined.length; k++) combined[k] += spectrum.power[k] / total;
      const s = std(pulse) + 1e-9;
      for (let i = 0; i < n; i++) waveform[i] += pulse[i] / s;
    }
    if (combined === null) return this.rate.value;
    const previous = this.rate.value ? this.rate.value / 60 : null;
    let freq;
    [freq, this.snrDb] = pickPeak(freqs, combined, low, high, 0.15, previous);
    this.waveform = waveform;
    if (this.snrDb >= this.minSnrDb) {
      freq = refineRateHz(waveform, HR_FS, freq, 0.15, 3);
      this.rate.add(freq * 60);
    } else {
      this.rate.miss();
    }
    return this.rate.value;
  }

  get signalOk() {
    return this.snrDb !== null && this.snrDb >= this.minSnrDb;
  }
}

// Breathing rate from several motion signals (chest and head). Keeps the clearest one.
export class RespirationEstimator {
  constructor(channelNames, windowSec = 30, minSec = 15, minSnrDb = -3) {
    this.channelNames = channelNames;
    this.buffer = new RollingBuffer(windowSec);
    this.minSec = minSec;
    this.minSnrDb = minSnrDb;
    this.rate = new SmoothedRate(3);
    this.snrDb = this.waveform = this.channel = null;
  }

  add(t, values) {
    this.buffer.add(t, values);
  }

  reset() {
    this.buffer.clear();
    this.rate.clear();
    this.snrDb = this.waveform = this.channel = null;
  }

  get channelName() {
    return this.channel !== null ? this.channelNames[this.channel] : null;
  }

  update() {
    if (this.buffer.duration() < this.minSec) return this.rate.value;
    const cols = resampleUniform(this.buffer.t, this.buffer.columns(), RESP_FS);
    if (cols[0].length < 64) return this.rate.value;
    const previous = this.rate.value ? this.rate.value / 60 : null;
    let best = null;
    cols.forEach((raw, channel) => {
      if (std(raw) < 1e-6) return;                       // this signal isn't available
      const filtered = bandpass(raw, "resp");
      const { freqs, power } = powerSpectrum(filtered, RESP_FS, 8192);
      const [freq, snr] = pickPeak(freqs, power, ...RESP_BAND_HZ, 0.05, previous);
      if (best === null || snr > best.snr) best = { freq, snr, filtered, channel };
    });
    if (best === null || best.snr < this.minSnrDb) {
      this.rate.miss();
      return this.rate.value;
    }
    this.snrDb = best.snr;
    this.waveform = best.filtered;
    this.channel = best.channel;
    this.rate.add(60 * refineRateHz(best.filtered, RESP_FS, best.freq, 0.25, 2));
    return this.rate.value;
  }
}

// Counts blinks from the eye aspect ratio (EAR) with a per-person threshold.
export class BlinkCounter {
  constructor(closedRatio = 0.75, minFrames = 2, maxFrames = 15, windowSec = 60) {
    Object.assign(this, { closedRatio, minFrames, maxFrames, windowSec });
    this.reset();
  }

  reset() {
    this.earHistory = [];
    this.closedFrames = 0;
    this.blinkTimes = [];
    this.start = null;
  }

  update(t, ear) {
    if (this.start === null) this.start = t;
    this.earHistory.push(ear);
    if (this.earHistory.length > 300) this.earHistory.shift();
    const openLevel = percentile(this.earHistory, 90);    // this person's open-eye EAR
    if (ear < this.closedRatio * openLevel) {
      this.closedFrames++;
    } else {
      if (this.closedFrames >= this.minFrames && this.closedFrames <= this.maxFrames) {
        this.blinkTimes.push(t);
      }
      this.closedFrames = 0;
    }
    while (this.blinkTimes.length && t - this.blinkTimes[0] > this.windowSec) this.blinkTimes.shift();
  }

  ratePerMin(t) {
    if (this.start === null) return null;
    const elapsed = Math.min(this.windowSec, t - this.start);
    return elapsed < 10 ? null : this.blinkTimes.length * 60 / elapsed;
  }
}

// Records the live heart rate for a fixed period and reports the average.
// One reading per second while a heart rate is shown. With no reading (no face,
// or still measuring) recording pauses, so the result always covers `duration`
// seconds of real readings. Once complete, the final average is kept until reset().
export class AverageBpmMonitor {
  static SAMPLE_EVERY_SEC = 1;

  constructor(durationSec) {
    this.duration = durationSec;
    this.reset();
  }

  reset() {
    this.readings = [];
    this.lastSample = -1e9;
    this.paused = false;
    this.result = null;
  }

  get done() {
    return this.result !== null;
  }

  get recordedSec() {
    return this.readings.length * AverageBpmMonitor.SAMPLE_EVERY_SEC;
  }

  get progress() {
    return Math.min(1, this.recordedSec / this.duration);
  }

  get runningAverage() {
    if (!this.readings.length) return null;
    return this.readings.reduce((a, b) => a + b, 0) / this.readings.length;
  }

  // now: time in seconds. bpm: the live heart rate, or null when there isn't one.
  update(now, bpm) {
    if (this.done) return;
    this.paused = bpm === null;
    if (bpm === null || now - this.lastSample < AverageBpmMonitor.SAMPLE_EVERY_SEC) return;
    this.lastSample = now;
    this.readings.push(bpm);
    if (this.recordedSec >= this.duration) this.result = this.runningAverage;
  }
}
