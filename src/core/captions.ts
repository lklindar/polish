// Captions are derived from transcript words minus cut words, in source time. Editing a caption
// edits the underlying words, so edits survive any re-plan of the cuts.

import { segmentIndexAt, srcToOut, type Caption, type Cut, type Segment } from './edl';
import { fmtTime } from './format';
import type { Word } from './transcript';

export interface CaptionSettings {
  /** Burn captions into the exported video (the .srt is always available). */
  burnIn: boolean;
  maxCharsPerLine: number;
  maxLines: number;
  highlightWord: boolean;
  /** Font size as a fraction of output height. */
  size: number;
}

const MAX_CAPTION_SEC = 7;
const GAP_BREAK_SEC = 0.8;

/** Words whose midpoint isn't inside an enabled cut. */
export function keptWords(words: Word[], cuts: Cut[]): Word[] {
  const enabled = cuts.filter((c) => c.enabled).sort((a, b) => a.start - b.start);
  return words.filter((w) => {
    const mid = (w.t0 + w.t1) / 2;
    return !enabled.some((c) => mid >= c.start && mid < c.end);
  });
}

/** Greedy line breaking. */
export function wrapLines(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function buildCaptions(words: Word[], cuts: Cut[], s: Pick<CaptionSettings, 'maxCharsPerLine' | 'maxLines'>): Caption[] {
  const ws = keptWords(words, cuts);
  const caps: Caption[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const lines = wrapLines(cur.map((w) => w.w), s.maxCharsPerLine);
    caps.push({
      start: cur[0].t0,
      end: cur[cur.length - 1].t1,
      text: lines.join('\n'),
      words: cur.map((w) => ({ t0: w.t0, t1: w.t1, w: w.w })),
    });
    cur = [];
  };
  for (const w of ws) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const lines = wrapLines([...cur, w].map((x) => x.w), s.maxCharsPerLine);
      const sentenceEnd = /[.?!]$/.test(prev.w) && cur.map((x) => x.w).join(' ').length >= 20;
      if (
        lines.length > s.maxLines ||
        w.t0 - prev.t1 > GAP_BREAK_SEC ||
        w.t1 - cur[0].t0 > MAX_CAPTION_SEC ||
        sentenceEnd
      ) {
        flush();
      }
    }
    cur.push(w);
  }
  flush();
  // Hold each caption until the next one (max +0.6 s) so it doesn't flicker off between phrases.
  for (let i = 0; i < caps.length; i++) {
    const next = caps[i + 1];
    caps[i].end = Math.min(next ? next.start : Infinity, caps[i].end + 0.6);
  }
  return caps;
}

export function captionAt(captions: Caption[], t: number): Caption | null {
  let lo = 0;
  let hi = captions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = captions[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

/**
 * Applies an edited caption text to the transcript. Same word count → words are renamed in place
 * (timings kept); otherwise the caption's words are replaced and their span is split evenly.
 */
export function applyCaptionEdit(words: Word[], caption: Caption, newText: string): Word[] {
  const tokens = newText.split(/\s+/).filter(Boolean);
  const inCap = (w: Word) => caption.words.some((cw) => Math.abs(cw.t0 - w.t0) < 1e-6 && Math.abs(cw.t1 - w.t1) < 1e-6);
  const idx = words.map((w, i) => (inCap(w) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return words;
  const out = words.slice();
  if (tokens.length === idx.length) {
    idx.forEach((wi, k) => (out[wi] = { ...out[wi], w: tokens[k] }));
    return out;
  }
  const t0 = words[idx[0]].t0;
  const t1 = words[idx[idx.length - 1]].t1;
  const step = (t1 - t0) / Math.max(1, tokens.length);
  const replacement = tokens.map((w, k) => ({ w, t0: t0 + k * step, t1: t0 + (k + 1) * step }));
  out.splice(idx[0], idx[idx.length - 1] - idx[0] + 1, ...replacement);
  return out;
}

/** SRT in output time. Captions entirely inside cuts are dropped. */
export function toSrt(captions: Caption[], segments: Segment[], globalSpeed = 1): string {
  const blocks: string[] = [];
  let n = 1;
  for (const c of captions) {
    const a = srcToOut(segments, c.start, globalSpeed);
    const b = srcToOut(segments, c.end, globalSpeed);
    if (b - a < 0.05) continue;
    blocks.push(`${n++}\n${srtTime(a)} --> ${srtTime(b)}\n${c.text}\n`);
  }
  return blocks.join('\n');
}

function srtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (v: number, l = 2) => String(v).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** Plain transcript of the edited video (output timestamps every caption). */
export function toTranscriptText(captions: Caption[], segments: Segment[]): string {
  return captions
    .filter((c) => segmentIndexAt(segments, c.words[0]?.t0 ?? c.start) >= 0)
    .map((c) => `[${fmtTime(srcToOut(segments, c.start))}] ${c.text.replace(/\n/g, ' ')}`)
    .join('\n');
}
