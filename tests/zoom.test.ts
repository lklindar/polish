import { describe, expect, it } from 'vitest';
import { inferClicks, trackCursor, type InferredClick } from '../src/core/clicks';
import { CHANGE_FIELDS, CHANGE_SLOTS, CURSOR_FIELDS, CURSOR_SLOTS, type FrameData } from '../src/core/frameData';
import { detectContentRect, type Layout } from '../src/core/layout';
import { cameraAt, clampCamera, easeInOut, planZooms, project, viewport, type ZoomSettings } from '../src/core/zoom';

const content = { x: 100, y: 50, w: 1400, h: 900 };
const zs: ZoomSettings = { enabled: true, scale: 1.8, minConfidence: 0.5, followCursor: false, motionBlur: false, ripple: false };
const click = (t: number, x = 800, y = 500, confidence = 0.8): InferredClick => ({ t, x, y, confidence, reason: 'local' });

describe('easing', () => {
  it('cubic-bezier(0.65,0,0.35,1) is symmetric, monotonic and flat at the ends', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 3);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 3);
    let prev = 0;
    for (let x = 0.01; x <= 1; x += 0.01) {
      const y = easeInOut(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
    expect(easeInOut(0.05)).toBeLessThan(0.01); // no linear start
  });
});

describe('click grouping → zoom blocks', () => {
  it('groups clicks < 3 s apart into one block that pans, separate otherwise', () => {
    const z = planZooms([click(10, 300, 200), click(11.5, 1200, 800), click(20)], null, content, zs);
    expect(z).toHaveLength(2);
    expect(z[0].start).toBeCloseTo(10 - 0.4 - 0.35);
    expect(z[0].end).toBeCloseTo(11.5 + 1.2 + 0.8);
    expect(z[0].focus.map((f) => f.x)).toEqual([300, 1200]);
  });

  it('ignores low-confidence clicks and merges blocks that would touch', () => {
    expect(planZooms([click(5, 800, 500, 0.3)], null, content, zs)).toHaveLength(0);
    // 3.2 s apart (two groups), but block 1 ends at 12.0 and block 2 starts at 12.45: they merge.
    expect(planZooms([click(10), click(13.2)], null, content, zs)).toHaveLength(1);
    expect(planZooms([click(10), click(16)], null, content, zs)).toHaveLength(2);
  });
});

describe('camera', () => {
  const zooms = planZooms([click(10, 120, 60)], null, content, zs); // click near the top-left corner

  it('eases in, holds, eases out', () => {
    expect(cameraAt(zooms, content, zooms[0].start).scale).toBeCloseTo(1);
    expect(cameraAt(zooms, content, 10).scale).toBeGreaterThan(1.5);
    expect(cameraAt(zooms, content, 10.8).scale).toBeCloseTo(1.8);
    expect(cameraAt(zooms, content, zooms[0].end - 0.001).scale).toBeLessThan(1.01);
    expect(cameraAt(zooms, content, 50).scale).toBe(1);
  });

  it('never shows anything outside the content rect', () => {
    for (let t = zooms[0].start; t < zooms[0].end; t += 0.05) {
      const v = viewport(cameraAt(zooms, content, t), content);
      expect(v.x).toBeGreaterThanOrEqual(content.x - 1e-6);
      expect(v.y).toBeGreaterThanOrEqual(content.y - 1e-6);
      expect(v.x + v.w).toBeLessThanOrEqual(content.x + content.w + 1e-6);
      expect(v.y + v.h).toBeLessThanOrEqual(content.y + content.h + 1e-6);
    }
    const c = clampCamera({ scale: 2, cx: -500, cy: 5000 }, content);
    expect(c.cx).toBe(content.x + content.w / 4);
  });

  it('projects the click point onto the screen consistently', () => {
    const cam = cameraAt(zooms, content, 10.8);
    const p = project(cam, content, 120, 60);
    // The clamped camera pins the top-left corner, so a point there stays near the corner.
    expect(p.x).toBeCloseTo(content.x + (120 - content.x) * 1.8, 0);
    expect(p.y).toBeCloseTo(content.y + (60 - content.y) * 1.8, 0);
  });

  it('pans smoothly (no jumps) between clicks of one block', () => {
    // A 1000 px pan over 0.8 s peaks near 2.5 px/ms with this easing; a jump would be ~1000 px.
    const z = planZooms([click(10, 300, 300), click(12, 1300, 800)], null, content, zs);
    let prev = cameraAt(z, content, z[0].start);
    for (let t = z[0].start + 0.02; t < z[0].end; t += 0.02) {
      const cur = cameraAt(z, content, t);
      expect(Math.hypot(cur.cx - prev.cx, cur.cy - prev.cy)).toBeLessThan(60);
      prev = cur;
    }
  });
});

describe('layout', () => {
  it('finds the window inside padding and its rounded corner', () => {
    const W = 400;
    const H = 260;
    const img = new Uint8Array(W * H).fill(60); // background
    const r = 6;
    for (let y = 20; y < 240; y++) {
      for (let x = 30; x < 370; x++) {
        const dx = Math.max(30 + r - x, 0, x - (369 - r));
        const dy = Math.max(20 + r - y, 0, y - (239 - r));
        if (dx * dx + dy * dy <= r * r) img[y * W + x] = 240; // window
      }
    }
    const res = detectContentRect(img, W, H);
    expect(res.styled).toBe(true);
    expect(Math.abs(res.rect.x - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(res.rect.y - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(res.rect.x + res.rect.w - 370)).toBeLessThanOrEqual(1);
    expect(Math.abs(res.rect.y + res.rect.h - 240)).toBeLessThanOrEqual(1);
    expect(res.radius).toBeGreaterThanOrEqual(3);
  });

  it('treats an unstyled recording as full-frame content', () => {
    const img = new Uint8Array(400 * 260).fill(230);
    expect(detectContentRect(img, 400, 260).styled).toBe(false);
  });
});

/**
 * Synthetic "video": a dot moves to a box, rests, and the box changes colour 0.3 s later (a click);
 * later it rests elsewhere with nothing happening (no click), and rests on a box that was already
 * flickering before it arrived (no click).
 */
function syntheticFrames(): FrameData {
  const fps = 15;
  const frames = 15 * 12;
  const cursorCands = new Float32Array(frames * CURSOR_SLOTS * CURSOR_FIELDS).fill(NaN);
  const changes = new Float32Array(frames * CHANGE_SLOTS * CHANGE_FIELDS).fill(NaN);
  const changedFrac = new Float32Array(frames);
  let px = 50;
  let py = 50;
  const moveTo = (f0: number, f1: number, x: number, y: number) => {
    for (let f = f0; f <= f1; f++) {
      const a = (f - f0 + 1) / (f1 - f0 + 1);
      const nx = px + (x - px) * a;
      const ny = py + (y - py) * a;
      cursorCands.set([nx, ny, 20, nx - (x - px) / (f1 - f0 + 1), ny - (y - py) / (f1 - f0 + 1)], f * CURSOR_SLOTS * CURSOR_FIELDS);
    }
    px = x;
    py = y;
  };
  const change = (f: number, x0: number, y0: number, x1: number, y1: number, cells: number) =>
    changes.set([x0, y0, x1, y1, cells], f * CHANGE_SLOTS * CHANGE_FIELDS);

  moveTo(5, 15, 200, 150); // arrive at the box at frame 15 (1.0 s)
  change(20, 180, 140, 240, 170, 8); // box turns colour 0.33 s later → click
  moveTo(40, 50, 300, 100); // rest at 3.3 s: nothing happens
  for (let f = 70; f < 110; f += 2) change(f, 380, 180, 420, 200, 4); // a flickering widget
  moveTo(80, 90, 400, 190); // rest on it at 6 s
  return {
    fps,
    frames,
    width: 500,
    height: 300,
    scale: 1,
    cursorCands,
    changes,
    changedFrac,
    motionGrid: { cols: 1, rows: 1, cell: 8, blockSec: 4, blocks: 0, data: new Uint8Array(0) },
    snapshots: { width: 1, height: 1, scale: 1, blockSec: 4, count: 0, data: new Uint8Array(0) },
    still: new Uint8Array(500 * 300),
  };
}

describe('click inference (synthetic dot + box)', () => {
  const fd = syntheticFrames();
  const layout: Layout = { content: { x: 0, y: 0, w: 500, h: 300 }, radius: 0, styled: false, webcam: [] };
  const track = trackCursor(fd, layout);

  it('tracks the dot and holds its position while it rests', () => {
    expect(track.x[30]).toBeCloseTo(200, 0);
    expect(track.y[30]).toBeCloseTo(150, 0);
  });

  it('finds exactly the real click, at the box, just before the reaction', () => {
    const clicks = inferClicks(fd, layout, track).filter((c) => c.confidence >= 0.5);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].x).toBeCloseTo(200, 0);
    expect(clicks[0].t).toBeGreaterThan(1.0);
    expect(clicks[0].t).toBeLessThan(20 / 15);
  });

  it('never places a click inside the webcam bubble', () => {
    const withCam: Layout = { ...layout, webcam: [{ t0: 0, t1: 12, x: 200, y: 150, r: 40 }] };
    for (const c of inferClicks(fd, withCam, trackCursor(fd, withCam))) {
      expect(Math.hypot(c.x - 200, c.y - 150)).toBeGreaterThan(40);
    }
  });
});
