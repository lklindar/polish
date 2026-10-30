// Auto-zoom: clicks → zoom blocks, and the camera (scale + centre) at any source time.
// The camera is a pure function of the block, so preview, export and seeking always agree.

import type { InferredClick, CursorTrack } from './clicks';
import type { ZoomBlock } from './edl';
import type { Rect } from './layout';

export interface ZoomSettings {
  enabled: boolean;
  scale: number;
  /** Clicks below this confidence don't create zooms (they're still shown on the clicks track). */
  minConfidence: number;
  followCursor: boolean;
  motionBlur: boolean;
  ripple: boolean;
}

export const ZOOM_IN_SEC = 0.7;
export const ZOOM_OUT_SEC = 0.8;
const LEAD_SEC = 0.4; // zoom is half-way in this long before the first click
const HOLD_SEC = 1.2; // after the last click
const GROUP_GAP_SEC = 3;
const PAN_SEC = 0.8;
const DEAD_ZONE = 0.6; // inner share of the viewport the cursor may roam without moving the camera

/** cubic-bezier(0.65, 0, 0.35, 1), solved for y at x. */
export function easeInOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const p1x = 0.65, p1y = 0, p2x = 0.35, p2y = 1;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * p1x + 3 * (1 - t) * t * t * p2x + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * p1y + 3 * (1 - t) * t * t * p2y + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** Groups clicks < 3 s apart into blocks, with cursor-follow focus keyframes baked in. */
export function planZooms(clicks: InferredClick[], track: CursorTrack | null, content: Rect, s: ZoomSettings): ZoomBlock[] {
  if (!s.enabled) return [];
  const usable = clicks.filter((c) => c.confidence >= s.minConfidence).sort((a, b) => a.t - b.t);
  const groups: InferredClick[][] = [];
  for (const c of usable) {
    const g = groups[groups.length - 1];
    if (g && c.t - g[g.length - 1].t < GROUP_GAP_SEC) g.push(c);
    else groups.push([c]);
  }
  const blocks: ZoomBlock[] = groups.map((g) => {
    const start = Math.max(0, g[0].t - LEAD_SEC - ZOOM_IN_SEC / 2);
    const end = g[g.length - 1].t + HOLD_SEC + ZOOM_OUT_SEC;
    return { start, end, scale: s.scale, focus: focusPath(g, track, content, s, start, end), source: 'auto' as const };
  });
  // Blocks that would touch merge, so the camera pans instead of zooming out and back in.
  const merged: ZoomBlock[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.start - last.end < 0.5) {
      last.end = b.end;
      last.focus = [...last.focus, ...b.focus].sort((x, y) => x.t - y.t);
    } else merged.push(b);
  }
  return merged;
}

/**
 * Focus keyframes: each click, plus (with follow on) a new keyframe whenever the cursor leaves the
 * dead zone of the current viewport, so the camera only moves when the cursor nears the edge.
 */
function focusPath(clicks: InferredClick[], track: CursorTrack | null, content: Rect, s: ZoomSettings, start: number, end: number) {
  const vw = content.w / s.scale;
  const vh = content.h / s.scale;
  const keys: { t: number; x: number; y: number }[] = [];
  let cx = clicks[0].x;
  let cy = clicks[0].y;
  keys.push({ t: start, x: cx, y: cy });
  let ci = 1;
  const step = 0.1;
  for (let t = clicks[0].t; t < end - ZOOM_OUT_SEC; t += step) {
    let tx: number | null = null;
    let ty: number | null = null;
    while (ci < clicks.length && clicks[ci].t <= t) {
      tx = clicks[ci].x;
      ty = clicks[ci].y;
      ci++;
    }
    if (tx == null && s.followCursor && track) {
      const f = Math.min(track.x.length - 1, Math.round(t * track.fps));
      const px = track.x[f];
      const py = track.y[f];
      if (!Number.isNaN(px)) {
        const ex = Math.abs(px - cx) - (vw / 2) * DEAD_ZONE;
        const ey = Math.abs(py - cy) - (vh / 2) * DEAD_ZONE;
        if (ex > 0 || ey > 0) {
          tx = ex > 0 ? cx + Math.sign(px - cx) * ex : cx;
          ty = ey > 0 ? cy + Math.sign(py - cy) * ey : cy;
        }
      }
    }
    if (tx != null && ty != null && Math.hypot(tx - cx, ty - cy) > 12) {
      const last = keys[keys.length - 1];
      // Debounce: fold keyframes closer than a pan into one.
      if (t - last.t < PAN_SEC * 0.6 && keys.length > 1) keys.pop();
      cx = tx;
      cy = ty;
      keys.push({ t, x: cx, y: cy });
    }
  }
  return keys;
}

export interface Camera {
  /** Zoom factor (1 = none). */
  scale: number;
  /** Viewport centre in source px. */
  cx: number;
  cy: number;
}

export function zoomAt(zooms: ZoomBlock[], t: number): ZoomBlock | null {
  for (const z of zooms) if (t >= z.start && t < z.end) return z;
  return null;
}

/** Camera for source time t: eased zoom envelope, eased pans between focus keys, clamped to content. */
export function cameraAt(zooms: ZoomBlock[], content: Rect, t: number): Camera {
  const centre = { scale: 1, cx: content.x + content.w / 2, cy: content.y + content.h / 2 };
  const z = zoomAt(zooms, t);
  if (!z) return centre;
  const inDur = Math.min(ZOOM_IN_SEC, (z.end - z.start) / 2);
  const outDur = Math.min(ZOOM_OUT_SEC, (z.end - z.start) / 2);
  const env = t < z.start + inDur ? easeInOut((t - z.start) / inDur) : t > z.end - outDur ? easeInOut((z.end - t) / outDur) : 1;
  const scale = 1 + (z.scale - 1) * env;

  // Target: hold the previous key, ease into each key over the PAN_SEC before it.
  const keys = z.focus.length ? z.focus : [{ t: z.start, x: centre.cx, y: centre.cy }];
  let tx = keys[0].x;
  let ty = keys[0].y;
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    // Longer moves get longer pans (0.6–1.2 s) so the camera never whips across the screen.
    const dist = Math.hypot(k.x - keys[i - 1].x, k.y - keys[i - 1].y);
    const pan = Math.min(Math.min(1.2, Math.max(0.6, 0.5 + dist / 1500)), k.t - keys[i - 1].t);
    if (t >= k.t) {
      tx = k.x;
      ty = k.y;
    } else if (t > k.t - pan) {
      const e = easeInOut((t - (k.t - pan)) / pan);
      tx = tx + (k.x - tx) * e;
      ty = ty + (k.y - ty) * e;
      break;
    } else break;
  }
  return clampCamera({ scale, cx: tx, cy: ty }, content);
}

/** Keeps the viewport inside the content rect: never shows outside the frame. */
export function clampCamera(c: Camera, content: Rect): Camera {
  const vw = content.w / c.scale;
  const vh = content.h / c.scale;
  return {
    scale: c.scale,
    cx: Math.min(content.x + content.w - vw / 2, Math.max(content.x + vw / 2, c.cx)),
    cy: Math.min(content.y + content.h - vh / 2, Math.max(content.y + vh / 2, c.cy)),
  };
}

/** Viewport rect (source px) for a camera. */
export function viewport(c: Camera, content: Rect): Rect {
  const w = content.w / c.scale;
  const h = content.h / c.scale;
  return { x: c.cx - w / 2, y: c.cy - h / 2, w, h };
}

/** Maps a source point inside the content to where it appears on screen under the camera. */
export function project(c: Camera, content: Rect, x: number, y: number) {
  const v = viewport(c, content);
  return { x: content.x + (x - v.x) * c.scale, y: content.y + (y - v.y) * c.scale };
}
