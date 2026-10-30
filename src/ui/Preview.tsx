import { useEffect, useRef, useState, type RefObject } from 'react';
import { outputDuration, segmentIndexAt, srcToOut } from '../core/edl';
import { fmtTime } from '../core/format';
import { viewport } from '../core/zoom';
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
          : `${fmtTime(srcToOut(segs, t, useStore.getState().edl!.globalSpeed), true)} / ${fmtTime(outputDuration(segs, useStore.getState().edl!.globalSpeed))}`;
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
            onClick={(e) => {
              // With a zoom selected, clicking the picture sets where it zooms to.
              const { selection, edl: cur, updateZoom } = useStore.getState();
              if (selection?.kind === 'zoom' && cur) {
                const r = e.currentTarget.getBoundingClientRect();
                const sx = ((e.clientX - r.left) / r.width) * cur.source.width;
                const sy = ((e.clientY - r.top) / r.height) * cur.source.height;
                const content = cur.layout?.content ?? { x: 0, y: 0, w: cur.source.width, h: cur.source.height };
                // The picture may be zoomed right now: map back through the current camera.
                const cam = player.compose?.(player.srcTime)?.camera ?? { scale: 1, cx: 0, cy: 0 };
                const v = viewport(cam, content);
                const inContent = sx >= content.x && sx <= content.x + content.w && sy >= content.y && sy <= content.y + content.h;
                const x = cam.scale > 1.001 && inContent ? v.x + (sx - content.x) / cam.scale : sx;
                const y = cam.scale > 1.001 && inContent ? v.y + (sy - content.y) / cam.scale : sy;
                const z = cur.zooms[selection.index];
                updateZoom(selection.index, { focus: [{ t: z.start, x, y }] });
                return;
              }
              player.toggle();
            }}
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
      <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-t border-zinc-800/80 min-w-0 overflow-hidden">
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
        <CaptionToggle />
        <SpeedMenu />
        <span ref={timeRef} className="text-sm tabular-nums text-zinc-300 whitespace-nowrap" />
        <span className="ml-auto text-xs text-zinc-500 truncate hidden xl:block">Space play · J/K/L shuttle · Z zoom · Del delete/cut · ⌘Z undo</span>
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

/** Captions on/off. Off = nothing in the preview and nothing burned into the export. */
export function CaptionToggle() {
  const enabled = useStore((s) => s.settings.captions.enabled);
  const hasCaptions = useStore((s) => (s.edl?.captions.length ?? 0) > 0);
  const toggle = () => {
    const { settings, presetId, setSettings } = useStore.getState();
    setSettings({ ...settings, captions: { ...settings.captions, enabled: !enabled } }, presetId);
  };
  return (
    <button
      onClick={toggle}
      title={enabled ? 'Captions on: click to turn them off' : 'Captions off: click to turn them on'}
      aria-pressed={enabled}
      className={`px-1.5 py-0.5 rounded text-[11px] font-bold tracking-wide border transition ${
        enabled ? 'border-white bg-white text-zinc-900' : 'border-zinc-600 text-zinc-500 hover:text-zinc-300'
      } ${hasCaptions ? '' : 'opacity-50'}`}
    >
      CC
    </button>
  );
}

const SPEEDS = [1, 1.1, 1.2, 1.25, 1.5, 1.75, 2];

/** Whole-video speed. Applies to preview and export; voices keep their pitch. */
export function SpeedMenu() {
  const speed = useStore((s) => s.edl?.globalSpeed ?? 1);
  const setGlobalSpeed = useStore((s) => s.setGlobalSpeed);
  return (
    <select
      value={speed}
      onChange={(e) => setGlobalSpeed(Number(e.target.value))}
      title="Video speed (voices keep their pitch)"
      className={`rounded border px-1 py-0.5 text-[11px] font-bold bg-zinc-900 ${speed !== 1 ? 'border-white text-white' : 'border-zinc-600 text-zinc-400'}`}
    >
      {SPEEDS.map((v) => (
        <option key={v} value={v}>
          {v}×
        </option>
      ))}
    </select>
  );
}
