// Edit Decision List: the single source of truth for an edit. Nothing is re-encoded until export.

export type CutType = 'silence' | 'filler' | 'manual' | 'deadStartEnd';

export interface Cut {
  start: number;
  end: number;
  type: CutType;
  label?: string;
  enabled: boolean;
  confidence?: number;
  /** The user toggled this cut; re-planning keeps their choice. */
  userSet?: boolean;
}

export interface SpeedUp {
  start: number;
  end: number;
  speed: number;
  enabled: boolean;
}

export interface Segment {
  srcStart: number;
  srcEnd: number;
  speed: number;
  reason?: 'keep' | 'speedup';
}

export interface ZoomBlock {
  start: number;
  end: number;
  scale: number;
  focus: { t: number; x: number; y: number }[];
  source: 'auto' | 'manual';
}

export interface Click {
  t: number;
  x: number;
  y: number;
  confidence: number;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
  words: { t0: number; t1: number; w: string }[];
}

export interface EDL {
  source: { durationSec: number; width: number; height: number; fps: number };
  /** Derived from cuts + speedups by `buildSegments`; kept parts in source order. */
  segments: Segment[];
  cuts: Cut[];
  /** Silent-but-busy ranges played faster instead of cut. */
  speedups: SpeedUp[];
  zooms: ZoomBlock[];
  clicks: Click[];
  captions: Caption[];
  audio: { denoise: boolean; targetLufs: number; music?: { fileId: string; gainDb: number; duck: boolean } };
  style: Record<string, unknown>;
  /** Whole-video playback speed (pitch preserved). */
  globalSpeed: number;
  /** Source of truth for captions; caption edits rewrite these words. */
  transcript?: { words: { w: string; t0: number; t1: number }[]; language: string; model: string; device: string };
  /** False starts / retakes, offered for review, never cut automatically. */
  suggestions?: { start: number; end: number; text: string }[];
}

/** Kept pieces shorter than this are swallowed by neighbouring cuts (avoids flashes and clicks). */
export const MIN_SEGMENT_SEC = 0.08;

export function emptyEdl(source: EDL['source']): EDL {
  return {
    source,
    segments: [{ srcStart: 0, srcEnd: source.durationSec, speed: 1, reason: 'keep' }],
    cuts: [],
    speedups: [],
    zooms: [],
    clicks: [],
    captions: [],
    audio: { denoise: true, targetLufs: -16 },
    style: {},
    globalSpeed: 1,
  };
}

interface Range {
  start: number;
  end: number;
}

/** Union of overlapping/touching ranges, sorted. */
export function mergeRanges<T extends Range>(ranges: T[], joinGap = 0): Range[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + joinGap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Turns enabled cuts and speed-ups into the ordered list of kept segments.
 * Cuts win over speed-ups. Kept slivers shorter than MIN_SEGMENT_SEC merge into the cut.
 */
export function buildSegments(durationSec: number, cuts: Cut[], speedups: SpeedUp[]): Segment[] {
  const removed = mergeRanges(
    cuts.filter((c) => c.enabled).map((c) => ({ start: clamp(c.start, 0, durationSec), end: clamp(c.end, 0, durationSec) })),
    MIN_SEGMENT_SEC,
  );

  // Kept ranges = complement of removed.
  const kept: Range[] = [];
  let t = 0;
  for (const r of removed) {
    if (r.start - t >= MIN_SEGMENT_SEC) kept.push({ start: t, end: r.start });
    t = Math.max(t, r.end);
  }
  if (durationSec - t >= MIN_SEGMENT_SEC) kept.push({ start: t, end: durationSec });

  const fast = speedups.filter((s) => s.enabled && s.end > s.start).sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  for (const k of kept) {
    let cursor = k.start;
    for (const s of fast) {
      const a = Math.max(s.start, k.start);
      const b = Math.min(s.end, k.end);
      if (b - a < MIN_SEGMENT_SEC || a < cursor) continue;
      if (a - cursor > 1e-6) segments.push({ srcStart: cursor, srcEnd: a, speed: 1, reason: 'keep' });
      segments.push({ srcStart: a, srcEnd: b, speed: s.speed, reason: 'speedup' });
      cursor = b;
    }
    if (k.end - cursor > 1e-6) segments.push({ srcStart: cursor, srcEnd: k.end, speed: 1, reason: 'keep' });
  }
  return segments;
}

/** Recomputes `segments` from the EDL's cuts and speed-ups. */
export function withSegments(edl: EDL): EDL {
  return { ...edl, segments: buildSegments(edl.source.durationSec, edl.cuts, edl.speedups) };
}

/** Output start time of each segment (before global speed), plus total at the end. */
export function segmentOutStarts(segments: Segment[]): number[] {
  const starts = new Array<number>(segments.length + 1);
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    starts[i] = acc;
    acc += (segments[i].srcEnd - segments[i].srcStart) / segments[i].speed;
  }
  starts[segments.length] = acc;
  return starts;
}

export function outputDuration(segments: Segment[], globalSpeed = 1): number {
  return segmentOutStarts(segments)[segments.length] / globalSpeed;
}

/** Index of the segment containing src time `t`, or -1 when `t` is inside a cut. */
export function segmentIndexAt(segments: Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.srcStart) hi = mid - 1;
    else if (t >= s.srcEnd) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Index of the first segment starting at or after src time `t` (segments.length if none). */
export function nextSegmentIndex(segments: Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].srcEnd <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Source → output time. Times inside a cut snap to where the next kept segment begins. */
export function srcToOut(segments: Segment[], t: number, globalSpeed = 1): number {
  const starts = segmentOutStarts(segments);
  const i = nextSegmentIndex(segments, t);
  if (i >= segments.length) return starts[segments.length] / globalSpeed;
  const s = segments[i];
  const local = Math.max(0, t - s.srcStart) / s.speed;
  return (starts[i] + local) / globalSpeed;
}

/** Output → source time. */
export function outToSrc(segments: Segment[], tOut: number, globalSpeed = 1): number {
  if (segments.length === 0) return 0;
  const starts = segmentOutStarts(segments);
  const target = Math.max(0, tOut * globalSpeed);
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const s = segments[lo];
  return Math.min(s.srcEnd, s.srcStart + (target - starts[lo]) * s.speed);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Summary used in the edit report. */
export function editStats(edl: EDL) {
  const out = outputDuration(edl.segments, edl.globalSpeed);
  const enabled = edl.cuts.filter((c) => c.enabled);
  return {
    sourceSec: edl.source.durationSec,
    outputSec: out,
    removedSec: edl.source.durationSec - out,
    silences: enabled.filter((c) => c.type === 'silence').length,
    fillers: enabled.filter((c) => c.type === 'filler').length,
    manual: enabled.filter((c) => c.type === 'manual').length,
    speedups: edl.speedups.filter((s) => s.enabled).length,
    zooms: edl.zooms.length,
  };
}
