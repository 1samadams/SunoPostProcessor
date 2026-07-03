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
- Choose a de-harshing preset (Off / Gentle / Standard / Aggressive) and fine
  -tune with an intensity slider
- Mud cut and loudness normalization run automatically, no tuning needed
- Shows before/after frequency spectrum and a loudness meter (input → output
  LUFS against the -14 LUFS / -1 dBTP target) *(Phase 2)*
- Batch mode shows a results table per file *(Phase 2)*

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

Early build. **Phase 1 (DSP core) + a deployable web skeleton are in place.**
Preset threshold/ratio values are starting points and need ear-tuning against
real Suno exports — don't assume "Standard" is dialed in yet. The rich web UI
(before/after plots, batch table, saved settings) is Phase 2, pending that
ear-test. See CLAUDE.md for the full technical rationale and open questions.
