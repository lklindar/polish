// Per-frame (20 ms) voicing, pitch and spectral flux on 16 kHz mono. Used by the acoustic filler
// detector: a held "aaaa"/"mmm" is voiced, has a steady pitch and very low spectral flux.

export const FEATURE_RATE = 16000;
const HOP = 320; // 20 ms at 16 kHz
const WIN8 = 320; // 40 ms window at 8 kHz (after 2× decimation)
const MIN_LAG = 20; // 400 Hz at 8 kHz
const MAX_LAG = 114; // 70 Hz
const FFT_N = 256; // at 8 kHz → 31 Hz bins

export interface FrameFeatures {
  /** Normalized autocorrelation peak, 0–1 (≥ ~0.5 = voiced). */
  voicing: number;
  /** Pitch in Hz, 0 when unvoiced. */
  f0: number;
  /** Spectral flux vs. the previous frame (sum of positive log-magnitude increases / bins). */
  flux: number;
}

/**
 * Streaming extractor: push 16 kHz samples, it emits one FrameFeatures per 20 ms hop, aligned with
 * the energy frames (frame k covers [k·20 ms, (k+1)·20 ms)).
 */
export class FeatureExtractor {
  private pending = new Float32Array(0);
  private pendingStart = 0; // absolute 16 kHz index of pending[0]
  private nextFrame = 0;
  private prevMag = new Float32Array(FFT_N / 2);
  private readonly x8 = new Float32Array(WIN8);
  private readonly corr = new Float32Array(MAX_LAG + 1);
  private readonly re = new Float32Array(FFT_N);
  private readonly im = new Float32Array(FFT_N);
  private readonly hann = Float32Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));

  constructor(private readonly onFrame: (index: number, f: FrameFeatures) => void) {}

  push(samples: Float32Array) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    this.pending = merged;
    // Each frame needs a 40 ms window starting at its hop start (20 ms of look-ahead).
    const need = WIN8 * 2;
    while ((this.nextFrame * HOP - this.pendingStart) + need <= this.pending.length) {
      const off = this.nextFrame * HOP - this.pendingStart;
      this.onFrame(this.nextFrame, this.analyze(this.pending.subarray(off, off + need)));
      this.nextFrame++;
    }
    const drop = this.nextFrame * HOP - this.pendingStart;
    if (drop > 0) {
      this.pending = this.pending.slice(drop);
      this.pendingStart += drop;
    }
  }

  private analyze(w16: Float32Array): FrameFeatures {
    // 2× decimation by pair averaging (16 kHz source is already band-limited).
    const x = this.x8;
    let mean = 0;
    for (let i = 0; i < WIN8; i++) {
      x[i] = 0.5 * (w16[2 * i] + w16[2 * i + 1]);
      mean += x[i];
    }
    mean /= WIN8;
    let energy = 0;
    for (let i = 0; i < WIN8; i++) {
      x[i] -= mean;
      energy += x[i] * x[i];
    }

    let voicing = 0;
    let f0 = 0;
    if (energy > 1e-7) {
      // Normalized cross-correlation per lag; the first peak within 85% of the best wins, which
      // avoids picking a multiple of the true period (octave errors).
      const rs = this.corr;
      let best = 0;
      const span = WIN8 - MAX_LAG;
      let e0 = 0;
      for (let i = 0; i < span; i++) e0 += x[i] * x[i];
      for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
        let c = 0;
        let e1 = 0;
        for (let i = 0; i < span; i++) {
          c += x[i] * x[i + lag];
          e1 += x[i + lag] * x[i + lag];
        }
        const r = c / Math.sqrt(e0 * e1 + 1e-12);
        rs[lag] = r;
        if (r > best) best = r;
      }
      let bestLag = 0;
      for (let lag = MIN_LAG + 1; lag < MAX_LAG; lag++) {
        if (rs[lag] >= 0.85 * best && rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1]) {
          bestLag = lag;
          break;
        }
      }
      voicing = Math.max(0, best);
      if (voicing > 0.5 && bestLag) f0 = 8000 / bestLag;
    }

    // Log-magnitude spectrum of the first 256 samples at 8 kHz.
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < FFT_N; i++) {
      re[i] = (x[i] ?? 0) * this.hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 0; k < FFT_N / 2; k++) {
      const m = Math.log1p(Math.hypot(re[k], im[k]) * 100);
      const d = m - this.prevMag[k];
      if (d > 0) flux += d;
      this.prevMag[k] = m;
    }
    return { voicing, f0, flux: flux / (FFT_N / 2) };
  }
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
