import { useEffect, useState } from 'react';
import { drawCaption } from '../core/captionRender';
import { captionAt } from '../core/captions';
import { frameState } from '../core/compose';
import { webcamAt } from '../core/layout';
import { editStats } from '../core/edl';
import { fmtDuration } from '../core/format';
import { EdlPlayer } from '../player/EdlPlayer';
import { forgetProject, projectJson, useStore } from '../state/store';
import { ExportPanel } from './ExportPanel';
import { PlayerContext } from './playerContext';
import { Preview } from './Preview';
import { SettingsPanel } from './SettingsPanel';
import { Timeline } from './Timeline';
import { useShortcuts } from './useShortcuts';

export function Editor() {
  const fileUrl = useStore((s) => s.fileUrl)!;
  // Created in an effect (not useMemo) so StrictMode's mount/unmount/mount gets a live player.
  const [player, setPlayer] = useState<EdlPlayer | null>(null);
  useEffect(() => {
    const p = new EdlPlayer(fileUrl);
    // Zoom and captions come from the store on every frame, in source time (After mode only).
    p.compose = (t) => {
      const { edl, settings, mode } = useStore.getState();
      return edl && mode === 'after' ? frameState(edl, settings.zoom, t) : null;
    };
    p.overlay = (ctx, t, w, h) => {
      const { edl, settings, mode } = useStore.getState();
      if (!edl || mode === 'before' || !settings.captions.enabled) return false;
      const cap = captionAt(edl.captions, t);
      if (!cap) return false;
      drawCaption(ctx, cap, t, settings.captions, w, h, edl.layout ? webcamAt(edl.layout.webcam, t) : null);
      return true;
    };
    setPlayer(p);
    if (import.meta.env.DEV) (globalThis as unknown as { __player: EdlPlayer }).__player = p;
    return () => p.destroy();
  }, [fileUrl]);

  const edl = useStore((s) => s.edl)!;
  const mode = useStore((s) => s.mode);
  useEffect(() => player?.setSegments(edl.segments), [player, edl.segments]);
  useEffect(() => player?.setGlobalSpeed(edl.globalSpeed), [player, edl.globalSpeed]);
  useEffect(() => player?.setBypass(mode === 'before'), [player, mode]);

  if (!player) return null;
  return (
    <PlayerContext.Provider value={player}>
      <Shell />
    </PlayerContext.Provider>
  );
}

function Shell() {
  useShortcuts();
  const { edl, file, mode, past, future, analysisMs, restoredProject } = useStore();
  const { setMode, undo, redo, reset, importProject } = useStore.getState();
  const [exporting, setExporting] = useState(false);
  const stats = editStats(edl!);

  const downloadProject = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([projectJson()], { type: 'application/json' }));
    a.download = `${file?.name.replace(/\.[^.]+$/, '') ?? 'project'}.polish.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const loadProject = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        importProject(await f.text());
      } catch (e) {
        alert(String((e as Error).message));
      }
    };
    input.click();
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-zinc-800/80">
        <button onClick={reset} className="flex items-center gap-2 hover:opacity-80" title="Back to start">
          <div className="h-6 w-6 rounded-md bg-gradient-to-br from-accent to-accent-2 grid place-items-center text-zinc-950 text-xs font-black">P</div>
          <span className="font-semibold">Polish</span>
        </button>
        <span className="text-zinc-500 text-sm truncate max-w-[22rem]">{file?.name}</span>

        <div className="ml-4 flex rounded-lg bg-zinc-900 p-0.5 text-sm border border-zinc-800">
          {(['before', 'after'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md capitalize ${mode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="text-xs text-zinc-400 ml-2 hidden lg:block" title={`Analysis took ${(analysisMs / 1000).toFixed(1)}s`}>
          <span className="text-zinc-200 font-medium">{fmtDuration(stats.sourceSec)} → {fmtDuration(stats.outputSec)}</span>
          <span className="text-zinc-500">
            {' '}· removed {fmtDuration(stats.removedSec)} ({Math.round((stats.removedSec / stats.sourceSec) * 100)}%): {stats.silences} silences, {stats.fillers} fillers, {stats.repeats} repeats, {stats.zooms} zooms
            {stats.speedups > 0 && `, ${stats.speedups} speed-ups`}
          </span>
          {restoredProject && <span className="ml-2 text-accent-2/80">· restored autosave</span>}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <IconBtn onClick={undo} disabled={!past.length} title="Undo (⌘Z)">↶</IconBtn>
          <IconBtn onClick={redo} disabled={!future.length} title="Redo (⇧⌘Z)">↷</IconBtn>
          <IconBtn onClick={loadProject} title="Import project JSON">⤒</IconBtn>
          <IconBtn onClick={downloadProject} title="Export project JSON">⤓</IconBtn>
          <IconBtn
            onClick={async () => {
              if (!confirm('Discard your edits and rebuild the edit from the current settings?')) return;
              await forgetProject();
              useStore.getState().rebuildEdit();
            }}
            title="Rebuild edit from settings"
          >
            ⟲
          </IconBtn>
          <button
            onClick={() => setExporting(true)}
            className="ml-2 px-4 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:brightness-110"
          >
            Export
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 flex flex-col">
          <Preview />
        </main>
        <SettingsPanel />
      </div>
      <Timeline />
      {exporting && <ExportPanel onClose={() => setExporting(false)} />}
    </div>
  );
}

function IconBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="h-8 w-8 grid place-items-center rounded-md text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
    />
  );
}
