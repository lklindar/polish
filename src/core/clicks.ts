// Cursor path and click inference from pixels only (no click metadata). Inputs are the worker's
// per-frame cursor candidates and change regions; outputs are in source pixels / seconds.

import { CHANGE_FIELDS, CHANGE_SLOTS, CURSOR_FIELDS, CURSOR_SLOTS, type FrameData } from './frameData';
import type { Layout } from './layout';

export interface CursorTrack {
  fps: number;
  /** Per analysis frame: source-px position (held while the cursor rests), NaN before first seen. */
  x: Float32Array;
  y: Float32Array;
  /** 1 where the cursor was actually observed moving in that frame. */
  seen: Uint8Array;
}

export interface InferredClick {
  t: number;
  x: number;
  y: number;
  confidence: number;
  reason: 'local' | 'navigation' | 'shape' | 'hover';
}

/** Reaches ~100 px/frame at half-res 15 fps (a fast flick). */
const MAX_JUMP = 140;
const LOST_FRAMES = 45; // 3 s without an association → re-acquire anywhere

/** Inside the screen content and clear of the webcam bubble (any fit within ±8 s, since the fit
 * can flicker between neighbouring estimates of the same bubble). */
function inside(layout: Layout, t: number, x: number, y: number): boolean {
  const c = layout.content;
  if (x < c.x || y < c.y || x > c.x + c.w || y > c.y + c.h) return false;
  return !layout.webcam.some((w) => w.t1 > t - 8 && w.t0 < t + 8 && Math.hypot(x - w.x, y - w.y) < w.r);
}

export function trackCursor(fd: FrameData, layout: Layout): CursorTrack {
  const n = fd.frames;
  const k = 1 / fd.scale;
  const x = new Float32Array(n).fill(NaN);
  const y = new Float32Array(n).fill(NaN);
  const seen = new Uint8Array(n);
  let px = NaN;
  let py = NaN;
  let vx = 0;
  let vy = 0;
  let lastSeen = -1e9;
  // Paired candidates of the previous frame: a pointer moving on its own forms a chain where each
  // blob's "left from" spot is the previous blob. That's how a fast flick is re-acquired at once.
  let prevPaired: [number, number][] = [];

  for (let f = 0; f < n; f++) {
    const t = f / fd.fps;
    let best = -1;
    let bestCost = Infinity;
    const paired: [number, number][] = [];
    for (let s = 0; s < CURSOR_SLOTS; s++) {
      const o = (f * CURSOR_SLOTS + s) * CURSOR_FIELDS;
      const cx = fd.cursorCands[o];
      if (Number.isNaN(cx)) break;
      const cy = fd.cursorCands[o + 1];
      if (!inside(layout, t, cx * k, cy * k)) continue;
      const lx = fd.cursorCands[o + 3];
      const ly = fd.cursorCands[o + 4];
      const isPaired = !Number.isNaN(lx);
      if (isPaired) paired.push([cx, cy]);
      const chained = isPaired && prevPaired.some(([qx, qy]) => Math.hypot(lx - qx, ly - qy) < 12);
      let cost: number;
      if (Number.isNaN(px) || f - lastSeen > LOST_FRAMES) {
        // (Re)acquire: only trust a blob that moved (has a matching "left from" blob).
        cost = isPaired ? Math.hypot(lx - cx, ly - cy) : Infinity;
      } else {
        // Strongest evidence: the blob it left from is where we last had the cursor.
        const fromHere = isPaired ? Math.hypot(lx - px, ly - py) : Infinity;
        const predicted = Math.hypot(cx - (px + vx), cy - (py + vy));
        cost = fromHere < 10 ? fromHere * 0.2 : predicted;
        // Unpaired dark blobs (e.g. typed text appearing) only count as a short continuation.
        if (fromHere >= 10 && (predicted > MAX_JUMP || (!isPaired && predicted > 25))) cost = Infinity;
        // A chained blob far from the track: the pointer flicked faster than the gate allows.
        if (cost === Infinity && chained) cost = 50;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = o;
      }
    }
    prevPaired = paired;
    if (best >= 0 && bestCost < Infinity) {
      const cx = fd.cursorCands[best];
      const cy = fd.cursorCands[best + 1];
      if (!Number.isNaN(px) && f - lastSeen <= 2) {
        vx = 0.5 * vx + 0.5 * (cx - px);
        vy = 0.5 * vy + 0.5 * (cy - py);
      } else {
        vx = 0;
        vy = 0;
      }
      px = cx;
      py = cy;
      lastSeen = f;
      seen[f] = 1;
    } else if (f - lastSeen > 1) {
      // No movement → resting; stop predicting motion.
      vx = 0;
      vy = 0;
    }
    x[f] = px * k;
    y[f] = py * k;
  }
  return { fps: fd.fps, x, y, seen };
}

/**
 * Click = the cursor comes to rest (≥ 270 ms) and, within 0.7 s, the UI reacts near it (button
 * state, highlight, dropdown) or the whole screen changes (navigation). A small change right at
 * the cursor (arrow ↔ hand) is a weaker hint. Changes in the first 130 ms of a rest are likely
 * hover effects of arriving, so they score low.
 */
export function inferClicks(fd: FrameData, layout: Layout, track: CursorTrack): InferredClick[] {
  const k = 1 / fd.scale;
  const fps = fd.fps;
  const out: InferredClick[] = [];
  const n = fd.frames;
  // A click keeps the pointer still for press + release; shorter pauses are mid-move hesitations.
  const minRest = Math.round(0.27 * fps);
  const windowF = Math.round(0.7 * fps);
  const hoverF = Math.round(0.13 * fps);
  const near = 70 * k; // source px from cursor to region edge

  let f = 1;
  while (f < n) {
    // A rest starts after the last observed movement frame.
    if (!(track.seen[f - 1] && !track.seen[f])) {
      f++;
      continue;
    }
    const restStart = f;
    let restEnd = f;
    while (restEnd < n && !track.seen[restEnd]) restEnd++;
    if (restEnd - restStart < minRest || Number.isNaN(track.x[f])) {
      f = restEnd + 1;
      continue;
    }
    const cx = track.x[f];
    const cy = track.y[f];
    const t0 = restStart / fps;
    if (!inside(layout, t0, cx, cy)) {
      f = restEnd + 1;
      continue;
    }

    // UI that was already changing near the cursor before it stopped (streaming text, a spinner)
    // isn't a reaction to a click. Changes made by the moving pointer itself don't count.
    const busyBefore = (rx0: number, ry0: number, rx1: number, ry1: number) => {
      // Look at up to 0.6 s of frames where the pointer wasn't moving, reaching back at most 2 s.
      let checked = 0;
      for (let g = restStart - 2; g >= Math.max(1, restStart - 2 * fps) && checked < Math.round(0.6 * fps); g--) {
        if (track.seen[g] || track.seen[g + 1]) continue;
        checked++;
        for (let s = 0; s < CHANGE_SLOTS; s++) {
          const o = (g * CHANGE_SLOTS + s) * CHANGE_FIELDS;
          if (Number.isNaN(fd.changes[o])) break;
          const ox0 = fd.changes[o] * k, oy0 = fd.changes[o + 1] * k, ox1 = fd.changes[o + 2] * k, oy1 = fd.changes[o + 3] * k;
          if (fd.changes[o + 4] > 3 && ox0 < rx1 && rx0 < ox1 && oy0 < ry1 && ry0 < oy1) return true;
        }
      }
      return false;
    };

    let found: InferredClick | null = null;
    // The reaction must start while the pointer is still resting (or right as it leaves).
    for (let g = restStart; g < Math.min(n, restStart + windowF, restEnd + 1); g++) {
      const t = g / fps;
      // Navigation / big content change.
      if (fd.changedFrac[g] > 0.12) {
        found = { t: Math.max(t0, t - 0.1), x: cx, y: cy, confidence: g - restStart < hoverF ? 0.45 : 0.6, reason: 'navigation' };
        break;
      }
      for (let s = 0; s < CHANGE_SLOTS; s++) {
        const o = (g * CHANGE_SLOTS + s) * CHANGE_FIELDS;
        if (Number.isNaN(fd.changes[o])) break;
        const x0 = fd.changes[o] * k;
        const y0 = fd.changes[o + 1] * k;
        const x1 = fd.changes[o + 2] * k;
        const y1 = fd.changes[o + 3] * k;
        const cells = fd.changes[o + 4];
        const dx = Math.max(x0 - cx, 0, cx - x1);
        const dy = Math.max(y0 - cy, 0, cy - y1);
        if (Math.hypot(dx, dy) > near) continue;
        // A tiny change hugging the cursor is the pointer changing shape (mostly hovering a link).
        const atCursor = cells <= 3 && Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) < 20 * k;
        if (!atCursor && busyBefore(x0, y0, x1, y1)) continue;
        const hover = g - restStart < hoverF;
        // The thing under the pointer reacting (button state, menu opening) is the strongest sign.
        const underPointer = cx >= x0 - 8 * k && cx <= x1 + 8 * k && cy >= y0 - 8 * k && cy <= y1 + 8 * k;
        let confidence = atCursor ? 0.3 : hover ? 0.3 : (underPointer ? 0.62 : 0.45) + Math.min(0.25, cells / 40);
        if (!atCursor && !hover && fd.changedFrac[g] > 0.03) confidence += 0.1;
        // Measured on a real recording with ground truth: real clicks cause bigger reactions and the
        // pointer stays put a while after; hover tooltips/highlights are small and the pointer moves on.
        if (!atCursor && !hover && cells < 6) confidence -= 0.15;
        if (restEnd - g < Math.round(0.2 * fps)) confidence -= 0.1;
        const cand: InferredClick = {
          t: Math.max(t0, t - 0.1),
          x: cx,
          y: cy,
          confidence: Math.min(0.95, confidence),
          reason: atCursor ? 'shape' : hover ? 'hover' : 'local',
        };
        if (!found || cand.confidence > found.confidence) found = cand;
      }
      if (found && found.confidence >= 0.55) break;
    }
    if (found) out.push({ ...found, confidence: Math.round(found.confidence * 100) / 100 });
    f = restEnd + 1;
  }
  return out;
}
