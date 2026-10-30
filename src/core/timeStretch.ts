// Streaming WSOLA time-stretch: changes tempo without changing pitch. Used by export for the
// whole-video speed (1.2×, 1.5×, …). Frames of ~40 ms are taken from the input every hop × speed
// samples, nudged by up to ±12 ms to the position whose waveform best continues the previous
// frame, and overlap-added with a Hann window (50% overlap sums to 1).

export class TimeStretcher {
  private readonly N: number; // frame length
  private readonly Hs: number; // synthesis hop
  private readonly tol: number; // search tolerance
  private readonly win: Float32Array;
  private readonly ch: number;
  private readonly speed: number;

  private input: Float32Array[]; // pending input per channel
  private inStart = 0; // absolute input index of input[c][0]
  private totalIn = 0;
  private k = 0; // next synthesis frame index
  private prevPos = -1; // absolute input position of the previous frame
  private acc: Float32Array[]; // overlap-add accumulator, starts at output index accStart
  private accStart = 0;
  private emitted = 0;

  constructor(sampleRate: number, channels: number, speed: number) {
    this.speed = speed;
    this.ch = channels;
    this.N = 2 * Math.round(sampleRate * 0.02);
    this.Hs = this.N / 2;
    this.tol = Math.round(sampleRate * 0.012);
    this.win = Float32Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N));
    this.input = Array.from({ length: channels }, () => new Float32Array(0));
    this.acc = Array.from({ length: channels }, () => new Float32Array(this.N));
  }

  /** Feeds input (planar); returns finished output (planar). */
  push(planes: Float32Array[]): Float32Array[] {
    if (this.speed === 1) return planes;
    for (let c = 0; c < this.ch; c++) {
      const m = new Float32Array(this.input[c].length + planes[c].length);
      m.set(this.input[c]);
      m.set(planes[c], this.input[c].length);
      this.input[c] = m;
    }
    this.totalIn += planes[0].length;
    return this.process(false);
  }

  /** Flushes the tail; total output length is exactly round(totalIn / speed). */
  flush(): Float32Array[] {
    if (this.speed === 1) return Array.from({ length: this.ch }, () => new Float32Array(0));
    const out = this.process(true);
    const target = Math.round(this.totalIn / this.speed);
    const have = this.emitted;
    const extra = Math.max(0, target - have);
    // Remaining accumulator content (already windowed) fills the tail; pad with silence if short.
    const tail = this.acc.map((a) => {
      const t = new Float32Array(extra);
      t.set(a.subarray(0, Math.min(extra, a.length)));
      return t;
    });
    this.emitted += extra;
    const joined = out.map((o, c) => {
      const j = new Float32Array(o.length + tail[c].length);
      j.set(o);
      j.set(tail[c], o.length);
      return j;
    });
    // If we overshot (can't un-emit), the caller's sync tolerance covers ≤ 1 hop; trim when possible.
    const over = this.emitted - target;
    return over > 0 ? joined.map((j) => j.subarray(0, Math.max(0, j.length - over))) : joined;
  }

  private process(final: boolean): Float32Array[] {
    const { N, Hs, tol } = this;
    const outs: Float32Array[][] = Array.from({ length: this.ch }, () => []);
    const inEnd = this.inStart + this.input[0].length;
    for (;;) {
      const ideal = Math.round(this.k * Hs * this.speed);
      // Need the frame plus the search range available.
      if (ideal + N + tol > inEnd) {
        if (!final || ideal >= inEnd) break;
      }
      let pos = ideal;
      if (this.prevPos >= 0) {
        // Best match for the natural continuation of the previous frame (prevPos + Hs).
        const natural = this.prevPos + Hs;
        let best = -Infinity;
        const lo = Math.max(this.inStart, ideal - tol);
        const hi = Math.min(inEnd - N, ideal + tol);
        for (let p = lo; p <= hi; p += 2) {
          let corr = 0;
          for (let i = 0; i < Hs; i += 4) {
            const a = this.at(0, natural + i);
            const b = this.at(0, p + i);
            corr += a * b;
          }
          if (corr > best) {
            best = corr;
            pos = p;
          }
        }
      }
      // Overlap-add frame into the accumulator at output index k·Hs.
      const outPos = this.k * Hs;
      this.ensureAcc(outPos + N);
      for (let c = 0; c < this.ch; c++) {
        const a = this.acc[c];
        const o = outPos - this.accStart;
        for (let i = 0; i < N; i++) a[o + i] += this.at(c, pos + i) * this.win[i];
      }
      this.prevPos = pos;
      this.k++;
      // Everything before the next frame's start is final.
      const ready = this.k * Hs - this.accStart;
      if (ready > 0) {
        for (let c = 0; c < this.ch; c++) {
          outs[c].push(this.acc[c].slice(0, ready));
          const rest = new Float32Array(this.acc[c].length);
          rest.set(this.acc[c].subarray(ready));
          this.acc[c] = rest;
        }
        this.accStart += ready;
        this.emitted += ready;
      }
      // Drop input no longer reachable.
      const keepFrom = Math.max(0, Math.min(Math.round(this.k * Hs * this.speed) - tol, pos + Hs - tol) - this.inStart - 1);
      if (keepFrom > 4096) {
        for (let c = 0; c < this.ch; c++) this.input[c] = this.input[c].slice(keepFrom);
        this.inStart += keepFrom;
      }
    }
    return outs.map((parts) => {
      const len = parts.reduce((s, p) => s + p.length, 0);
      const o = new Float32Array(len);
      let off = 0;
      for (const p of parts) {
        o.set(p, off);
        off += p.length;
      }
      return o;
    });
  }

  private at(c: number, abs: number): number {
    const i = abs - this.inStart;
    const buf = this.input[c];
    return i >= 0 && i < buf.length ? buf[i] : 0;
  }

  private ensureAcc(absEnd: number) {
    const need = absEnd - this.accStart;
    if (need <= this.acc[0].length) return;
    this.acc = this.acc.map((a) => {
      const b = new Float32Array(Math.max(need, a.length * 2));
      b.set(a);
      return b;
    });
  }
}
