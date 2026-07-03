"""DSP core for the Suno post-processor.

Three pure functions operating on numpy arrays, fully decoupled from any GUI:

    deharsh(audio, sr, preset, intensity)   -> dynamic 3-6 kHz cut
    cut_mud(audio, sr)                       -> static wide-Q 200-400 Hz cut
    normalize_loudness(audio, sr, ...)       -> -14 LUFS / -1 dBTP normalization

Processing order (see CLAUDE.md) is de-harsh -> mud cut -> loudness normalize.
The GUI / CLI layers are expected to call them in that order.

Audio arrays follow the soundfile convention: shape (n_samples,) for mono or
(n_samples, n_channels) for multichannel, float32/float64, nominally in
[-1.0, 1.0]. Sample rate `sr` is in Hz.

None of these functions mutate their input array.
"""

from __future__ import annotations

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d
import pyloudnorm as pyln


# ---------------------------------------------------------------------------
# Presets for the dynamic de-harsh stage (CLAUDE.md, step 1)
#
# The threshold is set at a PERCENTILE of the 3-6 kHz band envelope's own
# distribution: with `pctl` = 91, only the loudest ~9% of the band's moments
# (the actual harsh spikes) cross it and get compressed -- everything below is
# untouched. This is what keeps the cut *dynamic* rather than a static shelf:
# steady band content sits near the median, well under the threshold, so it is
# left alone; only transient sizzle/sibilance is pulled down. It is also
# self-calibrating and level-independent (percentile of the track's own band),
# which matters because de-harsh runs before loudness normalization.
#
# NOTE: pctl/ratio values are still unvalidated placeholders -- ear-tune them
# against real Suno exports (that's what the Advanced panel is for).
# ---------------------------------------------------------------------------
PRESETS = {
    "Off": None,  # bypass de-harsh (mud cut + loudness still run)
    "Gentle": {"pctl": 96.0, "ratio": 2.0},      # grab loudest ~4%
    "Standard": {"pctl": 91.0, "ratio": 3.0},    # grab loudest ~9%
    "Aggressive": {"pctl": 84.0, "ratio": 5.0},  # grab loudest ~16%
}

# De-harsh band (Hz)
_DEHARSH_LOW = 3000.0
_DEHARSH_HIGH = 6000.0

# Envelope follower time constants (CLAUDE.md: ~5-15 ms attack, ~80-150 ms release)
_ATTACK_S = 0.010
_RELEASE_S = 0.120

# Mud cut (CLAUDE.md step 2): static, gentle, wide-Q cut in 200-400 Hz
_MUD_FREQ = 283.0   # geometric centre of 200-400 Hz
_MUD_GAIN_DB = -1.5
_MUD_Q = 1.0        # wide

_EPS = 1e-12


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _as_2d(audio: np.ndarray) -> tuple[np.ndarray, bool]:
    """Return (audio_2d, was_mono). audio_2d has shape (n, ch)."""
    audio = np.asarray(audio, dtype=np.float64)
    if audio.ndim == 1:
        return audio[:, None], True
    return audio, False


def _restore_shape(audio_2d: np.ndarray, was_mono: bool) -> np.ndarray:
    return audio_2d[:, 0] if was_mono else audio_2d


def _asym_envelope(x: np.ndarray, sr: int, attack_s: float, release_s: float) -> np.ndarray:
    """Fast-attack / slow-release envelope of a 1-D signal.

    Implemented as the max of a fast and a slow one-pole low-pass on the
    rectified signal: rises with the fast filter (attack), decays with the
    slow one (release). Fully vectorized -- no per-sample Python loop.

    (RMS-vs-peak follower is a flagged open question in CLAUDE.md; this uses a
    rectified-peak follower. Swapping to RMS = sqrt of the same filters on x**2.)
    """
    rect = np.abs(x)
    a_att = np.exp(-1.0 / (sr * attack_s))
    a_rel = np.exp(-1.0 / (sr * release_s))
    fast = signal.lfilter([1.0 - a_att], [1.0, -a_att], rect)
    slow = signal.lfilter([1.0 - a_rel], [1.0, -a_rel], rect)
    return np.maximum(fast, slow)


def _peaking_biquad(freq: float, gain_db: float, q: float, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """RBJ cookbook peaking-EQ biquad. Returns (b, a)."""
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * freq / sr
    cos_w0 = np.cos(w0)
    alpha = np.sin(w0) / (2.0 * q)

    b0 = 1.0 + alpha * A
    b1 = -2.0 * cos_w0
    b2 = 1.0 - alpha * A
    a0 = 1.0 + alpha / A
    a1 = -2.0 * cos_w0
    a2 = 1.0 - alpha / A

    b = np.array([b0, b1, b2]) / a0
    a = np.array([a0, a1, a2]) / a0
    return b, a


# ---------------------------------------------------------------------------
# measurement (also used by the CLI test script / GUI meters)
# ---------------------------------------------------------------------------
def integrated_lufs(audio: np.ndarray, sr: int) -> float:
    """Integrated loudness (LUFS, ITU-R BS.1770) via pyloudnorm.

    Returns -inf for silence (pyloudnorm returns -inf below its gate).
    """
    meter = pyln.Meter(sr)
    audio2d, _ = _as_2d(audio)
    return float(meter.integrated_loudness(audio2d))


def true_peak_db(audio: np.ndarray, sr: int, oversample: int = 4) -> float:
    """True-peak level in dBTP.

    True peak != sample peak: we oversample (4x min, per ITU-R BS.1770 Annex 2)
    before peak-detecting so inter-sample peaks are caught.
    """
    audio2d, _ = _as_2d(audio)
    up = signal.resample_poly(audio2d, oversample, 1, axis=0)
    peak = np.max(np.abs(up))
    return 20.0 * np.log10(peak + _EPS)


# ---------------------------------------------------------------------------
# step 1: dynamic de-harsh (3-6 kHz)
# ---------------------------------------------------------------------------
def _deharsh_bands(audio2d: np.ndarray, sr: int):
    """Split the signal for de-harshing.

    Returns (band, rest, env) where `band` is the zero-phase 3-6 kHz bandpass,
    `rest` = audio - band (so band + rest reconstructs the input exactly), and
    `env` is the stereo-linked fast-attack/slow-release envelope of the band
    that drives the compressor sidechain.
    """
    sos = signal.butter(4, [_DEHARSH_LOW, _DEHARSH_HIGH], btype="bandpass",
                        fs=sr, output="sos")
    band = signal.sosfiltfilt(sos, audio2d, axis=0)
    rest = audio2d - band
    sidechain = np.mean(np.abs(band), axis=1)  # one envelope for both channels
    env = _asym_envelope(sidechain, sr, _ATTACK_S, _RELEASE_S)
    return band, rest, env


def band_envelope_db(audio: np.ndarray, sr: int, subsample_hz: float = 500.0) -> np.ndarray:
    """Subsampled dB envelope of the 3-6 kHz band over a whole track.

    The de-harsh threshold is a percentile of this distribution. Compute it
    once on the WHOLE track at upload and pass it back into deharsh()/process()
    as `env_db_ref` so a short preview segment picks the same threshold the
    full track will (otherwise a 10 s clip estimates the percentile from its
    own, possibly unrepresentative, slice). Subsampled because the envelope is
    smooth (~120 ms release) so the distribution is preserved at low rate.
    """
    audio2d, _ = _as_2d(audio)
    _, _, env = _deharsh_bands(audio2d, sr)
    env_db = 20.0 * np.log10(env + _EPS)
    step = max(1, int(sr / subsample_hz))
    return env_db[::step].astype(np.float64)


def deharsh(audio: np.ndarray, sr: int, preset: str = "Standard",
            intensity: float = 100.0, threshold_pctl: float | None = None,
            ratio: float | None = None, env_db_ref: np.ndarray | None = None) -> np.ndarray:
    """Dynamic downward compression of the 3-6 kHz band.

    A single-band downward compressor sidechained to its own bandpass-filtered
    signal (a de-esser aimed at resonant "digital sheen"), NOT a full multiband
    compressor. Only the 3-6 kHz band is touched; everything else passes through.

    The threshold is a PERCENTILE of the band envelope's distribution, so only
    the loudest few % of band moments (harsh spikes) are compressed and steady
    band content is left alone -- this is what makes the cut dynamic, not a
    static shelf.

    Parameters
    ----------
    preset : one of PRESETS keys ("Off", "Gentle", "Standard", "Aggressive").
             "Off" bypasses this stage. Ignored when both `threshold_pctl` and
             `ratio` are given (manual/custom mode).
    intensity : 0-150 (%). Scales the preset/override. 100 = as-tabled;
                0 = bypass; 150 = lower percentile (grabs more) + higher ratio.
    threshold_pctl, ratio : optional manual overrides (Advanced panel). If BOTH
                are given they replace the preset's base values.
    env_db_ref : optional whole-track band envelope (from band_envelope_db()).
                Its distribution sets the threshold percentile; pass it for
                preview segments so they match the full-track result.
    """
    resolved = _resolve_deharsh(preset, intensity, threshold_pctl, ratio)
    if resolved is None:
        return np.array(audio, dtype=np.float64, copy=True)  # Off / zero intensity
    pctl_eff, ratio_eff = resolved

    audio2d, was_mono = _as_2d(audio)
    band, rest, env = _deharsh_bands(audio2d, sr)
    env_db = 20.0 * np.log10(env + _EPS)

    gr_db = _deharsh_gr_db(env_db, env_db_ref, pctl_eff, ratio_eff)
    gain = 10.0 ** (gr_db / 20.0)

    out = rest + band * gain[:, None]
    return _restore_shape(out, was_mono)


def _resolve_deharsh(preset, intensity, threshold_pctl, ratio):
    """Resolve (pctl_eff, ratio_eff) from preset/overrides + intensity.

    Returns None when the stage should bypass (Off preset or zero intensity).
    """
    k = float(intensity) / 100.0
    if threshold_pctl is not None and ratio is not None:
        base_pctl, base_ratio = float(threshold_pctl), float(ratio)  # manual/custom
    else:
        if preset not in PRESETS:
            raise ValueError(f"unknown preset {preset!r}; choose from {list(PRESETS)}")
        params = PRESETS[preset]
        if params is None:
            return None  # Off
        base_pctl = params["pctl"] if threshold_pctl is None else float(threshold_pctl)
        base_ratio = params["ratio"] if ratio is None else float(ratio)
    if k <= 0.0:
        return None  # zero intensity = bypass
    # scale by intensity: lower percentile (grab more of the band) + higher ratio
    pctl_eff = float(np.clip(100.0 - (100.0 - base_pctl) * k, 50.0, 100.0))
    ratio_eff = 1.0 + (base_ratio - 1.0) * k
    return pctl_eff, ratio_eff


def _deharsh_gr_db(env_db, env_db_ref, pctl_eff, ratio_eff):
    """Per-sample gain reduction (dB, <= 0) for the band from a hard-knee curve.

    Threshold = `pctl_eff` percentile of the band distribution (whole-track
    `env_db_ref` if given, else the local envelope)."""
    dist = env_db_ref if env_db_ref is not None else env_db
    thresh_db = float(np.percentile(dist, pctl_eff))
    over = env_db - thresh_db
    return np.where(over > 0.0, over * (1.0 / ratio_eff - 1.0), 0.0)


def deharsh_metrics(audio: np.ndarray, sr: int, preset: str = "Standard",
                    intensity: float = 100.0, threshold_pctl: float | None = None,
                    ratio: float | None = None,
                    env_db_ref: np.ndarray | None = None) -> dict:
    """Peak gain reduction (dB) and engagement duty cycle for given settings.

    Reports what the de-harsh actually does on this audio without applying it,
    so the UI can show how hard it grabs the spikes -- more meaningful than
    average band-energy change, which stays tiny for a working de-esser."""
    resolved = _resolve_deharsh(preset, intensity, threshold_pctl, ratio)
    if resolved is None:
        return {"peak_gr_db": 0.0, "duty_pct": 0.0}
    pctl_eff, ratio_eff = resolved
    audio2d, _ = _as_2d(audio)
    _, _, env = _deharsh_bands(audio2d, sr)
    env_db = 20.0 * np.log10(env + _EPS)
    gr_db = _deharsh_gr_db(env_db, env_db_ref, pctl_eff, ratio_eff)
    return {
        "peak_gr_db": round(float(gr_db.min()), 2),          # most negative
        "duty_pct": round(float(np.mean(gr_db < -0.1) * 100.0), 1),
    }


# ---------------------------------------------------------------------------
# step 2: static mud cut (200-400 Hz)
# ---------------------------------------------------------------------------
def cut_mud(audio: np.ndarray, sr: int, gain_db: float = _MUD_GAIN_DB,
            freq: float = _MUD_FREQ, q: float = _MUD_Q) -> np.ndarray:
    """Static, gentle, wide-Q peaking cut centred in the low-mid mud region.

    Defaults to ~1.5 dB at ~283 Hz, Q=1.0. No dynamics -- this band's problem
    is static buildup. (CLAUDE.md: never more than 3 dB.)
    """
    if gain_db < -3.0:
        raise ValueError("mud cut deeper than 3 dB throws away warmth (see CLAUDE.md)")
    audio2d, was_mono = _as_2d(audio)
    b, a = _peaking_biquad(freq, gain_db, q, sr)
    out = signal.lfilter(b, a, audio2d, axis=0)
    return _restore_shape(out, was_mono)


# ---------------------------------------------------------------------------
# step 3: loudness normalization (-14 LUFS / -1 dBTP)
# ---------------------------------------------------------------------------
def _true_peak_limit(audio2d: np.ndarray, sr: int, ceiling_lin: float,
                     oversample: int = 4, lookahead_s: float = 0.0015,
                     release_s: float = 0.050) -> np.ndarray:
    """Stereo-linked true-peak limiter guaranteeing |true peak| <= ceiling.

    Peak detection is done on the oversampled signal (inter-sample peaks); the
    gain envelope is computed and applied at the base rate. minimum_filter1d
    supplies look-ahead so gain dips *before* a peak arrives; a one-pole
    release smooths recovery. Fully vectorized.
    """
    up = signal.resample_poly(audio2d, oversample, 1, axis=0)
    up_peak = np.max(np.abs(up), axis=1)  # stereo-linked, oversampled

    # collapse oversampled peaks back to one value per base sample (max of group)
    n_base = audio2d.shape[0]
    pad = n_base * oversample - up_peak.shape[0]
    if pad > 0:
        up_peak = np.concatenate([up_peak, np.zeros(pad)])
    else:
        up_peak = up_peak[:n_base * oversample]
    tp_base = up_peak.reshape(n_base, oversample).max(axis=1)

    required = np.minimum(1.0, ceiling_lin / np.maximum(tp_base, _EPS))

    # look-ahead: pull gain down around every peak so attack is never late
    win = max(1, int(sr * lookahead_s))
    g_att = minimum_filter1d(required, size=2 * win + 1, mode="nearest")

    # one-pole release smoothing; min() keeps us at/under the required reduction
    a_rel = np.exp(-1.0 / (sr * release_s))
    g_rel = signal.lfilter([1.0 - a_rel], [1.0, -a_rel], g_att)
    g = np.minimum(g_att, g_rel)

    return audio2d * g[:, None]


def normalize_loudness(audio: np.ndarray, sr: int, target_lufs: float = -14.0,
                       ceiling_dbtp: float = -1.0,
                       measured_lufs: float | None = None) -> np.ndarray:
    """Normalize integrated loudness to target_lufs with a true-peak ceiling.

    Applies broadband gain to hit target_lufs, then a true-peak limiter so the
    output never exceeds ceiling_dbtp. This is normalization for consistency,
    not limiting-for-loudness -- the limiter only catches stray inter-sample
    peaks (see CLAUDE.md).

    measured_lufs : if given, use it as the source loudness instead of
        measuring `audio`. Lets a preview segment be shifted by the *full
        track's* gain (level-matched to the final result) rather than by its
        own segment loudness.
    """
    audio2d, was_mono = _as_2d(audio)

    loudness = measured_lufs if measured_lufs is not None else integrated_lufs(audio2d, sr)
    if not np.isfinite(loudness):
        # silence / below gate: nothing meaningful to normalize
        return _restore_shape(np.array(audio2d, copy=True), was_mono)

    gain_db = target_lufs - loudness
    out = audio2d * (10.0 ** (gain_db / 20.0))

    ceiling_lin = 10.0 ** (ceiling_dbtp / 20.0)
    out = _true_peak_limit(out, sr, ceiling_lin)

    return _restore_shape(out, was_mono)


# ---------------------------------------------------------------------------
# full chain convenience wrapper (used by the CLI test script and web app)
# ---------------------------------------------------------------------------
def process(audio: np.ndarray, sr: int, preset: str = "Standard",
            intensity: float = 100.0, target_lufs: float = -14.0,
            ceiling_dbtp: float = -1.0, threshold_pctl: float | None = None,
            ratio: float | None = None, env_db_ref: np.ndarray | None = None,
            measured_lufs: float | None = None) -> np.ndarray:
    """Run the full chain: de-harsh -> mud cut -> loudness normalize.

    `threshold_pctl`/`ratio`/`env_db_ref` pass through to deharsh() and
    `measured_lufs` to normalize_loudness() (see those functions) -- used by
    the web app's preview path to make short clips match the full track.
    """
    x = deharsh(audio, sr, preset, intensity, threshold_pctl, ratio, env_db_ref)
    x = cut_mud(x, sr)
    x = normalize_loudness(x, sr, target_lufs, ceiling_dbtp, measured_lufs)
    return x
