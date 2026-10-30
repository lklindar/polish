// What to draw for a given source time: camera, motion blur, webcam redraw and click ripples.
// Pure, so the preview and the export compose identical frames.

import type { EDL } from './edl';
import { webcamAt } from './layout';
import type { FrameState } from '../render/compositor';
import { cameraAt, project, type ZoomSettings } from './zoom';

const RIPPLE_SEC = 0.35;

export function frameState(edl: EDL, zoom: ZoomSettings, t: number, fps = 30): FrameState {
  const L = edl.layout;
  const content = L?.content ?? { x: 0, y: 0, w: edl.source.width, h: edl.source.height };
  const zooms = zoom.enabled ? edl.zooms : edl.zooms.filter((z) => z.source === 'manual');
  const camera = cameraAt(zooms, content, t);

  let blur = { x: 0, y: 0 };
  if (zoom.motionBlur && camera.scale > 1.001) {
    // Subtle blur along fast pans only: follow the camera centre (a zoom in/out moves the viewport
    // corner a lot but isn't a pan), and cap the streak length.
    const prev = cameraAt(zooms, content, t - 1 / fps);
    const dx = camera.cx - prev.cx;
    const dy = camera.cy - prev.cy;
    const d = Math.hypot(dx, dy);
    // Only for pans while fully zoomed; zooming in/out reads better without streaks.
    const zoomingNow = Math.abs(camera.scale - prev.scale) > 0.002;
    if (d > 6 && !zoomingNow) {
      const len = Math.min(10, d * 0.35);
      blur = { x: (dx / d) * len, y: (dy / d) * len };
    }
  }

  const ripples = zoom.ripple
    ? edl.clicks
        .filter((c) => c.confidence >= zoom.minConfidence && t >= c.t && t < c.t + RIPPLE_SEC)
        .map((c) => ({ ...project(camera, content, c.x, c.y), p: (t - c.t) / RIPPLE_SEC }))
    : [];

  return { camera, blur, content, radius: L?.radius ?? 0, webcam: L ? webcamAt(L.webcam, t) : null, ripples };
}
