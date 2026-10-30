import { describe, expect, it } from 'vitest';
import { buildSegments, outToSrc, outputDuration, segmentIndexAt, srcToOut, type Cut } from '../src/core/edl';

const cut = (start: number, end: number, enabled = true): Cut => ({ start, end, type: 'silence', enabled });

describe('buildSegments', () => {
  it('returns the complement of enabled cuts', () => {
    const segs = buildSegments(10, [cut(2, 3), cut(5, 6), cut(7, 8, false)], []);
    expect(segs.map((s) => [s.srcStart, s.srcEnd])).toEqual([[0, 2], [3, 5], [6, 10]]);
    expect(outputDuration(segs)).toBeCloseTo(8);
  });

  it('merges overlapping cuts and swallows slivers < 80 ms', () => {
    const segs = buildSegments(10, [cut(2, 3), cut(2.5, 4), cut(4.05, 5)], []);
    expect(segs.map((s) => [s.srcStart, s.srcEnd])).toEqual([[0, 2], [5, 10]]);
  });

  it('splits kept parts around speed-ups', () => {
    const segs = buildSegments(10, [cut(1, 2)], [{ start: 4, end: 8, speed: 4, enabled: true }]);
    expect(segs).toEqual([
      { srcStart: 0, srcEnd: 1, speed: 1, reason: 'keep' },
      { srcStart: 2, srcEnd: 4, speed: 1, reason: 'keep' },
      { srcStart: 4, srcEnd: 8, speed: 4, reason: 'speedup' },
      { srcStart: 8, srcEnd: 10, speed: 1, reason: 'keep' },
    ]);
    expect(outputDuration(segs)).toBeCloseTo(1 + 2 + 1 + 2);
  });

  it('cuts win over speed-ups', () => {
    const segs = buildSegments(10, [cut(5, 6)], [{ start: 4, end: 8, speed: 2, enabled: true }]);
    expect(segs.map((s) => [s.srcStart, s.srcEnd, s.speed])).toEqual([[0, 4, 1], [4, 5, 2], [6, 8, 2], [8, 10, 1]]);
  });
});

describe('time mapping', () => {
  const segs = buildSegments(20, [cut(2, 4), cut(10, 12)], [{ start: 14, end: 18, speed: 4, enabled: true }]);

  it('maps source → output', () => {
    expect(srcToOut(segs, 0)).toBe(0);
    expect(srcToOut(segs, 1)).toBeCloseTo(1);
    expect(srcToOut(segs, 3)).toBeCloseTo(2); // inside a cut → snaps to next kept start
    expect(srcToOut(segs, 5)).toBeCloseTo(3);
    expect(srcToOut(segs, 16)).toBeCloseTo(2 + 6 + 2 + 0.5);
    expect(srcToOut(segs, 20)).toBeCloseTo(outputDuration(segs));
  });

  it('round-trips output → source → output', () => {
    const total = outputDuration(segs);
    for (let t = 0; t < total; t += 0.37) {
      const src = outToSrc(segs, t);
      expect(segmentIndexAt(segs, src)).toBeGreaterThanOrEqual(0);
      expect(srcToOut(segs, src)).toBeCloseTo(t, 6);
    }
  });

  it('applies global speed', () => {
    expect(outputDuration(segs, 1.25)).toBeCloseTo(outputDuration(segs) / 1.25);
    expect(srcToOut(segs, 5, 1.25)).toBeCloseTo(3 / 1.25);
    expect(outToSrc(segs, 3 / 1.25, 1.25)).toBeCloseTo(5);
  });
});
