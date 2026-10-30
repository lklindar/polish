import { useEffect, useMemo, useRef, useState } from 'react';
import { captionAt } from '../core/captions';
import { segmentIndexAt, srcToOut } from '../core/edl';
import { fmtTime } from '../core/format';
import { HoverFrames } from '../player/HoverFrames';
import { useStore } from '../state/store';

const W = 240;

/**
 * YouTube-style hover preview above the timeline: the frame at the hovered time, its time (in the
 * edited video), the caption being spoken, and whether that moment was cut.
 */
export function ScrubPreview({ t, x, containerWidth, live }: { t: number; x: number; containerWidth: number; live: HoverFrames }) {
  const edl = useStore((s) => s.edl)!;
  const mode = useStore((s) => s.mode);
  const thumbs = useStore((s) => s.thumbs);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const H = Math.round((W * edl.source.height) / edl.source.width);
  // Exact thumbnail, else the nearest one already made (keyframe previews arrive first).
  const blob = useMemo(() => {
    if (!thumbs) return undefined;
    const i = Math.min(thumbs.blobs.length - 1, Math.round(t / thumbs.interval));
    for (let d = 0; d <= Math.round(12 / thumbs.interval); d++) {
      const b = thumbs.blobs[i - d] ?? thumbs.blobs[i + d];
      if (b) return b;
    }
    return undefined;
  }, [thumbs, t]);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  useEffect(() => {
    if (!blob && canvasRef.current) live.request(t, canvasRef.current);
  }, [blob, t, live]);

  const removed = edl.cuts.find((c) => c.enabled && t >= c.start && t < c.end);
  const seg = edl.segments[segmentIndexAt(edl.segments, t)];
  const caption = captionAt(edl.captions, t)?.text.replace(/\n/g, ' ');
  const time = mode === 'before' ? t : srcToOut(edl.segments, t, edl.globalSpeed);
  const left = Math.min(Math.max(8, x - W / 2), containerWidth - W - 8);

  return (
    <div className="pointer-events-none absolute z-30 bottom-full mb-2" style={{ left }}>
      <div className="rounded-xl overflow-hidden border-2 border-white/90 shadow-2xl shadow-black/60 bg-black" style={{ width: W, height: H }}>
        {url ? (
          <img src={url} width={W} height={H} alt="" className={`block ${removed && mode === 'after' ? 'opacity-40 grayscale' : ''}`} />
        ) : (
          <canvas ref={canvasRef} width={W} height={H} className="block" />
        )}
      </div>
      <div className="mt-1.5 flex justify-center">
        <div className="max-w-[300px] rounded-lg bg-black/75 backdrop-blur px-2.5 py-1 text-[13px] text-white flex items-center gap-2">
          <span className="font-semibold tabular-nums">{fmtTime(time)}</span>
          {removed && mode === 'after' ? (
            <span className="text-red-300 truncate">Removed · {removed.label ?? removed.type}</span>
          ) : seg?.reason === 'speedup' && mode === 'after' ? (
            <span className="text-sky-300">⏩ {seg.speed}×</span>
          ) : caption ? (
            <span className="truncate text-zinc-200">{caption}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
