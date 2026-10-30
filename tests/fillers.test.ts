import { describe, expect, it } from 'vitest';
import { acousticFillers, closeGaps, findRepeats, heldWordCuts, planFillerCuts, refineFiller, repeatCuts, transcriptFillers, DEFAULT_LEXICON, DEFAULT_SOFT_LEXICON, type FillerSettings } from '../src/core/fillers';
import { adaptiveLevels, smoothedDb, FRAME_SEC, type AudioAnalysis } from '../src/core/silence';
import type { Word } from '../src/core/transcript';

const W = (w: string, t0: number, t1: number): Word => ({ w, t0, t1 });
const settings: FillerSettings = { enabled: true, minConfidence: 0.6, lexicon: DEFAULT_LEXICON, softLexicon: DEFAULT_SOFT_LEXICON, acoustic: true, paddingSec: 0.03, removeRepeats: true, trimHeldWords: true };

/** Synthetic analysis: segments of [sec, kind] where kind = speech | vowel (held, steady) | pause. */
function synth(pattern: [number, 'speech' | 'vowel' | 'pause'][]): AudioAnalysis {
  const rms: number[] = [];
  const voicing: number[] = [];
  const f0: number[] = [];
  const flux: number[] = [];
  let k = 0;
  for (const [sec, kind] of pattern) {
    for (let i = 0; i < Math.round(sec / FRAME_SEC); i++, k++) {
      if (kind === 'pause') {
        rms.push(0.001); voicing.push(0.1); f0.push(0); flux.push(0.01);
      } else if (kind === 'vowel') {
        rms.push(0.03); voicing.push(0.9); f0.push(140 + Math.sin(k) * 1); flux.push(0.004);
      } else {
        // Articulated speech: pitch moves, flux high, voicing alternates.
        rms.push(0.04 * (0.7 + 0.6 * ((k * 7919) % 10) / 10)); voicing.push(k % 3 ? 0.8 : 0.3);
        f0.push(k % 3 ? 120 + 40 * Math.sin(k / 3) : 0); flux.push(0.08);
      }
    }
  }
  const r = Float32Array.from(rms);
  return { frameSec: FRAME_SEC, rms: r, peak: r, sampleRate: 16000, channels: 1, voicing: Float32Array.from(voicing), f0: Float32Array.from(f0), flux: Float32Array.from(flux) };
}

describe('transcript fillers (A)', () => {
  it('matches lexicon entries with repeated letters and multi-word phrases', () => {
    const words = [W('So,', 0, 0.3), W('ummm,', 0.4, 0.8), W('we', 0.9, 1), W('Uh.', 1.1, 1.3), W('apa', 1.5, 1.7), W('ya', 1.7, 1.9), W('umbrella', 2, 2.5)];
    const f = transcriptFillers(words, settings);
    expect(f.map((x) => x.text)).toEqual(['um', 'uh', 'apa ya']);
    expect(f[2].confidence).toBeLessThan(0.6); // soft entries need review
  });
});

describe('refineFiller', () => {
  // Measured on the sample at 128.30–129.20 s: "This, uh, master". 's' of "This" until 128.48,
  // "uh" 128.50–128.78, then the "m" of "master" (quieter, voiced) and its vowel at 128.92.
  const dbs = [-42, -41, -42, -43, -42, -43, -43, -44, -45, -46, -41, -32, -30, -30, -30, -30, -30, -31, -32, -33, -34, -34, -33, -33, -36, -39, -40, -40, -39, -39, -37, -29, -30, -30, -30, -34, -38, -43, -44, -43, -46, -54, -58, -42, -31];
  const voiced = dbs.map((_, i) => (i >= 10 && i <= 35) || i >= 43 ? 0.9 : 0.2);
  const t0 = 128.3;
  const audio = {
    frameSec: FRAME_SEC,
    rms: Float32Array.from([...Array(Math.round(t0 / FRAME_SEC)).fill(1e-4), ...dbs.map((d) => 10 ** (d / 20))]),
    peak: new Float32Array(0),
    sampleRate: 16000,
    channels: 1,
    voicing: Float32Array.from([...Array(Math.round(t0 / FRAME_SEC)).fill(0), ...voiced]),
  } as AudioAnalysis;

  it('stops at the start of the next word, even when Whisper and the voicing run on (no "mas" clipped)', () => {
    const r = refineFiller({ start: 128.49, end: 128.93, text: 'uh' }, audio, { prevT0: 127.89, nextT0: 128.93 }, 0.03);
    expect(r.start).toBeGreaterThan(128.44);
    expect(r.start).toBeLessThan(128.52);
    expect(r.end).toBeGreaterThan(128.74);
    expect(r.end).toBeLessThanOrEqual(128.81);
  });

  /** Analysis with measured 20 ms levels starting at t0 (voiced where dB > −45). */
  const measured = (t0: number, levels: number[]) => {
    const pre = Math.round(t0 / FRAME_SEC);
    return {
      frameSec: FRAME_SEC,
      rms: Float32Array.from([...Array(pre).fill(1e-4), ...levels.map((d) => 10 ** (d / 20)), 1e-4, 1e-4]),
      peak: new Float32Array(0),
      sampleRate: 16000,
      channels: 1,
      voicing: Float32Array.from([...Array(pre).fill(0), ...levels.map((d) => (d > -45 ? 0.9 : 0.2)), 0, 0]),
    } as AudioAnalysis;
  };

  it('picks the run inside Whisper\'s span, not a drawn-out neighbouring word ("throoough, uh")', () => {
    // Sample 756.70–757.66: "go" · gap · held "through" 756.98–757.34 · dip · "uh" 757.40–757.52 · "s…"
    const a = measured(756.7, [-44, -30, -29, -28, -29, -30, -32, -37, -50, -56, -60, -62, -60, -50, -31, -30, -31, -31, -29, -29, -29, -30, -30, -30, -30, -30, -30, -30, -30, -32, -33, -39, -38, -52, -49, -34, -32, -32, -31, -32, -31, -33, -38, -43, -40, -42, -42, -43]);
    const r = refineFiller({ start: 757.08, end: 757.62, text: 'uh' }, a, { prevT0: 756.8, nextT0: 757.62 }, 0.03);
    expect(r.start).toBeGreaterThan(757.34);
    expect(r.end).toBeLessThan(757.58);
  });

  it('ends an "um" tail where the next word ("what") starts rising', () => {
    // Sample 55.40–56.04: "is," · um 55.54–55.74 + m-tail · "what" rising from 55.86.
    const a = measured(55.4, [-32, -36, -39, -42, -41, -44, -39, -30, -29, -27, -26, -26, -27, -27, -27, -30, -30, -32, -34, -35, -36, -36, -36, -35, -34, -33, -31, -35, -40, -37, -35, -33, -32]);
    const r = refineFiller({ start: 55.6, end: 55.88, text: 'um' }, a, { prevT0: 55.16, nextT0: 55.88 }, 0.03);
    expect(r.start).toBeGreaterThan(55.48);
    expect(r.end).toBeLessThanOrEqual(55.88);
    expect(r.end).toBeGreaterThan(55.74);
  });

  it('lets "um" keep its nasal tail', () => {
    const r = refineFiller({ start: 128.49, end: 128.93, text: 'um' }, audio, { nextT0: 128.95 }, 0.03);
    expect(r.end).toBeGreaterThan(128.85);
    expect(r.end).toBeLessThanOrEqual(128.95);
  });
});

describe('acoustic fillers (B)', () => {
  const a = synth([[1, 'speech'], [0.3, 'pause'], [0.5, 'vowel'], [0.3, 'pause'], [1, 'speech']]);
  const lv = adaptiveLevels(smoothedDb(a.rms), 0.35);

  it('finds an uncovered held vowel between phrases', () => {
    const words = [W('hello', 0, 0.5), W('there', 0.5, 1), W('next', 2.1, 2.6), W('thing', 2.6, 3.1)];
    const f = acousticFillers(a, lv, words);
    expect(f).toHaveLength(1);
    expect(f[0].start).toBeGreaterThan(1.2);
    expect(f[0].end).toBeLessThan(1.95);
    expect(f[0].confidence).toBeGreaterThan(0.7);
  });

  it('ignores voiced stretches that a transcribed word covers', () => {
    const words = [W('hello', 0, 0.5), W('there', 0.5, 1), W('okay', 1.3, 1.8), W('next', 2.1, 2.6)];
    expect(acousticFillers(a, lv, words)).toHaveLength(0);
  });

  it('planFillerCuts pads by 30 ms and merges A+B on the same span', () => {
    const words = [W('hello', 0, 0.5), W('there', 0.5, 1), W('uh', 1.35, 1.75), W('next', 2.1, 2.6)];
    const cuts = planFillerCuts(a, lv, words, settings);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].enabled).toBe(true);
    expect(cuts[0].start).toBeLessThan(1.31);
    expect(cuts[0].end).toBeGreaterThan(1.8);
  });
});

describe('findRepeats', () => {
  it('suggests cutting a false start that is repeated within 10 s', () => {
    const t = (i: number) => [i * 0.4, i * 0.4 + 0.35] as const;
    const text = 'so we click the settings button no wait so we click the settings button and then'.split(' ');
    const words = text.map((w, i) => W(w, ...t(i)));
    const r = findRepeats(words, []);
    expect(r).toHaveLength(1);
    expect(r[0].start).toBe(0);
    expect(r[0].end).toBeCloseTo(t(8)[0]);
  });

  it('ignores a phrase repeated later with other speech in between', () => {
    const words = 'we click the button and the page opens then we click the button again'.split(' ').map((w, i) => W(w, i * 0.3, i * 0.3 + 0.25));
    expect(findRepeats(words, [])).toHaveLength(0);
  });
});

describe('repeats, held words, gap closing', () => {
  // Levels per 20 ms frame: speech -30 dB, pause -65 dB.
  const level = (spans: [number, number, number][], total: number): AudioAnalysis => {
    const n = Math.round(total / FRAME_SEC);
    const db = new Array(n).fill(-65);
    for (const [a, b, d] of spans) for (let i = Math.round(a / FRAME_SEC); i < Math.round(b / FRAME_SEC); i++) db[i] = d;
    const rms = Float32Array.from(db.map((d) => 10 ** (d / 20)));
    return { frameSec: FRAME_SEC, rms, peak: rms, sampleRate: 16000, channels: 1, voicing: Float32Array.from(db.map((d) => (d > -50 ? 0.9 : 0.1))) };
  };

  it('cuts the first of two repeated words at the quiet point before the retake', () => {
    // "the [gap] the demo": the1 0.50–0.70, quiet 0.70–0.80, the2 0.80–1.00, demo 1.00–1.50
    const a = level([[0.5, 0.7, -30], [0.8, 1.0, -30], [1.0, 1.5, -28]], 2);
    const ws = [W('So', 0.1, 0.4), W('the,', 0.5, 0.72), W('the', 0.8, 1.0), W('demo', 1.0, 1.5)];
    const cuts = repeatCuts(ws, a, []);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].enabled).toBe(true);
    expect(cuts[0].start).toBeGreaterThan(0.38);
    expect(cuts[0].start).toBeLessThanOrEqual(0.5);
    expect(cuts[0].end).toBeGreaterThanOrEqual(0.7);
    expect(cuts[0].end).toBeLessThanOrEqual(0.8);
  });

  it('cuts two-word repeats and leaves grammatical "that that" for review', () => {
    const a = level([[0, 3, -30]], 3);
    const ws = ['we', 'can', 'we', 'can', 'go', 'that', 'that', 'works'].map((w, i) => W(w, i * 0.3, i * 0.3 + 0.25));
    const cuts = repeatCuts(ws, a, []);
    expect(cuts.map((c) => [c.label, c.enabled])).toEqual([
      ['we can (repeat)', true],
      ['that (repeat)', false],
    ]);
  });

  it('trims a drawn-out "a" to its first ~0.14 s and leaves a normal one alone', () => {
    // "in a……… way": "a" vowel held 1.00–1.70; then "way". And a normal "a" at 3.0–3.12.
    const a = level([[0.6, 0.85, -30], [1.0, 1.7, -31], [1.75, 2.1, -29], [3.0, 3.12, -31], [3.15, 3.5, -29]], 4);
    const ws = [W('in', 0.6, 0.85), W('a', 1.0, 1.7), W('way', 1.75, 2.1), W('a', 3.0, 3.12), W('box', 3.15, 3.5)];
    const cuts = heldWordCuts(ws, a);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].start).toBeCloseTo(1.14, 1);
    expect(cuts[0].end).toBeCloseTo(1.7, 1);
  });

  it('closes the pauses either side of a removed filler down to the padding', () => {
    const pauses = [{ start: 1.0, end: 1.4 }, { start: 1.8, end: 2.3 }];
    const [c] = closeGaps([{ start: 1.4, end: 1.8, type: 'filler', enabled: true }], pauses, 0.1);
    expect(c.start).toBeCloseTo(1.1);
    expect(c.end).toBeCloseTo(2.2);
    // Disabled (kept) fillers aren't touched.
    expect(closeGaps([{ start: 1.4, end: 1.8, type: 'filler', enabled: false }], pauses, 0.1)[0].start).toBe(1.4);
  });
});
