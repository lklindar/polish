// One decode pass over the video at half resolution, 15 fps. Produces:
//  - the 5 Hz cell-diff grid for the visual-activity guard (silence speed-ups);
//  - FrameData for cursor/click/webcam/layout inference (see core/frameData.ts).
// Only compact per-frame summaries leave the worker; frames are closed as soon as they're read.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import { DIFF_QUANT, type VideoActivityRaw } from '../core/activity';
import { CHANGE_FIELDS, CHANGE_SLOTS, CURSOR_FIELDS, CURSOR_SLOTS, type FrameData } from '../core/frameData';
import type { AnalyzeVideoOut } from './protocol';

const FPS = 15;
const ACTIVITY_EVERY = 3; // 15 / 3 = 5 Hz activity samples
const ACTIVITY_COLS = 24;
const MAX_W = 960;
const CELL = 8; // change-grid cell, analysis px
const BLOCK_SEC = 4;
const SNAP_DIV = 4; // snapshot = analysis / 4
const STILLS = 36;
const DARKEN = 40; // luma drop for a "became dark" pixel (cursor arriving)
const CHANGED = 20; // abs luma change for UI-change cells
const WEBCAM_EMA = 0.25; // cells changing this often are "always moving" (talking head)
const MAX_PAIR = 120; // max distance (analysis px) between where the pointer left and arrived per frame

const post = (m: AnalyzeVideoOut, transfer: Transferable[] = []) => postMessage(m, { transfer });

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  try {
    const input = new Input({ source: new BlobSource(e.data.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');
    const duration = await input.computeDuration();
    const srcW = track.displayWidth;
    const srcH = track.displayHeight;
    const scale = Math.min(0.5, MAX_W / srcW);
    const W = Math.max(2, Math.round(srcW * scale));
    const H = Math.max(2, Math.round(srcH * scale));
    const N = W * H;
    const frames = Math.floor(duration * FPS);

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    let prev = new Uint8Array(N);
    let cur = new Uint8Array(N);
    let prevAct = new Uint8Array(N);

    // Activity grid (5 Hz).
    const aRows = Math.max(1, Math.round((ACTIVITY_COLS * H) / W));
    const aCells = ACTIVITY_COLS * aRows;
    const aFrames = Math.floor(frames / ACTIVITY_EVERY);
    const aDiffs = new Uint8Array(aFrames * aCells);
    const aCellOf = new Uint16Array(N);
    const aCount = new Uint32Array(aCells);
    for (let y = 0; y < H; y++) {
      const r = Math.min(aRows - 1, Math.floor((y * aRows) / H));
      for (let x = 0; x < W; x++) aCellOf[y * W + x] = r * ACTIVITY_COLS + Math.min(ACTIVITY_COLS - 1, Math.floor((x * ACTIVITY_COLS) / W));
    }
    for (let i = 0; i < N; i++) aCount[aCellOf[i]]++;
    const aSum = new Float32Array(aCells);

    // Change grid.
    const gCols = Math.ceil(W / CELL);
    const gRows = Math.ceil(H / CELL);
    const gCells = gCols * gRows;
    const cellCount = new Uint16Array(gCells);
    const cellOn = new Uint8Array(gCells);
    const ema = new Float32Array(gCells);
    const blockFrames = BLOCK_SEC * FPS;
    const blocks = Math.ceil(frames / blockFrames);
    const motion = new Uint8Array(blocks * gCells);
    const blockAcc = new Uint16Array(gCells);

    // Snapshots + stills.
    const sW = Math.floor(W / SNAP_DIV);
    const sH = Math.floor(H / SNAP_DIV);
    const snaps = new Uint8Array(blocks * sW * sH);
    const stillEvery = Math.max(1, Math.floor(frames / STILLS));
    const stills: Uint8Array[] = [];

    const cursorCands = new Float32Array(frames * CURSOR_SLOTS * CURSOR_FIELDS).fill(NaN);
    const changes = new Float32Array(frames * CHANGE_SLOTS * CHANGE_FIELDS).fill(NaN);
    const changedFrac = new Float32Array(frames);

    // Scratch for connected components.
    const label = new Int32Array(N);
    const stack = new Int32Array(N);
    const gLabel = new Int32Array(gCells);
    const gStack = new Int32Array(gCells);

    /** Flood-fills one signed-change blob; returns [cx, cy, area, meanLuma, x0, y0, x1, y1] if pointer-sized. */
    const component = (seed: number, sign: number): number[] | null => {
      let sp = 0;
      stack[sp++] = seed;
      label[seed] = 1;
      let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, lum = 0;
      const take = (q: number) => {
        if (label[q]) return;
        const dq = cur[q] - prev[q];
        if ((sign < 0 && dq < -DARKEN) || (sign > 0 && dq > DARKEN)) {
          label[q] = 1;
          stack[sp++] = q;
        }
      };
      while (sp) {
        const k = stack[--sp];
        const x = k % W;
        const y = (k / W) | 0;
        n++;
        sx += x;
        sy += y;
        lum += cur[k];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x > 0) take(k - 1);
        if (x < W - 1) take(k + 1);
        if (y > 0) take(k - W);
        if (y < H - 1) take(k + W);
      }
      // Pointer at half-res is roughly 6×9 px; allow up to ~2× for larger cursors.
      if (n < 4 || n > 160 || x1 - x0 + 1 > 22 || y1 - y0 + 1 > 26) return null;
      return [sx / n, sy / n, n, lum / n, x0, y0, x1, y1];
    };

    /**
     * The darkening blob is only the part of the pointer that didn't overlap its old position, so
     * its centroid is biased. Re-find the whole dark shape in the current frame and return its tip
     * (top-left-ish, where macOS arrow/hand hotspots are).
     */
    const hotspot = (b: number[]): [number, number] => {
      const bx0 = Math.max(0, Math.floor(b[4]) - 8);
      const by0 = Math.max(0, Math.floor(b[5]) - 8);
      const bx1 = Math.min(W - 1, bx0 + 31);
      const by1 = Math.min(H - 1, by0 + 31);
      let seed = -1;
      let min = 256;
      for (let y = Math.floor(b[5]); y <= b[7]; y++) {
        for (let x = Math.floor(b[4]); x <= b[6]; x++) {
          if (cur[y * W + x] < min) {
            min = cur[y * W + x];
            seed = y * W + x;
          }
        }
      }
      if (seed < 0 || min > 200) return [b[0], b[1]];
      // Relative threshold: the pointer is whatever is clearly darker than its surroundings.
      const dark = min + 45;
      const q = [seed];
      let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
      const seen = new Set<number>([seed]);
      while (q.length && n < 260) {
        const k = q.pop()!;
        const x = k % W;
        const y = (k / W) | 0;
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (const nb of [k - 1, k + 1, k - W, k + W]) {
          const nx = nb % W;
          const ny = (nb / W) | 0;
          if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1 || seen.has(nb) || cur[nb] > dark) continue;
          seen.add(nb);
          q.push(nb);
        }
      }
      // Ran into text or a large dark area: keep the blob centre.
      if (n >= 260 || x1 - x0 > 16 || y1 - y0 > 20) return [b[0], b[1]];
      return [x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.1];
    };

    let planeBuf = new Uint8Array(0);
    const YUV = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);
    /** 2×2 box-downsampled luma straight from the frame's Y plane; false if the frame isn't YUV. */
    const readLuma = async (sample: VideoSample, out: Uint8Array): Promise<boolean> => {
      const vf = sample.toVideoFrame();
      try {
        if (!vf.format || !YUV.has(vf.format)) return false;
        const size = vf.allocationSize();
        if (planeBuf.length < size) planeBuf = new Uint8Array(size);
        const layout = await vf.copyTo(planeBuf);
        const { offset, stride } = layout[0];
        const sw = vf.visibleRect?.width ?? vf.codedWidth;
        const sh = vf.visibleRect?.height ?? vf.codedHeight;
        const fx = sw / W;
        const fy = sh / H;
        for (let y = 0; y < H; y++) {
          const r0 = offset + Math.min(sh - 2, Math.floor(y * fy)) * stride;
          const r1 = r0 + stride;
          for (let x = 0; x < W; x++) {
            const c = Math.min(sw - 2, Math.floor(x * fx));
            out[y * W + x] = (planeBuf[r0 + c] + planeBuf[r0 + c + 1] + planeBuf[r1 + c] + planeBuf[r1 + c + 1]) >> 2;
          }
        }
        return true;
      } catch {
        return false;
      } finally {
        vf.close();
      }
    };

    const sink = new VideoSampleSink(track);
    function* times() {
      for (let i = 0; i < frames; i++) yield i / FPS;
    }
    let f = 0;
    let lastPost = 0;
    const timing = { decode: 0, read: 0, analyze: 0 };
    let tMark = performance.now();
    for await (const sample of sink.samplesAtTimestamps(times())) {
      const tGot = performance.now();
      timing.decode += tGot - tMark;
      if (sample) {
        // Fast path: read the decoder's luma plane directly (2.5× faster than drawing to a canvas and
        // reading RGBA back). Falls back to the canvas for decoders that hand out RGB frames.
        if (!(await readLuma(sample, cur))) {
          sample.draw(ctx, 0, 0, W, H);
          const px = ctx.getImageData(0, 0, W, H).data;
          for (let i = 0, j = 0; i < N; i++, j += 4) cur[i] = (77 * px[j] + 150 * px[j + 1] + 29 * px[j + 2]) >> 8;
        }
        sample.close();
      }
      const tRead = performance.now();
      timing.read += tRead - tGot;

      if (f % stillEvery === 0 && stills.length < STILLS) stills.push(cur.slice());
      const block = Math.floor(f / blockFrames);
      if (f % blockFrames === 0) {
        const base = block * sW * sH;
        for (let y = 0; y < sH; y++) {
          for (let x = 0; x < sW; x++) snaps[base + y * sW + x] = cur[y * SNAP_DIV * W + x * SNAP_DIV];
        }
      }

      if (f > 0) {
        // 1. Changed cells (abs diff), frame-level change fraction.
        cellCount.fill(0);
        let changedPx = 0;
        for (let y = 0; y < H; y++) {
          const row = (y >> 3) * gCols;
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const d = cur[i] - prev[i];
            if (d > CHANGED || d < -CHANGED) {
              changedPx++;
              cellCount[row + (x >> 3)]++;
            }
          }
        }
        changedFrac[f] = changedPx / N;
        for (let c = 0; c < gCells; c++) {
          const on = cellCount[c] >= 3 ? 1 : 0;
          cellOn[c] = on;
          ema[c] += (on - ema[c]) / 30;
          blockAcc[c] += on;
        }

        // 2. Change regions: components of changed cells, largest first.
        gLabel.fill(0);
        const regions: number[][] = [];
        let gl = 0;
        for (let c = 0; c < gCells; c++) {
          if (!cellOn[c] || gLabel[c]) continue;
          gl++;
          let sp = 0;
          gStack[sp++] = c;
          gLabel[c] = gl;
          let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0, steady = 0;
          while (sp) {
            const k = gStack[--sp];
            const cx = k % gCols;
            const cy = (k / gCols) | 0;
            n++;
            if (ema[k] > WEBCAM_EMA) steady++;
            if (cx < x0) x0 = cx;
            if (cx > x1) x1 = cx;
            if (cy < y0) y0 = cy;
            if (cy > y1) y1 = cy;
            if (cx > 0 && cellOn[k - 1] && !gLabel[k - 1]) { gLabel[k - 1] = gl; gStack[sp++] = k - 1; }
            if (cx < gCols - 1 && cellOn[k + 1] && !gLabel[k + 1]) { gLabel[k + 1] = gl; gStack[sp++] = k + 1; }
            if (cy > 0 && cellOn[k - gCols] && !gLabel[k - gCols]) { gLabel[k - gCols] = gl; gStack[sp++] = k - gCols; }
            if (cy < gRows - 1 && cellOn[k + gCols] && !gLabel[k + gCols]) { gLabel[k + gCols] = gl; gStack[sp++] = k + gCols; }
          }
          // Skip the always-moving webcam area and single-cell specks.
          if (n >= 2 && steady / n < 0.5) regions.push([x0 * CELL, y0 * CELL, (x1 + 1) * CELL, (y1 + 1) * CELL, n]);
        }
        regions.sort((a, b) => b[4] - a[4]);
        for (let r = 0; r < Math.min(CHANGE_SLOTS, regions.length); r++) {
          changes.set(regions[r], (f * CHANGE_SLOTS + r) * CHANGE_FIELDS);
        }

        // 3. Cursor candidates: small, dark, compact blobs that just appeared ("became dark"),
        //    paired with a similar "became light" blob where the cursor left. Skipped during big
        //    changes (navigation) and on static frames.
        if (changedPx > 0 && changedFrac[f] < 0.15) {
          const dark: number[][] = [];
          const light: number[][] = [];
          label.fill(0);
          for (let i = 0; i < N; i++) {
            if (label[i]) continue;
            const d = cur[i] - prev[i];
            const sign = d < -DARKEN ? -1 : d > DARKEN ? 1 : 0;
            if (!sign) continue;
            const c = ((((i / W) | 0) >> 3) * gCols) + ((i % W) >> 3);
            if (ema[c] > WEBCAM_EMA) continue;
            const blob = component(i, sign);
            if (blob) (sign < 0 ? dark : light).push(blob);
            if (dark.length + light.length > 60) break; // a busy frame (animation): not a cursor move
          }
          if (dark.length + light.length <= 60) {
            const pairs = dark
              // The new pixels are darkish. At half-res a thin arrow or the white hand's outline
              // averages to mid-grey (~110–160), so this only rules out near-white noise.
              .filter((b) => b[3] < 170)
              .map((b) => {
                let best: number[] | null = null;
                let bestDist = MAX_PAIR;
                for (const q of light) {
                  const ratio = q[2] / b[2];
                  if (ratio < 0.33 || ratio > 3) continue;
                  const dist = Math.hypot(q[0] - b[0], q[1] - b[1]);
                  if (dist < bestDist) {
                    bestDist = dist;
                    best = q;
                  }
                }
                return { b, from: best, dist: best ? bestDist : Infinity };
              });
            // Blobs sharing one motion vector are scrolling/animating content (list rows, text
            // lines), not the pointer, which moves alone.
            const vec = (p: { b: number[]; from: number[] | null }) =>
              p.from ? `${Math.round((p.b[0] - p.from[0]) / 3)},${Math.round((p.b[1] - p.from[1]) / 3)}` : '';
            const counts = new Map<string, number>();
            for (const p of pairs) if (p.from) counts.set(vec(p), (counts.get(vec(p)) ?? 0) + 1);
            const scored = pairs
              .filter((p) => !p.from || (counts.get(vec(p)) ?? 0) < 2)
              .sort((a, b) => a.dist - b.dist);
            for (let k = 0; k < Math.min(CURSOR_SLOTS, scored.length); k++) {
              const { b, from } = scored[k];
              const [hx, hy] = hotspot(b);
              cursorCands.set([hx, hy, b[2], from ? from[0] : NaN, from ? from[1] : NaN], (f * CURSOR_SLOTS + k) * CURSOR_FIELDS);
            }
          }
        }
      }

      // 4. Activity cells at 5 Hz (vs. the frame 0.2 s earlier).
      if (f % ACTIVITY_EVERY === 0) {
        const af = f / ACTIVITY_EVERY;
        if (af > 0 && af < aFrames) {
          aSum.fill(0);
          for (let i = 0; i < N; i++) {
            const d = cur[i] - prevAct[i];
            aSum[aCellOf[i]] += d < 0 ? -d : d;
          }
          for (let c = 0; c < aCells; c++) aDiffs[af * aCells + c] = Math.min(255, Math.round((aSum[c] / aCount[c]) * DIFF_QUANT));
        }
        prevAct.set(cur);
      }

      // Close a motion block.
      if ((f + 1) % blockFrames === 0 || f + 1 === frames) {
        const n = (f % blockFrames) + 1;
        for (let c = 0; c < gCells; c++) motion[block * gCells + c] = Math.min(255, Math.round((blockAcc[c] / n) * 255));
        blockAcc.fill(0);
      }

      [prev, cur] = [cur, prev];
      f++;
      const now = performance.now();
      timing.analyze += now - tRead;
      tMark = now;
      if (now - lastPost > 250) {
        lastPost = now;
        post({ type: 'progress', fraction: f / frames });
      }
      if (f >= frames) break;
    }
    input.dispose();
    console.info(
      `[analyzeVideo] ${frames} frames: decode ${(timing.decode / 1000).toFixed(1)}s, read ${(timing.read / 1000).toFixed(1)}s, analyze ${(timing.analyze / 1000).toFixed(1)}s`,
    );

    // Median still (per pixel over the sampled stills) for window-rect detection.
    const still = new Uint8Array(N);
    const col = new Uint8Array(stills.length);
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < stills.length; k++) col[k] = stills[k][i];
      col.sort();
      still[i] = col[col.length >> 1];
    }

    const activity: VideoActivityRaw = { hz: FPS / ACTIVITY_EVERY, cols: ACTIVITY_COLS, rows: aRows, frames: aFrames, diffs: aDiffs };
    const frameData: FrameData = {
      fps: FPS,
      frames,
      width: W,
      height: H,
      scale,
      cursorCands,
      changes,
      changedFrac,
      motionGrid: { cols: gCols, rows: gRows, cell: CELL, blockSec: BLOCK_SEC, blocks, data: motion },
      snapshots: { width: sW, height: sH, scale: scale / SNAP_DIV, blockSec: BLOCK_SEC, count: blocks, data: snaps },
      still,
    };
    post({ type: 'done', activity, frameData }, [aDiffs.buffer, cursorCands.buffer, changes.buffer, changedFrac.buffer, motion.buffer, snaps.buffer, still.buffer]);
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
