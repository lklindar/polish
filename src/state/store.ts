import { create } from 'zustand';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { computeActivity, type ActivityTrack, type VideoActivityRaw } from '../core/activity';
import { detectCapabilities, type Capabilities } from '../core/capabilities';
import { kv } from '../core/db';
import { applyCaptionEdit, buildCaptions } from '../core/captions';
import { emptyEdl, withSegments, type Cut, type EDL, type ZoomBlock } from '../core/edl';
import type { FrameData } from '../core/frameData';
import { inferClicks, trackCursor, type CursorTrack, type InferredClick } from '../core/clicks';
import { detectLayout, type Layout } from '../core/layout';
import { planZooms } from '../core/zoom';
import { closeGaps, heldWordCuts, planFillerCuts, repeatCuts } from '../core/fillers';
import { fileKey } from '../core/hash';
import { PRESETS, cloneSettings, type PresetId, type Settings } from '../core/settings';
import { detectPauses, planSilenceEdits, type AudioAnalysis, type Levels } from '../core/silence';
import { planChunks, type Transcript, type Word } from '../core/transcript';
import type { AnalyzeAudioOut, AnalyzeVideoOut, PcmRef, SourceMeta } from '../workers/protocol';
import type { WhisperIn, WhisperOut } from '../workers/whisper.worker';
import type { ThumbsIn, ThumbsOut } from '../workers/thumbs.worker';

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'cached';
export interface Step {
  id: 'probe' | 'audio' | 'transcribe' | 'video' | 'build';
  label: string;
  detail?: string;
  status: StepStatus;
  fraction: number;
}

const HISTORY_LIMIT = 200;
const ANALYSIS_VERSION = 7;
const PROJECT_VERSION = 2;

interface CachedAnalysis {
  v: number;
  meta: SourceMeta;
  audio: AudioAnalysis | null;
  activityRaw: VideoActivityRaw | null;
  frameData: FrameData | null;
  pcm: PcmRef | null;
}

interface SavedProject {
  v: number;
  edl: EDL;
  settings: Settings;
  presetId: PresetId | 'custom';
  savedAt: number;
}

export type Selection =
  | { kind: 'cut'; index: number }
  | { kind: 'speedup'; index: number }
  | { kind: 'caption'; index: number }
  | { kind: 'zoom'; index: number }
  | { kind: 'range'; start: number; end: number }
  | null;

interface State {
  caps: Capabilities | null;
  phase: 'start' | 'analyzing' | 'editor';
  file: File | null;
  fileUrl: string | null;
  key: string | null;
  meta: SourceMeta | null;
  steps: Step[];
  error: string | null;
  analysisStartedAt: number;
  analysisMs: number;

  audio: AudioAnalysis | null;
  activity: ActivityTrack | null;
  levels: Levels | null;
  pcm: PcmRef | null;
  /** Frame analysis results: window/webcam layout, cursor path and inferred clicks. */
  vision: Vision | null;
  /** Hover-preview thumbnails, one per `interval` s of source; filled in progressively. */
  thumbs: { interval: number; blobs: (Blob | undefined)[]; ready: boolean } | null;
  /** Live words while (re)transcribing, and progress for the editor's banner. */
  transcribing: { fraction: number; detail: string; words: Word[] } | null;

  presetId: PresetId | 'custom';
  settings: Settings;
  edl: EDL | null;
  past: EDL[];
  future: EDL[];
  selection: Selection;
  mode: 'after' | 'before';
  restoredProject: boolean;

  init(): Promise<void>;
  setFile(file: File): void;
  runPipeline(): Promise<void>;
  reset(): void;
  /** Pushes an undo step. Commits with the same `coalesce` tag within 600 ms merge into one step. */
  commit(edl: EDL, coalesce?: string): void;
  undo(): void;
  redo(): void;
  setSettings(s: Settings, presetId?: PresetId | 'custom'): void;
  rebuildEdit(): void;
  setSelection(s: Selection): void;
  setMode(m: 'after' | 'before'): void;
  toggleCut(index: number): void;
  toggleSpeedup(index: number): void;
  addManualCut(start: number, end: number): void;
  deleteSelection(): void;
  importProject(json: string): void;
  editCaption(index: number, text: string): void;
  applySuggestion(index: number): void;
  dismissSuggestion(index: number): void;
  retranscribe(): Promise<void>;
  /** Adds a manual zoom at source time t (focus = last cursor position, else content centre). */
  addZoom(t: number): void;
  /** Edits a zoom; any edit makes it 'manual' so re-planning keeps it. */
  updateZoom(index: number, patch: Partial<ZoomBlock>, coalesce?: string): void;
  deleteZoom(index: number): void;
  /** Whole-video playback speed (1×, 1.2×, 1.5× …), pitch preserved. */
  setGlobalSpeed(speed: number): void;
}

const initialSteps = (): Step[] => [
  { id: 'probe', label: 'Reading file', status: 'pending', fraction: 0 },
  { id: 'audio', label: 'Analyzing audio', status: 'pending', fraction: 0 },
  { id: 'transcribe', label: 'Transcribing', status: 'pending', fraction: 0 },
  { id: 'video', label: 'Finding clicks', status: 'pending', fraction: 0 },
  { id: 'build', label: 'Building edit', status: 'pending', fraction: 0 },
];

async function probe(file: File): Promise<SourceMeta> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new Error('This file has no video track.');
    const a = await input.getPrimaryAudioTrack();
    const stats = await v.computePacketStats(120);
    return {
      durationSec: await input.computeDuration(),
      width: v.displayWidth,
      height: v.displayHeight,
      fps: Math.round(stats.averagePacketRate * 100) / 100 || 30,
      hasAudio: !!a,
      audioCodec: a?.codec ?? null,
      videoCodec: v.codec ?? null,
      sampleRate: a?.sampleRate ?? 0,
      channels: a?.numberOfChannels ?? 0,
    };
  } finally {
    input.dispose();
  }
}

function runWorker<TOut extends { type: string }>(
  worker: Worker,
  msg: unknown,
  onProgress: (f: number) => void,
): Promise<Extract<TOut, { type: 'done' }>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<TOut & { fraction?: number; message?: string }>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.fraction ?? 0);
      else if (m.type === 'done') {
        resolve(m as Extract<TOut, { type: 'done' }>);
        worker.terminate();
      } else if (m.type === 'error') {
        reject(new Error(m.message));
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Worker crashed'));
      worker.terminate();
    };
    worker.postMessage(msg);
  });
}

/** Fills settings added in later versions (and renamed fields) from the Premium defaults. */
function migrateSettings(s: Settings): Settings {
  const d = PRESETS.premium.settings;
  const out = cloneSettings(d);
  for (const k of Object.keys(d) as (keyof Settings)[]) Object.assign(out[k], s[k] ?? {});
  const legacy = s.captions as Settings['captions'] & { burnIn?: boolean };
  if (legacy && legacy.enabled === undefined && legacy.burnIn !== undefined) out.captions.enabled = legacy.burnIn;
  delete (out.captions as { burnIn?: boolean }).burnIn;
  return out;
}

export interface Vision {
  layout: Layout;
  track: CursorTrack;
  clicks: InferredClick[];
}

function analyzeVision(fd: FrameData | null): Vision | null {
  if (!fd) return null;
  const layout = detectLayout(fd);
  const track = trackCursor(fd, layout);
  return { layout, track, clicks: inferClicks(fd, layout, track) };
}

/** Recomputes everything derived from cuts: segments and captions. */
function finalize(edl: EDL, settings: Settings): EDL {
  const withSegs = withSegments(edl);
  const words = edl.transcript?.words ?? [];
  return { ...withSegs, captions: words.length ? buildCaptions(words, withSegs.cuts, settings.captions) : [] };
}

/** Regenerates auto cuts from analysis + settings, keeping manual cuts and the user's toggles. */
function planEdl(base: EDL, audio: AudioAnalysis | null, activity: ActivityTrack | null, settings: Settings, vision: Vision | null) {
  base = planVision(base, settings, vision);
  if (!audio) return { edl: finalize(base, settings), levels: null };
  const plan = planSilenceEdits(audio, activity, settings.silence);
  const words = base.transcript?.words ?? [];
  const fs = settings.fillers;
  const baseFillers = planFillerCuts(audio, plan.levels, words, fs);
  const held = fs.enabled && fs.trimHeldWords && words.length ? heldWordCuts(words, audio) : [];
  const repeats = fs.removeRepeats && words.length ? repeatCuts(words, audio, baseFillers) : [];
  // Close the pauses around removed fillers/repeats so they don't join into one long gap.
  const fillers = closeGaps([...baseFillers, ...held, ...repeats], plan.pauses, settings.silence.paddingSec);
  const overlaps = (a: Cut, b: Cut) =>
    a.type === b.type && Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.5 * Math.min(a.end - a.start, b.end - b.start);
  const userSet = base.cuts.filter((c) => c.userSet && c.type !== 'manual');
  const remember = (c: Cut): Cut => {
    const prev = userSet.find((u) => overlaps(c, u));
    return prev ? { ...c, enabled: prev.enabled, userSet: true } : c;
  };
  const cuts = [...plan.cuts, ...fillers]
    .map(remember)
    .concat(base.cuts.filter((c) => c.type === 'manual'))
    .sort((a, b) => a.start - b.start);
  // Retakes are cut (as 'repeat' cuts) now; nothing left to suggest separately.
  const suggestions: { start: number; end: number; text: string }[] = [];
  const edl = finalize({ ...base, cuts, speedups: plan.speedups, suggestions }, settings);
  return { edl, levels: plan.levels };
}

/** Auto zooms from clicks; zooms the user created or edited (source 'manual') are kept. */
function planVision(base: EDL, settings: Settings, vision: Vision | null): EDL {
  if (!vision) return base;
  const manual = base.zooms.filter((z) => z.source === 'manual');
  const dismissed = base.dismissedZooms ?? [];
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
  const auto = planZooms(vision.clicks, vision.track, vision.layout.content, settings.zoom).filter(
    (z) => !manual.some((m) => overlaps(m, z)) && !dismissed.some((d) => overlaps(d, z)),
  );
  return {
    ...base,
    layout: vision.layout,
    clicks: vision.clicks.map((c) => ({ t: c.t, x: c.x, y: c.y, confidence: c.confidence, reason: c.reason })),
    zooms: [...manual, ...auto].sort((a, b) => a.start - b.start),
  };
}

const transcriptKey = (key: string, t: Settings['transcription']) =>
  `transcript:v2:${key}:${t.model}:${t.language}:${t.prompt.length}:${hashStr(t.prompt)}`;

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function pcmExists(pcm: PcmRef | null) {
  if (!pcm) return false;
  try {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle(pcm.name)).getFile();
    return f.size >= pcm.samples * 4;
  } catch {
    return false;
  }
}

/** Runs the Whisper worker over pause-aligned chunks. */
function transcribe(
  pcm: PcmRef,
  audio: AudioAnalysis,
  durationSec: number,
  settings: Settings,
  preferWebGpu: boolean,
  onProgress: (fraction: number, detail: string, words: Word[]) => void,
): Promise<Transcript> {
  const { pauses } = detectPauses(audio, settings.silence.thresholdRatio);
  const chunks = planChunks(durationSec, pauses);
  const worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), { type: 'module' });
  const words: Word[] = [];
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WhisperOut>) => {
      const m = e.data;
      if (m.type === 'download') {
        const mb = (b: number) => (b / 1048576).toFixed(0);
        onProgress(0, `Downloading whisper-${settings.transcription.model} (${mb(m.loaded)}/${mb(m.total)} MB, cached after)`, words);
      } else if (m.type === 'progress') {
        words.push(...m.words);
        onProgress(m.fraction, `${Math.round(m.fraction * chunks.length)}/${chunks.length} chunks · ${m.device.toUpperCase()}`, words);
      } else if (m.type === 'done') {
        worker.terminate();
        if (m.retries) console.info(`[transcribe] ${m.retries} chunk(s) re-decoded without the prompt (skipped speech)`);
        resolve({ words: m.words, language: m.language, device: m.device, model: `whisper-${m.model}` });
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Transcription worker crashed'));
    };
    const msg: WhisperIn = {
      type: 'start',
      pcm,
      chunks,
      pauses: pauses.map((p) => ({ start: p.start, end: p.end })),
      model: settings.transcription.model,
      language: settings.transcription.language,
      prompt: settings.transcription.prompt,
      preferWebGpu,
    };
    worker.postMessage(msg);
  });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let thumbWorker: Worker | null = null;

const THUMB_INTERVAL = 1;
const THUMB_WIDTH = 240;

/** Hover previews: from the cache, or generated in the background (progressively) and cached. */
async function loadThumbnails(key: string, file: File) {
  const cacheKey = `thumbs:v1:${key}`;
  const cached = await kv.get<{ interval: number; blobs: Blob[] }>(cacheKey);
  if (useStore.getState().key !== key) return;
  if (cached) {
    useStore.setState({ thumbs: { interval: cached.interval, blobs: cached.blobs, ready: true } });
    return;
  }
  thumbWorker?.terminate();
  const w = new Worker(new URL('../workers/thumbs.worker.ts', import.meta.url), { type: 'module' });
  thumbWorker = w;
  const blobs: (Blob | undefined)[] = [];
  useStore.setState({ thumbs: { interval: THUMB_INTERVAL, blobs, ready: false } });
  w.onmessage = (e: MessageEvent<ThumbsOut>) => {
    const m = e.data;
    if (useStore.getState().key !== key) return w.terminate();
    if (m.type === 'batch') {
      blobs.length = Math.max(blobs.length, m.total);
      m.blobs.forEach((b, i) => (blobs[m.indices[i]] = b));
      useStore.setState({ thumbs: { interval: THUMB_INTERVAL, blobs: blobs.slice(), ready: false } });
    } else if (m.type === 'done') {
      useStore.setState({ thumbs: { interval: THUMB_INTERVAL, blobs: blobs.slice(), ready: true } });
      void kv.set(cacheKey, { interval: THUMB_INTERVAL, blobs });
      w.terminate();
      thumbWorker = null;
    } else {
      console.warn('[thumbs]', m.message);
      w.terminate();
    }
  };
  w.postMessage({ file, interval: THUMB_INTERVAL, width: THUMB_WIDTH } satisfies ThumbsIn);
}
let lastCommit: { tag?: string; at: number } = { at: 0 };

export const useStore = create<State>((set, get) => ({
  caps: null,
  phase: 'start',
  file: null,
  fileUrl: null,
  key: null,
  meta: null,
  steps: initialSteps(),
  error: null,
  analysisStartedAt: 0,
  analysisMs: 0,
  audio: null,
  activity: null,
  levels: null,
  pcm: null,
  vision: null,
  thumbs: null,
  transcribing: null,
  presetId: 'premium',
  settings: cloneSettings(PRESETS.premium.settings),
  edl: null,
  past: [],
  future: [],
  selection: null,
  mode: 'after',
  restoredProject: false,

  async init() {
    set({ caps: await detectCapabilities() });
  },

  setFile(file) {
    const old = get().fileUrl;
    if (old) URL.revokeObjectURL(old);
    set({ file, fileUrl: URL.createObjectURL(file), error: null, steps: initialSteps() });
  },

  async runPipeline() {
    const { file } = get();
    if (!file) return;
    const t0 = performance.now();
    set({ phase: 'analyzing', error: null, steps: initialSteps(), analysisStartedAt: Date.now() });
    const step = (id: Step['id'], patch: Partial<Step>) =>
      set((s) => ({ steps: s.steps.map((st) => (st.id === id ? { ...st, ...patch } : st)) }));

    try {
      step('probe', { status: 'running' });
      const [key, meta] = await Promise.all([fileKey(file), probe(file)]);
      step('probe', { status: 'done', fraction: 1 });
      set({ key, meta });

      let cached = await kv.get<CachedAnalysis>(`analysis:${key}`);
      if (cached?.v !== ANALYSIS_VERSION || (cached.audio && !(await pcmExists(cached.pcm)))) cached = undefined;
      let audio = cached?.audio ?? null;
      let activityRaw = cached?.activityRaw ?? null;
      let frameData = cached?.frameData ?? null;
      let pcm = cached?.pcm ?? null;
      const settings = get().settings;
      const tKey = transcriptKey(key, settings.transcription);
      const preferWebGpu = !!get().caps?.webGpu;

      const runTranscription = async (a: AudioAnalysis | null, p: PcmRef | null): Promise<Transcript | null> => {
        if (!a || !p) {
          step('transcribe', { status: 'done', fraction: 1, detail: 'no audio' });
          return null;
        }
        const hit = await kv.get<Transcript>(tKey);
        if (hit) {
          step('transcribe', { status: 'cached', fraction: 1 });
          return hit;
        }
        step('transcribe', { status: 'running' });
        const t = await transcribe(p, a, meta.durationSec, settings, preferWebGpu, (fraction, detail) =>
          step('transcribe', { fraction, detail }),
        );
        await kv.set(tKey, t);
        step('transcribe', { status: 'done', fraction: 1, detail: `${t.words.length} words · ${t.language} · ${t.device}` });
        return t;
      };

      let transcript: Transcript | null;
      if (cached) {
        step('audio', { status: 'cached', fraction: 1 });
        step('video', { status: 'cached', fraction: 1 });
        transcript = await runTranscription(audio, pcm);
      } else {
        step('audio', { status: meta.hasAudio ? 'running' : 'done' });
        step('video', { status: 'running' });
        // Audio → transcription runs alongside the (longer) screen scan.
        const audioThenText = meta.hasAudio
          ? runWorker<AnalyzeAudioOut>(
              new Worker(new URL('../workers/analyzeAudio.worker.ts', import.meta.url), { type: 'module' }),
              { file, key },
              (f) => step('audio', { fraction: f }),
            ).then(async (r) => {
              step('audio', { status: 'done', fraction: 1 });
              audio = r.audio;
              pcm = r.pcm ?? null;
              return runTranscription(audio, pcm);
            })
          : Promise.resolve(null);
        const videoP = runWorker<AnalyzeVideoOut>(
          new Worker(new URL('../workers/analyzeVideo.worker.ts', import.meta.url), { type: 'module' }),
          { file },
          (f) => step('video', { fraction: f }),
        ).then((r) => {
          step('video', { status: 'done', fraction: 1 });
          frameData = r.frameData;
          return r.activity;
        });
        [transcript, activityRaw] = await Promise.all([audioThenText, videoP]);
        await kv.set(`analysis:${key}`, { v: ANALYSIS_VERSION, meta, audio, activityRaw, frameData, pcm } satisfies CachedAnalysis);
      }

      step('build', { status: 'running' });
      const activity = activityRaw ? computeActivity(activityRaw) : null;
      const vision = analyzeVision(frameData);
      const saved = await kv.get<SavedProject>(`project:${key}`);
      let edl: EDL;
      let levels: Levels | null = null;
      let restoredProject = false;
      if (saved?.edl && saved.v === PROJECT_VERSION) {
        edl = saved.edl;
        restoredProject = true;
        const restored = migrateSettings(saved.settings);
        set({ settings: restored, presetId: saved.presetId });
        levels = planEdl(edl, audio, activity, restored, vision).levels;
      } else {
        const base = emptyEdl({ durationSec: meta.durationSec, width: meta.width, height: meta.height, fps: meta.fps });
        if (transcript) base.transcript = transcript;
        ({ edl, levels } = planEdl(base, audio, activity, get().settings, vision));
      }
      step('build', { status: 'done', fraction: 1 });
      set({
        audio,
        activity,
        levels,
        pcm,
        vision,
        edl,
        past: [],
        future: [],
        selection: null,
        phase: 'editor',
        restoredProject,
        analysisMs: performance.now() - t0,
      });
      void loadThumbnails(key, file);
    } catch (err) {
      set((s) => ({
        error: String((err as Error)?.message ?? err),
        steps: s.steps.map((st) => (st.status === 'running' ? { ...st, status: 'error' } : st)),
      }));
    }
  },

  reset() {
    thumbWorker?.terminate();
    thumbWorker = null;
    const old = get().fileUrl;
    if (old) URL.revokeObjectURL(old);
    set({
      phase: 'start',
      file: null,
      fileUrl: null,
      key: null,
      meta: null,
      edl: null,
      audio: null,
      activity: null,
      pcm: null,
      vision: null,
      thumbs: null,
      transcribing: null,
      past: [],
      future: [],
      selection: null,
      steps: initialSteps(),
      error: null,
    });
  },

  commit(edl, coalesce) {
    const prev = get().edl;
    const now = performance.now();
    const merge = !!coalesce && lastCommit.tag === coalesce && now - lastCommit.at < 600;
    lastCommit = { tag: coalesce, at: now };
    set((s) => ({
      edl,
      past: prev && !merge ? [...s.past, prev].slice(-HISTORY_LIMIT) : s.past,
      future: [],
    }));
    scheduleSave();
  },

  undo() {
    const { past, edl, future } = get();
    if (!past.length || !edl) return;
    set({ edl: past[past.length - 1], past: past.slice(0, -1), future: [edl, ...future], selection: null });
    scheduleSave();
  },

  redo() {
    const { past, edl, future } = get();
    if (!future.length || !edl) return;
    set({ edl: future[0], future: future.slice(1), past: [...past, edl], selection: null });
    scheduleSave();
  },

  setSettings(settings, presetId = 'custom') {
    const prev = get().settings;
    const changed = (k: keyof Settings) => JSON.stringify(settings[k]) !== JSON.stringify(prev[k]);
    // Caption on/off is a display choice; only layout changes re-split the caption lines.
    const captionLayoutChanged =
      JSON.stringify({ ...settings.captions, enabled: true }) !== JSON.stringify({ ...prev.captions, enabled: true });
    set({ settings, presetId });
    if (changed('transcription')) void get().retranscribe();
    else if (changed('silence') || changed('fillers') || changed('zoom') || captionLayoutChanged) get().rebuildEdit();
    else scheduleSave();
  },

  rebuildEdit() {
    const { edl, audio, activity, settings, vision } = get();
    if (!edl) return;
    const { edl: next, levels } = planEdl(edl, audio, activity, settings, vision);
    set({ levels, selection: null });
    get().commit(next, 'settings');
  },

  setSelection(selection) {
    set({ selection });
  },

  setMode(mode) {
    set({ mode });
  },

  toggleCut(index) {
    const { edl, settings } = get();
    if (!edl) return;
    const cuts = edl.cuts.map((c, i) => (i === index ? { ...c, enabled: !c.enabled, userSet: true } : c));
    get().commit(finalize({ ...edl, cuts }, settings));
  },

  toggleSpeedup(index) {
    const { edl, settings } = get();
    if (!edl) return;
    const speedups = edl.speedups.map((s, i) => (i === index ? { ...s, enabled: !s.enabled } : s));
    get().commit(finalize({ ...edl, speedups }, settings));
  },

  addManualCut(start, end) {
    const { edl, settings } = get();
    if (!edl || end - start < 0.05) return;
    const cuts = [...edl.cuts, { start, end, type: 'manual' as const, label: 'Manual cut', enabled: true }].sort(
      (a, b) => a.start - b.start,
    );
    get().commit(finalize({ ...edl, cuts }, settings));
    set({ selection: null });
  },

  deleteSelection() {
    const { selection, edl, settings } = get();
    if (!selection || !edl) return;
    if (selection.kind === 'range') get().addManualCut(selection.start, selection.end);
    else if (selection.kind === 'cut') {
      const c = edl.cuts[selection.index];
      if (c?.type === 'manual') {
        get().commit(finalize({ ...edl, cuts: edl.cuts.filter((_, i) => i !== selection.index) }, settings));
        set({ selection: null });
      } else get().toggleCut(selection.index);
    } else if (selection.kind === 'speedup') get().toggleSpeedup(selection.index);
    else if (selection.kind === 'zoom') get().deleteZoom(selection.index);
  },

  importProject(json) {
    const data = JSON.parse(json) as Partial<SavedProject>;
    if (!data.edl?.segments || !data.edl.source) throw new Error('Not a Polish project file.');
    if (data.v !== PROJECT_VERSION) throw new Error('This project file is from an older version of Polish.');
    if (data.settings) set({ settings: migrateSettings(data.settings), presetId: data.presetId ?? 'custom' });
    get().commit(finalize(data.edl, get().settings));
  },

  editCaption(index, text) {
    const { edl, settings } = get();
    const cap = edl?.captions[index];
    if (!edl?.transcript || !cap || cap.text.replace(/\n/g, ' ') === text.trim()) return;
    const words = applyCaptionEdit(edl.transcript.words, cap, text);
    get().commit(finalize({ ...edl, transcript: { ...edl.transcript, words } }, settings));
  },

  applySuggestion(index) {
    const { edl, settings } = get();
    const sug = edl?.suggestions?.[index];
    if (!edl || !sug) return;
    const cuts = [...edl.cuts, { start: sug.start, end: sug.end, type: 'manual' as const, label: 'Retake', enabled: true }].sort(
      (a, b) => a.start - b.start,
    );
    get().commit(finalize({ ...edl, cuts, suggestions: edl.suggestions!.filter((_, i) => i !== index) }, settings));
  },

  dismissSuggestion(index) {
    const { edl } = get();
    if (!edl?.suggestions) return;
    get().commit({ ...edl, suggestions: edl.suggestions.filter((_, i) => i !== index) });
  },

  addZoom(t) {
    const { edl, settings, vision } = get();
    if (!edl) return;
    const content = edl.layout?.content ?? { x: 0, y: 0, w: edl.source.width, h: edl.source.height };
    let x = content.x + content.w / 2;
    let y = content.y + content.h / 2;
    if (vision) {
      const f = Math.min(vision.track.x.length - 1, Math.round(t * vision.track.fps));
      if (!Number.isNaN(vision.track.x[f])) {
        x = vision.track.x[f];
        y = vision.track.y[f];
      }
    }
    const start = Math.max(0, t - 0.3);
    // Don't overlap neighbours: trim to the gap the playhead is in.
    const next = edl.zooms.find((z) => z.start > t);
    const end = Math.min(start + 2.5, next ? next.start : Infinity);
    if (edl.zooms.some((z) => t >= z.start && t < z.end) || end - start < 1) return;
    const zoom: ZoomBlock = { start, end, scale: settings.zoom.scale, focus: [{ t: start, x, y }], source: 'manual' };
    const zooms = [...edl.zooms, zoom].sort((a, b) => a.start - b.start);
    get().commit({ ...edl, zooms });
    set({ selection: { kind: 'zoom', index: zooms.indexOf(zoom) } });
  },

  updateZoom(index, patch, coalesce) {
    const { edl } = get();
    const z = edl?.zooms[index];
    if (!edl || !z) return;
    const zooms = edl.zooms.map((x, i) => (i === index ? { ...x, ...patch, source: 'manual' as const } : x));
    get().commit({ ...edl, zooms }, coalesce);
  },

  setGlobalSpeed(speed) {
    const { edl } = get();
    if (!edl || edl.globalSpeed === speed) return;
    get().commit({ ...edl, globalSpeed: speed });
  },

  deleteZoom(index) {
    const { edl } = get();
    const z = edl?.zooms[index];
    if (!edl || !z) return;
    const dismissedZooms = z.source === 'auto' ? [...(edl.dismissedZooms ?? []), { start: z.start, end: z.end }] : edl.dismissedZooms;
    get().commit({ ...edl, zooms: edl.zooms.filter((_, i) => i !== index), dismissedZooms });
    set({ selection: null });
  },

  async retranscribe() {
    const { key, pcm, audio, meta, settings, caps } = get();
    if (!key || !pcm || !audio || !meta || get().transcribing) return;
    try {
      const tKey = transcriptKey(key, settings.transcription);
      let t = await kv.get<Transcript>(tKey);
      if (!t) {
        set({ transcribing: { fraction: 0, detail: 'Starting…', words: [] } });
        t = await transcribe(pcm, audio, meta.durationSec, settings, !!caps?.webGpu, (fraction, detail, words) =>
          set({ transcribing: { fraction, detail, words: words.slice() } }),
        );
        await kv.set(tKey, t);
      }
      const edl = get().edl!;
      const { edl: next, levels } = planEdl({ ...edl, transcript: t }, audio, get().activity, get().settings, get().vision);
      set({ levels });
      get().commit(next);
    } catch (err) {
      set({ error: String((err as Error)?.message ?? err) });
    } finally {
      set({ transcribing: null });
    }
  },
}));

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { key, edl, settings, presetId } = useStore.getState();
    if (key && edl) void kv.set(`project:${key}`, { v: PROJECT_VERSION, edl, settings, presetId, savedAt: Date.now() } satisfies SavedProject);
  }, 600);
}

export function projectJson(): string {
  const { edl, settings, presetId } = useStore.getState();
  return JSON.stringify({ v: PROJECT_VERSION, edl, settings, presetId, savedAt: Date.now() }, null, 2);
}

export async function forgetProject() {
  const { key } = useStore.getState();
  if (key) await kv.del(`project:${key}`);
}

// Dev only: a handle for automated checks in the browser console.
if (import.meta.env.DEV) (globalThis as unknown as { __polish: unknown }).__polish = { useStore };
