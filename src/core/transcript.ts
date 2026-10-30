// Transcript types and helpers that don't depend on the ASR runtime.

import type { SilenceRange } from './silence';

export interface Word {
  w: string;
  t0: number;
  t1: number;
}

export interface Transcript {
  model: string;
  language: string;
  device: string;
  words: Word[];
}

export interface Chunk {
  start: number;
  end: number;
}

/**
 * Splits audio into ≤ maxLen s chunks for Whisper, cutting in the middle of the longest pause
 * available in each window, so words are never split across chunks.
 */
export function planChunks(durationSec: number, pauses: SilenceRange[], maxLen = 28, minLen = 8): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = 0;
  while (durationSec - cursor > maxLen) {
    let best: SilenceRange | null = null;
    for (const p of pauses) {
      const mid = (p.start + p.end) / 2;
      if (mid <= cursor + minLen || mid >= cursor + maxLen) continue;
      // Prefer long pauses; among similar ones prefer later (fewer chunks).
      const score = Math.min(p.end - p.start, 1.5) + (mid - cursor) / maxLen / 10;
      const bestScore = best ? Math.min(best.end - best.start, 1.5) + ((best.start + best.end) / 2 - cursor) / maxLen / 10 : -1;
      if (score > bestScore) best = p;
    }
    const cut = best ? (best.start + best.end) / 2 : cursor + maxLen;
    chunks.push({ start: cursor, end: cut });
    cursor = cut;
  }
  if (durationSec - cursor > 0.05) chunks.push({ start: cursor, end: durationSec });
  return chunks;
}

/**
 * Groups BPE tokens into words. A token starting with a space begins a new word; punctuation-only
 * tokens attach to the previous word. Token i spans [times[i], times[i+1]].
 */
export function tokensToWords(texts: string[], times: number[], offset = 0): Word[] {
  const words: Word[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (!t) continue;
    const t0 = times[i] + offset;
    const t1 = (times[i + 1] ?? times[i] + 0.1) + offset;
    const startsWord = /^\s/.test(t) || words.length === 0;
    const isPunct = /^[\s]*[.,!?;:…"')\]-]+$/.test(t);
    if (startsWord && !isPunct) words.push({ w: t.trim(), t0, t1 });
    else {
      const last = words[words.length - 1];
      if (last) {
        last.w += t.trim();
        last.t1 = Math.max(last.t1, t1);
      } else words.push({ w: t.trim(), t0, t1 });
    }
  }
  return words.filter((w) => w.w.length > 0);
}

/** Lowercase, strip surrounding punctuation. */
export function normWord(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Drops Whisper's repetition loops ("the the the the …") and words outside the chunk. Returns the
 * cleaned list.
 */
export function cleanChunkWords(words: Word[], chunk: Chunk): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    if (w.t0 > chunk.end + 0.2) continue;
    const t0 = Math.max(chunk.start, Math.min(w.t0, chunk.end));
    const t1 = Math.max(t0 + 0.02, Math.min(w.t1, chunk.end));
    // Same word 4+ times in a row within 2 s → decoder loop, not speech ("no, no, no" survives).
    const n = out.length;
    const k = normWord(w.w);
    if (n >= 3 && [1, 2, 3].every((d) => normWord(out[n - d].w) === k) && t0 - out[n - 3].t0 < 2) continue;
    out.push({ w: w.w, t0, t1 });
  }
  return out;
}

/**
 * Seconds of speech inside `chunk` that no word overlaps, counting only stretches of at least
 * `minGap` (short pauses inside a stretch don't break it). Catches Whisper stopping early or
 * skipping a passage.
 */
export function uncoveredSpeech(words: Word[], chunk: Chunk, pauses: { start: number; end: number }[], minGap = 2.5): number {
  const subtract = (ranges: Chunk[], holes: { start: number; end: number }[]) => {
    let out = ranges;
    for (const h of holes) {
      out = out.flatMap((r) =>
        h.end <= r.start || h.start >= r.end
          ? [r]
          : [
              ...(h.start > r.start ? [{ start: r.start, end: h.start }] : []),
              ...(h.end < r.end ? [{ start: h.end, end: r.end }] : []),
            ],
      );
    }
    return out;
  };
  const uncovered = subtract(subtract([{ ...chunk }], pauses), words.map((w) => ({ start: w.t0, end: w.t1 })))
    .filter((r) => r.end - r.start > 0.05)
    .sort((a, b) => a.start - b.start);
  // Join pieces separated only by short pauses; sum the speech inside each group.
  const groups: { end: number; speech: number }[] = [];
  for (const r of uncovered) {
    const last = groups[groups.length - 1];
    const pauseOnly = last && !words.some((w) => w.t1 > last.end && w.t0 < r.start);
    if (last && pauseOnly && r.start - last.end < 0.8) {
      last.end = r.end;
      last.speech += r.end - r.start;
    } else groups.push({ end: r.end, speech: r.end - r.start });
  }
  return groups.filter((g) => g.speech >= minGap).reduce((a, g) => a + g.speech, 0);
}
