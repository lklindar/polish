import { canEncodeAudio, canEncodeVideo } from 'mediabunny';

export interface Capabilities {
  webCodecs: boolean;
  aacEncode: boolean;
  opusEncode: boolean;
  h264Encode: boolean;
  webGpu: boolean;
  crossOriginIsolated: boolean;
  opfs: boolean;
  offscreenCanvas: boolean;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const webCodecs = typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
  const safe = async (p: () => Promise<boolean>) => {
    try {
      return await p();
    } catch {
      return false;
    }
  };
  const [aacEncode, opusEncode, h264Encode] = webCodecs
    ? await Promise.all([
        safe(() => canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 })),
        safe(() => canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 })),
        safe(() => canEncodeVideo('avc', { width: 1920, height: 1080, bitrate: 12e6 })),
      ])
    : [false, false, false];
  let webGpu = false;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) webGpu = await safe(async () => !!(await gpu.requestAdapter()));
  return {
    webCodecs,
    aacEncode,
    opusEncode,
    h264Encode,
    webGpu,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    opfs: typeof navigator.storage?.getDirectory === 'function',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  };
}
