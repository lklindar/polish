# Polish — architecture

Browser-only. No server, no upload. Everything below runs in the user's tab.

## Data flow

```
File ──► hash (first+last 4 MB + size) ──► IndexedDB cache hit? ──yes──► Analysis
  │                                                   │no
  ├─► analyze-audio.worker  (Mediabunny AudioSampleSink, streamed)
  │      20 ms RMS/peak · voicing/pitch/flux · 16 kHz PCM → OPFS file
  ├─► analyze-video.worker  (Mediabunny VideoSampleSink, streamed, low-res)
  │      per-cell frame diff → visual activity  ·  later: webcam/content rect, cursor, clicks
  └─► whisper.worker         (transformers.js, WebGPU → WASM; reads PCM chunks from OPFS,
                              pause-aligned ≤ 28 s, disfluent prompt, word DTW on non-prompt rows)
                 │
                 ▼
          Analysis (cached)  ──► pure detectors in src/core (silence, fillers, clicks→zooms)
                 │                    (re-run instantly when a setting changes)
                 ▼
                EDL  ◄──── timeline / transcript / settings edits (Zustand, 200-step undo)
                 │
     ┌───────────┴─────────────┐
 Preview (EdlPlayer)        Export (export.worker)
 two <video> elements,      one linear decode pass → render (2D now, WebGL2 at M4)
 ping-pong pre-seek,        → VideoEncoder (avc1.6400xx, HW) ┐
 canvas compositor          audio: linear decode → segment   ├─► Mediabunny MP4 → OPFS file
                            assembler (fades, speed) → AAC   ┘    (memory stays flat)
```

Design rules:

- **Nothing re-encodes before Export.** Every analysis output is cached raw data; every edit is a
  change to the EDL.
- **Streaming everywhere.** Decoded frames and audio chunks are closed as soon as they're consumed.
  Export writes to an OPFS file through `StreamTarget`, so a 1.5 GB output never sits in RAM.
- **Detectors are pure functions** in `src/core`, unit-tested against synthetic fixtures, with no
  DOM or WebCodecs dependency.
- **Source-time timeline.** The timeline shows the full source with cuts overlaid, as Descript and
  Screen Studio do. `srcToOut` / `outToSrc` in `edl.ts` convert between source and output time.

## File structure

```
polish/
├─ index.html · vite.config.ts · vercel.json · public/_headers   (COOP/COEP)
├─ src/
│  ├─ main.tsx · index.css
│  ├─ core/                 pure logic, unit-tested
│  │  ├─ edl.ts             EDL types, buildSegments, srcToOut/outToSrc
│  │  ├─ silence.ts         frame energy, adaptive threshold + hysteresis, cut/speed-up planning
│  │  ├─ audioAssembler.ts  segment → output PCM (fades at cuts, speed-ups)
│  │  ├─ settings.ts        settings schema + presets (Clean / Premium / Snappy)
│  │  ├─ capabilities.ts · hash.ts · db.ts · format.ts
│  ├─ workers/
│  │  ├─ protocol.ts        typed worker messages
│  │  ├─ analyzeAudio.worker.ts
│  │  ├─ analyzeVideo.worker.ts
│  │  └─ export.worker.ts
│  ├─ player/EdlPlayer.ts   dual-video real-time EDL playback + canvas compositor
│  ├─ state/store.ts        Zustand store, undo/redo, autosave
│  └─ ui/                   StartScreen, Editor, Preview, Timeline, SettingsPanel, ExportPanel …
└─ tests/                   Vitest, synthetic fixtures
```

M3 added `core/transcript.ts` (chunking, token→word, coverage), `core/fillers.ts` (lexicon +
acoustic detectors, waveform-based boundary refinement, retake finder), `core/captions.ts` /
`core/captionRender.ts` (layout, SRT, shared preview/export drawing), `core/resample.ts`,
`core/audioFeatures.ts` and `workers/whisper.worker.ts`.

Captions are derived, not stored: `transcript.words` (in the EDL) minus enabled cuts → caption
lines. Editing a caption rewrites the words, so edits survive any re-plan.

Later milestones add `core/clicks.ts`, `core/zoom.ts`, `render/gl.ts` (WebGL2 compositor for
preview and export) and `audio/polish.ts` (RNNoise + filter chain + LUFS).

## Notes on the sample file

- The keyframe interval is 10 s, so seeking a single `<video>` is slow. The preview therefore uses
  two `<video>` elements: one plays while the other pre-seeks to the next kept segment.
- Source integrated loudness is −34.2 LUFS (measured with ffmpeg ebur128). Normalizing to −16 LUFS
  takes about +18 dB of gain, so denoising has to run before that gain (M5).
- The webcam bubble moves and changes size (it is large in some parts and small in others). The
  visual-activity measure masks cells that are always moving, so the talking head doesn't count as
  "screen activity".
