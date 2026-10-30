// Whisper transcription with word timestamps (transformers.js v3). WebGPU when available, WASM
// otherwise; the model is cached in Cache Storage by transformers.js.
//
// Two things the stock pipeline can't do, so we drive model.generate directly:
//  - a disfluent text prompt (<|startofprev|> …), which makes Whisper keep "um"/"uh";
//  - word timestamps with that prompt: the stock DTW would include the prompt tokens' cross-
//    attention rows, so we patch the extractor to align only the transcribed tokens.

import {
  AutoProcessor,
  AutoTokenizer,
  Tensor,
  WhisperForConditionalGeneration,
  cat,
  dynamic_time_warping,
  env,
  mean,
  medianFilter,
  stack,
  std_mean,
  type PreTrainedTokenizer,
  type Processor,
} from '@huggingface/transformers';
import { cleanChunkWords, tokensToWords, uncoveredSpeech, type Chunk, type Word } from '../core/transcript';
import type { PcmRef } from './protocol';

env.allowLocalModels = false;
env.useBrowserCache = true;

export type WhisperIn = {
  type: 'start';
  pcm: PcmRef;
  chunks: Chunk[];
  /** Detected pauses, used to notice when Whisper skipped speech. */
  pauses: Chunk[];
  model: 'base' | 'small';
  language: 'auto' | 'en' | 'id';
  prompt: string;
  preferWebGpu: boolean;
};

export type WhisperOut =
  | { type: 'download'; loaded: number; total: number }
  | { type: 'progress'; fraction: number; words: Word[]; device: string }
  | { type: 'done'; words: Word[]; language: string; device: string; model: string; retries: number }
  | { type: 'error'; message: string };

const post = (m: WhisperOut) => postMessage(m);

type Model = WhisperForConditionalGeneration & {
  generation_config: Record<string, unknown> & {
    lang_to_id: Record<string, number>;
    task_to_id: Record<string, number>;
    no_timestamps_token_id: number;
    decoder_start_token_id: number;
    alignment_heads: number[][];
  };
  config: { decoder_layers: number; median_filter_width?: number };
  _extract_token_timestamps: (outputs: unknown, heads: number[][], numFrames?: number) => Tensor;
};

async function load(modelSize: string, device: 'webgpu' | 'wasm') {
  const id = `onnx-community/whisper-${modelSize}_timestamped`;
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let loaded = 0;
      let total = 0;
      files.forEach((f) => {
        loaded += f.loaded;
        total += f.total;
      });
      post({ type: 'download', loaded, total });
    }
  };
  const dtype =
    device === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' };
  const [model, processor, tokenizer] = await Promise.all([
    WhisperForConditionalGeneration.from_pretrained(id, { device, dtype, progress_callback } as never) as Promise<Model>,
    AutoProcessor.from_pretrained(id, { progress_callback } as never),
    AutoTokenizer.from_pretrained(id, { progress_callback } as never),
  ]);
  return { model: model as Model, processor, tokenizer };
}

/** Tensors support `t[i]` (sub-tensor) at runtime via a proxy; the typings don't say so. */
const ix = (t: Tensor) => t as Tensor & Record<number, Tensor>;

/** DTW over cross-attention rows from `rowStart` on (the prompt rows are excluded). */
function extractTimestamps(model: Model, outputs: { cross_attentions: Tensor[][]; sequences: Tensor }, heads: number[][], numFrames: number, rowStart: number): Tensor {
  const medianWidth = model.config.median_filter_width ?? 7;
  const steps = outputs.cross_attentions;
  const layers = Array.from({ length: model.config.decoder_layers }, (_, i) => cat(steps.map((x) => x[i]), 2));
  const rows = layers[0].dims[2];
  const weights = stack(
    heads.map(([l, h]) => layers[l].slice(null, h, [rowStart, rows], [0, numFrames])),
  ).transpose(1, 0, 2, 3);
  const [std, avg] = std_mean(weights, -2, 0, true);
  const smoothed = weights.clone();
  for (let a = 0; a < smoothed.dims[0]; ++a) {
    const at = ix(smoothed)[a];
    for (let b = 0; b < at.dims[0]; ++b) {
      const bt = ix(at)[b];
      const sd = ix(ix(ix(std)[a])[b])[0].data as Float32Array;
      const mu = ix(ix(ix(avg)[a])[b])[0].data as Float32Array;
      for (let c = 0; c < bt.dims[0]; ++c) {
        const d = ix(bt)[c].data as Float32Array;
        for (let k = 0; k < d.length; ++k) d[k] = (d[k] - mu[k]) / sd[k];
        d.set(medianFilter(d, medianWidth));
      }
    }
  }
  const matrix = mean(smoothed, 1).neg().squeeze_(0);
  const [textIdx, timeIdx] = dynamic_time_warping(matrix.tolist() as number[][]);
  const jumps: number[] = [];
  for (let i = 0; i < textIdx.length; i++) if (i === 0 || textIdx[i] !== textIdx[i - 1]) jumps.push(timeIdx[i] * 0.02);
  const dims = outputs.sequences.dims;
  const ts = new Tensor('float32', new Float32Array(dims[0] * dims[1]), dims);
  (ix(ts)[0].data as Float32Array).set(jumps.slice(0, dims[1] - rowStart - 1), rowStart + 1);
  return ts;
}

async function detectLanguage(model: Model, features: Tensor, candidates: string[]): Promise<string> {
  const sot = model.generation_config.decoder_start_token_id;
  const out = (await model({
    input_features: features,
    decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]),
  })) as { logits: Tensor };
  const logits = out.logits.data as Float32Array;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const lang of candidates) {
    const id = model.generation_config.lang_to_id[`<|${lang}|>`];
    if (id != null && logits[id] > bestScore) {
      bestScore = logits[id];
      best = lang;
    }
  }
  return best;
}

self.onmessage = async (e: MessageEvent<WhisperIn>) => {
  const msg = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await (await root.getFileHandle(msg.pcm.name)).createSyncAccessHandle();
    const readChunk = (c: Chunk) => {
      const a = Math.max(0, Math.round(c.start * msg.pcm.sampleRate));
      const b = Math.min(msg.pcm.samples, Math.round(c.end * msg.pcm.sampleRate));
      const buf = new Float32Array(Math.max(0, b - a));
      handle.read(buf, { at: a * 4 });
      return buf;
    };

    let device: 'webgpu' | 'wasm' = msg.preferWebGpu ? 'webgpu' : 'wasm';
    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load(msg.model, device);
    } catch (err) {
      if (device !== 'webgpu') throw err;
      console.warn('WebGPU load failed, falling back to WASM', err);
      device = 'wasm';
      loaded = await load(msg.model, device);
    }
    const { model, processor, tokenizer } = loaded as { model: Model; processor: Processor; tokenizer: PreTrainedTokenizer };
    const gc = model.generation_config;
    const tok = (t: string) => tokenizer.model.tokens_to_ids.get(t) as number;
    const promptIds = msg.prompt ? tokenizer.encode(` ${msg.prompt.trim()}`, { add_special_tokens: false }) : [];
    const eot = tok('<|endoftext|>');
    const hop = 160;

    let language = msg.language === 'auto' ? '' : msg.language;
    let retries = 0;
    const all: Word[] = [];
    for (let ci = 0; ci < msg.chunks.length; ci++) {
      const chunk = msg.chunks[ci];
      const audio = readChunk(chunk);
      if (audio.length < 1600) continue;
      const { input_features } = (await processor(audio)) as { input_features: Tensor };

      if (!language) language = await detectLanguage(model, input_features, ['en', 'id']).catch(() => 'en');

      const numFrames = Math.floor(audio.length / hop);
      const decode = async (withPrompt: boolean): Promise<Word[]> => {
        const prefix = [
          ...(withPrompt && promptIds.length ? [tok('<|startofprev|>'), ...promptIds] : []),
          gc.decoder_start_token_id,
          gc.lang_to_id[`<|${language}|>`],
          gc.task_to_id.transcribe,
          gc.no_timestamps_token_id,
        ];
        const rowStart = prefix.length - 4; // first row = <|startoftranscript|>
        model._extract_token_timestamps = (outputs, heads) =>
          extractTimestamps(model, outputs as never, heads, numFrames, rowStart);
        const out = (await model.generate({
          inputs: input_features,
          decoder_input_ids: prefix,
          return_token_timestamps: true,
          num_frames: numFrames,
          max_new_tokens: 444 - prefix.length,
        } as never)) as { sequences: Tensor; token_timestamps: Tensor };
        const ids = (out.sequences.tolist() as bigint[][])[0].map(Number);
        const times = (out.token_timestamps.tolist() as number[][])[0];
        const texts: string[] = [];
        const tts: number[] = [];
        for (let i = prefix.length; i < ids.length; i++) {
          if (ids[i] >= eot) {
            if (ids[i] === eot) tts.push(times[i]);
            continue;
          }
          texts.push(tokenizer.decode([ids[i]], { skip_special_tokens: true }));
          tts.push(times[i]);
        }
        return cleanChunkWords(tokensToWords(texts, tts, chunk.start), chunk);
      };

      // The disfluent prompt keeps fillers, but now and then Whisper stops early or skips a
      // passage. If a lot of speech is left uncovered, retry without the prompt and keep the better.
      let words = await decode(true);
      const missing = uncoveredSpeech(words, chunk, msg.pauses);
      if (missing >= 2.5) {
        retries++;
        const alt = await decode(false);
        if (uncoveredSpeech(alt, chunk, msg.pauses) < missing - 0.5) words = alt;
      }
      all.push(...words);
      post({ type: 'progress', fraction: (ci + 1) / msg.chunks.length, words, device });
    }
    handle.close();
    post({ type: 'done', words: all, language: language || 'en', device, model: msg.model, retries });
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
