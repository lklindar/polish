// Screen layout of a (possibly pre-styled) recording: the app-window rectangle inside any padding /
// background, and the webcam bubble over time. Everything returned is in source pixels.

import type { FrameData } from './frameData';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface WebcamSpan extends Circle {
  t0: number;
  t1: number;
}

export interface Layout {
  /** Screen content (the app window), source px. Equals the full frame for unstyled recordings. */
  content: Rect;
  /** Corner radius of the content window, source px. */
  radius: number;
  /** True when padding/background was found around the content (already styled input). */
  styled: boolean;
  webcam: WebcamSpan[];
}

const EDGE = 14; // luma step that counts as an edge

/**
 * Finds the window rectangle in a median still: the outermost columns/rows where a long, straight
 * edge runs through most of the frame (window border against the background).
 */
export function detectContentRect(still: Uint8Array, W: number, H: number): { rect: Rect; radius: number; styled: boolean } {
  const colScore = new Float32Array(W);
  const rowScore = new Float32Array(H);
  const y0 = Math.floor(H * 0.1);
  const y1 = Math.ceil(H * 0.9);
  const x0 = Math.floor(W * 0.1);
  const x1 = Math.ceil(W * 0.9);
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (Math.abs(still[y * W + x + 1] - still[y * W + x - 1]) > EDGE) colScore[x]++;
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = x0; x < x1; x++) {
      if (Math.abs(still[(y + 1) * W + x] - still[(y - 1) * W + x]) > EDGE) rowScore[y]++;
    }
  }
  for (let x = 0; x < W; x++) colScore[x] /= y1 - y0;
  for (let y = 0; y < H; y++) rowScore[y] /= x1 - x0;

  // An edge column spans most of the height; take the outermost strong one on each side
  // (an edge may smear over 2 px, so require it be a local max).
  const pick = (score: Float32Array, from: number, to: number, outermostFirst: boolean) => {
    const step = from < to ? 1 : -1;
    let best = -1;
    let bestScore = 0;
    for (let i = from; i !== to; i += step) {
      if (score[i] >= 0.5 && score[i] >= (score[i - 1] ?? 0) && score[i] >= (score[i + 1] ?? 0)) {
        if (outermostFirst) return i;
        if (score[i] > bestScore) {
          bestScore = score[i];
          best = i;
        }
      }
    }
    return best;
  };
  const left = pick(colScore, 1, Math.floor(W * 0.3), true);
  const right = pick(colScore, W - 2, Math.floor(W * 0.7), true);
  const top = pick(rowScore, 1, Math.floor(H * 0.3), true);
  const bottom = pick(rowScore, H - 2, Math.floor(H * 0.7), true);

  const styled = left > 0 && right > 0 && top > 0 && bottom > 0;
  if (!styled) return { rect: { x: 0, y: 0, w: W, h: H }, radius: 0, styled: false };
  const rect = { x: left + 1, y: top + 1, w: right - left - 1, h: bottom - top - 1 };

  // Corner radius: how far along the top edge the straight border starts.
  let radius = 0;
  for (let x = rect.x; x < rect.x + rect.w * 0.2; x++) {
    const i = top * W + x;
    if (Math.abs(still[i + W] - still[i - W]) > EDGE) {
      radius = x - rect.x;
      break;
    }
  }
  return { rect, radius, styled };
}

/** Sobel magnitude. */
function gradient(img: Uint8Array, W: number, H: number): Float32Array {
  const g = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = img[i - W + 1] + 2 * img[i + 1] + img[i + W + 1] - img[i - W - 1] - 2 * img[i - 1] - img[i + W - 1];
      const gy = img[i + W - 1] + 2 * img[i + W] + img[i + W + 1] - img[i - W - 1] - 2 * img[i - W] - img[i - W + 1];
      g[i] = Math.hypot(gx, gy);
    }
  }
  return g;
}

/** Mean gradient along a circle and the share of samples that sit on an edge. */
function circleScore(g: Float32Array, W: number, H: number, cx: number, cy: number, r: number): [number, number] {
  const n = 48;
  let sum = 0;
  let hits = 0;
  let inside = 0;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = Math.round(cx + r * Math.cos(a));
    const y = Math.round(cy + r * Math.sin(a));
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
    inside++;
    const v = g[y * W + x];
    sum += v;
    if (v > 60) hits++;
  }
  return inside < n * 0.6 ? [0, 0] : [sum / inside, hits / inside];
}

/**
 * Webcam bubble per motion block: the largest blob of "constantly changing" cells (a talking
 * head), refined to the circle whose edge is strongest in that block's snapshot. Consecutive
 * blocks with the same circle merge into one span.
 */
export function detectWebcam(fd: FrameData): WebcamSpan[] {
  const { cols, rows, cell, blockSec, blocks, data } = fd.motionGrid;
  const snap = fd.snapshots;
  const toSnap = snap.scale / fd.scale; // analysis px → snapshot px
  const perBlock: (Circle | null)[] = [];
  const label = new Int32Array(cols * rows);

  for (let b = 0; b < blocks; b++) {
    const base = b * cols * rows;
    label.fill(0);
    let best: { n: number; x0: number; y0: number; x1: number; y1: number } | null = null;
    let l = 0;
    for (let c = 0; c < cols * rows; c++) {
      if (label[c] || data[base + c] < 64) continue;
      l++;
      const stack = [c];
      label[c] = l;
      let n = 0, x0 = cols, y0 = rows, x1 = 0, y1 = 0;
      while (stack.length) {
        const k = stack.pop()!;
        const x = k % cols;
        const y = (k / cols) | 0;
        n++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (const q of [x > 0 ? k - 1 : -1, x < cols - 1 ? k + 1 : -1, y > 0 ? k - cols : -1, y < rows - 1 ? k + cols : -1]) {
          if (q >= 0 && !label[q] && data[base + q] >= 40) {
            label[q] = l;
            stack.push(q);
          }
        }
      }
      // A face blob is compact (roughly as tall as wide) and not tiny.
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      if (n >= 6 && bw / bh < 2.2 && bh / bw < 2.2 && n / (bw * bh) > 0.3 && (!best || n > best.n)) best = { n, x0, y0, x1, y1 };
    }
    if (!best || b >= snap.count) {
      perBlock.push(null);
      continue;
    }
    // Seed in snapshot px.
    const sx = (((best.x0 + best.x1 + 1) / 2) * cell) * toSnap;
    const sy = (((best.y0 + best.y1 + 1) / 2) * cell) * toSnap;
    const r0 = (Math.max(best.x1 - best.x0 + 1, best.y1 - best.y0 + 1) / 2) * cell * toSnap;
    const img = snap.data.subarray(b * snap.width * snap.height, (b + 1) * snap.width * snap.height);
    const g = gradient(img, snap.width, snap.height);
    let bestC: Circle | null = null;
    let bestS = 0;
    const span = Math.max(2, Math.round(r0 * 0.5));
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        for (let r = Math.max(4, r0 * 0.8); r <= r0 * 2.2; r += 1) {
          const [mean, hit] = circleScore(g, snap.width, snap.height, sx + dx, sy + dy, r);
          const s = mean * hit;
          if (hit >= 0.55 && s > bestS) {
            bestS = s;
            bestC = { x: sx + dx, y: sy + dy, r };
          }
        }
      }
    }
    const c = bestC ?? { x: sx, y: sy, r: r0 * 1.2 };
    // A webcam bubble is small relative to the frame; a huge "blob" is a panel animating.
    const maxR = 0.22 * Math.min(snap.width, snap.height);
    perBlock.push(c.r > maxR ? null : { x: c.x / snap.scale, y: c.y / snap.scale, r: c.r / snap.scale });
  }

  // The bubble sits in a few recurring places/sizes. Cluster the per-block circles, keep clusters
  // seen in ≥ 3 blocks, snap each block to its cluster, and bridge short gaps.
  const clusters: { members: Circle[]; c: Circle }[] = [];
  const assign: number[] = perBlock.map(() => -1);
  perBlock.forEach((c, b) => {
    if (!c) return;
    let ci = clusters.findIndex((k) => Math.hypot(k.c.x - c.x, k.c.y - c.y) < k.c.r * 0.35 && Math.abs(k.c.r - c.r) < k.c.r * 0.3);
    if (ci < 0) {
      clusters.push({ members: [], c: { ...c } });
      ci = clusters.length - 1;
    }
    const k = clusters[ci];
    k.members.push(c);
    const med = (key: keyof Circle) => k.members.map((m) => m[key]).sort((a, b2) => a - b2)[k.members.length >> 1];
    k.c = { x: med('x'), y: med('y'), r: med('r') };
    assign[b] = ci;
  });
  const valid = clusters.map((k) => k.members.length >= 3);
  const snapped: (Circle | null)[] = assign.map((ci) => (ci >= 0 && valid[ci] ? clusters[ci].c : null));
  for (let b = 1; b < snapped.length; b++) {
    if (snapped[b]) continue;
    let next = b;
    while (next < snapped.length && !snapped[next]) next++;
    if (snapped[b - 1] && next - b <= 3) for (let k = b; k < next; k++) snapped[k] = snapped[b - 1];
    b = next;
  }

  const spans: WebcamSpan[] = [];
  snapped.forEach((c, b) => {
    if (!c) return;
    const t0 = b * blockSec;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.t1 - t0) < 1e-6 && last.x === c.x && last.y === c.y && last.r === c.r) last.t1 = t0 + blockSec;
    else spans.push({ ...c, t0, t1: t0 + blockSec });
  });
  // Pad the bubble slightly so its border/shadow is excluded too.
  return spans.map((s) => ({ ...s, r: s.r * 1.04 }));
}

export function webcamAt(spans: WebcamSpan[], t: number): WebcamSpan | null {
  for (const s of spans) if (t >= s.t0 && t < s.t1) return s;
  return null;
}

export function detectLayout(fd: FrameData): Layout {
  const { rect, radius, styled } = detectContentRect(fd.still, fd.width, fd.height);
  const k = 1 / fd.scale;
  return {
    content: { x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k },
    radius: radius * k,
    styled,
    webcam: detectWebcam(fd),
  };
}
