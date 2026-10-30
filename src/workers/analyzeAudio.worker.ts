// Streams the audio track once: 20 ms energy frames, voicing/pitch/flux features, and a 16 kHz mono
// PCM copy written to OPFS for transcription. No full PCM is held in memory.

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { FEATURE_RATE, FeatureExtractor } from '../core/audioFeatures';
import { StreamResampler } from '../core/resample';
import { FRAME_SEC } from '../core/silence';
import { pcmFileName, type AnalyzeAudioOut } from './protocol';

const post = (m: AnalyzeAudioOut, transfer: Transferable[] = []) => postMessage(m, { transfer });

self.onmessage = async (e: MessageEvent<{ file: File; key: string }>) => {
  let pcmHandle: FileSystemSyncAccessHandle | null = null;
  try {
    const input = new Input({ source: new BlobSource(e.data.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      post({ type: 'done', audio: null });
      return;
    }
    const duration = await input.computeDuration();
    const sr = track.sampleRate;
    const channels = track.numberOfChannels;
    const frameLen = Math.round(FRAME_SEC * sr);
    const nFrames = Math.ceil((duration * sr) / frameLen) + 1;
    const sumsq = new Float64Array(nFrames);
    const counts = new Uint32Array(nFrames);
    const peak = new Float32Array(nFrames);

    const voicing = new Float32Array(nFrames);
    const f0 = new Float32Array(nFrames);
    const flux = new Float32Array(nFrames);
    const features = new FeatureExtractor((i, f) => {
      if (i >= nFrames) return;
      voicing[i] = f.voicing;
      f0[i] = f.f0;
      flux[i] = f.flux;
    });
    const resampler = new StreamResampler(sr, FEATURE_RATE);
    const root = await navigator.storage.getDirectory();
    const pcmFile = await root.getFileHandle(pcmFileName(e.data.key), { create: true });
    pcmHandle = await pcmFile.createSyncAccessHandle();
    pcmHandle.truncate(0);
    let pcmBytes = 0;
    const emit16k = (x: Float32Array) => {
      if (!x.length) return;
      features.push(x);
      pcmHandle!.write(x, { at: pcmBytes });
      pcmBytes += x.byteLength;
    };
    let expected16k = 0; // keeps the 16 kHz stream aligned to sample timestamps across gaps

    const sink = new AudioSampleSink(track);
    let plane = new Float32Array(0);
    let mono = new Float32Array(0);
    let lastPost = 0;
    for await (const sample of sink.samples()) {
      const n = sample.numberOfFrames;
      if (mono.length < n) {
        mono = new Float32Array(n);
        plane = new Float32Array(n);
      }
      mono.fill(0, 0, n);
      for (let c = 0; c < sample.numberOfChannels; c++) {
        sample.copyTo(plane, { planeIndex: c, format: 'f32-planar', frameCount: n });
        for (let i = 0; i < n; i++) mono[i] += plane[i] / sample.numberOfChannels;
      }
      const startIdx = Math.round(Math.max(0, sample.timestamp) * sr);
      const ts = sample.timestamp;
      sample.close();
      // Fill any timestamp gap with silence so 16 kHz index = time × 16000.
      const want16k = Math.round((startIdx / sr) * FEATURE_RATE);
      if (want16k > expected16k + 160) {
        emit16k(resampler.push(new Float32Array(Math.round(((want16k - expected16k) * sr) / FEATURE_RATE))));
      }
      const out16 = resampler.push(mono.subarray(0, n));
      emit16k(out16);
      expected16k = pcmBytes / 4;
      for (let i = 0; i < n; i++) {
        const f = Math.floor((startIdx + i) / frameLen);
        if (f >= nFrames) break;
        const v = mono[i];
        sumsq[f] += v * v;
        counts[f]++;
        const a = v < 0 ? -v : v;
        if (a > peak[f]) peak[f] = a;
      }
      const now = performance.now();
      if (now - lastPost > 200) {
        lastPost = now;
        post({ type: 'progress', fraction: Math.min(1, ts / duration) });
      }
    }

    emit16k(resampler.flush());
    features.push(new Float32Array(640)); // let the last frames see a full window
    pcmHandle.flush();
    pcmHandle.close();
    pcmHandle = null;

    const used = Math.min(nFrames, Math.ceil((duration * sr) / frameLen));
    const rms = new Float32Array(used);
    for (let f = 0; f < used; f++) rms[f] = counts[f] ? Math.sqrt(sumsq[f] / counts[f]) : 0;
    const pk = peak.slice(0, used);
    const vo = voicing.slice(0, used);
    const pf = f0.slice(0, used);
    const fx = flux.slice(0, used);
    input.dispose();
    post(
      {
        type: 'done',
        audio: { frameSec: FRAME_SEC, rms, peak: pk, sampleRate: sr, channels, voicing: vo, f0: pf, flux: fx },
        pcm: { name: pcmFileName(e.data.key), samples: pcmBytes / 4, sampleRate: FEATURE_RATE },
      },
      [rms.buffer, pk.buffer, vo.buffer, pf.buffer, fx.buffer],
    );
  } catch (err) {
    pcmHandle?.close();
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
