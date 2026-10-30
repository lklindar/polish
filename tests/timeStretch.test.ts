import { describe, expect, it } from 'vitest';
import { TimeStretcher } from '../src/core/timeStretch';

const sr = 16000;
const tone = (sec: number, f: number) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));

function run(input: Float32Array, speed: number, chunk = 997) {
  const ts = new TimeStretcher(sr, 1, speed);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += chunk) parts.push(ts.push([input.subarray(i, i + chunk)])[0]);
  parts.push(ts.flush()[0]);
  return Float32Array.from(parts.flatMap((p) => [...p]));
}

/** Dominant frequency by counting rising zero crossings. */
function freq(x: Float32Array) {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return (n * sr) / x.length;
}

describe('TimeStretcher (WSOLA)', () => {
  for (const speed of [1.2, 1.5, 2]) {
    it(`${speed}×: shortens by exactly 1/speed and keeps the pitch`, () => {
      const out = run(tone(3, 220), speed);
      expect(out.length).toBe(Math.round((3 * sr) / speed));
      const mid = out.subarray(Math.round(out.length * 0.2), Math.round(out.length * 0.8));
      expect(freq(mid)).toBeGreaterThan(215);
      expect(freq(mid)).toBeLessThan(225);
      // Phase-aligned overlap-add keeps the level (no comb-filter dips).
      let rms = 0;
      for (const v of mid) rms += v * v;
      expect(Math.sqrt(rms / mid.length)).toBeGreaterThan(0.3);
    });
  }

  it('1× is a pass-through', () => {
    const x = tone(1, 300);
    expect(run(x, 1)).toEqual(x);
  });
});
