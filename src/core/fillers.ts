// Filler detection. Whisper tends to drop "uh"/"um" from transcripts, so two detectors are merged:
//  A. transcript: words matching an editable lexicon (decoder primed with a disfluent prompt);
//  B. acoustic: voiced stretches no transcribed word covers, with steady pitch and low spectral
//     flux (a held "aaaa"/"mmm").

import type { Cut } from './edl';
import { smoothedDb, type AudioAnalysis, type Levels } from './silence';
import { normWord, type Word } from './transcript';

export interface FillerSettings {
  enabled: boolean;
  /** Fillers with confidence below this are listed for review but not cut. */
  minConfidence: number;
  /** Comma-separated; letters may repeat ("um" also matches "ummm"). */
  lexicon: string;
  /** Ambiguous entries (real words that are often fillers), scored low so they need review. */
  softLexicon: string;
  acoustic: boolean;
  paddingSec: number;
}

export const DEFAULT_LEXICON = 'um, uh, uhm, er, erm, hmm, hm, mm, ah, eh, ehm, em';
export const DEFAULT_SOFT_LEXICON = 'anu, apa ya, gitu';
export const DISFLUENT_PROMPT = 'Umm, so, uh, I mean, like, hmm, okay. Eh, jadi, apa, ehm, gitu ya.';

export interface FillerCandidate {
  start: number;
  end: number;
  text: string;
  source: 'transcript' | 'acoustic' | 'both';
  confidence: number;
}

interface LexEntry {
  parts: RegExp[];
  confidence: number;
  text: string;
}

function compileLexicon(list: string, confidence: number): LexEntry[] {
  return list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((text) => ({
      text,
      confidence,
      // Each letter may repeat: "um" ↔ "umm", "uhh" etc.
      parts: text.split(/\s+/).map((p) => new RegExp(`^${[...p].map((c) => `${escapeRe(c)}+`).join('')}$`)),
    }));
}

function escapeRe(c: string) {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detector A: lexicon matches in the transcript (multi-word entries match consecutive words). */
export function transcriptFillers(words: Word[], s: Pick<FillerSettings, 'lexicon' | 'softLexicon'>): FillerCandidate[] {
  const entries = [...compileLexicon(s.lexicon, 0.92), ...compileLexicon(s.softLexicon, 0.45)].sort(
    (a, b) => b.parts.length - a.parts.length,
  );
  const norm = words.map((w) => normWord(w.w));
  const out: FillerCandidate[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const e of entries) {
      if (i + e.parts.length > words.length) continue;
      if (!e.parts.every((re, k) => re.test(norm[i + k]))) continue;
      const last = words[i + e.parts.length - 1];
      out.push({ start: words[i].t0, end: last.t1, text: e.text, source: 'transcript', confidence: e.confidence });
      i += e.parts.length - 1;
      break;
    }
  }
  return out;
}

/**
 * Finds a transcribed filler's true extent. Whisper's DTW spans are loose (ends run late, and an
 * "uh" glued to the next word shares its voicing), so instead of thresholding energy we anchor on
 * the filler's vowel core and grow only while the sound stays within 6 dB of it. Fillers ending in
 * a nasal ("um", "hmm") may extend into their quieter "m" tail. Padding is added only into frames
 * that are clearly quieter than the filler, so it never eats a neighbouring consonant.
 */
export function refineFiller(
  c: { start: number; end: number; text: string },
  audio: AudioAnalysis,
  neighbours: { prevT0?: number; nextT0?: number },
  paddingSec: number,
): { start: number; end: number; refined: boolean } {
  const f = audio.frameSec;
  const n = audio.rms.length;
  const db = (i: number) => 20 * Math.log10(Math.max(audio.rms[i], 1e-6));
  const voiced = (i: number) => (audio.voicing ? audio.voicing[i] >= 0.45 : true);
  const fi = (t: number) => Math.max(0, Math.min(n - 1, Math.round(t / f)));

  // Split the neighbourhood of Whisper's span into loud runs (within 8 dB of its peak). A drawn-out
  // word next to the filler ("throoough, uh") forms its own run; the filler is the run that lies
  // (almost) entirely inside Whisper's span. Without one, take the run most inside it.
  const w0 = fi(c.start - 0.15);
  const w1 = fi(c.end + 0.1);
  let peak = -Infinity;
  for (let i = w0; i <= w1; i++) peak = Math.max(peak, db(i));
  const runs: [number, number][] = [];
  for (let i = w0; i <= w1; i++) {
    if (db(i) < peak - 8) continue;
    const r0 = i;
    while (i + 1 <= w1 && db(i + 1) >= peak - 8) i++;
    runs.push([r0, i]);
  }
  const inside = ([r0, r1]: [number, number]) => {
    const a0 = r0 * f;
    const a1 = (r1 + 1) * f;
    return { frac: Math.max(0, Math.min(a1, c.end) - Math.max(a0, c.start)) / (a1 - a0), len: a1 - a0 };
  };
  const contained = runs.filter((r) => inside(r).frac >= 0.85).sort((x, y) => inside(y).len - inside(x).len);
  const chosen = contained[0] ?? runs.sort((x, y) => inside(y).frac - inside(x).frac)[0];
  if (!chosen || inside(chosen).frac === 0) return { start: c.start, end: c.end, refined: false };
  let core = chosen[0];
  for (let i = chosen[0]; i <= chosen[1]; i++) if (db(i) > db(core)) core = i;
  const coreDb = db(core);
  const maxFrames = Math.round(1.2 / f);

  // Within 6 dB of the core counts as the filler whether or not it reads as voiced (attack frames
  // are transitional); consonants of neighbouring words sit well below that.
  let a = core;
  while (a > 0 && db(a - 1) >= coreDb - 6 && core - a < maxFrames) a--;
  let b = core;
  while (b < n - 1 && db(b + 1) >= coreDb - 6 && b - core < maxFrames) b++;
  if (/m+$/.test(c.text.replace(/\s+/g, ''))) {
    // Nasal tail: quieter, still voiced, at most 0.3 s. It ends where the level starts rising
    // again: that's the next word's onset (a "w" or "m" looks just like the tail otherwise).
    const vowelEnd = b;
    let floor = Infinity;
    while (b < n - 1 && voiced(b + 1) && db(b + 1) >= coreDb - 16 && b - vowelEnd < Math.round(0.3 / f)) {
      floor = Math.min(floor, db(b + 1));
      if (db(b + 1) > floor + 1.5) break;
      b++;
    }
  }

  let start = a * f;
  let end = (b + 1) * f;
  const quiet = (i: number) => i >= 0 && i < n && db(i) < coreDb - 10;
  const padFrames = Math.round(paddingSec / f);
  if (padFrames > 0 && quiet(a - 1)) start -= paddingSec;
  if (padFrames > 0 && quiet(b + 1)) end += paddingSec;

  // Guard rails from the neighbouring words. Whisper onsets are off by up to ~±130 ms either way,
  // so they only cap a runaway walk; the waveform decides the edge.
  if (neighbours.prevT0 != null) start = Math.max(start, neighbours.prevT0 + 0.08);
  if (neighbours.nextT0 != null) end = Math.min(end, neighbours.nextT0 + 0.05);
  if (end - start < 0.06) return { start: c.start, end: Math.min(c.end, neighbours.nextT0 ?? c.end), refined: false };
  return { start, end, refined: true };
}

/** Max plausible spoken duration of a word, used so a stretched word span can't "cover" a filler. */
function wordCore(w: Word): [number, number] {
  const maxDur = 0.15 + 0.075 * w.w.length;
  return [w.t0, Math.min(w.t1, w.t0 + maxDur)];
}

/** Detector B: steady, voiced, uncovered stretches. */
export function acousticFillers(audio: AudioAnalysis, levels: Levels, words: Word[]): FillerCandidate[] {
  if (!audio.voicing || !audio.f0 || !audio.flux) return [];
  const db = smoothedDb(audio.rms, 3);
  const f = audio.frameSec;
  const n = db.length;
  const voiced = (i: number) => db[i] > levels.thresholdDb && audio.voicing![i] > 0.55 && audio.f0![i] > 0;

  // Median flux over voiced frames = typical speech articulation.
  const vf: number[] = [];
  for (let i = 0; i < n; i += 3) if (voiced(i)) vf.push(audio.flux[i]);
  vf.sort((a, b) => a - b);
  const speechFlux = vf[vf.length >> 1] || 0.05;

  // Coverage map from word cores.
  const covered = new Uint8Array(n);
  for (const w of words) {
    const [a, b] = wordCore(w);
    for (let i = Math.max(0, Math.floor(a / f)); i < Math.min(n, Math.ceil(b / f)); i++) covered[i] = 1;
  }

  const out: FillerCandidate[] = [];
  let i = 0;
  while (i < n) {
    if (!voiced(i)) {
      i++;
      continue;
    }
    let j = i;
    let gap = 0;
    while (j + 1 < n && (voiced(j + 1) || (gap < 1 && j + 2 < n && voiced(j + 2)))) {
      gap = voiced(j + 1) ? 0 : gap + 1;
      j++;
    }
    const start = i * f;
    const end = (j + 1) * f;
    const dur = end - start;
    i = j + 1;
    if (dur < 0.15 || dur > 1.5) continue;
    // Fillers sit between transcribed words. With no word close on both sides this is more likely
    // a passage Whisper skipped than a filler, so leave it alone.
    const near = 1.5;
    if (!words.some((w) => w.t1 <= start + 0.05 && w.t1 > start - near) || !words.some((w) => w.t0 >= end - 0.05 && w.t0 < end + near)) {
      continue;
    }
    let cov = 0;
    for (let k = Math.floor(start / f); k <= j; k++) cov += covered[k];
    if (cov / (j - Math.floor(start / f) + 1) > 0.3) continue;

    // Pitch stability in semitones and flux relative to typical speech.
    const st: number[] = [];
    let flux = 0;
    for (let k = Math.floor(start / f); k <= j; k++) {
      if (audio.f0[k] > 0) st.push(12 * Math.log2(audio.f0[k]));
      flux += audio.flux[k];
    }
    flux /= j - Math.floor(start / f) + 1;
    const meanSt = st.reduce((a, b) => a + b, 0) / Math.max(1, st.length);
    const sdSt = Math.sqrt(st.reduce((a, b) => a + (b - meanSt) ** 2, 0) / Math.max(1, st.length));
    const steady = clamp01(1 - sdSt / 2.5); // ≤ ~0.5 semitone wobble → 0.8+
    const smooth = clamp01(1 - flux / (speechFlux * 1.2));
    // Isolated by pauses on either side is typical for "uh" between phrases.
    const before = Math.floor(start / f) - 1;
    const isolated = (before < 0 || db[Math.max(0, before - 3)] < levels.thresholdDb ? 0.5 : 0) + (j + 4 >= n || db[Math.min(n - 1, j + 4)] < levels.thresholdDb ? 0.5 : 0);
    const lengthScore = dur >= 0.25 && dur <= 0.9 ? 1 : 0.5;
    const confidence = clamp01(0.4 * steady + 0.3 * smooth + 0.15 * isolated + 0.15 * lengthScore);
    // Weak candidates would only clutter the review list.
    if (confidence >= 0.4) out.push({ start, end, text: '≈ held vowel', source: 'acoustic', confidence: round2(confidence) });
  }
  return out;
}

/** Merges A and B, refines edges to the filler's own sound, and turns them into filler cuts. */
export function planFillerCuts(audio: AudioAnalysis, levels: Levels, words: Word[], s: FillerSettings): Cut[] {
  if (!s.enabled || !words.length) return [];
  const a = transcriptFillers(words, s).map((c) => {
    const i = words.findIndex((w) => w.t0 >= c.start - 1e-6);
    const k = words.findIndex((w) => w.t0 >= c.end - 1e-6);
    const r = refineFiller(c, audio, { prevT0: words[i - 1]?.t0, nextT0: k >= 0 ? words[k].t0 : undefined }, s.paddingSec);
    return { ...c, start: r.start, end: r.end };
  });
  const b = s.acoustic ? acousticFillers(audio, levels, words) : [];
  const merged: FillerCandidate[] = a.map((c) => ({ start: c.start, end: c.end, text: c.text, source: c.source, confidence: c.confidence }));
  for (const c of b) {
    const hit = merged.find((m) => Math.min(m.end, c.end) - Math.max(m.start, c.start) > 0);
    if (hit) {
      // Detector A already has tight edges; B only raises confidence.
      hit.confidence = Math.max(hit.confidence, Math.min(0.99, c.confidence + 0.1));
      hit.source = 'both';
    } else {
      merged.push({ ...c, start: Math.max(0, c.start - s.paddingSec), end: c.end + s.paddingSec });
    }
  }
  return merged
    .sort((x, y) => x.start - y.start)
    .map((c) => ({
      start: c.start,
      end: c.end,
      type: 'filler' as const,
      label: c.source === 'acoustic' ? '≈ uh' : c.text,
      confidence: c.confidence,
      enabled: c.confidence >= s.minConfidence,
    }));
}

export interface RepeatSuggestion {
  start: number;
  end: number;
  text: string;
}

/**
 * False starts / retakes: an n-gram (n ≥ 3) that is said again within 10 s. Suggests cutting the
 * first attempt, from its first word up to where the retake starts.
 */
export function findRepeats(words: Word[], fillerCuts: Cut[]): RepeatSuggestion[] {
  const isFiller = (w: Word) => fillerCuts.some((c) => w.t0 >= c.start - 0.01 && w.t1 <= c.end + 0.01);
  const ws = words.filter((w) => !isFiller(w));
  const norm = ws.map((w) => normWord(w.w));
  const out: RepeatSuggestion[] = [];
  let i = 0;
  while (i < ws.length) {
    let found: RepeatSuggestion | null = null;
    for (let j = i + 1; j < ws.length && ws[j].t0 - ws[i].t0 <= 10; j++) {
      if (norm[j] !== norm[i]) continue;
      let n = 0;
      while (i + n < j && j + n < ws.length && norm[i + n] === norm[j + n]) n++;
      const meaningful = norm.slice(i, i + n).some((w) => w.length >= 4);
      // A retake starts right after the first attempt (≤ 3 words like "no wait" in between); a
      // phrase repeated later with other speech in between is just repetition.
      if (n >= 3 && meaningful && j - (i + n) <= 3) {
        found = { start: ws[i].t0, end: ws[j].t0, text: ws.slice(i, j).map((w) => w.w).join(' ') };
        break;
      }
    }
    if (found && found.end - found.start <= 10) {
      out.push(found);
      i = ws.findIndex((w) => w.t0 >= found!.end);
      if (i < 0) break;
    } else i++;
  }
  return out;
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
