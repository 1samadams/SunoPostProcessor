# Suno Post-Processor

A small local GUI tool for cleaning up WAV exports from Suno AI before
release or further mixing.

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

- Load a single WAV or a folder of WAVs
- Choose a de-harshing preset (Off / Gentle / Standard / Aggressive) and fine
  -tune with an intensity slider
- Mud cut and loudness normalization run automatically, no tuning needed
- Shows before/after frequency spectrum and a loudness meter (input → output
  LUFS against the -14 LUFS / -1 dBTP target)
- Batch mode shows a results table per file

## Install

```
pip install numpy scipy pyloudnorm matplotlib soundfile
python main.py
```

## Status

Early build. Preset threshold/ratio values are starting points and need
ear-tuning against real Suno exports — don't assume "Standard" is dialed in
yet. See CLAUDE.md for the full technical rationale and open questions.
