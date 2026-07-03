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
# NOTE: threshold/ratio values are unvalidated first-draft placeholders. They
# must be ear-tuned against real Suno exports before "Standard" is trusted.
# The threshold is interpreted RELATIVE to the loudest moment of the 3-6 kHz
# band in each track (see _deharsh_threshold docstring), so engagement is
# consistent regardless of the track's absolute input level -- important
# because de-harshing runs BEFORE loudness normalization, when input level is
# still inconsistent (-9 to -16 LUFS).
# ---------------------------------------------------------------------------
PRESETS = {
    "Off": None,  # bypass de-harsh (mud cut + loudness still run)
    "Gentle": {"threshold_db": -18.0, "ratio": 2.0},
    "Standard": {"threshold_db": -14.0, "ratio": 3.0},
    "Aggressive": {"threshold_db": -10.0, "ratio": 5.0},
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
def _deharsh_threshold(env: np.ndarray, offset_db: float) -> float:
    """Absolute envelope threshold (linear) from a per-track reference.

    Reference = loudest moment of the band envelope. `offset_db` (negative,
    e.g. -14) sets the threshold that many dB below that peak, so compression
    engages on the top |offset_db| of the band's dynamic range -- i.e. only
    the loud resonant spikes, not the whole band. Being relative to the
    track's own band peak makes engagement level-independent.
    """
    ref_db = 20.0 * np.log10(np.max(env) + _EPS)
    return 10.0 ** ((ref_db + offset_db) / 20.0)


def deharsh(audio: np.ndarray, sr: int, preset: str = "Standard",
            intensity: float = 100.0) -> np.ndarray:
    """Dynamic downward compression of the 3-6 kHz band.

    A single-band downward compressor sidechained to its own bandpass-filtered
    signal (a de-esser aimed at resonant "digital sheen"), NOT a full multiband
    compressor. Only the 3-6 kHz band is touched; everything else passes through.

    Parameters
    ----------
    preset : one of PRESETS keys ("Off", "Gentle", "Standard", "Aggressive").
             "Off" bypasses this stage (returns a copy).
    intensity : 0-150 (%). Scales threshold depth and ratio of the active
                preset. 100 = preset as-tabled; 0 = effectively bypass;
                150 = deeper threshold + higher ratio.
    """
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}; choose from {list(PRESETS)}")

    params = PRESETS[preset]
    k = float(intensity) / 100.0
    if params is None or k <= 0.0:
        return np.array(audio, dtype=np.float64, copy=True)

    # scale preset by intensity: deeper threshold, higher ratio
    offset_db = params["threshold_db"] * k
    ratio = 1.0 + (params["ratio"] - 1.0) * k

    audio2d, was_mono = _as_2d(audio)

    # bandpass the de-harsh region; zero-phase so band + (audio-band) == audio
    sos = signal.butter(4, [_DEHARSH_LOW, _DEHARSH_HIGH], btype="bandpass",
                        fs=sr, output="sos")
    band = signal.sosfiltfilt(sos, audio2d, axis=0)
    rest = audio2d - band

    # stereo-linked sidechain: one envelope drives both channels (no image shift)
    sidechain = np.mean(np.abs(band), axis=1)
    env = _asym_envelope(sidechain, sr, _ATTACK_S, _RELEASE_S)

    # static gain-reduction curve (hard knee), applied to the band only
    thresh = _deharsh_threshold(env, offset_db)
    env_db = 20.0 * np.log10(env + _EPS)
    thresh_db = 20.0 * np.log10(thresh + _EPS)
    over = env_db - thresh_db
    gr_db = np.where(over > 0.0, over * (1.0 / ratio - 1.0), 0.0)  # <= 0
    gain = 10.0 ** (gr_db / 20.0)

    out = rest + band * gain[:, None]
    return _restore_shape(out, was_mono)


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
                       ceiling_dbtp: float = -1.0) -> np.ndarray:
    """Normalize integrated loudness to target_lufs with a true-peak ceiling.

    Applies broadband gain to hit target_lufs, then a true-peak limiter so the
    output never exceeds ceiling_dbtp. This is normalization for consistency,
    not limiting-for-loudness -- the limiter only catches stray inter-sample
    peaks (see CLAUDE.md).
    """
    audio2d, was_mono = _as_2d(audio)

    loudness = integrated_lufs(audio2d, sr)
    if not np.isfinite(loudness):
        # silence / below gate: nothing meaningful to normalize
        return _restore_shape(np.array(audio2d, copy=True), was_mono)

    gain_db = target_lufs - loudness
    out = audio2d * (10.0 ** (gain_db / 20.0))

    ceiling_lin = 10.0 ** (ceiling_dbtp / 20.0)
    out = _true_peak_limit(out, sr, ceiling_lin)

    return _restore_shape(out, was_mono)


# ---------------------------------------------------------------------------
# full chain convenience wrapper (used by CLI test script and, later, GUI/CLI)
# ---------------------------------------------------------------------------
def process(audio: np.ndarray, sr: int, preset: str = "Standard",
            intensity: float = 100.0, target_lufs: float = -14.0,
            ceiling_dbtp: float = -1.0) -> np.ndarray:
    """Run the full chain: de-harsh -> mud cut -> loudness normalize."""
    x = deharsh(audio, sr, preset, intensity)
    x = cut_mud(x, sr)
    x = normalize_loudness(x, sr, target_lufs, ceiling_dbtp)
    return x
