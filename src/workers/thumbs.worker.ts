// Hover-preview thumbnails ("storyboard"): one small JPEG per `interval` seconds of source video.
// Pass 1 decodes only keyframes (cheap: no dependent frames), so the whole timeline has coarse
// previews within seconds; pass 2 fills in every `interval`. Batches stream back as they're made;
// the full set is cached in IndexedDB by the caller.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';

export type ThumbsIn = { file: File; interval: number; width: number };
export type ThumbsOut =
  | { type: 'batch'; indices: number[]; blobs: Blob[]; total: number }
  | { type: 'done'; total: number; width: number; height: number }
  | { type: 'error'; message: string };

const post = (m: ThumbsOut) => postMessage(m);

self.onmessage = async (e: MessageEvent<ThumbsIn>) => {
  const { file, interval, width } = e.data;
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track.');
    const duration = await input.computeDuration();
    const W = width;
    const H = Math.round((width * track.displayHeight) / track.displayWidth / 2) * 2;
    const total = Math.max(1, Math.floor(duration / interval) + 1);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.imageSmoothingQuality = 'high';

    const sink = new VideoSampleSink(track);
    const render = async (times: number[], indices: number[], every: number) => {
      let blobs: Blob[] = [];
      let idx: number[] = [];
      let k = 0;
      for await (const sample of sink.samplesAtTimestamps(times)) {
        if (sample) {
          sample.draw(ctx, 0, 0, W, H);
          sample.close();
          blobs.push(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 }));
          idx.push(indices[k]);
        }
        k++;
        if (blobs.length >= every) {
          post({ type: 'batch', indices: idx, blobs, total });
          blobs = [];
          idx = [];
        }
      }
      if (blobs.length) post({ type: 'batch', indices: idx, blobs, total });
    };

    // Pass 1: keyframes only.
    const packets = new EncodedPacketSink(track);
    const keyTimes: number[] = [];
    for (let p = await packets.getFirstKeyPacket({ metadataOnly: true }); p; p = await packets.getNextKeyPacket(p, { metadataOnly: true })) {
      keyTimes.push(Math.max(0, p.timestamp));
    }
    await render(keyTimes, keyTimes.map((t) => Math.min(total - 1, Math.round(t / interval))), 8);

    // Pass 2: every interval.
    const all = Array.from({ length: total }, (_, i) => Math.min(duration - 0.05, i * interval));
    await render(all, all.map((_, i) => i), 30);
    input.dispose();
    post({ type: 'done', total, width: W, height: H });
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
