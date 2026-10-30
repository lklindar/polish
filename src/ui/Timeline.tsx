// Multi-track timeline on a single canvas, in source time: ruler, waveform with cut overlays, an
// edits track (gray = silence, blue = speed-up, yellow = filler, violet = manual) and captions.

import { useEffect, useMemo, useRef } from 'react';
import type { Cut, EDL } from '../core/edl';
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
const HEIGHT = CAPS_Y + CAPS_H + 10;
const LABEL_W = 64;

export const CUT_COLORS: Record<Cut['type'] | 'speedup', string> = {
  silence: '#71717a',
  filler: '#eab308',
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
  const drag = useRef<{ kind: 'scrub' | 'range'; x0: number; t0: number; moved: boolean } | null>(null);
  const audio = useStore((s) => s.audio);

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
        if (item && hit.kind === 'cut' && edl.cuts[hit.index].type === 'filler') {
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
    const d = drag.current;
    if (!d) return;
    const x = e.clientX - canvasRef.current!.getBoundingClientRect().left;
    if (Math.abs(x - d.x0) > 3) d.moved = true;
    const t = Math.max(0, timeAt(x));
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
    <div ref={wrapRef} className="shrink-0 border-t border-zinc-800/80 select-none" style={{ background: '#0c0c0e' }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        className="block cursor-crosshair"
      />
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
  const order = edl.cuts.map((_, i) => i).sort((a, b) => Number(edl.cuts[a].type === 'filler') - Number(edl.cuts[b].type === 'filler'));
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
