// Caption drawing shared by the preview canvas and the export worker (OffscreenCanvas), so what
// you see is what gets burned in. Lines come from the caption text; the active word is tinted.

import type { Caption } from './edl';
import type { CaptionSettings } from './captions';
import type { Circle } from './layout';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const FONT = '600 {px}px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** `avoid` (in canvas px) is the webcam bubble: the caption box slides sideways or above to clear it. */
export function drawCaption(ctx: Ctx, cap: Caption, t: number, s: CaptionSettings, width: number, height: number, avoid?: Circle | null) {
  const px = Math.round(height * s.size);
  ctx.save();
  ctx.font = FONT.replace('{px}', String(px));
  ctx.textBaseline = 'alphabetic';
  const lines = cap.text.split('\n').map((l) => l.split(' ').filter(Boolean));
  const space = ctx.measureText(' ').width;
  const widths = lines.map((ws) => ws.reduce((a, w) => a + ctx.measureText(w).width, 0) + space * Math.max(0, ws.length - 1));
  const lineH = px * 1.3;
  const padX = px * 0.6;
  const padY = px * 0.38;
  const boxW = Math.max(...widths) + padX * 2;
  const boxH = lines.length * lineH + padY * 2 - (lineH - px * 1.05);
  let x0 = (width - boxW) / 2;
  let y0 = height - height * 0.06 - boxH;
  if (avoid) {
    const gap = px * 0.6;
    const hits = (x: number, y: number) =>
      x < avoid.x + avoid.r + gap && avoid.x - avoid.r - gap < x + boxW && y < avoid.y + avoid.r + gap && avoid.y - avoid.r - gap < y + boxH;
    if (hits(x0, y0)) {
      const side = avoid.x < width / 2 ? avoid.x + avoid.r + gap : avoid.x - avoid.r - gap - boxW;
      if (side >= gap && side + boxW <= width - gap) x0 = side;
      else y0 = Math.max(gap, avoid.y - avoid.r - gap - boxH);
    }
  }
  const shift = x0 - (width - boxW) / 2;

  // Fade in/out over 120 ms.
  const fade = Math.min(1, (t - cap.start) / 0.12, (cap.end - t) / 0.12);
  ctx.globalAlpha = Math.max(0, fade);
  ctx.fillStyle = 'rgba(10,10,14,0.72)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, boxW, boxH, px * 0.35);
  ctx.fill();

  // Active word index (by time) across the caption's words.
  let active = -1;
  if (s.highlightWord) {
    for (let i = 0; i < cap.words.length; i++) if (t >= cap.words[i].t0) active = i;
  }
  let wi = 0;
  lines.forEach((ws, li) => {
    let x = (width - widths[li]) / 2 + shift;
    const y = y0 + padY + px * 0.95 + li * lineH;
    for (const w of ws) {
      ctx.fillStyle = wi === active ? '#c4b8ff' : wi < active ? '#ffffff' : 'rgba(255,255,255,0.86)';
      ctx.fillText(w, x, y);
      x += ctx.measureText(w).width + space;
      wi++;
    }
  });
  ctx.restore();
}
