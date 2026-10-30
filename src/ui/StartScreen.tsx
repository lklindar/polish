import { useEffect, useRef, useState } from 'react';
import { fmtBytes, fmtTime } from '../core/format';
import { PRESETS, cloneSettings, type PresetId } from '../core/settings';
import { useStore, type Step } from '../state/store';

export function StartScreen() {
  const { file, phase, steps, error, caps, presetId, settings } = useStore();
  const captionsOn = settings.captions.enabled;
  const setFile = useStore((s) => s.setFile);
  const run = useStore((s) => s.runPipeline);
  const setSettings = useStore((s) => s.setSettings);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const analyzing = phase === 'analyzing';

  const pick = (f: File | undefined) => {
    if (f && (f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name))) setFile(f);
  };

  const missing: string[] = [];
  if (caps && !caps.webCodecs) missing.push('WebCodecs (decode/encode video)');
  if (caps && caps.webCodecs && !caps.h264Encode) missing.push('H.264 encoding');
  if (caps && !caps.opfs) missing.push('Origin Private File System (streams large exports to disk)');
  const warnings: string[] = [];
  if (caps && caps.webCodecs && !caps.aacEncode)
    warnings.push(caps.opusEncode ? 'AAC encoding is unavailable, so exports will be WebM (VP9 + Opus).' : 'No audio encoder is available.');
  if (caps && !caps.webGpu) warnings.push('WebGPU is unavailable, so transcription will use the slower WASM backend.');
  if (caps && !caps.crossOriginIsolated) warnings.push('The page is not cross-origin isolated, so WASM runs single-threaded.');

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 py-12 bg-[radial-gradient(ellipse_at_top,rgba(139,124,255,0.18),transparent_60%)]">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-accent to-accent-2 grid place-items-center text-zinc-950 font-black">P</div>
          <h1 className="text-3xl font-semibold tracking-tight">Polish</h1>
        </div>
        <p className="text-zinc-400 mb-8">One click from a raw screen recording to a tight, premium demo.</p>

        {missing.length > 0 && (
          <div className="mb-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            <div className="font-medium mb-1">This browser can't run Polish. It's missing:</div>
            <ul className="list-disc ml-5">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
            <div className="mt-2 text-red-300/80">Use a current version of desktop Chrome or Edge.</div>
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files[0]);
          }}
          onClick={() => !analyzing && inputRef.current?.click()}
          className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition ${
            drag ? 'border-accent bg-accent/10' : 'border-zinc-700 hover:border-zinc-500 bg-zinc-900/50'
          }`}
        >
          <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          {file ? (
            <div>
              <div className="text-lg font-medium truncate">{file.name}</div>
              <div className="text-zinc-400 text-sm mt-1">{fmtBytes(file.size)} · click to choose another</div>
            </div>
          ) : (
            <div>
              <div className="text-lg font-medium">Drop a screen recording here</div>
              <div className="text-zinc-400 text-sm mt-1">MP4, MOV or WebM · or click to browse</div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-2">
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <button
              key={id}
              disabled={analyzing}
              onClick={() => setSettings(cloneSettings(PRESETS[id].settings), id)}
              title={PRESETS[id].blurb}
              className={`px-3 py-1.5 rounded-lg text-sm border transition ${
                presetId === id ? 'border-accent bg-accent/15 text-white' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
              }`}
            >
              {PRESETS[id].label}
            </button>
          ))}
          <span className="text-xs text-zinc-500 ml-2 flex-1">{presetId !== 'custom' && PRESETS[presetId].blurb}</span>
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer select-none" title="Burn captions into the video. You can change this later with the CC button.">
            <input
              type="checkbox"
              checked={captionsOn}
              disabled={analyzing}
              onChange={(e) => setSettings({ ...settings, captions: { ...settings.captions, enabled: e.target.checked } }, presetId)}
              className="accent-[#8b7cff]"
            />
            Captions
          </label>
        </div>

        <button
          disabled={!file || analyzing || missing.length > 0}
          onClick={() => void run()}
          className="mt-4 w-full rounded-2xl py-4 text-lg font-semibold bg-gradient-to-r from-accent to-[#6f9bff] text-white shadow-lg shadow-accent/20 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          ✨ Make it Premium
        </button>

        {(analyzing || error) && <Progress steps={steps} error={error} />}

        {warnings.length > 0 && (
          <ul className="mt-6 text-xs text-amber-300/80 space-y-1">
            {warnings.map((w) => <li key={w}>⚠ {w}</li>)}
          </ul>
        )}

        <p className="mt-8 text-xs text-zinc-500 leading-relaxed">
          🔒 Your video never leaves this computer. Decoding, analysis, transcription and export all run inside this
          browser tab. Nothing is uploaded, and analysis results are cached locally in IndexedDB so reopening the same
          file is instant.
        </p>
      </div>
    </div>
  );
}

function Progress({ steps, error }: { steps: Step[]; error: string | null }) {
  const startedAt = useStore((s) => s.analysisStartedAt);
  const meta = useStore((s) => s.meta);
  return (
    <div className="mt-6 rounded-xl bg-zinc-900 border border-zinc-800 p-4 space-y-3">
      {meta && (
        <div className="text-xs text-zinc-500">
          {fmtTime(meta.durationSec)} · {meta.width}×{meta.height} · {meta.fps} fps · {meta.videoCodec}/{meta.audioCodec ?? 'no audio'}
        </div>
      )}
      {steps.map((s) => (
        <div key={s.id}>
          <div className="flex justify-between text-sm">
            <span className={s.status === 'pending' ? 'text-zinc-500' : 'text-zinc-200'}>
              {icon(s.status)} {s.label}
            </span>
            <span className="text-zinc-500 tabular-nums">
              {s.status === 'cached' ? 'cached' : s.status === 'running' ? `${Math.round(s.fraction * 100)}%` : ''}
            </span>
          </div>
          {s.detail && <div className="text-xs text-zinc-500 mt-0.5">{s.detail}</div>}
          <div className="h-1 mt-1 rounded bg-zinc-800 overflow-hidden">
            <div
              className={`h-full transition-[width] ${s.status === 'error' ? 'bg-red-500' : 'bg-accent'}`}
              style={{ width: `${(s.status === 'done' || s.status === 'cached' ? 1 : s.fraction) * 100}%` }}
            />
          </div>
        </div>
      ))}
      {error && <div className="text-sm text-red-300">Error: {error}</div>}
      {!error && startedAt > 0 && <Elapsed since={startedAt} />}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <div className="text-xs text-zinc-500 tabular-nums">Elapsed {fmtTime((now - since) / 1000)}</div>;
}

function icon(s: Step['status']) {
  return s === 'done' || s === 'cached' ? '✓' : s === 'running' ? '◌' : s === 'error' ? '✕' : '·';
}
