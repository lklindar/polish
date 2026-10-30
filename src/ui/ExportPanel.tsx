import { useEffect, useRef, useState } from 'react';
import { toSrt, toTranscriptText } from '../core/captions';
import { editStats } from '../core/edl';
import { fmtBytes, fmtDuration, fmtTime } from '../core/format';
import { outputSize } from '../core/settings';
import { useStore } from '../state/store';
import type { ExportIn, ExportOut } from '../workers/protocol';
import { usePlayer } from './playerContext';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; fraction: number; startedAt: number; framesOut: number }
  | { kind: 'done'; url: string; name: string; size: number; tookSec: number; note?: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

interface MemSample {
  t: number;
  usedMB: number;
}

export function ExportPanel({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const { edl, file, settings, meta } = useStore();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [mem, setMem] = useState<MemSample[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const stats = editStats(edl!);
  const size = outputSize({ width: meta!.width, height: meta!.height }, settings.export.resolution);
  const baseName = file!.name.replace(/\.[^.]+$/, '');

  useEffect(() => () => workerRef.current?.terminate(), []);

  const start = async () => {
    player.pause();
    await clearOldExports();
    const w = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    const startedAt = performance.now();
    setMem([]);
    setStatus({ kind: 'running', fraction: 0, startedAt, framesOut: 0 });
    // Whole-agent memory (page + workers) needs cross-origin isolation; fall back to the page heap.
    let measuring = false;
    const memTimer = setInterval(async () => {
      if (measuring) return;
      measuring = true;
      try {
        const bytes = await measureMemory();
        if (bytes != null) {
          const sample = { t: (performance.now() - startedAt) / 1000, usedMB: bytes / 1048576 };
          console.log(`[export] t=${sample.t.toFixed(0)}s memory ${sample.usedMB.toFixed(0)} MB`);
          setMem((m) => [...m.slice(-59), sample]);
        }
      } finally {
        measuring = false;
      }
    }, 5000);
    w.onmessage = async (e: MessageEvent<ExportOut>) => {
      const m = e.data;
      if (m.type === 'progress') setStatus({ kind: 'running', fraction: m.fraction, startedAt, framesOut: m.framesOut });
      else {
        clearInterval(memTimer);
        w.terminate();
        workerRef.current = null;
        if (m.type === 'done') {
          const root = await navigator.storage.getDirectory();
          const f = await (await root.getFileHandle(m.opfsName)).getFile();
          setStatus({
            kind: 'done',
            url: URL.createObjectURL(f),
            name: `${baseName} (polished).${m.container}`,
            size: m.size,
            tookSec: (performance.now() - startedAt) / 1000,
            note: m.note,
          });
        } else if (m.type === 'error') setStatus({ kind: 'error', message: m.message });
        else setStatus({ kind: 'cancelled' });
      }
    };
    const msg: ExportIn = {
      type: 'start',
      file: file!,
      edl: edl!,
      settings: settings.export,
      fileName: file!.name,
      captionStyle: settings.captions.enabled && edl!.captions.length ? settings.captions : null,
      zoom: settings.zoom,
    };
    w.postMessage(msg);
  };

  const cancel = () => workerRef.current?.postMessage({ type: 'cancel' });

  const report = [
    `Polish edit report: ${file!.name}`,
    `Source ${fmtDuration(stats.sourceSec)} → output ${fmtDuration(stats.outputSec)}`,
    `Removed ${fmtDuration(stats.removedSec)} (${Math.round((stats.removedSec / stats.sourceSec) * 100)}%): ${stats.silences} silences, ${stats.fillers} fillers, ${stats.repeats} repeats${stats.manual ? `, ${stats.manual} manual cuts` : ''}.`,
    `Sped up ${stats.speedups} silent-but-busy stretches. Added ${stats.zooms} zooms.`,
  ].join('\n');

  const running = status.kind === 'running';
  const eta =
    running && status.fraction > 0.01
      ? ((performance.now() - status.startedAt) / 1000) * ((1 - status.fraction) / status.fraction)
      : NaN;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-6">
      <div className="w-full max-w-lg rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">Export</h2>
          {!running && (
            <button onClick={onClose} className="text-zinc-500 hover:text-white">
              ✕
            </button>
          )}
        </div>
        <div className="text-sm text-zinc-400 mt-1">
          {size.width}×{size.height} · H.264 High · {settings.export.bitrateMbps} Mbps · AAC · {fmtTime(stats.outputSec)}
          {settings.captions.enabled && edl!.captions.length > 0 ? ' · captions burned in' : ' · no captions'}
          {edl!.globalSpeed !== 1 && ` · ${edl!.globalSpeed}× speed`}
        </div>
        <pre className="mt-4 text-xs text-zinc-400 bg-zinc-950 rounded-lg p-3 whitespace-pre-wrap">{report}</pre>

        {status.kind === 'idle' && (
          <button onClick={start} className="mt-5 w-full py-3 rounded-xl bg-accent text-white font-medium hover:brightness-110">
            Start export
          </button>
        )}

        {running && (
          <div className="mt-5">
            <div className="h-2 rounded bg-zinc-800 overflow-hidden">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${status.fraction * 100}%` }} />
            </div>
            <div className="flex justify-between text-xs text-zinc-400 mt-2 tabular-nums">
              <span>
                {Math.round(status.fraction * 100)}% · {status.framesOut} frames
              </span>
              <span>{Number.isFinite(eta) ? `~${fmtDuration(eta)} left` : 'estimating…'}</span>
            </div>
            {mem.length > 0 && (
              <div className="text-xs text-zinc-500 mt-1 tabular-nums">
                Memory {mem[mem.length - 1].usedMB.toFixed(0)} MB (min {Math.min(...mem.map((m) => m.usedMB)).toFixed(0)}, max{' '}
                {Math.max(...mem.map((m) => m.usedMB)).toFixed(0)})
              </div>
            )}
            <button onClick={cancel} className="mt-4 w-full py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm">
              Cancel
            </button>
          </div>
        )}

        {status.kind === 'done' && (
          <div className="mt-5 space-y-2">
            <div className="text-sm text-emerald-300">
              Done in {fmtDuration(status.tookSec)} · {fmtBytes(status.size)}
            </div>
            {status.note && <div className="text-xs text-amber-300">{status.note}</div>}
            <a
              href={status.url}
              download={status.name}
              className="block text-center w-full py-3 rounded-xl bg-accent text-white font-medium hover:brightness-110"
            >
              Download video
            </a>
            <div className="grid grid-cols-3 gap-2">
              <TextDownload text={report} name={`${baseName} - edit report.txt`} label="Edit report" />
              {edl!.captions.length > 0 && (
                <>
                  <TextDownload text={toSrt(edl!.captions, edl!.segments, edl!.globalSpeed)} name={`${baseName} (polished).srt`} label="Captions .srt" />
                  <TextDownload text={toTranscriptText(edl!.captions, edl!.segments, edl!.globalSpeed)} name={`${baseName} - transcript.txt`} label="Transcript" />
                </>
              )}
            </div>
          </div>
        )}

        {status.kind === 'error' && (
          <div className="mt-5 text-sm text-red-300">
            Export failed: {status.message}
            <button onClick={() => setStatus({ kind: 'idle' })} className="block mt-2 underline">
              Try again
            </button>
          </div>
        )}
        {status.kind === 'cancelled' && (
          <div className="mt-5 text-sm text-zinc-400">
            Export cancelled.
            <button onClick={() => setStatus({ kind: 'idle' })} className="block mt-2 underline">
              Start again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Exports live in OPFS until the next export; remove stale ones so disk use doesn't grow. */
async function clearOldExports() {
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
    if (name.startsWith('export-')) names.push(name);
  }
  await Promise.all(names.map((n) => root.removeEntry(n).catch(() => {})));
}

async function measureMemory(): Promise<number | null> {
  const perf = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  if (crossOriginIsolated && perf.measureUserAgentSpecificMemory) {
    try {
      return (await perf.measureUserAgentSpecificMemory()).bytes;
    } catch {
      /* fall through */
    }
  }
  return perf.memory?.usedJSHeapSize ?? null;
}

function TextDownload({ text, name, label }: { text: string; name: string; label: string }) {
  // Created in the effect so StrictMode's unmount/remount doesn't leave a revoked URL behind.
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [text]);
  return (
    <a href={url} download={name} className="block text-center py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs">
      {label}
    </a>
  );
}
