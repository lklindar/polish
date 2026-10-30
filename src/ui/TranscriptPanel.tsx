import { useEffect, useRef, useState } from 'react';
import { captionAt } from '../core/captions';
import { srcToOut } from '../core/edl';
import { fmtTime } from '../core/format';
import { useStore } from '../state/store';
import { usePlayer } from './playerContext';

/** Caption lines in output time. Click to seek, double-click to edit (edits rewrite the words). */
export function TranscriptPanel() {
  const player = usePlayer();
  const edl = useStore((s) => s.edl)!;
  const transcribing = useStore((s) => s.transcribing);
  const editCaption = useStore((s) => s.editCaption);
  const [active, setActive] = useState(-1);
  const [editing, setEditing] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // Follow playback at ~6 Hz.
  useEffect(() => {
    const id = setInterval(() => {
      const caps = useStore.getState().edl?.captions ?? [];
      const c = captionAt(caps, player.srcTime);
      setActive(c ? caps.indexOf(c) : -1);
    }, 160);
    return () => clearInterval(id);
  }, [player]);

  useEffect(() => {
    if (active < 0 || !player.playing) return;
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, player]);

  if (!edl.transcript) {
    return (
      <div className="p-4 text-sm text-zinc-500">
        {transcribing ? `Transcribing… ${transcribing.detail}` : 'No transcript yet.'}
      </div>
    );
  }

  return (
    <div ref={listRef} className="text-sm">
      <div className="px-4 py-2 text-xs text-zinc-500 border-b border-zinc-800/80">
        {edl.transcript.words.length} words · {edl.transcript.language} · {edl.transcript.model} ({edl.transcript.device}) ·
        double-click a line to edit
      </div>
      {edl.captions.map((c, i) => (
        <div
          key={`${c.start}`}
          data-i={i}
          className={`px-4 py-1.5 border-l-2 ${i === active ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-zinc-900'}`}
          onClick={() => editing !== i && player.seek(c.start)}
          onDoubleClick={() => setEditing(i)}
        >
          <div className="text-[11px] text-zinc-500 tabular-nums">{fmtTime(srcToOut(edl.segments, c.start))}</div>
          {editing === i ? (
            <textarea
              autoFocus
              defaultValue={c.text.replace(/\n/g, ' ')}
              className="w-full bg-zinc-900 border border-accent/60 rounded p-1 text-zinc-100 resize-none"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  editCaption(i, (e.target as HTMLTextAreaElement).value);
                  setEditing(-1);
                } else if (e.key === 'Escape') setEditing(-1);
              }}
              onBlur={(e) => {
                editCaption(i, e.target.value);
                setEditing(-1);
              }}
            />
          ) : (
            <div className={i === active ? 'text-white' : 'text-zinc-300'}>{c.text.replace(/\n/g, ' ')}</div>
          )}
        </div>
      ))}
    </div>
  );
}
