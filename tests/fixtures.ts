// Synthetic fixtures generated in code.

import { FRAME_SEC, type AudioAnalysis } from '../src/core/silence';

/** 20 ms RMS frames for a tone-with-gaps signal: `pattern` is [seconds, isTone][]. */
export function toneWithGaps(pattern: [number, boolean][], toneRms = 0.05, noiseRms = 0.0015): AudioAnalysis {
  const frames: number[] = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [sec, tone] of pattern) {
    const n = Math.round(sec / FRAME_SEC);
    for (let i = 0; i < n; i++) {
      const base = tone ? toneRms * (0.6 + 0.8 * rand()) : noiseRms * (0.7 + 0.6 * rand());
      frames.push(base);
    }
  }
  const rms = Float32Array.from(frames);
  return { frameSec: FRAME_SEC, rms, peak: rms.map((v) => v * 1.4), sampleRate: 16000, channels: 1 };
}

/** PCM sine-with-gaps at `sr`, for the assembler. */
export function pcm(sr: number, seconds: number, f = 440): Float32Array {
  const out = new Float32Array(Math.round(sr * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
  return out;
}
