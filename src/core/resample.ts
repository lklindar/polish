// Streaming windowed-sinc resampler (mono). Web Audio isn't available in workers, so analysis and
// transcription resample decoded chunks with this as they arrive.

export class StreamResampler {
  private readonly ratio: number; // in / out
  private readonly taps: number;
  private readonly cutoff: number;
  private buf = new Float32Array(0);
  /** Absolute input index of buf[0]. */
  private bufStart = 0;
  /** Absolute (fractional) input position of the next output sample. */
  private pos = 0;
  private readonly kernel: (x: number) => number;

  constructor(inRate: number, outRate: number, halfTaps = 16) {
    this.ratio = inRate / outRate;
    this.taps = halfTaps;
    // Low-pass at the lower Nyquist, a little under to leave room for the transition band.
    this.cutoff = Math.min(1, outRate / inRate) * 0.92;
    // Tabulated Blackman-windowed sinc (trig per tap would dominate the cost).
    const N = halfTaps;
    const fc = this.cutoff;
    const res = 512;
    const table = new Float32Array(N * res + 2);
    for (let k = 0; k < table.length; k++) {
      const x = k / res;
      const sinc = x === 0 ? fc : Math.sin(Math.PI * fc * x) / (Math.PI * x);
      const w = x >= N ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * x) / N) + 0.08 * Math.cos((2 * Math.PI * x) / N);
      table[k] = sinc * w;
    }
    this.kernel = (x: number) => {
      const f = Math.abs(x) * res;
      const k = f | 0;
      if (k >= N * res) return 0;
      const t = f - k;
      return table[k] * (1 - t) + table[k + 1] * t;
    };
  }

  /** Feeds input samples; returns the output samples that are now fully determined. */
  push(input: Float32Array): Float32Array {
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    this.buf = merged;
    return this.drain(false);
  }

  /** Flushes the tail (zero-padded). */
  flush(): Float32Array {
    return this.drain(true);
  }

  private drain(final: boolean): Float32Array {
    const N = this.taps;
    const end = this.bufStart + this.buf.length;
    const limit = final ? end : end - N;
    const out: number[] = [];
    while (this.pos < limit) {
      const center = this.pos;
      const i0 = Math.ceil(center - N);
      const i1 = Math.floor(center + N);
      let acc = 0;
      for (let i = i0; i <= i1; i++) {
        const j = i - this.bufStart;
        if (j < 0 || j >= this.buf.length) continue;
        acc += this.buf[j] * this.kernel(center - i);
      }
      out.push(acc);
      this.pos += this.ratio;
    }
    // Drop input no longer needed.
    const keepFrom = Math.max(0, Math.floor(this.pos - N) - this.bufStart);
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.bufStart += keepFrom;
    }
    return Float32Array.from(out);
  }
}
