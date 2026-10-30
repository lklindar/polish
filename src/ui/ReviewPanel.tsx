import { useState } from 'react';
import { fmtTime } from '../core/format';
import { useStore } from '../state/store';
import { usePlayer } from './playerContext';

type Filter = 'all' | 'removed' | 'kept';

/** Every detected filler and retake suggestion, with audition and toggle. */
export function ReviewPanel() {
  const player = usePlayer();
  const edl = useStore((s) => s.edl)!;
  const selection = useStore((s) => s.selection);
  const { toggleCut, setSelection, setMode, applySuggestion, dismissSuggestion } = useStore.getState();
  const [filter, setFilter] = useState<Filter>('all');

  const fillers = edl.cuts
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.type === 'filler' || c.type === 'repeat')
    .filter(({ c }) => (filter === 'all' ? true : filter === 'removed' ? c.enabled : !c.enabled));
  const all = edl.cuts.filter((c) => c.type === 'filler' || c.type === 'repeat');
  const removed = all.filter((c) => c.enabled);
  const removedSec = removed.reduce((a, c) => a + c.end - c.start, 0);

  const audition = (start: number, end: number) => {
    setMode('before');
    player.playSpan(Math.max(0, start - 0.6), end + 0.4);
  };

  return (
    <div className="text-sm">
      <div className="p-4 border-b border-zinc-800/80">
        <div className="text-zinc-300">
          <span className="text-yellow-400 font-medium">{removed.length}</span> of {all.length} fillers, repeats and held words removed ·{' '}
          {removedSec.toFixed(1)}s
        </div>
        <div className="flex gap-1 mt-2">
          {(['all', 'removed', 'kept'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded text-xs capitalize ${filter === f ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {(edl.suggestions?.length ?? 0) > 0 && (
        <div className="p-4 border-b border-zinc-800/80 space-y-2">
          <div className="text-xs uppercase tracking-wider text-zinc-500">Possible retakes</div>
          {edl.suggestions!.map((s, i) => (
            <div key={`${s.start}`} className="rounded-lg bg-zinc-900 border border-zinc-800 p-2">
              <div className="text-xs text-zinc-500 tabular-nums">
                {fmtTime(s.start)} · {(s.end - s.start).toFixed(1)}s
              </div>
              <div className="text-zinc-300 line-through decoration-zinc-600">{s.text}</div>
              <div className="flex gap-2 mt-1.5">
                <button className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700" onClick={() => audition(s.start, s.end + 2)}>
                  ▶ Play
                </button>
                <button className="text-xs px-2 py-0.5 rounded bg-accent/80 hover:bg-accent" onClick={() => applySuggestion(i)}>
                  Cut first take
                </button>
                <button className="text-xs px-2 py-0.5 rounded text-zinc-400 hover:text-zinc-200" onClick={() => dismissSuggestion(i)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ul className="divide-y divide-zinc-800/60">
        {fillers.map(({ c, index }) => {
          const sel = selection?.kind === 'cut' && selection.index === index;
          return (
            <li
              key={`${c.start}-${c.end}`}
              className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer ${sel ? 'bg-zinc-800/70' : 'hover:bg-zinc-900'}`}
              onClick={() => {
                setSelection({ kind: 'cut', index });
                audition(c.start, c.end);
              }}
            >
              <input
                type="checkbox"
                checked={c.enabled}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleCut(index)}
                title={c.enabled ? 'Removed. Uncheck to keep it.' : 'Kept. Check to remove it.'}
                className="accent-yellow-500"
              />
              <span className="tabular-nums text-xs text-zinc-500 w-12">{fmtTime(c.start)}</span>
              <span className={`flex-1 ${c.enabled ? (c.type === 'repeat' ? 'text-orange-300' : 'text-zinc-200') : 'text-zinc-500'}`}>{c.label}</span>
              <span className="w-14 h-1.5 rounded bg-zinc-800 overflow-hidden" title={`Confidence ${Math.round((c.confidence ?? 0) * 100)}%`}>
                <span className="block h-full bg-yellow-500/80" style={{ width: `${(c.confidence ?? 0) * 100}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {fillers.length === 0 && <div className="p-4 text-zinc-500">No fillers here.</div>}
    </div>
  );
}
