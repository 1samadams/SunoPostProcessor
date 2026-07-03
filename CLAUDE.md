# CLAUDE.md — Suno Post-Processor

## What this tool does
Batch/single-file post-processing for WAV exports from Suno AI, targeting three
specific, well-understood problems with AI-generated mixes:

1. **Dynamic de-harshing (3–6 kHz)** — Suno exports carry resonant buildup in
   this band from generation/encoding artifacts. Reads as metallic/digital,
   worst on cymbals and vocal sibilants. Must be a **dynamic** cut (only
   engages when the band actually spikes), not a static EQ notch — static
   cuts dull the whole track.
2. **Low-mid mud (200–400 Hz)** — static, gentle, wide-Q cut. 1–2 dB. Never
   more than 3 dB (throws away warmth). No dynamics needed here.
3. **Loudness normalization** — Suno exports land anywhere from -9 to -16
   LUFS integrated, inconsistently. Target: **-14 LUFS integrated, -1 dBTP
   true-peak ceiling** (Spotify's normalization target). This is
   normalization, not limiting-for-loudness — the point is consistency, not
   crushing the track.

Processing order matters: **de-harsh → mud cut → loudness normalize**.
Normalizing before EQ means your gain staging is wrong by the time you EQ;
always fix the spectral issues first, then set final level last.

## Architecture decisions (don't relitigate these without reason)

- **Language:** Python. `pyloudnorm` (ITU-R BS.1770) is the only mature,
  correct-by-default LUFS implementation readily available — don't hand-roll
  loudness measurement.
- **Interface:** Web app (Flask + gunicorn), deployable on Railway. This was
  originally speced as a Tkinter + matplotlib desktop GUI; the user explicitly
  asked to reconsider so the tool can be deployed and used from anywhere (a
  desktop GUI can't run on a headless host like Railway). Flask stays a *thin
  wrapper* over the DSP core, exactly like the CLI — the DSP core is unchanged
  by this pivot. Chosen over FastAPI/Electron/JS-SPA because Flask + gunicorn
  is the conventional, zero-packaging-headache Railway Python path and keeps
  the dependency set small. Plots (Phase 2) render server-side with matplotlib
  to PNG and embed in the page — no JS charting dependency.
- **Deployment:** Railway via Nixpacks. `Procfile` + `railway.json` define the
  gunicorn start command and a `/health` liveness probe; `nixpacks.toml` pins
  `libsndfile1` so `soundfile` loads on the minimal image. Runs anywhere
  gunicorn does (Railway, Render, Fly, a plain box) — nothing is
  Railway-specific except the config filenames.
- **True peak detection:** true peak ≠ sample peak. Must oversample (4x
  minimum, per ITU-R BS.1770 Annex 2) before peak-detecting, or the -1 dBTP
  ceiling will be wrong and you'll get inter-sample clipping on streaming
  platforms that don't oversample on playback.
- **Dynamic EQ implementation:** bandpass filter the 3–6 kHz region →
  envelope follower (RMS or peak, ~5–15ms attack, ~80–150ms release) →
  threshold/ratio-based gain reduction curve → apply reduction back onto that
  band only → sum with the rest of the spectrum. This is a single-band
  downward compressor sidechained to its own filtered signal, not a
  multiband compressor split across the whole spectrum — don't over-build it.
- **De-harsh threshold is a PERCENTILE of the band envelope, not a level
  relative to its peak.** This matters: an early version referenced the
  threshold to the band's *peak* (`peak − N dB`), which on dense/steady Suno
  material (band sits within a few dB of its peak almost constantly) engaged
  ~100% of the time — a static shelf that dulled the whole top end, the exact
  failure the "must be dynamic" rule exists to prevent. Referencing a high
  percentile of the envelope's own distribution means only the loudest few %
  (the actual spikes) cross the threshold; steady content near the median is
  left alone. It is self-calibrating and level-independent (percentile of the
  track's own band), which is what "relative" needs to mean here.

## Presets (dynamic EQ / step 1)

Four presets, not six — more choices here just recreates the manual-plugin
decision fatigue this tool exists to avoid.

Threshold is a **percentile** of the 3–6 kHz band envelope (see architecture
note above): the preset picks how much of the band's loudest content gets
compressed.

| Preset     | Threshold (pctl) | Grabs loudest | Ratio | Notes                        |
|------------|------------------|---------------|-------|------------------------------|
| Off        | —                | —             | —     | bypass, still mud + loudness |
| Gentle     | 96th             | ~4%           | 2:1   | mild resonance               |
| Standard   | 91st             | ~9%           | 3:1   | default                      |
| Aggressive | 84th             | ~16%          | 5:1   | heavy cymbal wash / sibilance|

Plus a single **Intensity slider (0–150%)** that scales the active preset —
lower percentile (grabs more of the band) and higher ratio — so borderline
tracks aren't stuck between two presets. The **Advanced** panel exposes the
percentile ("Sensitivity") and ratio directly for ear-tuning.

**Important:** these percentile/ratio numbers are starting points, not gospel.
They need tuning by ear against real Suno exports before trusting "Standard"
as a true default — treat the table as the first draft to test.

## Web UI requirements

Same functional requirements as before — only "file picker" becomes "file
upload" and the surface is a browser page instead of a Tkinter window:

- File upload (single file or multi-file/batch)
- Preset dropdown + intensity slider for step 1
- Steps 2 & 3 run automatically, no user tuning surfaced (per user's spec —
  don't add controls for these unless asked)
- Before/after plots: frequency spectrum (so the 3–6kHz reduction and mud cut
  are visible) and a loudness meter showing input LUFS → output LUFS with the
  -14 LUFS / -1 dBTP target marked. Rendered server-side (matplotlib → PNG),
  embedded in the response page.
- Batch mode should show per-file results in a simple table (filename, input
  LUFS, output LUFS, peak reduction applied)

**Current state:** the interactive tuning UI is built (`app.py` +
`templates/index.html` + `static/`). Upload once, then everything previews
off short **10 / 15 / 30 s** clips with a start-position scrubber:

- Preset segmented control + intensity slider, plus a collapsible **Advanced**
  panel that hand-tunes threshold & ratio directly (this is the ear-tuning
  surface — kept behind a disclosure so the default view stays at 4 presets,
  no decision fatigue). Steps 2 & 3 stay automatic, no controls.
- **Gapless A/B**: original and processed clips play in sync; a toggle gates
  which you hear. The original is level-matched (same loudness gain + ceiling,
  no EQ) so the A/B is honest — only the de-harsh/mud differ, not level.
- Live before/after **spectrum** (server-computed magnitudes drawn on a canvas)
  with the 3–6 kHz and 200–400 Hz bands highlighted, plus a LUFS / true-peak /
  de-harsh-Δband readout.
- **Process full track** commit → download, using the tuned settings.

Preview correctness: the de-harsh band reference and loudness gain are measured
once on the whole track at upload and reused for every preview segment, so a
clip sounds like its slice of the final render.

Still **Phase 2/3 TODO:** batch/multi-file upload + results table, and saved
settings between runs.

## Code style / conventions
- Keep the DSP core (de-harsh, mud cut, loudness normalize) as pure functions
  operating on numpy arrays, fully decoupled from the interface layer. The web
  app (and the CLI) should be thin wrappers — this is what makes the CLI, the
  web app, and any future batch mode share one implementation without
  duplicating logic. `dsp.py` imports nothing from `app.py`; the dependency
  only ever points inward.
- Write one small test/validation script that processes a known WAV and
  prints before/after LUFS and true peak, so DSP changes can be sanity-checked
  without opening the web app (`test_dsp.py`, incl. `--selftest`).
- No exotic dependencies beyond: numpy, scipy, pyloudnorm, matplotlib,
  soundfile (for WAV I/O — better format handling than scipy.io.wavfile),
  plus flask + gunicorn for the web/deploy layer.

## Known open questions (flag these back to the user, don't silently decide)
- Exact threshold/ratio values per preset need ear-tuning against real
  exports — treat current values as placeholders.
- Whether envelope follower should be peak or RMS-based may need A/B testing
  on actual cymbal-heavy vs vocal-heavy tracks.
- **De-harsh band is fixed at 3–6 kHz, but measured real "air"/sibilance
  harshness often sits higher (6–10 kHz+).** If ear-testing shows the sizzle
  lives above 6 kHz, revisit the band (widen or shift up) — don't change it
  silently; it's an architecture decision. The band edges auto-clamp under
  Nyquist so low-sr files don't crash (de-harsh just narrows/bypasses).
- **Loudness on high-crest material lands slightly under −14 LUFS** (~0.5 dB on
  very peaky tracks) because the true-peak ceiling is honoured without
  crushing transients. This is the intended "normalize, don't limit-for-
  loudness" tradeoff (CLAUDE.md step 3) — hitting −14 exactly on those tracks
  would require aggressive limiting we deliberately avoid. The commit screen
  shows the actual output LUFS so it's never silent about a miss.
- Batch mode UX (process-then-review vs review-each-file) — ask before
  building the more complex version. (Single-file preview/tuning is built;
  batch is not yet.)
- Preview clips use short segments (10/15/30 s) with a whole-track reference
  for the de-harsh threshold and loudness gain. The reference is measured once
  at upload; if a track's character varies a lot across its length, the ideal
  preview start point is wherever the harshness actually lives — hence the
  start scrubber.
