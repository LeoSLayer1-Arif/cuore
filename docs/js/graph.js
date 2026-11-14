// Scrolling signal graph on a <canvas>: dashed grid, time axis, glowing line with area fill.

const GRID = "rgba(255, 255, 255, 0.08)";
const AXIS = "rgba(255, 255, 255, 0.18)";
const LABEL = "rgba(255, 255, 255, 0.42)";

export class SignalGraph {
  // seconds: how much history to show. color: CSS colour of the line.
  constructor(canvas, seconds, color) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.seconds = seconds;
    this.color = color;
  }

  // Match the canvas to its on-screen size so lines stay sharp on high-DPI phones.
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [width, height];
  }

  draw(waveform, fs) {
    const [width, height] = this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    const left = 2, right = width - 2, top = 4, bottom = height - 20;
    const plotW = right - left, plotH = bottom - top;
    if (plotW < 10 || plotH < 10) return;

    // Grid: dashed horizontal lines, a vertical line per time tick, labels underneath.
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = Math.round(top + plotH * i / 4) + 0.5;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    const step = this.seconds <= 10 ? 1 : 5;
    for (let s = step; s <= this.seconds; s += step) {
      const x = Math.round(right - plotW * s / this.seconds) + 0.5;
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(left, bottom + 0.5); ctx.lineTo(right, bottom + 0.5);
    ctx.stroke();

    ctx.font = "500 10px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = LABEL;
    ctx.textBaseline = "alphabetic";
    const labelEvery = plotW < 260 && step === 5 ? 10 : step;   // fewer labels on small screens
    for (let s = 0; s <= this.seconds; s += labelEvery) {
      const x = right - plotW * s / this.seconds;
      const label = s === 0 ? "now" : `-${s}s`;
      const lw = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(Math.max(x - lw / 2, left), right - lw), height - 5);
    }

    if (!waveform || waveform.length < 2) {
      ctx.font = "13px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("waiting for signal…", left + plotW / 2, top + plotH / 2 + 4);
      ctx.restore();
      return;
    }

    const count = Math.min(waveform.length, Math.round(this.seconds * fs));
    const segment = waveform.slice(waveform.length - count);
    // Scale with the 2nd-98th percentile so one spike doesn't flatten the curve.
    const sorted = Float64Array.from(segment).sort();
    const low = sorted[Math.floor(0.02 * (count - 1))], high = sorted[Math.ceil(0.98 * (count - 1))];
    const pad = 0.12 * plotH;
    const xs = new Float64Array(count), ys = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const v = Math.min(1, Math.max(0, (segment[i] - low) / (high - low + 1e-9)));
      xs[i] = right - (count - 1 - i) / fs / this.seconds * plotW;   // newest on the right
      ys[i] = bottom - pad - v * (plotH - 2 * pad);
    }

    const path = new Path2D();
    path.moveTo(xs[0], ys[0]);
    for (let i = 1; i < count; i++) path.lineTo(xs[i], ys[i]);

    const area = new Path2D(path);
    area.lineTo(xs[count - 1], bottom);
    area.lineTo(xs[0], bottom);
    area.closePath();
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, withAlpha(this.color, 0.32));
    gradient.addColorStop(1, withAlpha(this.color, 0.0));
    ctx.fillStyle = gradient;
    ctx.fill(area);

    ctx.lineJoin = ctx.lineCap = "round";
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = withAlpha(this.color, 0.7);
    ctx.shadowBlur = 8;
    ctx.stroke(path);
    ctx.shadowBlur = 0;

    const ex = xs[count - 1], ey = ys[count - 1];
    ctx.fillStyle = withAlpha(this.color, 0.3);
    ctx.beginPath(); ctx.arc(ex, ey, 8, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = this.color;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ex, ey, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

// "#rrggbb" -> "rgba(r, g, b, a)"
function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
