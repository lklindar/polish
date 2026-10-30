import { describe, expect, it } from 'vitest';
import { adaptiveLevels, detectPauses, planSilenceEdits, smoothedDb } from '../src/core/silence';
import { PRESETS } from '../src/core/settings';
import type { ActivityTrack } from '../src/core/activity';
import { toneWithGaps } from './fixtures';

const premium = PRESETS.premium.settings.silence;

describe('adaptive threshold', () => {
  it('sits between the noise floor and speech level for a quiet file', () => {
    // Quiet like the sample: speech around −34 dB, floor around −56 dB.
    const a = toneWithGaps([[5, true], [2, false], [5, true], [2, false]], 0.02, 0.0015);
    const lv = adaptiveLevels(smoothedDb(a.rms), 0.35);
    expect(lv.floorDb).toBeLessThan(-50);
    expect(lv.speechDb).toBeGreaterThan(-40);
    expect(lv.thresholdDb).toBeGreaterThan(lv.floorDb);
    expect(lv.thresholdDb).toBeLessThan(lv.speechDb);
  });

  it('a fixed −35 dB threshold would fail here, the adaptive one does not', () => {
    const a = toneWithGaps([[3, true], [1.5, false], [3, true], [1.5, false], [3, true]], 0.012, 0.001);
    const { pauses } = detectPauses(a, 0.35);
    const long = pauses.filter((p) => p.end - p.start > 1);
    expect(long).toHaveLength(2);
  });
});

describe('detectPauses', () => {
  it('finds gaps with ~frame accuracy', () => {
    const a = toneWithGaps([[2, true], [1, false], [2, true], [0.3, false], [2, true]]);
    const { pauses } = detectPauses(a, 0.35);
    const long = pauses.filter((p) => p.end - p.start >= 0.6);
    expect(long).toHaveLength(1);
    expect(long[0].start).toBeGreaterThan(1.9);
    expect(long[0].start).toBeLessThan(2.12);
    expect(long[0].end).toBeGreaterThan(2.88);
    expect(long[0].end).toBeLessThan(3.1);
  });

  it('absorbs a 40 ms click inside a pause (hysteresis + min speech)', () => {
    const a = toneWithGaps([[2, true], [0.6, false], [0.04, true], [0.6, false], [2, true]]);
    const long = detectPauses(a, 0.35).pauses.filter((p) => p.end - p.start >= 1);
    expect(long).toHaveLength(1);
  });
});

describe('planSilenceEdits', () => {
  it('cuts long pauses but keeps padding on both sides', () => {
    const a = toneWithGaps([[2, true], [1.5, false], [2, true]]);
    const plan = planSilenceEdits(a, null, { ...premium, trimDeadAir: false });
    expect(plan.cuts).toHaveLength(1);
    const c = plan.cuts[0];
    expect(c.type).toBe('silence');
    expect(c.start).toBeGreaterThan(2 + premium.paddingSec - 0.06);
    expect(c.end).toBeLessThan(3.5 - premium.paddingSec + 0.06);
    // Remaining pause ≈ 2 × padding (± detector edge slop).
    const kept = 1.5 - (c.end - c.start);
    expect(kept).toBeGreaterThan(0.18);
    expect(kept).toBeLessThan(0.4);
  });

  it('ignores pauses shorter than the minimum', () => {
    const a = toneWithGaps([[2, true], [0.4, false], [2, true]]);
    expect(planSilenceEdits(a, null, { ...premium, trimDeadAir: false }).cuts).toHaveLength(0);
  });

  it('speeds up a busy pause instead of cutting it', () => {
    const a = toneWithGaps([[2, true], [6, false], [2, true]]);
    const hz = 5;
    const score = new Float32Array(10 * hz);
    for (let i = 2 * hz; i < 8 * hz; i++) score[i] = 10; // screen changing during the pause
    const activity: ActivityTrack = { hz, score, mask: new Uint8Array(0) };
    const plan = planSilenceEdits(a, activity, { ...premium, trimDeadAir: false });
    expect(plan.cuts).toHaveLength(0);
    expect(plan.speedups).toHaveLength(1);
    expect(plan.speedups[0].speed).toBeGreaterThanOrEqual(premium.minSpeed);
    expect(plan.speedups[0].speed).toBeLessThanOrEqual(premium.maxSpeed);
  });

  it('trims dead air at start and end', () => {
    const a = toneWithGaps([[4, false], [3, true], [5, false]]);
    const plan = planSilenceEdits(a, null, premium);
    const dead = plan.cuts.filter((c) => c.type === 'deadStartEnd');
    expect(dead).toHaveLength(2);
    expect(dead[0].start).toBe(0);
    expect(dead[0].end).toBeGreaterThan(3.5);
    expect(dead[0].end).toBeLessThan(4);
    expect(dead[1].end).toBeCloseTo(12, 1);
    // No silence cut overlaps the dead-air cuts.
    for (const c of plan.cuts.filter((c) => c.type === 'silence')) {
      expect(c.start).toBeGreaterThanOrEqual(dead[0].end);
      expect(c.end).toBeLessThanOrEqual(dead[1].start);
    }
  });
});
