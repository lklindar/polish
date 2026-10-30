// Measures an audio encoder's priming delay by round-tripping an impulse through
// AudioEncoder → AudioDecoder. Apple's AAC encoder adds 2112 samples (≈48 ms at 44.1 kHz) and the
// muxed MP4 carries no edit list for it, so without compensation audio plays late everywhere.

export async function measureEncoderDelay(codec: string, sampleRate: number, channels: number): Promise<number> {
  const len = Math.round(sampleRate * 0.5);
  const at = Math.round(sampleRate * 0.1);
  const pcm = new Float32Array(len * channels);
  for (let c = 0; c < channels; c++) pcm[c * len + at] = 0.9;

  const chunks: EncodedAudioChunk[] = [];
  let decoderConfig: AudioDecoderConfig | undefined;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: () => {},
  });
  enc.configure({ codec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });
  // Feed in 1024-frame blocks, then trailing silence so the impulse is flushed out.
  const block = 1024;
  const total = len + sampleRate * 0.2;
  for (let i = 0; i < total; i += block) {
    const data = new Float32Array(block * channels);
    for (let c = 0; c < channels; c++) {
      for (let j = 0; j < block && i + j < len; j++) data[c * block + j] = pcm[c * len + i + j];
    }
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: block, numberOfChannels: channels, timestamp: (i / sampleRate) * 1e6, data });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (!decoderConfig) return 0;

  const decoded: number[] = [];
  const dec = new AudioDecoder({
    output: (ad) => {
      const p = new Float32Array(ad.numberOfFrames);
      ad.copyTo(p, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(...p);
      ad.close();
    },
    error: () => {},
  });
  dec.configure(decoderConfig);
  chunks.forEach((c) => dec.decode(c));
  await dec.flush();
  dec.close();

  let peak = 0;
  let idx = at;
  decoded.forEach((v, i) => {
    if (Math.abs(v) > peak) {
      peak = Math.abs(v);
      idx = i;
    }
  });
  return Math.max(0, idx - at);
}
