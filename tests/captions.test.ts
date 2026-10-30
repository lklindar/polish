import { describe, expect, it } from 'vitest';
import { applyCaptionEdit, buildCaptions, captionAt, toSrt, wrapLines } from '../src/core/captions';
import { buildSegments } from '../src/core/edl';
import { planChunks, tokensToWords, uncoveredSpeech } from '../src/core/transcript';

const words = 'This is the first sentence of our demo. Now we open the settings page and click the button to continue'
  .split(' ')
  .map((w, i) => ({ w, t0: i * 0.3, t1: i * 0.3 + 0.25 }));

describe('captions', () => {
  it('wraps to ≤ 42 chars and ≤ 2 lines', () => {
    const caps = buildCaptions(words, [], { maxCharsPerLine: 42, maxLines: 2 });
    for (const c of caps) {
      const lines = c.text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    }
    expect(caps[0].text.replace('\n', ' ')).toBe('This is the first sentence of our demo.');
  });

  it('drops words that are cut (fillers)', () => {
    const ws = [{ w: 'So', t0: 0, t1: 0.2 }, { w: 'uh', t0: 0.3, t1: 0.6 }, { w: 'yes', t0: 0.7, t1: 0.9 }];
    const caps = buildCaptions(ws, [{ start: 0.27, end: 0.63, type: 'filler', enabled: true }], { maxCharsPerLine: 42, maxLines: 2 });
    expect(caps[0].text).toBe('So yes');
  });

  it('captionAt finds the active caption', () => {
    const caps = buildCaptions(words, [], { maxCharsPerLine: 42, maxLines: 2 });
    expect(captionAt(caps, 0.1)?.text.startsWith('This')).toBe(true);
    expect(captionAt(caps, 100)).toBeNull();
  });

  it('editing keeps timings when the word count matches, redistributes otherwise', () => {
    const caps = buildCaptions(words, [], { maxCharsPerLine: 42, maxLines: 2 });
    const same = applyCaptionEdit(words, caps[0], 'That is the first sentence of our demo!');
    expect(same[0]).toEqual({ ...words[0], w: 'That' });
    const fewer = applyCaptionEdit(words, caps[0], 'Intro sentence.');
    expect(fewer.length).toBe(words.length - 8 + 2);
    expect(fewer[0].t0).toBe(words[0].t0);
    expect(fewer[1].t1).toBeCloseTo(words[7].t1);
  });

  it('SRT uses output time', () => {
    const caps = buildCaptions(words, [], { maxCharsPerLine: 42, maxLines: 2 });
    const segs = buildSegments(10, [{ start: 0, end: 1, type: 'deadStartEnd', enabled: true }], []);
    const srt = toSrt(caps, segs);
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(wrapLines(['a', 'b'], 42)).toEqual(['a b']);
  });
});

describe('transcript helpers', () => {
  it('chunks split at the longest pause inside each 28 s window', () => {
    const chunks = planChunks(60, [{ start: 10, end: 10.3 }, { start: 20, end: 21.5 }, { start: 45, end: 46 }]);
    expect(chunks[0]).toEqual({ start: 0, end: 20.75 });
    expect(chunks[1].start).toBe(20.75);
    expect(chunks[chunks.length - 1].end).toBe(60);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(28);
  });

  it('groups BPE tokens into words', () => {
    const w = tokensToWords([' Hel', 'lo', ',', ' wor', 'ld', '.'], [0, 0.1, 0.2, 0.3, 0.4, 0.5], 10);
    expect(w).toEqual([{ w: 'Hello,', t0: 10, t1: 10.3 }, { w: 'world.', t0: 10.3, t1: 10.6 }]);
  });

  it('measures speech Whisper skipped', () => {
    const chunk = { start: 0, end: 20 };
    const pauses = [{ start: 5, end: 5.5 }, { start: 12, end: 12.4 }];
    const words = [
      { w: 'a', t0: 0, t1: 4.9 },
      { w: 'b', t0: 12.4, t1: 20 },
    ];
    // 5.5–12 is speech with no words (6.5 s), joined with the 0.1 s sliver before the pause.
    expect(uncoveredSpeech(words, chunk, pauses)).toBeCloseTo(6.6, 1);
    expect(uncoveredSpeech([...words, { w: 'c', t0: 5.5, t1: 12 }], chunk, pauses)).toBe(0);
  });
});
