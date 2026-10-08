# Suno Post-Processor

A small web tool for cleaning up WAV exports from Suno AI before release or
further mixing. Run it locally or deploy it to Railway and use it from any
browser.

## Why this exists

Suno exports share three consistent, fixable problems:

1. **Metallic sheen** — resonant buildup around 3–6 kHz (cymbals, vocal
   sibilants) from generation/encoding. Fixed with a *dynamic* cut that only
   engages when the resonance spikes, so the track doesn't go dull.
2. **Low-mid mud** — buildup around 200–400 Hz typical of dense AI mixes.
   Fixed with a small, static, wide cut (1–2 dB).
3. **Inconsistent loudness** — Suno exports land anywhere from -9 to -16
   LUFS. Normalized to -14 LUFS integrated / -1 dBTP true peak, matching
   Spotify's normalization target, so tracks sit consistently rather than
   getting flattened by a limiter that doesn't actually help on streaming.

Plus optional finishing when you want it — a sibilance-aware **de-ess** and a
**glue/warmth** stage — both off by default so the core stays transparent.

## What it does

- Upload a single file — WAV, FLAC, AIFF, OGG or MP3 (batch upload coming in a
  later phase)
- Choose a de-harshing preset (Off / Gentle / Standard / Aggressive), fine-tune
  with an intensity slider, or hand-tune threshold & ratio in the Advanced panel
- Mud cut and loudness normalization run automatically, no tuning needed
- **Smart tuner:** on upload the whole track is analysed and a starting point is
  auto-applied, with the reasoning shown in a banner — de-harsh preset/strength,
  the adaptive target band, mud depth, and (when vocal sibilance is detected) a
  suggested **de-ess** amount. A plain-English + technical **track assessment**
  reads the track like an engineer would.
- **Optional Finalize stages** (off by default, in a collapsed panel):
  - **De-ess** — dynamic sibilance control; the tuner auto-suggests it (and an
    adaptive band) only when it detects spiky vocal "ess" energy, so it won't
    dull cymbals or air on a non-sibilant track
  - **Glue** — gentle bus compression + valve/transformer-style warmth
  - **Output format** — WAV or FLAC, 16- or 24-bit, source / 44.1 / 48 kHz
- **Tune by ear before committing:** preview a 10 / 15 / 30 s clip (scrub to any
  start point) with gapless, level-matched A/B between original, processed, and
  a **Removed** monitor (hear exactly what the processing takes out)
- Live before/after frequency spectrum (target and mud bands highlighted),
  gain-reduction timeline, whole-track harshness map, plus a LUFS / true-peak /
  de-harsh readout
- When it sounds right, process the full track and download it, with a
  before/after scorecard
- Batch mode with a per-file results table is still to come

## Run locally

```
pip install -r requirements.txt
python app.py            # dev server on http://localhost:8000
```

Or with the production server (same command Railway uses):

```
gunicorn app:app --bind 0.0.0.0:8000
```

### Sanity-check the DSP without the web app

```
python test_dsp.py your_export.wav --preset Standard --intensity 100
python test_dsp.py --selftest        # synthetic signal, no file needed
```

Prints before/after integrated LUFS and true peak, and writes a processed WAV.

## Deploy to Railway

The repo is Railway-ready (Nixpacks). From the [Railway](https://railway.app)
dashboard or CLI, point a new service at this repo — that's it. The included
config does the rest:

- `Procfile` / `railway.json` — gunicorn start command + a `/health` liveness
  probe Railway polls after deploy
- `nixpacks.toml` — installs `libsndfile1` so `soundfile` loads on the image
- `requirements.txt` — Python dependencies

Railway injects `$PORT`; the app binds to it automatically. Nothing here is
Railway-specific beyond the config filenames — the same setup runs on Render,
Fly, or any host that can run `gunicorn app:app`.

## Status

**Phase 1 (DSP core) + the interactive tuning web UI are in place.** Upload
(WAV/FLAC/AIFF/OGG/MP3), preview short clips, A/B against original and a Removed
monitor, tune presets/intensity/threshold/ratio, inspect the harshness map /
gain-reduction / spectral-change / loudness visualizers, and export the full
track to your chosen format. The smart tuner auto-suggests de-harsh and, when it
detects sibilance, de-ess; the optional glue/warmth stage is manual. The preset
values are accepted working defaults; the Advanced panel retunes per-track if a
specific track needs it. Batch/multi-file mode and saved settings are still to
come. See CLAUDE.md for the full technical rationale and open questions.
