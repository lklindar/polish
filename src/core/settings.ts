// Settings bundles. A preset is just a full Settings object; users can tweak and save their own.

import type { CaptionSettings } from './captions';
import { DEFAULT_LEXICON, DEFAULT_SOFT_LEXICON, DISFLUENT_PROMPT, type FillerSettings } from './fillers';
import type { ZoomSettings } from './zoom';

export interface SilenceSettings {
  enabled: boolean;
  /** Pauses at least this long are shortened. */
  minSilenceSec: number;
  /** Speech kept on each side of a cut, so a long pause becomes a ~2×padding natural pause. */
  paddingSec: number;
  /** Threshold = floor + ratio·(speech − floor), on adaptive dB percentiles. */
  thresholdRatio: number;
  /** Silent but visually busy (page load, scroll) → speed up instead of cut. */
  speedUpBusy: boolean;
  minSpeed: number;
  maxSpeed: number;
  /** Busy silences are sped up so they last about this long. */
  speedUpTargetSec: number;
  trimDeadAir: boolean;
}

export interface TranscriptionSettings {
  model: 'base' | 'small';
  language: 'auto' | 'en' | 'id';
  prompt: string;
}

export interface ExportSettings {
  resolution: '1080p' | 'source' | '4k';
  bitrateMbps: number;
  fadeMs: number;
}

export interface Settings {
  silence: SilenceSettings;
  fillers: FillerSettings;
  transcription: TranscriptionSettings;
  captions: CaptionSettings;
  zoom: ZoomSettings;
  export: ExportSettings;
}

export type PresetId = 'clean' | 'premium' | 'snappy';

const baseExport: ExportSettings = { resolution: '1080p', bitrateMbps: 12, fadeMs: 15 };
const baseFillers: FillerSettings = {
  enabled: true,
  minConfidence: 0.6,
  lexicon: DEFAULT_LEXICON,
  softLexicon: DEFAULT_SOFT_LEXICON,
  acoustic: true,
  paddingSec: 0.03,
  removeRepeats: true,
  trimHeldWords: true,
};
const baseTranscription: TranscriptionSettings = { model: 'base', language: 'auto', prompt: DISFLUENT_PROMPT };
const baseZoom: ZoomSettings = { enabled: true, scale: 1.8, minConfidence: 0.55, followCursor: true, motionBlur: true, ripple: true };
const baseCaptions: CaptionSettings = { enabled: true, maxCharsPerLine: 42, maxLines: 2, highlightWord: true, size: 0.042 };

export const PRESETS: Record<PresetId, { label: string; blurb: string; settings: Settings }> = {
  clean: {
    label: 'Clean',
    blurb: 'Cut silences and fillers, normalize audio. No zoom.',
    settings: {
      silence: {
        enabled: true,
        minSilenceSec: 0.6,
        paddingSec: 0.12,
        thresholdRatio: 0.35,
        speedUpBusy: false,
        minSpeed: 3,
        maxSpeed: 6,
        speedUpTargetSec: 2,
        trimDeadAir: true,
      },
      fillers: baseFillers,
      transcription: baseTranscription,
      captions: { ...baseCaptions, enabled: false },
      zoom: { ...baseZoom, enabled: false },
      export: baseExport,
    },
  },
  premium: {
    label: 'Premium',
    blurb: 'Everything at moderate strength.',
    settings: {
      silence: {
        enabled: true,
        minSilenceSec: 0.35,
        paddingSec: 0.1,
        thresholdRatio: 0.4,
        speedUpBusy: true,
        minSpeed: 3,
        maxSpeed: 12,
        speedUpTargetSec: 0.8,
        trimDeadAir: true,
      },
      fillers: baseFillers,
      transcription: baseTranscription,
      captions: baseCaptions,
      zoom: baseZoom,
      export: baseExport,
    },
  },
  snappy: {
    label: 'Snappy',
    blurb: 'Tight pauses, faster speed-ups, more zooms. Built for social.',
    settings: {
      silence: {
        enabled: true,
        minSilenceSec: 0.25,
        paddingSec: 0.07,
        thresholdRatio: 0.45,
        speedUpBusy: true,
        minSpeed: 4,
        maxSpeed: 16,
        speedUpTargetSec: 0.5,
        trimDeadAir: true,
      },
      fillers: { ...baseFillers, minConfidence: 0.5 },
      transcription: baseTranscription,
      captions: { ...baseCaptions, maxCharsPerLine: 32, size: 0.05 },
      zoom: { ...baseZoom, scale: 2, minConfidence: 0.45 },
      export: baseExport,
    },
  },
};

export function cloneSettings(s: Settings): Settings {
  return structuredClone(s);
}

/** Output frame size for an export resolution, keeping the source aspect and even dimensions. */
export function outputSize(src: { width: number; height: number }, res: ExportSettings['resolution']) {
  const targetH = res === '4k' ? 2160 : res === '1080p' ? 1080 : src.height;
  const scale = targetH / src.height;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(src.width * scale), height: even(targetH) };
}
