import type { VideoActivityRaw } from '../core/activity';
import type { FrameData } from '../core/frameData';
import type { AudioAnalysis } from '../core/silence';
import type { EDL } from '../core/edl';
import type { ExportSettings } from '../core/settings';
import type { CaptionSettings } from '../core/captions';
import type { ZoomSettings } from '../core/zoom';

export interface SourceMeta {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  audioCodec: string | null;
  videoCodec: string | null;
  sampleRate: number;
  channels: number;
}

export type AnalyzeAudioOut =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; audio: AudioAnalysis | null; pcm?: PcmRef }
  | { type: 'error'; message: string };

/** OPFS file holding the 16 kHz mono PCM (Float32 LE) for the transcription worker. */
export const pcmFileName = (key: string) => `pcm16k-${key}.f32`;

/** 16 kHz mono Float32 PCM in OPFS, written by the audio analysis worker. */
export interface PcmRef {
  name: string;
  samples: number;
  sampleRate: number;
}

export type AnalyzeVideoOut =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; activity: VideoActivityRaw; frameData: FrameData }
  | { type: 'error'; message: string };

export interface ExportIn {
  type: 'start';
  file: File;
  edl: EDL;
  settings: ExportSettings;
  fileName: string;
  /** Captions to burn in (source time), or null for none. */
  captionStyle: CaptionSettings | null;
  zoom: ZoomSettings;
}

export type ExportOut =
  | { type: 'progress'; phase: 'video' | 'audio'; fraction: number; framesOut: number }
  | { type: 'done'; opfsName: string; mime: string; size: number; container: 'mp4' | 'webm'; note?: string }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
