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

## What it does

- Upload a single WAV (batch upload coming in a later phase)
- Choose a de-harshing preset (Off / Gentle / Standard / Aggressive), fine-tune
  with an intensity slider, or hand-tune threshold & ratio in the Advanced panel
- Mud cut and loudness normalization run automatically, no tuning needed
- **Tune by ear before committing:** preview a 10 / 15 / 30 s clip (scrub to any
  start point) with gapless, level-matched A/B between original and processed
- Live before/after frequency spectrum (3–6 kHz and mud bands highlighted) plus
  a LUFS / true-peak / de-harsh readout
- When it sounds right, process the full track and download it
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

**Phase 1 (DSP core) + the interactive tuning web UI are in place.** Upload,
preview short clips, A/B, tune presets/intensity/threshold/ratio, inspect the
harshness map / gain-reduction / spectral-change / loudness visualizers, and
export the full track. The preset values are accepted working defaults; the
Advanced panel retunes per-track if a specific track needs it. Batch/multi-file
mode and saved settings are still to come. See CLAUDE.md for the full technical
rationale and open questions.
