// Builds the output audio stream from source audio chunks and the EDL's segments.
// At each discontinuity (a cut) it applies a short fade-out/fade-in so there are no pops while
// keeping output length exactly equal to the video's (a true overlap crossfade would drift A/V sync).

import type { Segment } from './edl';

export interface AssemblerOptions {
  sampleRate: number;
  channels: number;
  fadeSec: number;
  /** Gain applied to sped-up stretches (they are silent pauses anyway). */
  speedUpGain?: number;
  emit: (planes: Float32Array[], outFrameOffset: number) => void | Promise<void>;
}

export class AudioAssembler {
  private segIdx = 0;
  private outFrames = 0;
  /** Output frames held back so a fade-out can still be applied when the segment ends. */
  private held: Float32Array[];
  private heldLen = 0;
  private segOutFrames = 0; // frames written for the current segment so far
  private readonly fadeFrames: number;
  /** Fractional read position carry-over for sped-up segments. */
  private speedPhase = 0;

  private readonly segments: Segment[];
  private readonly o: AssemblerOptions;

  constructor(segments: Segment[], o: AssemblerOptions) {
    this.segments = segments;
    this.o = o;
    this.fadeFrames = Math.max(1, Math.round(o.fadeSec * o.sampleRate));
    this.held = Array.from({ length: o.channels }, () => new Float32Array(this.fadeFrames));
  }

  get framesOut(): number {
    return this.outFrames;
  }

  /** Feed a decoded source chunk (planar) that starts at src frame `srcFrame0`. Chunks must arrive in order. */
  async push(planes: Float32Array[], srcFrame0: number): Promise<void> {
    const sr = this.o.sampleRate;
    const n = planes[0].length;
    let pos = 0;
    while (pos < n && this.segIdx < this.segments.length) {
      const seg = this.segments[this.segIdx];
      const segA = Math.round(seg.srcStart * sr);
      const segB = Math.round(seg.srcEnd * sr);
      const abs = srcFrame0 + pos;
      if (abs >= segB) {
        await this.endSegment();
        continue;
      }
      if (abs < segA) {
        pos = Math.min(n, segA - srcFrame0);
        continue;
      }
      const take = Math.min(n - pos, segB - abs);
      const slice = planes.map((p) => p.subarray(pos, pos + take));
      await this.write(seg.speed === 1 ? slice : this.decimate(slice, seg.speed));
      pos += take;
    }
  }

  /** Call once after the last chunk. */
  async finish(): Promise<void> {
    while (this.segIdx < this.segments.length) await this.endSegment();
    await this.flushHeld();
  }

  private decimate(planes: Float32Array[], speed: number): Float32Array[] {
    const g = this.o.speedUpGain ?? 0.25;
    const outLen = Math.floor((planes[0].length - this.speedPhase) / speed + 1e-9);
    const out = planes.map(() => new Float32Array(Math.max(0, outLen)));
    for (let i = 0; i < outLen; i++) {
      const src = Math.floor(this.speedPhase + i * speed);
      for (let c = 0; c < planes.length; c++) out[c][i] = planes[c][src] * g;
    }
    this.speedPhase = this.speedPhase + outLen * speed - planes[0].length;
    return out;
  }

  private async write(planes: Float32Array[]): Promise<void> {
    const len = planes[0].length;
    if (len === 0) return;
    const fade = this.fadeFrames;
    // Fade in at the start of a segment that follows a cut.
    const needsFadeIn = this.segIdx > 0 && this.isDiscontinuous(this.segIdx) && this.segOutFrames < fade;
    let data = planes;
    if (needsFadeIn) {
      data = planes.map((p) => Float32Array.from(p));
      for (let i = 0; i < len && this.segOutFrames + i < fade; i++) {
        const g = gainCurve((this.segOutFrames + i) / fade);
        for (const p of data) p[i] *= g;
      }
    }
    this.segOutFrames += len;

    // Emit held + new, keeping the last `fade` frames held back.
    const total = this.heldLen + len;
    const emitLen = Math.max(0, total - fade);
    if (emitLen > 0) {
      const out = data.map(() => new Float32Array(emitLen));
      for (let c = 0; c < data.length; c++) {
        const fromHeld = Math.min(this.heldLen, emitLen);
        out[c].set(this.held[c].subarray(0, fromHeld), 0);
        if (emitLen > fromHeld) out[c].set(data[c].subarray(0, emitLen - fromHeld), fromHeld);
      }
      await this.o.emit(out, this.outFrames);
      this.outFrames += emitLen;
    }
    // New held = last min(total, fade) frames of (held + data).
    const keep = Math.min(total, fade);
    for (let c = 0; c < data.length; c++) {
      const next = new Float32Array(fade);
      const combinedTail = (k: number) => {
        // k-th frame of the combined buffer
        return k < this.heldLen ? this.held[c][k] : data[c][k - this.heldLen];
      };
      for (let i = 0; i < keep; i++) next[i] = combinedTail(total - keep + i);
      this.held[c] = next;
    }
    this.heldLen = keep;
  }

  private isDiscontinuous(i: number): boolean {
    const prev = this.segments[i - 1];
    const cur = this.segments[i];
    return !prev || Math.abs(prev.srcEnd - cur.srcStart) > 1e-6;
  }

  private async endSegment(): Promise<void> {
    const nextIdx = this.segIdx + 1;
    // Fade out the held tail if a cut follows.
    if (nextIdx < this.segments.length && this.isDiscontinuous(nextIdx)) {
      for (let i = 0; i < this.heldLen; i++) {
        const g = gainCurve((this.heldLen - 1 - i) / this.fadeFrames);
        for (const p of this.held) p[i] *= g;
      }
      await this.flushHeld();
    }
    this.segIdx = nextIdx;
    this.segOutFrames = 0;
    this.speedPhase = 0;
  }

  private async flushHeld(): Promise<void> {
    if (this.heldLen === 0) return;
    const out = this.held.map((p) => p.slice(0, this.heldLen));
    await this.o.emit(out, this.outFrames);
    this.outFrames += this.heldLen;
    this.heldLen = 0;
  }
}

/** Equal-power-ish raised-sine ramp, 0 → 1. */
function gainCurve(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return Math.sin((c * Math.PI) / 2) ** 2;
}
