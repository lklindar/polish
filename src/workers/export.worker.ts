// Export: one linear decode pass per track → render kept frames → encode → mux into an OPFS file.
// Video and audio run concurrently so the muxer can interleave without buffering a whole track.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  WebMOutputFormat,
  canEncodeAudio,
  type StreamTargetChunk,
} from 'mediabunny';
import { AudioAssembler } from '../core/audioAssembler';
import { TimeStretcher } from '../core/timeStretch';
import { drawCaption } from '../core/captionRender';
import { captionAt } from '../core/captions';
import { frameState } from '../core/compose';
import { webcamAt } from '../core/layout';
import { Compositor } from '../render/compositor';
import { measureEncoderDelay } from './encoderDelay';
import { segmentOutStarts } from '../core/edl';
import { outputSize } from '../core/settings';
import type { ExportIn, ExportOut } from './protocol';

const post = (m: ExportOut) => postMessage(m);
let cancelled = false;
class Cancelled extends Error {}

self.onmessage = (e: MessageEvent<ExportIn | { type: 'cancel' }>) => {
  if (e.data.type === 'cancel') cancelled = true;
  else void run(e.data);
};

/** H.264 High profile; level picked from macroblocks per frame. */
function avcCodecString(w: number, h: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  if (mbs <= 8192) return 'avc1.640028'; // 4.0
  if (mbs <= 22080) return 'avc1.640032'; // 5.0
  return 'avc1.640033'; // 5.1
}

async function run(msg: ExportIn) {
  cancelled = false;
  const { file, edl, settings } = msg;
  const opfsName = `export-${Date.now()}`;
  let handle: FileSystemSyncAccessHandle | null = null;
  let output: Output | null = null;
  const root = await navigator.storage.getDirectory();
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) throw new Error('No video track.');
    const aTrack = await input.getPrimaryAudioTrack();

    const useAac = await canEncodeAudio('aac', {
      numberOfChannels: aTrack?.numberOfChannels ?? 1,
      sampleRate: aTrack?.sampleRate ?? 48000,
    });
    const container: 'mp4' | 'webm' = useAac || !aTrack ? 'mp4' : 'webm';

    const fileHandle = await root.getFileHandle(`${opfsName}.${container}`, { create: true });
    handle = await fileHandle.createSyncAccessHandle();
    const h = handle;
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        h.write(chunk.data, { at: chunk.position });
      },
    });

    output = new Output({
      format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(writable, { chunked: true }),
    });

    const fps = Math.round(edl.source.fps) || 30;
    const size = outputSize({ width: vTrack.displayWidth, height: vTrack.displayHeight }, settings.resolution);
    const pixelsScale = (size.width * size.height) / (1920 * 1080);
    const videoSource = new VideoSampleSource({
      codec: container === 'mp4' ? 'avc' : 'vp9',
      fullCodecString: container === 'mp4' ? avcCodecString(size.width, size.height) : undefined,
      bitrate: Math.round(settings.bitrateMbps * 1e6 * Math.max(0.5, pixelsScale) * (fps / 30)),
      hardwareAcceleration: 'prefer-hardware',
      keyFrameInterval: 2,
      sizeChangeBehavior: 'deny',
    });
    output.addVideoTrack(videoSource, { frameRate: fps });

    let audioSource: AudioSampleSource | null = null;
    if (aTrack) {
      audioSource = new AudioSampleSource({
        codec: container === 'mp4' ? 'aac' : 'opus',
        bitrate: 160_000,
        transform: container === 'webm' ? { sampleRate: 48000 } : undefined,
      });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const totalSrc = edl.segments.reduce((a, s) => a + (s.srcEnd - s.srcStart), 0) || 1;
    const progress = { video: 0, audio: aTrack ? 0 : 1, framesOut: 0 };
    let lastPost = 0;
    const report = (phase: 'video' | 'audio') => {
      const now = performance.now();
      if (now - lastPost < 250) return;
      lastPost = now;
      post({ type: 'progress', phase, fraction: Math.min(progress.video, progress.audio), framesOut: progress.framesOut });
    };

    const videoJob = async () => {
      // Same WebGL2 compositor as the preview: zoom, motion blur, webcam redraw, ripples,
      // captions as an overlay texture.
      const canvas = new OffscreenCanvas(size.width, size.height);
      const gl = new Compositor(canvas);
      const overlay = new OffscreenCanvas(size.width, size.height);
      const octx = overlay.getContext('2d')!;
      const k = size.width / edl.source.width;
      const srcW = vTrack.displayWidth;
      const srcH = vTrack.displayHeight;
      const segs = edl.segments;
      const starts = segmentOutStarts(segs);
      const dt = 1 / fps;
      let nextGrid = 0;
      let si = 0;
      let doneSrc = 0;
      const sink = new VideoSampleSink(vTrack);
      if (segs.length === 0) return;
      for await (const sample of sink.samples(segs[0].srcStart, segs[segs.length - 1].srcEnd)) {
        try {
          if (cancelled) throw new Cancelled();
          const ts = sample.timestamp;
          while (si < segs.length && ts >= segs[si].srcEnd) {
            doneSrc += segs[si].srcEnd - segs[si].srcStart;
            si++;
          }
          if (si >= segs.length) break;
          const seg = segs[si];
          if (ts < seg.srcStart - 1e-4) continue;
          const outT = (starts[si] + (ts - seg.srcStart) / seg.speed) / edl.globalSpeed;
          if (outT + dt / 2 < nextGrid) continue; // dropped by a speed-up
          let drawn = false;
          if (msg.captionStyle) {
            const cap = captionAt(edl.captions, ts);
            if (cap) {
              octx.clearRect(0, 0, size.width, size.height);
              const cam = edl.layout ? webcamAt(edl.layout.webcam, ts) : null;
              drawCaption(octx, cap, ts, msg.captionStyle, size.width, size.height, cam && { x: cam.x * k, y: cam.y * k, r: cam.r * k });
              drawn = true;
            }
          }
          const vf = sample.toVideoFrame();
          gl.render(vf, srcW, srcH, frameState(edl, msg.zoom, ts, fps), drawn ? overlay : null);
          vf.close();
          while (nextGrid <= outT + dt / 2) {
            const frame = new VideoSample(canvas, { timestamp: nextGrid, duration: dt });
            await videoSource.add(frame);
            frame.close();
            nextGrid += dt;
            progress.framesOut++;
          }
          progress.video = (doneSrc + (ts - seg.srcStart)) / totalSrc;
          report('video');
        } finally {
          sample.close();
        }
      }
      progress.video = 1;
      videoSource.close();
    };

    const audioJob = async () => {
      if (!aTrack || !audioSource) return;
      const src = audioSource;
      const sr = aTrack.sampleRate;
      const ch = aTrack.numberOfChannels;
      const segs = edl.segments;
      // Advance audio by the encoder's priming delay (the muxer writes no edit list for it), then
      // pad the same amount of silence at the end so the track length still matches the video.
      const codecString = container === 'mp4' ? 'mp4a.40.2' : 'opus';
      let skip = await measureEncoderDelay(codecString, container === 'mp4' ? sr : 48000, ch).catch(() => 0);
      if (container === 'webm') skip = Math.round((skip * sr) / 48000);
      const delayFrames = skip;
      let written = 0;
      const assembler = new AudioAssembler(segs, {
        sampleRate: sr,
        channels: ch,
        fadeSec: settings.fadeMs / 1000,
        emit: async (rawPlanes) => {
          if (cancelled) throw new Cancelled();
          await encode(stretcher.push(rawPlanes));
        },
      });
      // Whole-video speed: time-stretch the assembled audio, pitch preserved.
      const stretcher = new TimeStretcher(sr, ch, edl.globalSpeed);
      async function encode(input: Float32Array[]) {
          let planes = input;
          if (planes[0].length === 0) return;
          if (skip > 0) {
            const drop = Math.min(skip, planes[0].length);
            planes = planes.map((p) => p.subarray(drop));
            skip -= drop;
            if (planes[0].length === 0) return;
          }
          const offset = written;
          written += planes[0].length;
          const n = planes[0].length;
          const data = new Float32Array(n * ch);
          planes.forEach((p, c) => data.set(p, c * n));
          const s = new AudioSample({
            data,
            format: 'f32-planar',
            numberOfChannels: ch,
            sampleRate: sr,
            timestamp: offset / sr,
          });
          await src.add(s);
          s.close();
      }
      const sink = new AudioSampleSink(aTrack);
      const first = segs[0]?.srcStart ?? 0;
      const last = segs[segs.length - 1]?.srcEnd ?? 0;
      for await (const sample of sink.samples(first, last)) {
        try {
          if (cancelled) throw new Cancelled();
          const n = sample.numberOfFrames;
          const planes: Float32Array[] = [];
          for (let c = 0; c < ch; c++) {
            const p = new Float32Array(n);
            sample.copyTo(p, { planeIndex: Math.min(c, sample.numberOfChannels - 1), format: 'f32-planar' });
            planes.push(p);
          }
          await assembler.push(planes, Math.round(sample.timestamp * sr));
          progress.audio = Math.min(1, (sample.timestamp - first) / Math.max(1e-6, last - first));
          report('audio');
        } finally {
          sample.close();
        }
      }
      await assembler.finish();
      await encode(stretcher.flush());
      if (delayFrames > 0) {
        const pad = new Float32Array(delayFrames * ch);
        const s = new AudioSample({ data: pad, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: written / sr });
        await src.add(s);
        s.close();
      }
      progress.audio = 1;
      src.close();
    };

    await Promise.all([videoJob(), audioJob()]);
    await output.finalize();
    handle.flush();
    const sizeBytes = handle.getSize();
    handle.close();
    handle = null;
    input.dispose();
    post({
      type: 'done',
      opfsName: `${opfsName}.${container}`,
      mime: container === 'mp4' ? 'video/mp4' : 'video/webm',
      size: sizeBytes,
      container,
      note: container === 'webm' ? 'AAC encoding is not supported in this browser, so the export is WebM (VP9 + Opus).' : undefined,
    });
  } catch (err) {
    try {
      await output?.cancel();
    } catch {
      /* already failed */
    }
    handle?.close();
    await root.removeEntry(`${opfsName}.mp4`).catch(() => {});
    await root.removeEntry(`${opfsName}.webm`).catch(() => {});
    if (err instanceof Cancelled || cancelled) post({ type: 'cancelled' });
    else post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
}
