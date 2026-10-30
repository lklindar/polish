// Fallback for hover previews when no thumbnail is ready yet: a hidden <video> that seeks to the
// hovered time and draws into a canvas. One instance is reused across hovers (so it stays loaded);
// only the latest request is kept, so fast mouse moves never queue a backlog of seeks.

export class HoverFrames {
  private readonly video: HTMLVideoElement;
  private busy = false;
  private pending: { t: number; canvas: HTMLCanvasElement } | null = null;

  constructor(url: string) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = url;
    this.video = v;
  }

  request(t: number, canvas: HTMLCanvasElement) {
    this.pending = { t, canvas };
    if (!this.busy) void this.next();
  }

  private async next() {
    const job = this.pending;
    this.pending = null;
    if (!job) return;
    this.busy = true;
    const v = this.video;
    try {
      // Seeking before metadata is loaded never fires 'seeked' in Chrome.
      if (v.readyState < 1) await waitFor(v, 'loadedmetadata', 5000);
      const seeked = waitFor(v, 'seeked', 3000);
      v.currentTime = Math.min(Math.max(0, job.t), Math.max(0, v.duration - 0.05));
      await seeked;
      if (v.readyState < 2) await waitFor(v, 'loadeddata', 2000);
      const ctx = job.canvas.getContext('2d');
      if (ctx && v.videoWidth) ctx.drawImage(v, 0, 0, job.canvas.width, job.canvas.height);
    } catch {
      /* timed out: the next request retries */
    } finally {
      this.busy = false;
      if (this.pending) void this.next();
    }
  }

  destroy() {
    this.pending = null;
    this.video.removeAttribute('src');
    this.video.load();
  }
}

function waitFor(el: HTMLElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      el.removeEventListener(event, on);
      reject(new Error(`${event} timeout`));
    }, timeoutMs);
    const on = () => {
      clearTimeout(timer);
      el.removeEventListener(event, on);
      resolve();
    };
    el.addEventListener(event, on);
  });
}
