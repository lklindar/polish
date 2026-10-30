// Real-time EDL playback on two <video> elements. The active one plays; the standby one is parked
// at the start of the next kept segment after a cut so the jump is instant (the sample file has a
// 10 s keyframe interval, so a cold seek can take hundreds of ms). Each frame is drawn to a canvas,
// which later milestones use for zoom, captions and ripples.

import { nextSegmentIndex, segmentIndexAt, type Segment } from '../core/edl';

const EPS = 1 / 120;

export class EdlPlayer {
  readonly videos: [HTMLVideoElement, HTMLVideoElement];
  private active = 0;
  private segments: Segment[] = [];
  private segIdx = 0;
  private standbyFor = -1;
  private raf = 0;
  private timer: ReturnType<typeof setInterval>;
  private ctx: CanvasRenderingContext2D | null = null;
  private listeners = new Set<() => void>();
  /** Before mode: plays the raw source, ignoring the EDL. */
  bypass = false;
  globalSpeed = 1;
  /** J/K/L shuttle multiplier. */
  shuttle = 1;
  playing = false;
  /** Drawn on top of each frame (captions, later zoom/ripples). Gets source time. */
  overlay: ((ctx: CanvasRenderingContext2D, srcTime: number, width: number, height: number) => void) | null = null;
  /** Pause automatically when source time reaches this (used to audition a single edit). */
  private stopAt: number | null = null;

  constructor(url: string) {
    this.videos = [this.makeVideo(url), this.makeVideo(url)];
    this.videos[1].muted = true;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.timer = setInterval(() => this.check(), 10);
    this.videos[0].addEventListener('ended', () => this.setPlaying(false));
  }

  private makeVideo(url: string) {
    const v = document.createElement('video');
    v.src = url;
    v.preload = 'auto';
    v.playsInline = true;
    v.preservesPitch = true;
    return v;
  }

  attachCanvas(canvas: HTMLCanvasElement | null) {
    this.ctx = canvas?.getContext('2d', { alpha: false }) ?? null;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  get video() {
    return this.videos[this.active];
  }

  private get standby() {
    return this.videos[1 - this.active];
  }

  get srcTime() {
    return this.video.currentTime;
  }

  setSegments(segments: Segment[]) {
    this.segments = segments;
    this.syncToTime(this.srcTime);
  }

  setBypass(b: boolean) {
    this.bypass = b;
    this.syncToTime(this.srcTime);
  }

  async play() {
    if (!this.bypass && this.segments.length) {
      const t = this.srcTime;
      const end = this.segments[this.segments.length - 1].srcEnd;
      if (t >= end - EPS) this.seek(this.segments[0].srcStart);
      else if (segmentIndexAt(this.segments, t) < 0) this.syncToTime(t);
    }
    this.applyRate();
    this.setPlaying(true);
    try {
      await this.video.play();
    } catch {
      this.setPlaying(false);
    }
  }

  /** Plays [start, end) once and pauses. */
  playSpan(start: number, end: number) {
    this.seek(start);
    this.stopAt = end;
    void this.play();
  }

  pause() {
    this.videos.forEach((v) => v.pause());
    this.setPlaying(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  private setPlaying(p: boolean) {
    this.playing = p;
    this.emit();
  }

  /** Seek in source time; in edited mode a time inside a cut snaps to the next kept segment. */
  seek(t: number) {
    this.stopAt = null;
    this.video.currentTime = Math.max(0, t);
    this.syncToTime(t);
    this.emit();
  }

  private syncToTime(t: number) {
    if (this.bypass || this.segments.length === 0) {
      this.applyRate();
      return;
    }
    const i = Math.min(nextSegmentIndex(this.segments, t), this.segments.length - 1);
    this.segIdx = i;
    const seg = this.segments[i];
    if (t < seg.srcStart) this.video.currentTime = seg.srcStart;
    this.applyRate();
    this.prepareStandby();
  }

  private applyRate() {
    const seg = this.segments[this.segIdx];
    const segSpeed = this.bypass || !seg ? 1 : seg.speed;
    const v = this.video;
    v.playbackRate = Math.min(16, segSpeed * this.globalSpeed * this.shuttle);
    v.muted = !this.bypass && seg?.reason === 'speedup';
  }

  /** Parks the standby video at the start of the next segment that follows a cut. */
  private prepareStandby() {
    let j = this.segIdx + 1;
    while (j < this.segments.length && this.contiguous(j)) j++;
    if (j >= this.segments.length || j === this.standbyFor) return;
    this.standbyFor = j;
    const sb = this.standby;
    sb.pause();
    sb.muted = true;
    sb.currentTime = this.segments[j].srcStart;
  }

  private contiguous(j: number) {
    return Math.abs(this.segments[j - 1].srcEnd - this.segments[j].srcStart) < 1e-6;
  }

  private advance() {
    const next = this.segIdx + 1;
    if (next >= this.segments.length) {
      this.pause();
      return;
    }
    if (this.contiguous(next)) {
      this.segIdx = next;
      this.applyRate();
      return;
    }
    const target = this.segments[next].srcStart;
    const sb = this.standby;
    const ready = this.standbyFor === next && sb.readyState >= 2 && Math.abs(sb.currentTime - target) < 0.05;
    this.segIdx = next;
    if (ready) {
      const old = this.video;
      this.active = 1 - this.active;
      this.applyRate();
      void this.video.play();
      old.pause();
      old.muted = true;
    } else {
      this.video.currentTime = target;
      this.applyRate();
    }
    this.prepareStandby();
    this.emit();
  }

  /** Segment boundary check. Runs on a 10 ms timer (not rAF) so cuts are honoured even when the
   * tab is hidden, and with finer granularity than a 60 Hz frame. */
  private check() {
    if (this.playing && this.stopAt != null && this.video.currentTime >= this.stopAt) {
      this.stopAt = null;
      this.pause();
      return;
    }
    if (!this.playing || this.bypass || !this.segments.length) return;
    const v = this.video;
    const seg = this.segments[this.segIdx];
    if (!seg) return;
    // Look ahead by one timer tick of media time so we don't overshoot into the cut.
    const ahead = 0.012 * v.playbackRate;
    if (v.currentTime + ahead >= seg.srcEnd) this.advance();
    else if (v.currentTime < seg.srcStart - 0.25) this.syncToTime(v.currentTime);
  }

  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    this.check();
    const v = this.video;
    const ctx = this.ctx;
    if (ctx && v.readyState >= 2) {
      const c = ctx.canvas;
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
      }
      ctx.drawImage(v, 0, 0, c.width, c.height);
      this.overlay?.(ctx, v.currentTime, c.width, c.height);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.videos.forEach((v) => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
    this.listeners.clear();
  }
}
