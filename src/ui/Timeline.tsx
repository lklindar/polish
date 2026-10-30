// Multi-track timeline on a single canvas, in source time: ruler, waveform with cut overlays, an
// edits track (gray = silence, blue = speed-up, yellow = filler, violet = manual), captions, zoom
// blocks (drag to move, drag an edge to resize) and inferred clicks.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrubPreview } from './ScrubPreview';
import { HoverFrames } from '../player/HoverFrames';
import type { Cut, EDL, ZoomBlock } from '../core/edl';
import { fmtTime } from '../core/format';
import { useStore, type Selection } from '../state/store';
import { usePlayer } from './playerContext';

const RULER_H = 22;
const WAVE_Y = RULER_H;
const WAVE_H = 84;
const EDITS_Y = WAVE_Y + WAVE_H + 6;
const EDITS_H = 22;
const CAPS_Y = EDITS_Y + EDITS_H + 6;
const CAPS_H = 20;
const ZOOM_Y = CAPS_Y + CAPS_H + 6;
const ZOOM_H = 22;
const CLICKS_Y = ZOOM_Y + ZOOM_H + 6;
const CLICKS_H = 14;
const HEIGHT = CLICKS_Y + CLICKS_H + 8;
const ZOOM_COLOR = '#22c55e';
const LABEL_W = 64;

export const CUT_COLORS: Record<Cut['type'] | 'speedup', string> = {
  silence: '#71717a',
  filler: '#eab308',
  repeat: '#f97316',
  manual: '#a78bfa',
  deadStartEnd: '#52525b',
  speedup: '#38bdf8',
};

interface View {
  pxPerSec: number;
  scroll: number; // source seconds at the left edge of the track area
}

export function Timeline() {
  const player = usePlayer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ pxPerSec: 0, scroll: 0 });
  const drag = useRef<
    | { kind: 'scrub' | 'range'; x0: number; t0: number; moved: boolean }
    | { kind: 'zoom'; mode: 'move' | 'start' | 'end'; index: number; x0: number; t0: number; orig: ZoomBlock; moved: boolean }
    | null
  >(null);
  const audio = useStore((s) => s.audio);
  const [hover, setHover] = useState<{ t: number; x: number; w: number } | null>(null);
  // One hidden video for hover previews, kept loaded for the whole editing session.
  const fileUrl = useStore((s) => s.fileUrl)!;
  const live = useMemo(() => new HoverFrames(fileUrl), [fileUrl]);
  useEffect(() => () => live.destroy(), [live]);
  const hoverRaf = useRef(0);
  const trackHover = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    cancelAnimationFrame(hoverRaf.current);
    if (x < LABEL_W) return setHover(null);
    const t = Math.min(useStore.getState().edl!.source.durationSec, Math.max(0, timeAt(x)));
    hoverRaf.current = requestAnimationFrame(() => setHover({ t, x, w: rect.width }));
  };

  // Normalize the waveform to the file's own loudness (the sample peaks at −8 dB).
  const norm = useMemo(() => {
    if (!audio) return 1;
    const sorted = Float32Array.from(audio.peak).sort();
    return Math.max(1e-4, sorted[Math.floor(sorted.length * 0.995)] || 1);
  }, [audio]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let width = 0;
    const ro = new ResizeObserver(() => {
      const dpr = devicePixelRatio || 1;
      width = wrapRef.current!.clientWidth;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${HEIGHT}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dur = useStore.getState().edl!.source.durationSec;
      const fit = (width - LABEL_W) / dur;
      if (!view.current.pxPerSec || view.current.pxPerSec < fit) view.current = { pxPerSec: fit, scroll: 0 };
    });
    ro.observe(wrapRef.current!);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!width) return;
      const s = useStore.getState();
      const edl = s.edl!;
      const v = view.current;
      const t = player.srcTime;
      // Follow the playhead while playing.
      const trackW = width - LABEL_W;
      if (player.playing) {
        const visible = trackW / v.pxPerSec;
        if (t > v.scroll + visible * 0.95 || t < v.scroll) v.scroll = Math.max(0, t - visible * 0.1);
      }
      v.scroll = Math.max(0, Math.min(v.scroll, edl.source.durationSec - trackW / v.pxPerSec));
      drawTimeline(ctx, width, edl, s.audio?.peak ?? null, s.audio?.frameSec ?? 0.02, norm, v, t, s.selection, s.mode);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [player, norm]);

  const timeAt = (x: number) => view.current.scroll + (x - LABEL_W) / view.current.pxPerSec;

  const hitEdit = (x: number): Selection => {
    const edl = useStore.getState().edl!;
    const t = timeAt(x);
    const tol = 3 / view.current.pxPerSec;
    const si = edl.speedups.findIndex((s) => t >= s.start - tol && t <= s.end + tol);
    if (si >= 0) return { kind: 'speedup', index: si };
    // Prefer the shortest cut under the pointer (fillers sit inside silences later on).
    let best = -1;
    edl.cuts.forEach((c, i) => {
      if (t >= c.start - tol && t <= c.end + tol && (best < 0 || c.end - c.start < edl.cuts[best].end - edl.cuts[best].start)) best = i;
    });
    return best >= 0 ? { kind: 'cut', index: best } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < LABEL_W) return;
    const store = useStore.getState();
    if (y >= EDITS_Y - 2 && y <= EDITS_Y + EDITS_H + 2) {
      const hit = hitEdit(x);
      store.setSelection(hit);
      if (hit && e.detail === 2) {
        if (hit.kind === 'cut') store.toggleCut(hit.index);
        else if (hit.kind === 'speedup') store.toggleSpeedup(hit.index);
      } else if (hit) {
        const edl = store.edl!;
        const item = hit.kind === 'cut' ? edl.cuts[hit.index] : hit.kind === 'speedup' ? edl.speedups[hit.index] : null;
        if (item && hit.kind === 'cut' && (edl.cuts[hit.index].type === 'filler' || edl.cuts[hit.index].type === 'repeat')) {
          // Audition the filler in the original, with a little context on each side.
          store.setMode('before');
          player.playSpan(Math.max(0, item.start - 0.6), item.end + 0.4);
        } else if (item) {
          // Jump just before the item so you hear the join (After) or what's removed (Before).
          player.seek(Math.max(0, item.start - 1));
        }
      }
      return;
    }
    if (y >= ZOOM_Y - 2 && y <= ZOOM_Y + ZOOM_H + 2) {
      const t = timeAt(x);
      const edl = store.edl!;
      const index = edl.zooms.findIndex((z) => t >= z.start - 4 / view.current.pxPerSec && t <= z.end + 4 / view.current.pxPerSec);
      if (index < 0) {
        store.setSelection(null);
        player.seek(t);
        return;
      }
      const z = edl.zooms[index];
      const edgePx = 6;
      const X = (tt: number) => LABEL_W + (tt - view.current.scroll) * view.current.pxPerSec;
      const mode = Math.abs(x - X(z.start)) <= edgePx ? 'start' : Math.abs(x - X(z.end)) <= edgePx ? 'end' : 'move';
      store.setSelection({ kind: 'zoom', index });
      (e.target as Element).setPointerCapture(e.pointerId);
      drag.current = { kind: 'zoom', mode, index, x0: x, t0: t, orig: z, moved: false };
      return;
    }
    if (y >= CLICKS_Y - 2 && y <= CLICKS_Y + CLICKS_H + 2) {
      const t = timeAt(x);
      const tol = 5 / view.current.pxPerSec;
      const c = store.edl!.clicks.find((k) => Math.abs(k.t - t) <= tol);
      player.seek(Math.max(0, (c?.t ?? t) - (c ? 0.6 : 0)));
      return;
    }
    if (y >= CAPS_Y - 2 && y <= CAPS_Y + CAPS_H + 2) {
      const t = timeAt(x);
      const index = store.edl!.captions.findIndex((c) => t >= c.start && t < c.end);
      store.setSelection(index >= 0 ? { kind: 'caption', index } : null);
      if (index >= 0) player.seek(store.edl!.captions[index].start);
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    const t = timeAt(x);
    drag.current = { kind: y < RULER_H ? 'scrub' : 'range', x0: x, t0: t, moved: false };
    if (y < RULER_H) player.seek(t);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    trackHover(e);
    const d = drag.current;
    if (!d) return;
    const x = e.clientX - canvasRef.current!.getBoundingClientRect().left;
    if (Math.abs(x - d.x0) > 3) d.moved = true;
    const t = Math.max(0, timeAt(x));
    if (d.kind === 'zoom') {
      if (!d.moved) return;
      const store = useStore.getState();
      const zs = store.edl!.zooms;
      const prevEnd = d.index > 0 ? zs[d.index - 1].end : 0;
      const nextStart = d.index < zs.length - 1 ? zs[d.index + 1].start : store.edl!.source.durationSec;
      const o = d.orig;
      let start = o.start;
      let end = o.end;
      const dt = t - d.t0;
      if (d.mode === 'move') {
        const len = o.end - o.start;
        start = Math.min(nextStart - len, Math.max(prevEnd, o.start + dt));
        end = start + len;
      } else if (d.mode === 'start') start = Math.min(o.end - 1, Math.max(prevEnd, o.start + dt));
      else end = Math.max(o.start + 1, Math.min(nextStart, o.end + dt));
      const shift = d.mode === 'move' ? start - o.start : 0;
      store.updateZoom(d.index, { start, end, focus: o.focus.map((f) => ({ ...f, t: f.t + shift })) }, 'zoom-drag');
      return;
    }
    if (d.kind === 'scrub') player.seek(t);
    else if (d.moved) useStore.getState().setSelection({ kind: 'range', start: Math.min(d.t0, t), end: Math.max(d.t0, t) });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'range' && !d.moved) {
      useStore.getState().setSelection(null);
      player.seek(d.t0);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const v = view.current;
    const edl = useStore.getState().edl!;
    const width = wrapRef.current!.clientWidth - LABEL_W;
    if (e.ctrlKey || e.metaKey) {
      const x = e.clientX - canvasRef.current!.getBoundingClientRect().left;
      const tAt = timeAt(x);
      const fit = width / edl.source.durationSec;
      v.pxPerSec = Math.min(400, Math.max(fit, v.pxPerSec * Math.exp(-e.deltaY * 0.002)));
      v.scroll = tAt - (x - LABEL_W) / v.pxPerSec;
    } else {
      v.scroll += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / v.pxPerSec;
    }
  };

  return (
    <div ref={wrapRef} className="relative shrink-0 border-t border-zinc-800/80 select-none" style={{ background: '#0c0c0e' }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onPointerLeave={() => {
          cancelAnimationFrame(hoverRaf.current);
          setHover(null);
        }}
        className="block cursor-crosshair"
      />
      {hover && <ScrubPreview t={hover.t} x={hover.x} containerWidth={hover.w} live={live} />}
    </div>
  );
}

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  width: number,
  edl: EDL,
  peak: Float32Array | null,
  frameSec: number,
  norm: number,
  v: View,
  playhead: number,
  selection: Selection,
  mode: 'before' | 'after',
) {
  const X = (t: number) => LABEL_W + (t - v.scroll) * v.pxPerSec;
  const t0 = v.scroll;
  const t1 = v.scroll + (width - LABEL_W) / v.pxPerSec;
  ctx.clearRect(0, 0, width, HEIGHT);

  // Track labels.
  ctx.fillStyle = '#0f0f12';
  ctx.fillRect(0, 0, LABEL_W, HEIGHT);
  ctx.font = '10px ui-sans-serif, system-ui';
  ctx.fillStyle = '#71717a';
  ctx.fillText('AUDIO', 10, WAVE_Y + WAVE_H / 2 + 3);
  ctx.fillText('EDITS', 10, EDITS_Y + EDITS_H / 2 + 3);
  ctx.fillText('CAPTIONS', 10, CAPS_Y + CAPS_H / 2 + 3);
  ctx.fillText('ZOOM', 10, ZOOM_Y + ZOOM_H / 2 + 3);
  ctx.fillText('CLICKS', 10, CLICKS_Y + CLICKS_H / 2 + 3);

  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, 0, width - LABEL_W, HEIGHT);
  ctx.clip();

  // Ruler.
  const step = niceStep(80 / v.pxPerSec);
  ctx.fillStyle = '#52525b';
  ctx.strokeStyle = '#27272a';
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(X(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H - 6);
    ctx.lineTo(x, RULER_H);
    ctx.stroke();
    ctx.fillText(fmtTime(t), x + 3, 12);
  }

  // Waveform.
  const mid = WAVE_Y + WAVE_H / 2;
  ctx.fillStyle = '#18181b';
  ctx.fillRect(LABEL_W, WAVE_Y, width - LABEL_W, WAVE_H);
  if (peak) {
    ctx.fillStyle = '#8b7cff';
    for (let x = LABEL_W; x < width; x++) {
      const ta = v.scroll + (x - LABEL_W) / v.pxPerSec;
      const tb = ta + 1 / v.pxPerSec;
      const a = Math.max(0, Math.floor(ta / frameSec));
      const b = Math.min(peak.length, Math.max(a + 1, Math.ceil(tb / frameSec)));
      let m = 0;
      for (let i = a; i < b; i++) if (peak[i] > m) m = peak[i];
      const hgt = Math.min(1, m / norm) * (WAVE_H / 2 - 2);
      ctx.fillRect(x, mid - hgt, 1, Math.max(1, hgt * 2));
    }
  }

  // Cut overlays and edit chips.
  const drawItem = (start: number, end: number, color: string, enabled: boolean, selected: boolean, label?: string) => {
    if (end < t0 || start > t1) return;
    const xa = X(start);
    const w = Math.max(1.5, (end - start) * v.pxPerSec);
    if (enabled && mode === 'after') {
      ctx.fillStyle = 'rgba(9,9,11,0.72)';
      ctx.fillRect(xa, WAVE_Y, w, WAVE_H);
    }
    ctx.globalAlpha = enabled ? 0.9 : 0.35;
    ctx.fillStyle = color;
    roundRect(ctx, xa, EDITS_Y, w, EDITS_H, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (!enabled) {
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      roundRect(ctx, xa + 0.5, EDITS_Y + 0.5, w - 1, EDITS_H - 1, 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (selected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      roundRect(ctx, xa, EDITS_Y, w, EDITS_H, 4);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (label && w > 34) {
      ctx.fillStyle = '#09090b';
      ctx.fillText(label, xa + 4, EDITS_Y + 14, w - 8);
    }
  };
  // Fillers last so they sit on top of the silences around them.
  const onTop = (c: Cut) => Number(c.type === 'filler' || c.type === 'repeat');
  const order = edl.cuts.map((_, i) => i).sort((a, b) => onTop(edl.cuts[a]) - onTop(edl.cuts[b]));
  for (const i of order) {
    const c = edl.cuts[i];
    drawItem(c.start, c.end, CUT_COLORS[c.type], c.enabled, selection?.kind === 'cut' && selection.index === i, c.label);
  }

  // Captions.
  edl.captions.forEach((c, i) => {
    if (c.end < t0 || c.start > t1) return;
    const xa = X(c.start);
    const w = Math.max(2, (c.end - c.start) * v.pxPerSec - 1);
    const sel = selection?.kind === 'caption' && selection.index === i;
    ctx.fillStyle = sel ? '#3f3f46' : '#27272a';
    roundRect(ctx, xa, CAPS_Y, w, CAPS_H, 3);
    ctx.fill();
    if (w > 24) {
      ctx.fillStyle = '#d4d4d8';
      ctx.fillText(c.text.replace(/\n/g, ' '), xa + 4, CAPS_Y + 13, w - 8);
    }
  });
  edl.speedups.forEach((s, i) => {
    if (s.enabled && mode === 'after' && s.end >= t0 && s.start <= t1) {
      ctx.fillStyle = 'rgba(56,189,248,0.12)';
      ctx.fillRect(X(s.start), WAVE_Y, (s.end - s.start) * v.pxPerSec, WAVE_H);
    }
    drawItem(s.start, s.end, CUT_COLORS.speedup, s.enabled, selection?.kind === 'speedup' && selection.index === i, `⏩ ${s.speed}×`);
  });

  // Zoom blocks, with the zoom-in/out ramps shaded.
  edl.zooms.forEach((z, i) => {
    if (z.end < t0 || z.start > t1) return;
    const xa = X(z.start);
    const w = Math.max(3, (z.end - z.start) * v.pxPerSec);
    const sel = selection?.kind === 'zoom' && selection.index === i;
    ctx.globalAlpha = z.source === 'manual' ? 0.95 : 0.7;
    ctx.fillStyle = ZOOM_COLOR;
    roundRect(ctx, xa, ZOOM_Y, w, ZOOM_H, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(9,9,11,0.35)';
    const ramp = Math.min(w / 2, 0.7 * v.pxPerSec);
    ctx.fillRect(xa, ZOOM_Y, ramp, ZOOM_H);
    ctx.fillRect(xa + w - Math.min(w / 2, 0.8 * v.pxPerSec), ZOOM_Y, Math.min(w / 2, 0.8 * v.pxPerSec), ZOOM_H);
    if (sel) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      roundRect(ctx, xa, ZOOM_Y, w, ZOOM_H, 4);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (w > 40) {
      ctx.fillStyle = '#052e16';
      ctx.fillText(`${z.scale.toFixed(1)}×${z.source === 'manual' ? ' ✎' : ''}`, xa + 5, ZOOM_Y + 14, w - 10);
    }
  });

  // Inferred clicks: brightness = confidence.
  for (const c of edl.clicks) {
    if (c.t < t0 || c.t > t1) continue;
    ctx.globalAlpha = 0.25 + 0.75 * c.confidence;
    ctx.fillStyle = c.confidence >= 0.55 ? '#facc15' : '#a1a1aa';
    ctx.beginPath();
    ctx.arc(X(c.t), CLICKS_Y + CLICKS_H / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (selection?.kind === 'range') {
    ctx.fillStyle = 'rgba(139,124,255,0.25)';
    ctx.fillRect(X(selection.start), WAVE_Y, (selection.end - selection.start) * v.pxPerSec, WAVE_H);
    ctx.strokeStyle = '#8b7cff';
    ctx.strokeRect(X(selection.start) + 0.5, WAVE_Y + 0.5, (selection.end - selection.start) * v.pxPerSec, WAVE_H - 1);
  }

  // Playhead.
  const px = Math.round(X(playhead)) + 0.5;
  ctx.strokeStyle = '#fafafa';
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, HEIGHT);
  ctx.stroke();
  ctx.fillStyle = '#fafafa';
  ctx.beginPath();
  ctx.moveTo(px - 5, 0);
  ctx.lineTo(px + 5, 0);
  ctx.lineTo(px, 7);
  ctx.fill();
  ctx.restore();
}

function niceStep(minSec: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s >= minSec) ?? 1200;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
