// Compact per-frame output of the frame-analysis worker. Everything is in analysis pixels (the
// worker runs at `scale` × source resolution); consumers convert to source pixels.

export interface FrameData {
  /** Analysis frames per second. */
  fps: number;
  frames: number;
  /** Analysis-pixel size and the factor to source pixels (source = analysis / scale). */
  width: number;
  height: number;
  scale: number;

  /**
   * Cursor-like blobs that just turned dark, per frame: up to CURSOR_SLOTS × [x, y, area, lx, ly],
   * where (lx, ly) is the matching blob that turned light (where the cursor left), NaN if none.
   */
  cursorCands: Float32Array;
  /** Changed regions per frame (UI reactions): up to CHANGE_SLOTS × [x0, y0, x1, y1, cells]. */
  changes: Float32Array;
  /** Fraction of the frame that changed vs. the previous analysis frame. */
  changedFrac: Float32Array;

  /** Motion-frequency grid per block (0–255 = share of frames a cell changed), for webcam detection. */
  motionGrid: { cols: number; rows: number; cell: number; blockSec: number; blocks: number; data: Uint8Array };
  /** Low-res luma snapshots per block (circle edges for the webcam), at `scale` × source. */
  snapshots: { width: number; height: number; scale: number; blockSec: number; count: number; data: Uint8Array };
  /** Per-pixel median of stills spread over the video (analysis resolution), for the window rect. */
  still: Uint8Array;
}

export const CURSOR_SLOTS = 4;
export const CURSOR_FIELDS = 5;
export const CHANGE_SLOTS = 6;
export const CHANGE_FIELDS = 5;
