import { useEffect, useRef, useState, type RefObject } from 'react';
import { outputDuration, segmentIndexAt, srcToOut } from '../core/edl';
import { fmtTime } from '../core/format';
import { useStore } from '../state/store';
import { usePlayer, usePlaying } from './playerContext';

export function Preview() {
  const player = usePlayer();
  const playing = usePlaying(player);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const edl = useStore((s) => s.edl)!;
  const mode = useStore((s) => s.mode);
  const areaRef = useRef<HTMLDivElement>(null);
  const fit = useFit(areaRef, edl.source.width / edl.source.height, 48);

  useEffect(() => {
    player.attachCanvas(canvasRef.current);
    return () => player.attachCanvas(null);
  }, [player]);

  // Time readout + speed-up badge, updated per frame without React renders.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = player.srcTime;
      const segs = useStore.getState().edl!.segments;
      const before = useStore.getState().mode === 'before';
      if (timeRef.current) {
        timeRef.current.textContent = before
          ? `${fmtTime(t, true)} / ${fmtTime(useStore.getState().edl!.source.durationSec)}`
          : `${fmtTime(srcToOut(segs, t), true)} / ${fmtTime(outputDuration(segs))}`;
      }
      if (badgeRef.current) {
        const seg = before ? undefined : segs[segmentIndexAt(segs, t)];
        // Skip the badge for blips that flash by in under half a second.
        const fast = seg?.reason === 'speedup' && (seg.srcEnd - seg.srcStart) / seg.speed >= 0.5;
        badgeRef.current.style.opacity = fast ? '1' : '0';
        if (fast) badgeRef.current.textContent = `⏩ ${seg.speed}×`;
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [player]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={areaRef} className="flex-1 min-h-0 min-w-0 grid place-items-center p-6 bg-[radial-gradient(ellipse_at_center,#18181b,#09090b)]">
        <div className="relative" style={{ width: fit.w, height: fit.h }}>
          <canvas
            ref={canvasRef}
            onClick={() => player.toggle()}
            className="h-full w-full rounded-lg shadow-2xl shadow-black/60 bg-black cursor-pointer"
          />
          <div
            ref={badgeRef}
            className="absolute top-3 right-3 px-2 py-1 rounded-md bg-black/60 backdrop-blur text-sm font-medium text-sky-300 transition-opacity opacity-0 pointer-events-none"
          />
          {mode === 'before' && (
            <div className="absolute top-3 left-3 px-2 py-1 rounded-md bg-black/60 text-xs uppercase tracking-wider text-zinc-300 pointer-events-none">
              Original
            </div>
          )}
        </div>
      </div>
      <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-t border-zinc-800/80">
        <button
          onClick={() => player.seek(Math.max(0, player.srcTime - 5))}
          className="text-zinc-400 hover:text-white text-sm"
          title="Back 5s (J)"
        >
          ⏪
        </button>
        <button
          onClick={() => player.toggle()}
          className="h-8 w-8 grid place-items-center rounded-full bg-white text-zinc-900 hover:scale-105 transition"
          title="Play/pause (Space)"
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span ref={timeRef} className="text-sm tabular-nums text-zinc-300 min-w-[11rem]" />
        <span className="ml-auto text-xs text-zinc-500">Space play · J/K/L shuttle · Del cut selection · ⌘Z undo</span>
      </div>
    </div>
  );
}

/** Largest box of the given aspect that fits inside the element (minus padding). */
function useFit(ref: RefObject<HTMLElement | null>, aspect: number, pad: number) {
  const [fit, setFit] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = Math.max(0, el.clientWidth - pad);
      const H = Math.max(0, el.clientHeight - pad);
      const w = Math.min(W, H * aspect);
      setFit({ w: Math.floor(w), h: Math.floor(w / aspect) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect, pad]);
  return fit;
}
