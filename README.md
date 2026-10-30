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
| 4. Frame analysis: webcam/content rect, cursor, clicks, zoom track + WebGL renderer | ✅ |
| 5. Audio polish chain, music ducking, global speed | next |
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

**M4: auto-zoom and captions on/off**
1. **Captions on/off.** Use the **CC** button in the player bar, or the *Captions* checkbox on the
   start screen. Off means no captions in the preview and none burned into the export. The `.srt`
   is still offered in the export dialog.
2. **Auto-zoom.** The **ZOOM** track shows green blocks; the darker ends are the ease-in/out. The
   **CLICKS** track shows every inferred click; brighter yellow means more confident. Play through
   a zoom: the app window's content zooms *inside its own frame*, the background stays put, the
   webcam bubble stays at normal size, and the camera pans between clicks that are close together.
3. **Edit zooms.** Drag a block to move it, drag its edges to resize, press Del to remove it (it
   won't come back on re-plan). Press **Z** to add a zoom at the playhead. With a zoom selected,
   click the picture to choose where it zooms. Edited zooms are marked ✎ and kept when settings
   change.
4. **Edit → Zoom.** Zoom level 1.3–2.5×, the click-confidence threshold, follow-cursor, motion blur
   (pans only) and the click ripple.
5. Captions step sideways, or above, to stay clear of the webcam bubble.

**Tighter edit + speed**
1. **Pauses:** Premium now shortens every pause from 0.35 s down to about 0.2 s (Snappy from
   0.25 s). When an "um" is cut, the pauses on both sides of it close up too, so they don't merge
   into one long gap. Silent-but-busy stretches (page loading, scrolling) are sped up to about
   0.8 s, at up to 12×.
2. **Hesitations:**
   - Drawn-out short words ("the……", "so……", "and……") are trimmed to their first ~0.14 s.
   - Steady "a…"/"uh…" sounds that Whisper leaves out of the transcript are cut when they sit
     between transcribed words.
3. **Repeated words:**
   - Stutters ("the, the", "we can, we can") and false starts are cut automatically, at the
     quietest point before the retake. They appear in orange on the timeline and in Review.
   - Grammatical doubles like "that that" are only listed, not cut.
   - Toggles: Edit → Fillers.
4. **Speed:** use the **1×** menu in the player bar (1×, 1.1×, 1.2×, 1.25×, 1.5×, 1.75×, 2×). It
   applies to both preview and export, and voices keep their pitch (WSOLA time-stretch in the
   export).

**Hover previews**
- Move the mouse over the timeline to see a thumbnail of that moment (like YouTube). It shows
  the time in the edited video and the caption being spoken. Moments that were cut appear greyed
  out, labelled with what was removed.
- Thumbnails (one per second, 240 px) are generated in the background after the editor opens.
  Keyframe thumbnails come first (every ~10 s across the whole video, within seconds), then every
  second fills in (about 45 s for 17 min, 6 MB, cached for next time). Until an exact thumbnail
  exists, the nearest one is shown; with none at all, a hidden video seeks to the frame.

## Measured on the sample (17.6 min, 1662×1080, M-series Mac)

- **Analysis:** about 95 s cold with the model cached (audio 20 s → transcription 74 s on WebGPU,
  running alongside the 45 s screen scan); 131 s including the one-time model download. 0.2 s
  when cached.
- **Removed:** **119 s (11.3%)**, double the earlier 58 s:
  - 189 pause trims;
  - 104 fillers, including 9 dropped "a…" hesitations and 16 trimmed drawn-out words;
  - 5 repeats;
  - 26 busy pauses tightened.

  The re-transcribed export was checked against the source transcript. Every real word missing
  near a cut was inspected on the waveform, and the cut was always clear of the word.
- **Speed 1.5×:**
  - output exactly 1.5000× shorter (15:37 → 10:25);
  - A/V aligned within 10 ms across the whole file;
  - voice pitch unchanged (102.6 Hz vs 103.9 Hz);
  - exported in 1 m 32 s. This speaker barely pauses (pauses of 0.6 s or more total about 4% of the file), so
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
- **Frame analysis** (M4): 75 s for the 17.6 min file at 15 fps, half resolution. Reading the
  decoder's luma plane directly instead of drawing to a canvas made it 2.5× faster. It runs
  alongside transcription.
- **Layout:** window rect found exactly (the source is already styled, so no extra frame is added).
  The webcam bubble is tracked as it moves between bottom-left and bottom-right and changes size.
- **Clicks vs. ground truth.** This recording draws a yellow click highlight, which gave 96 real
  clicks to score against:
  - 72% of real clicks get a zoom (chance level is 30%);
  - 40 of the 81 auto zooms contain a real click;
  - median click-position error is 4 px;
  - no zoom points at the webcam or the background.

  The main source of false zooms is hover tooltips and highlights, which pixel analysis can't
  tell apart from click reactions. Del removes one.
- **Export:** 2 m 16 s for 16.6 min with burned-in captions (2 m 11 s with 85 zooms). Memory flat (14–16 MB page heap).
  A/V sync exact (after compensating the AAC encoder's 2112-sample priming delay).

## Known issues

- Language "Auto" detects once, on the first chunk (English vs Indonesian); mixed speech is then
  decoded with that language token. Pick a language explicitly if the opening isn't typical.
- The acoustic detector is conservative: on the sample only 2 of its candidates clear the default
  0.6 confidence; the rest are listed in Review.
- Auto-zoom is below the 80% target on the sample (72%), and about half the auto zooms are on
  hovers rather than clicks. Ideas to improve this: tell tooltips (dark box below the pointer) apart
  from button reactions, and use pointer-shape templates (arrow → hand) as an extra click hint.
- The area under the webcam bubble is never recorded. Inside a zoom it is filled by extending the
  surrounding content outwards; this is invisible on plain UI but can show faint streaks over busy
  content.
- `measureUserAgentSpecificMemory` falls back to the page heap in some contexts, so the memory
  readout may not include the export worker's heap or native frame memory.
