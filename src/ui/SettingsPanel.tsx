import { useState, type ReactNode } from 'react';
import { PRESETS, cloneSettings, type PresetId, type Settings } from '../core/settings';
import { fmtTime } from '../core/format';
import { useStore } from '../state/store';
import { usePlayer } from './playerContext';
import { CUT_COLORS } from './Timeline';
import { ReviewPanel } from './ReviewPanel';
import { TranscriptPanel } from './TranscriptPanel';

type Tab = 'edit' | 'review' | 'transcript';

export function SettingsPanel() {
  const [tab, setTab] = useState<Tab>('edit');
  const transcribing = useStore((s) => s.transcribing);
  const fillerCount = useStore((s) => s.edl?.cuts.filter((c) => c.type === 'filler').length ?? 0);
  return (
    <aside className="w-[22rem] shrink-0 border-l border-zinc-800/80 flex flex-col min-h-0">
      <div className="flex border-b border-zinc-800/80 text-sm">
        {(
          [
            ['edit', 'Edit'],
            ['review', `Review${fillerCount ? ` (${fillerCount})` : ''}`],
            ['transcript', 'Transcript'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 py-2.5 border-b-2 ${tab === id ? 'border-accent text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {transcribing && (
        <div className="px-4 py-2 text-xs text-zinc-400 border-b border-zinc-800/80">
          Transcribing… {transcribing.detail}
          <div className="h-1 mt-1 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${transcribing.fraction * 100}%` }} />
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'edit' ? <EditSettings /> : tab === 'review' ? <ReviewPanel /> : <TranscriptPanel />}
      </div>
    </aside>
  );
}

function EditSettings() {
  const { settings, presetId, levels, edl, selection } = useStore();
  const setSettings = useStore((s) => s.setSettings);
  const update = (fn: (s: Settings) => void) => {
    const next = cloneSettings(settings);
    fn(next);
    setSettings(next, 'custom');
  };
  const sil = settings.silence;
  const fil = settings.fillers;
  const transcribing = useStore((s) => s.transcribing);
  const fillers = edl?.cuts.filter((c) => c.type === 'filler') ?? [];
  const fillerSummary = edl?.transcript
    ? `${fillers.filter((c) => c.enabled).length} removed, ${fillers.filter((c) => !c.enabled).length} below threshold (see Review)`
    : 'Needs a transcript';

  return (
    <div className="text-sm">
      <div className="p-4 border-b border-zinc-800/80">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Preset</div>
        <div className="flex gap-1">
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <button
              key={id}
              onClick={() => setSettings(cloneSettings(PRESETS[id].settings), id)}
              className={`flex-1 py-1.5 rounded-md border text-xs ${
                presetId === id ? 'border-accent bg-accent/15 text-white' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {PRESETS[id].label}
            </button>
          ))}
        </div>
        {presetId === 'custom' && <div className="text-xs text-zinc-500 mt-2">Custom settings</div>}
      </div>

      {selection && <SelectionCard />}

      <Section title="Silence" enabled={sil.enabled} onToggle={(v) => update((s) => (s.silence.enabled = v))}>
        <Slider label="Shorten pauses longer than" value={sil.minSilenceSec} min={0.3} max={2.5} step={0.05} unit="s"
          onChange={(v) => update((s) => (s.silence.minSilenceSec = v))} />
        <Slider label="Keep around speech" value={sil.paddingSec} min={0.04} max={0.4} step={0.01} unit="s"
          hint={`Pauses become ≈${(sil.paddingSec * 2).toFixed(2)}s`}
          onChange={(v) => update((s) => (s.silence.paddingSec = v))} />
        <Slider label="Sensitivity" value={sil.thresholdRatio} min={0.15} max={0.6} step={0.01}
          hint="Higher treats more quiet speech as silence"
          onChange={(v) => update((s) => (s.silence.thresholdRatio = v))} />
        <Toggle label="Speed up silent-but-busy parts" value={sil.speedUpBusy}
          onChange={(v) => update((s) => (s.silence.speedUpBusy = v))} />
        {sil.speedUpBusy && (
          <>
            <Slider label="Max speed-up" value={sil.maxSpeed} min={3} max={16} step={0.5} unit="×"
              onChange={(v) => update((s) => (s.silence.maxSpeed = v))} />
            <Slider label="Target length of a busy pause" value={sil.speedUpTargetSec} min={0.5} max={4} step={0.25} unit="s"
              onChange={(v) => update((s) => (s.silence.speedUpTargetSec = v))} />
          </>
        )}
        <Toggle label="Trim dead air at start and end" value={sil.trimDeadAir}
          onChange={(v) => update((s) => (s.silence.trimDeadAir = v))} />
        {levels && (
          <div className="text-xs text-zinc-500 leading-relaxed mt-1">
            Adaptive levels: floor {levels.floorDb.toFixed(1)} dB · speech {levels.speechDb.toFixed(1)} dB ·
            threshold {levels.thresholdDb.toFixed(1)} ± {levels.hysteresisDb.toFixed(1)} dB
          </div>
        )}
        {edl && <Legend />}
      </Section>

      <Section title="Fillers" enabled={fil.enabled} onToggle={(v) => update((s) => (s.fillers.enabled = v))}>
        <Slider label="Remove when confidence ≥" value={fil.minConfidence} min={0.3} max={0.95} step={0.05}
          hint={fillerSummary}
          onChange={(v) => update((s) => (s.fillers.minConfidence = v))} />
        <Toggle label="Acoustic detector (fillers Whisper skipped)" value={fil.acoustic}
          onChange={(v) => update((s) => (s.fillers.acoustic = v))} />
        <TextSetting label="Filler words" value={fil.lexicon} hint="Comma-separated. Letters may repeat: “um” also matches “ummm”."
          onCommit={(v) => update((s) => (s.fillers.lexicon = v))} />
        <TextSetting label="Maybe-fillers (review only)" value={fil.softLexicon}
          onCommit={(v) => update((s) => (s.fillers.softLexicon = v))} />
      </Section>

      <Section title="Transcription">
        <label className="flex items-center justify-between">
          <span className="text-zinc-400">Model</span>
          <select
            value={settings.transcription.model}
            disabled={!!transcribing}
            onChange={(e) => update((s) => (s.transcription.model = e.target.value as 'base' | 'small'))}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
          >
            <option value="base">whisper-base (fast)</option>
            <option value="small">whisper-small (accurate)</option>
          </select>
        </label>
        <label className="flex items-center justify-between">
          <span className="text-zinc-400">Language</span>
          <select
            value={settings.transcription.language}
            disabled={!!transcribing}
            onChange={(e) => update((s) => (s.transcription.language = e.target.value as 'auto' | 'en' | 'id'))}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
          >
            <option value="auto">Auto (English / Indonesian)</option>
            <option value="en">English</option>
            <option value="id">Indonesian</option>
          </select>
        </label>
        <TextSetting label="Disfluent prompt" value={settings.transcription.prompt}
          hint="Primes Whisper to keep fillers instead of cleaning them up. Changing it re-transcribes."
          onCommit={(v) => update((s) => (s.transcription.prompt = v))} />
      </Section>

      <Section title="Captions" enabled={settings.captions.burnIn} onToggle={(v) => update((s) => (s.captions.burnIn = v))}>
        <Slider label="Max characters per line" value={settings.captions.maxCharsPerLine} min={20} max={60} step={1}
          onChange={(v) => update((s) => (s.captions.maxCharsPerLine = v))} />
        <Slider label="Lines" value={settings.captions.maxLines} min={1} max={2} step={1}
          onChange={(v) => update((s) => (s.captions.maxLines = v))} />
        <Slider label="Size" value={settings.captions.size * 100} min={2.5} max={7} step={0.1} unit="%"
          onChange={(v) => update((s) => (s.captions.size = v / 100))} />
        <Toggle label="Highlight the current word" value={settings.captions.highlightWord}
          onChange={(v) => update((s) => (s.captions.highlightWord = v))} />
        <div className="text-xs text-zinc-500">On = burned into the video. An .srt is always exported.</div>
      </Section>

      <Section title="Export">
        <label className="flex items-center justify-between">
          <span className="text-zinc-400">Resolution</span>
          <select
            value={settings.export.resolution}
            onChange={(e) => update((s) => (s.export.resolution = e.target.value as Settings['export']['resolution']))}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
          >
            <option value="1080p">1080p</option>
            <option value="source">Source</option>
            <option value="4k">4K upscale</option>
          </select>
        </label>
        <Slider label="Bitrate" value={settings.export.bitrateMbps} min={4} max={30} step={1} unit=" Mbps"
          onChange={(v) => update((s) => (s.export.bitrateMbps = v))} />
      </Section>

      <div className="p-4 text-xs text-zinc-600">Zoom arrives in M4; audio polish in M5.</div>
    </div>
  );
}

function SelectionCard() {
  const player = usePlayer();
  const { selection, edl } = useStore();
  const s = useStore.getState();
  if (!selection || !edl || selection.kind === 'caption') return null;
  let title = '';
  let range: [number, number] = [0, 0];
  let enabled = true;
  let action: (() => void) | null = null;
  if (selection.kind === 'range') {
    title = 'Selection';
    range = [selection.start, selection.end];
  } else if (selection.kind === 'cut') {
    const c = edl.cuts[selection.index];
    if (!c) return null;
    title = c.type === 'filler' ? `Filler “${c.label}” · ${Math.round((c.confidence ?? 0) * 100)}%` : (c.label ?? c.type);
    range = [c.start, c.end];
    enabled = c.enabled;
    action = () => s.toggleCut(selection.index);
  } else {
    const sp = edl.speedups[selection.index];
    if (!sp) return null;
    title = `Speed-up ${sp.speed}×`;
    range = [sp.start, sp.end];
    enabled = sp.enabled;
    action = () => s.toggleSpeedup(selection.index);
  }
  return (
    <div className="m-3 p-3 rounded-lg bg-zinc-900 border border-zinc-800">
      <div className="font-medium">{title}</div>
      <div className="text-xs text-zinc-500 tabular-nums mt-0.5">
        {fmtTime(range[0], true)} → {fmtTime(range[1], true)} ({(range[1] - range[0]).toFixed(2)}s)
      </div>
      <div className="flex gap-2 mt-2">
        <button
          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs"
          onClick={() => {
            s.setMode('before');
            player.seek(Math.max(0, range[0] - 0.5));
            void player.play();
          }}
        >
          ▶ Play original
        </button>
        {action ? (
          <button className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs" onClick={action}>
            {enabled ? 'Keep this (restore)' : 'Remove again'}
          </button>
        ) : (
          <button className="px-2 py-1 rounded bg-accent/80 hover:bg-accent text-xs" onClick={() => s.deleteSelection()}>
            Cut selection (Del)
          </button>
        )}
      </div>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ['Silence', CUT_COLORS.silence],
    ['Filler', CUT_COLORS.filler],
    ['Speed-up', CUT_COLORS.speedup],
    ['Dead air', CUT_COLORS.deadStartEnd],
    ['Manual', CUT_COLORS.manual],
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500 mt-2">
      {items.map(([l, c]) => (
        <span key={l} className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} /> {l}
        </span>
      ))}
      <span className="w-full text-zinc-600">Click an edit to select · double-click to toggle · drag on the waveform + Del to cut</span>
    </div>
  );
}

function Section(props: { title: string; enabled?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-zinc-800/80">
      <div className="flex items-center px-4 py-3">
        <button onClick={() => setOpen(!open)} className="flex-1 text-left font-medium">
          <span className="text-zinc-500 mr-1">{open ? '▾' : '▸'}</span> {props.title}
        </button>
        {props.onToggle && <Switch value={!!props.enabled} onChange={props.onToggle} />}
      </div>
      {open && <div className={`px-4 pb-4 space-y-3 ${props.enabled === false ? 'opacity-40 pointer-events-none' : ''}`}>{props.children}</div>}
    </section>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const decimals = props.step < 0.1 ? 2 : props.step < 1 ? 1 : 0;
  return (
    <label className="block">
      <div className="flex justify-between text-zinc-400">
        <span>{props.label}</span>
        <span className="tabular-nums text-zinc-200">
          {props.value.toFixed(decimals)}
          {props.unit}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.hint && <div className="text-xs text-zinc-600">{props.hint}</div>}
    </label>
  );
}

function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-400">{props.label}</span>
      <Switch value={props.value} onChange={props.onChange} />
    </div>
  );
}

function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`h-5 w-9 rounded-full relative transition ${value ? 'bg-accent' : 'bg-zinc-700'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? 'left-4.5' : 'left-0.5'}`} />
    </button>
  );
}

function TextSetting(props: { label: string; value: string; hint?: string; onCommit: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-zinc-400">{props.label}</span>
      <textarea
        key={props.value}
        defaultValue={props.value}
        rows={2}
        onBlur={(e) => e.target.value !== props.value && props.onCommit(e.target.value)}
        className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 resize-y"
      />
      {props.hint && <div className="text-xs text-zinc-600">{props.hint}</div>}
    </label>
  );
}
