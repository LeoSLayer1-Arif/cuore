// Face regions, skin colour sampling, eye aspect ratio and chest motion.
// Ported from app.py. All coordinates are pixels in the processing frame.
import { percentile } from "./dsp.js";

// MediaPipe Face Mesh landmark indices (478-point model).
export const FOREHEAD = [10, 338, 297, 332, 151, 9, 103, 67, 109];
export const LEFT_CHEEK = [117, 118, 101, 36, 205, 187, 123, 116];
export const RIGHT_CHEEK = [346, 347, 330, 266, 425, 411, 352, 345];
export const LEFT_EYE = [33, 160, 158, 133, 153, 144];     // p1..p6 for the eye aspect ratio
export const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const FACE_TOP = 10, CHIN = 152, FACE_LEFT = 234, FACE_RIGHT = 454;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function toPixels(landmarks, width, height) {
  return landmarks.map((p) => [p.x * width, p.y * height]);
}

// Convex hull (monotone chain), counter-clockwise.
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Convex hull of some landmarks, optionally shrunk toward its centre to avoid hair and brows.
export function regionPolygon(points, indices, shrink = 1) {
  const hull = convexHull(indices.map((i) => points[i]));
  if (shrink >= 1) return hull;
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => [cx + (x - cx) * shrink, cy + (y - cy) * shrink]);
}

// Mean R, G, B of the skin inside a convex polygon, ignoring shine and shadows.
// data: RGBA pixels of the whole frame (ImageData.data).
export function regionMeanRgb(data, width, height, polygon) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of polygon) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(width - 1, Math.ceil(x1)); y1 = Math.min(height - 1, Math.ceil(y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const step = (x1 - x0) * (y1 - y0) > 6000 ? 2 : 1;      // sample every other pixel on big regions
  const n = polygon.length;
  const rs = [], gs = [], bs = [], brightness = [];
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      let inside = true;                                 // hull is counter-clockwise
      for (let i = 0; i < n && inside; i++) {
        const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % n];
        inside = (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
      }
      if (!inside) continue;
      const k = (y * width + x) * 4;
      rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]);
      brightness.push((data[k] + data[k + 1] + data[k + 2]) / 3);
    }
  }
  if (rs.length < 20) return null;
  const minBright = Math.max(30, percentile(brightness, 10));   // drop shadows, brows, hair
  let r = 0, g = 0, b = 0, kept = 0;
  for (let i = 0; i < rs.length; i++) {
    if (Math.max(rs[i], gs[i], bs[i]) < 245 && brightness[i] > minBright) {   // drop shine
      r += rs[i]; g += gs[i]; b += bs[i]; kept++;
    }
  }
  if (kept < 20) {
    r = rs.reduce((a, v) => a + v, 0); g = gs.reduce((a, v) => a + v, 0);
    b = bs.reduce((a, v) => a + v, 0); kept = rs.length;
  }
  return [r / kept, g / kept, b / kept];
}

export function eyeAspectRatio(points, indices) {
  const p = indices.map((i) => points[i]);
  const vertical = dist(p[1], p[5]) + dist(p[2], p[4]);
  return vertical / (2 * dist(p[0], p[3]) + 1e-6);
}

export function meanY(points) {
  return points.reduce((s, p) => s + p[1], 0) / points.length;
}

// Up-and-down movement of the chest and shoulders. Breathing moves the chest far
// more than the head, so this gives a cleaner breathing signal when the shoulders show.
//
// The desktop app uses OpenCV's dense optical flow here. In the browser this uses a
// cheaper equivalent: a single vertical Lucas-Kanade step over the 30% of pixels with
// the strongest vertical edges (shoulder line, collar, shirt folds), where up/down
// movement can actually be seen.
export class ChestMotion {
  constructor() {
    this.reset();
  }

  reset() {
    this.prev = null;
    this.position = 0;
    this.box = null;
  }

  update(data, width, height, points) {
    const chin = points[CHIN];
    const faceHeight = dist(points[CHIN], points[FACE_TOP]);
    const faceWidth = dist(points[FACE_RIGHT], points[FACE_LEFT]);
    const x0 = Math.max(0, Math.floor(chin[0] - faceWidth));
    const x1 = Math.min(width, Math.floor(chin[0] + faceWidth));
    const y0 = Math.min(height, Math.floor(chin[1] + 0.3 * faceHeight));
    const y1 = Math.min(height, Math.floor(chin[1] + 1.2 * faceHeight));
    this.box = x1 - x0 >= 40 && y1 - y0 >= 30 ? [x0, y0, x1, y1] : null;
    const gray = grayscale(data, width, height);
    if (this.box && this.prev) {
      const factor = Math.max(1, Math.ceil((x1 - x0) / 160));      // shrink for speed
      const before = shrink(this.prev, width, this.box, factor);
      const after = shrink(gray, width, this.box, factor);
      this.position += verticalShift(before, after) * factor;     // in pixels
    }
    this.prev = gray;
    return this.position;
  }
}

function grayscale(data, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0, k = 0; i < gray.length; i++, k += 4) {
    gray[i] = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  }
  return gray;
}

// Crop a box from a greyscale frame and average it down by an integer factor.
function shrink(gray, width, [x0, y0, x1, y1], factor) {
  const w = Math.floor((x1 - x0) / factor), h = Math.floor((y1 - y0) / factor);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y0 + y * factor + dy) * width + x0 + x * factor;
        for (let dx = 0; dx < factor; dx++) s += gray[row + dx];
      }
      out[y * w + x] = s / (factor * factor);
    }
  }
  return { data: out, w, h };
}

// Typical vertical movement (pixels, down is positive) between two small images.
function verticalShift(before, after) {
  const { w, h } = after;
  const iy = [], it = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // vertical gradient averaged over both frames, and the change over time
      iy.push(0.25 * (after.data[i + w] - after.data[i - w] + before.data[i + w] - before.data[i - w]));
      it.push(after.data[i] - before.data[i]);
    }
  }
  if (iy.length < 20) return 0;
  const strength = iy.map(Math.abs);
  const cutoff = percentile(strength, 70);
  let num = 0, den = 0;
  for (let i = 0; i < iy.length; i++) {
    if (strength[i] >= cutoff) { num += iy[i] * it[i]; den += iy[i] * iy[i]; }
  }
  if (den < 1e-6) return 0;
  const shift = -num / den;
  return Math.max(-3, Math.min(3, shift));         // a big jump is a movement, not breathing
}
