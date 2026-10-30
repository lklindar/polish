import { describe, expect, it } from 'vitest';
import { AudioAssembler } from '../src/core/audioAssembler';
import { buildSegments, outputDuration } from '../src/core/edl';
import { pcm } from './fixtures';

async function assemble(sr: number, src: Float32Array, segs: ReturnType<typeof buildSegments>, chunk = 1024) {
  const out: number[] = [];
  const offsets: number[] = [];
  const a = new AudioAssembler(segs, {
    sampleRate: sr,
    channels: 1,
    fadeSec: 0.015,
    emit: (planes, off) => {
      offsets.push(off);
      out.push(...planes[0]);
    },
  });
  for (let i = 0; i < src.length; i += chunk) await a.push([src.subarray(i, i + chunk)], i);
  await a.finish();
  return { out: Float32Array.from(out), offsets };
}

describe('AudioAssembler', () => {
  const sr = 8000;
  const src = pcm(sr, 10);

  it('output length equals the EDL output duration (A/V stays in sync)', async () => {
    const segs = buildSegments(10, [{ start: 2, end: 3, type: 'silence', enabled: true }, { start: 6, end: 6.5, type: 'silence', enabled: true }], [
      { start: 7, end: 9, speed: 4, enabled: true },
    ]);
    const { out, offsets } = await assemble(sr, src, segs, 997);
    expect(out.length / sr).toBeCloseTo(outputDuration(segs), 2);
    // Emitted offsets are contiguous.
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
  });

  it('fades to silence at a cut (no pop)', async () => {
    const segs = buildSegments(10, [{ start: 2, end: 3, type: 'silence', enabled: true }], []);
    const { out } = await assemble(sr, src, segs);
    const j = 2 * sr; // join point in output
    expect(Math.abs(out[j - 1])).toBeLessThan(0.01);
    expect(Math.abs(out[j])).toBeLessThan(0.01);
    // Away from the join it's untouched.
    expect(out[sr]).toBeCloseTo(src[sr], 6);
    expect(out[j + sr]).toBeCloseTo(src[3 * sr + sr], 6);
  });

  it('does not fade at a contiguous speed change', async () => {
    const segs = buildSegments(10, [], [{ start: 5, end: 7, speed: 2, enabled: true }]);
    const { out } = await assemble(sr, src, segs);
    const j = 5 * sr;
    expect(Math.abs(out[j - 3])).toBeCloseTo(Math.abs(src[j - 3]), 5);
  });
});
