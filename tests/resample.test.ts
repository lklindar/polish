import { describe, expect, it } from 'vitest';
import { FeatureExtractor, type FrameFeatures } from '../src/core/audioFeatures';
import { StreamResampler } from '../src/core/resample';

function sine(sr: number, sec: number, f: number, amp = 0.5) {
  return Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
}

describe('StreamResampler', () => {
  it('44.1 → 16 kHz keeps length, phase and amplitude of an in-band tone', () => {
    const x = sine(44100, 2, 440);
    const r = new StreamResampler(44100, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 1000) parts.push(r.push(x.subarray(i, i + 1000)));
    parts.push(r.flush());
    const y = Float32Array.from(parts.flatMap((p) => [...p]));
    expect(Math.abs(y.length - 32000)).toBeLessThanOrEqual(2);
    const ref = sine(16000, 2, 440);
    let err = 0;
    for (let i = 1000; i < 31000; i++) err = Math.max(err, Math.abs(y[i] - ref[i]));
    expect(err).toBeLessThan(0.01);
  });

  it('removes content above the new Nyquist (anti-aliasing)', () => {
    const x = sine(44100, 1, 12000); // above 8 kHz
    const r = new StreamResampler(44100, 16000);
    const y = Float32Array.from([...r.push(x), ...r.flush()]);
    let rms = 0;
    for (let i = 500; i < y.length - 500; i++) rms += y[i] * y[i];
    expect(Math.sqrt(rms / (y.length - 1000))).toBeLessThan(0.01);
  });
});

describe('FeatureExtractor', () => {
  const run = (x: Float32Array) => {
    const out: FrameFeatures[] = [];
    const fx = new FeatureExtractor((i, f) => (out[i] = f));
    fx.push(x);
    fx.push(new Float32Array(640));
    return out;
  };

  it('finds the pitch of a held vowel-like tone with low flux', () => {
    // Harmonic-rich 150 Hz "aaa".
    const sr = 16000;
    const x = Float32Array.from({ length: sr }, (_, i) =>
      [1, 0.6, 0.4, 0.3].reduce((a, g, h) => a + 0.2 * g * Math.sin((2 * Math.PI * 150 * (h + 1) * i) / sr), 0),
    );
    const f = run(x).slice(5, 40);
    const meanF0 = f.reduce((a, b) => a + b.f0, 0) / f.length;
    expect(meanF0).toBeGreaterThan(140);
    expect(meanF0).toBeLessThan(160);
    expect(Math.min(...f.map((v) => v.voicing))).toBeGreaterThan(0.8);
    expect(Math.max(...f.map((v) => v.flux))).toBeLessThan(0.05);
  });

  it('reports noise as unvoiced', () => {
    let seed = 1;
    const x = Float32Array.from({ length: 16000 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.3);
    const f = run(x).slice(5, 40);
    expect(f.filter((v) => v.voicing > 0.5).length).toBeLessThan(4);
  });
});
