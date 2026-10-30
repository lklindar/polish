# Polish

One-click premium screen recordings, entirely in the browser. No server, no upload.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest unit tests (synthetic fixtures)
npm run build      # typecheck + production build into dist/
```

Requires current desktop Chrome or Edge (WebCodecs, OPFS). The dev server and `vercel.json` /
`public/_headers` send COOP/COEP so the page is cross-origin isolated.

### Dev helpers (dev server only, never in a build)

- `http://localhost:5173/?src=/.dev-media/sample.mp4` preloads a file without the picker.
  `.dev-media/` is git-ignored; symlink your test recordings there.
- `window.__polish.useStore` and `window.__player` are available in the console.
- `POST /__dev/save?name=x.mp4` writes the request body to `.dev-media/x.mp4` so exports can be
  inspected with `ffprobe`.

## Status

| Milestone | State |
|---|---|
| 1. Scaffold, import, Mediabunny decode, preview player, waveform timeline | ✅ |
| 2. Silence detection, EDL, real-time cut preview, MP4 export (cuts only) | ✅ |
| 3. Whisper worker, fillers (transcript + acoustic), review UI, captions | ✅ |
| 4. Frame analysis: webcam/content rect, cursor, clicks, zoom track + WebGL renderer | next |
| 5. Audio polish chain, music ducking, global speed | |
| 6. One-click flow with all steps, Before/After, full edit report | partially (flow + toggle + report exist) |
| 7. Transcript editing, chapters, vertical export, intro/outro, styling | |
| 8. Performance pass, deploy, docs | partially (headers, README) |

## What to test

**M1–M2: silences, preview, export**
1. Drop a recording and click **✨ Make it Premium**. Steps: reading → audio → transcribing (runs
   alongside the screen scan) → building. Reopening the same file uses the IndexedDB cache and
   restores your autosaved edit.
2. **Preview.** Space plays the edited cut. Cuts are skipped seamlessly, a `⏩ 3×` badge shows on
   sped-up busy pauses, and **Before/After** switches to the untouched source.
3. **Timeline.** ⌘/Ctrl + scroll zooms; click the ruler to scrub. Click an edit chip to select it;
   double-click toggles it. Drag on the waveform and press Del to add a manual cut. ⌘Z / ⇧⌘Z
   undo and redo.
4. **Export.** Progress, ETA, memory and Cancel. You get an MP4 (H.264 High + AAC) plus the edit
   report, `.srt` and transcript.

**M3: transcript, fillers, captions**
1. The first run downloads whisper-base (~200 MB; cached in Cache Storage afterwards).
   Edit → Transcription switches to whisper-small or a fixed language. That re-transcribes in the
   background and caches per model.
2. **Review tab.** Every filler with a confidence bar. Click a row to hear it in the original
   (0.6 s of context either side); the checkbox keeps or removes it. Yellow chips on the timeline
   do the same. Choices you make survive changes to the sliders. Possible retakes (a phrase said
   again within 10 s) are listed with **Cut first take**; they're never cut automatically.
3. **Edit → Fillers.** The confidence threshold, the acoustic detector, and the editable lexicons
   (`um` also matches `ummm`; "maybe-fillers" like *gitu* / *apa ya* are listed for review but
   not cut).
4. **Transcript tab.** Caption lines in output time, following playback. Double-click to edit:
   edits rewrite the underlying words, so they survive re-planning.
5. **Captions.** Shown in the After preview with the current word highlighted, and burned into
   the export (toggle in Edit → Captions: chars/line, lines, size, highlight). The `.srt` always
   downloads.

## Measured on the sample (17.6 min, 1662×1080, M-series Mac)

- **Analysis:** about 95 s cold with the model cached (audio 20 s → transcription 74 s on WebGPU,
  running alongside the 45 s screen scan); 131 s including the one-time model download. 0.2 s
  when cached.
- **Removed:** 58 s (**5.5%**): 44 silences (≈30 s) plus 81 fillers (≈27 s), and 16 busy pauses
  sped up. This speaker barely pauses (pauses of 0.6 s or more total about 4% of the file), so
  the 20–35% target isn't reachable on this recording without cutting speech.
- **Fillers:** with the disfluent prompt Whisper keeps them: 79 "um"/"uh" transcribed.
  Median filler cut is 0.34 s.
- **Filler boundaries:** each one is placed from the waveform, because Whisper's word times are
  off by up to ~±130 ms: anchor on the filler's own vowel, extend within 6 dB, allow a nasal tail
  for "um" until the next word rises, and use Whisper's span only to choose which loud run is the
  filler.
- **No clipped words:** the export was re-transcribed and compared word-by-word with the source
  transcript minus cuts (similarity 0.956). Every real word missing near a cut was checked on the
  waveform; each time the cut was clear of the word and the difference was ASR variance. Three
  boundary bugs found this way ("uh, master", "um, what", "throoough, uh") are fixed and covered
  by regression tests built from the measured levels.
- **Skipped speech:** Whisper occasionally skips a passage. Chunks with ≥ 2.5 s of uncovered
  speech are re-decoded without the prompt (2 of 55 on the sample, recovering 61 words). The
  acoustic detector only flags sounds that have transcribed words on both sides, so a skipped
  passage can't be mistaken for fillers.
- **Export:** 2 m 16 s for 16.6 min with burned-in captions. Memory flat (14–16 MB page heap).
  A/V sync exact (after compensating the AAC encoder's 2112-sample priming delay).

## Known issues

- Captions are bottom-centred and can overlap the webcam bubble (sample: bottom-left). Webcam
  detection in M4 will steer them clear.
- Language "Auto" detects once, on the first chunk (English vs Indonesian); mixed speech is then
  decoded with that language token. Pick a language explicitly if the opening isn't typical.
- The acoustic detector is conservative: on the sample only 2 of its candidates clear the default
  0.6 confidence; the rest are listed in Review.
- Bright areas export about 1% darker than the source (canvas RGB round-trip). This will be fixed
  when export moves to the WebGL renderer in M4.
- `measureUserAgentSpecificMemory` falls back to the page heap in some contexts, so the memory
  readout may not include the export worker's heap or native frame memory.
- Global speed (1.1× / 1.25×) is implemented in the EDL and preview but not yet exposed in the UI;
  pitch-preserving export audio lands in M5.
