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
- **GUI:** Tkinter + matplotlib (`FigureCanvasTkAgg`). Not chosen for looks —
  chosen because it's stdlib-adjacent, has zero packaging headaches, and this
  is a personal tool, not a product. Don't suggest Electron/web-stack unless
  explicitly asked to reconsider.
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

## Presets (dynamic EQ / step 1)

Four presets, not six — more choices here just recreates the manual-plugin
decision fatigue this tool exists to avoid.

| Preset     | Threshold      | Ratio | Notes                                  |
|------------|----------------|-------|-----------------------------------------|
| Off        | —              | —     | bypass, still runs mud cut + loudness  |
| Gentle     | -18 dB (rel.)  | 2:1   | mild resonance                          |
| Standard   | -14 dB (rel.)  | 3:1   | default; tune against real Suno exports |
| Aggressive | -10 dB (rel.)  | 5:1   | heavy cymbal wash / sibilant vocals     |

Plus a single **Intensity slider (0–150%)** that scales threshold depth and
ratio of whichever preset is active, so borderline tracks aren't stuck
between two presets.

**Important:** these threshold numbers are starting points, not gospel. They
need to be tuned by ear against a batch of real Suno exports before trusting
"Standard" as a true default. Don't treat the table above as validated —
treat it as the first draft to test.

## GUI requirements

- File picker (single file or folder/batch)
- Preset dropdown + intensity slider for step 1
- Steps 2 & 3 run automatically, no user tuning surfaced (per user's spec —
  don't add controls for these unless asked)
- Before/after plots: frequency spectrum (so the 3–6kHz reduction and mud cut
  are visible) and a loudness meter showing input LUFS → output LUFS with the
  -14 LUFS / -1 dBTP target marked
- Batch mode should show per-file results in a simple table (filename, input
  LUFS, output LUFS, peak reduction applied)

## Code style / conventions
- Keep the DSP core (de-harsh, mud cut, loudness normalize) as pure functions
  operating on numpy arrays, fully decoupled from the GUI layer. The GUI
  should be a thin wrapper — this makes it trivial to also expose a CLI batch
  mode later without duplicating logic.
- Write one small test/validation script that processes a known WAV and
  prints before/after LUFS and true peak, so DSP changes can be sanity-checked
  without opening the GUI.
- No exotic dependencies beyond: numpy, scipy, pyloudnorm, matplotlib,
  soundfile (for WAV I/O — better format handling than scipy.io.wavfile).

## Known open questions (flag these back to the user, don't silently decide)
- Exact threshold/ratio values per preset need ear-tuning against real
  exports — treat current values as placeholders.
- Whether envelope follower should be peak or RMS-based may need A/B testing
  on actual cymbal-heavy vs vocal-heavy tracks.
- Batch mode UX (process-then-review vs review-each-file) — ask before
  building the more complex version.
