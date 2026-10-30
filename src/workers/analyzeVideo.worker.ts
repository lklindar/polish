// Low-res pass over the video: per-cell luma difference between samples taken at HZ.
// Feeds the visual-activity guard (and, from M4, the cursor/click tracker).

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { DIFF_QUANT, type VideoActivityRaw } from '../core/activity';
import type { AnalyzeVideoOut } from './protocol';

const HZ = 5;
const ANALYSIS_W = 320;
const COLS = 24;

const post = (m: AnalyzeVideoOut, transfer: Transferable[] = []) => postMessage(m, { transfer });

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  try {
    const input = new Input({ source: new BlobSource(e.data.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');
    const duration = await input.computeDuration();
    const w = ANALYSIS_W;
    const h = Math.max(2, Math.round((ANALYSIS_W * track.displayHeight) / track.displayWidth));
    const rows = Math.max(1, Math.round((COLS * h) / w));
    const cells = COLS * rows;
    const frames = Math.floor(duration * HZ);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const lumaA = new Float32Array(w * h);
    const lumaB = new Float32Array(w * h);
    let prev = lumaA;
    let cur = lumaB;
    const diffs = new Uint8Array(frames * cells);
    const cellSum = new Float32Array(cells);
    const cellCount = new Uint32Array(cells);
    // Precompute cell index per pixel.
    const cellOf = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = Math.min(rows - 1, Math.floor((y * rows) / h));
      for (let x = 0; x < w; x++) cellOf[y * w + x] = r * COLS + Math.min(COLS - 1, Math.floor((x * COLS) / w));
    }
    for (let i = 0; i < w * h; i++) cellCount[cellOf[i]]++;

    const sink = new VideoSampleSink(track);
    function* times() {
      for (let i = 0; i < frames; i++) yield i / HZ;
    }
    let f = 0;
    let lastPost = 0;
    for await (const sample of sink.samplesAtTimestamps(times())) {
      if (sample) {
        sample.draw(ctx, 0, 0, w, h);
        sample.close();
      }
      const px = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0, j = 0; i < cur.length; i++, j += 4) {
        cur[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
      }
      if (f > 0) {
        cellSum.fill(0);
        for (let i = 0; i < cur.length; i++) {
          const d = cur[i] - prev[i];
          cellSum[cellOf[i]] += d < 0 ? -d : d;
        }
        const base = f * cells;
        for (let c = 0; c < cells; c++) {
          diffs[base + c] = Math.min(255, Math.round((cellSum[c] / cellCount[c]) * DIFF_QUANT));
        }
      }
      [prev, cur] = [cur, prev];
      f++;
      const now = performance.now();
      if (now - lastPost > 200) {
        lastPost = now;
        post({ type: 'progress', fraction: f / frames });
      }
      if (f >= frames) break;
    }
    input.dispose();
    const activity: VideoActivityRaw = { hz: HZ, cols: COLS, rows, frames, diffs };
    post({ type: 'done', activity }, [diffs.buffer]);
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
