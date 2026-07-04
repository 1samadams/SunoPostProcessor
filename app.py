"""Web app around the DSP core, deployable on Railway.

Flow:
  POST /upload    -> stash the WAV, measure the whole track once
                     (LUFS, true peak, de-harsh band reference), return meta
  POST /preview   -> process a short segment (level-matched A/B original +
                     processed clips, metrics, before/after spectrum) so the
                     de-harsh can be ear-tuned without committing the full file
  POST /process   -> process the full track with the tuned settings, stash it
  GET  /download/<id> -> stream the processed WAV
  GET  /health    -> Railway liveness probe

The DSP core (dsp.py) is imported unchanged -- this module is a thin wrapper.
"""

from __future__ import annotations

import base64
import io
import os
import tempfile
import threading
import uuid
from collections import OrderedDict

import numpy as np
import soundfile as sf
from scipy import signal
from flask import (Flask, abort, jsonify, render_template, request,
                   send_file)

import dsp

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

# ---------------------------------------------------------------------------
# tiny in-process stores (single gunicorn worker; fine for a personal tool)
# ---------------------------------------------------------------------------
_TMP = os.path.join(tempfile.gettempdir(), "suno_pp")
os.makedirs(_TMP, exist_ok=True)
_LOCK = threading.Lock()
_UPLOADS: "OrderedDict[str, dict]" = OrderedDict()   # id -> {path, meta}
_DOWNLOADS: "OrderedDict[str, dict]" = OrderedDict()  # id -> {path, name}
_MAX_KEEP = 12  # cap stored files; evict oldest


def _remember(store: "OrderedDict[str, dict]", key: str, value: dict) -> None:
    with _LOCK:
        store[key] = value
        store.move_to_end(key)
        while len(store) > _MAX_KEEP:
            _, old = store.popitem(last=False)
            try:
                os.remove(old["path"])
            except OSError:
                pass


def _get_upload(uid: str) -> dict:
    with _LOCK:
        rec = _UPLOADS.get(uid)
        if rec is not None:
            _UPLOADS.move_to_end(uid)
    if rec is None:
        abort(404, "upload not found (it may have expired) -- re-upload the file")
    return rec


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _wav_data_uri(audio: np.ndarray, sr: int, subtype: str = "PCM_16") -> str:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype=subtype)
    return "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _spectrum(x: np.ndarray, sr: int, grid: np.ndarray) -> list[float]:
    """Smoothed magnitude spectrum (dB) resampled onto a shared log grid."""
    mono = x if x.ndim == 1 else x.mean(axis=1)
    nper = int(min(4096, len(mono)))
    if nper < 256:
        nper = len(mono)
    f, p = signal.welch(mono, fs=sr, nperseg=nper)
    p_db = 10.0 * np.log10(np.interp(grid, f, p) + 1e-20)
    return [round(float(v), 2) for v in p_db]


def _spectrum_pair(orig: np.ndarray, proc: np.ndarray, sr: int):
    fmax = min(20000.0, sr / 2.0)
    grid = np.geomspace(30.0, fmax, 180)
    return {
        "freqs": [round(float(v), 1) for v in grid],
        "orig_db": _spectrum(orig, sr, grid),
        "proc_db": _spectrum(proc, sr, grid),
    }


def _spectrogram(audio: np.ndarray, sr: int, n_time: int = 240, n_freq: int = 150,
                 fmin: float = 40.0) -> dict:
    """Whole-track magnitude spectrogram as a uint8 heatmap (base64).

    Log-frequency y-axis (fmin..~16 kHz) so the 3-6 kHz band and the "air"
    region above it are both visible; time binned to n_time columns. 70 dB
    display range. Returned row-major, freq-major, low freq first.
    """
    mono = audio if audio.ndim == 1 else audio.mean(axis=1)
    fmax = min(16000.0, sr / 2.0 * 0.98)
    nperseg = 1024
    hop = int(min(nperseg, max(256, len(mono) // 4000)))  # bound frame count
    f, _t, sxx = signal.spectrogram(mono, fs=sr, nperseg=nperseg,
                                    noverlap=nperseg - hop, mode="magnitude")
    nt = sxx.shape[1]
    edges = np.linspace(0, nt, n_time + 1).astype(int)
    binned = np.empty((sxx.shape[0], n_time))
    for j in range(n_time):
        a, b = edges[j], edges[j + 1]
        binned[:, j] = sxx[:, a:b].mean(axis=1) if b > a else sxx[:, min(a, nt - 1)]
    db = 20.0 * np.log10(binned + 1e-9)

    logf = np.geomspace(fmin, fmax, n_freq)
    grid = np.empty((n_freq, n_time))
    for j in range(n_time):
        grid[:, j] = np.interp(logf, f, db[:, j])

    mx = float(grid.max())
    floor = mx - 70.0
    norm = np.clip((grid - floor) / max(1e-6, mx - floor), 0.0, 1.0)
    u8 = (norm * 255.0).astype(np.uint8)
    return {
        "n_time": n_time, "n_freq": n_freq,
        "fmin": round(float(fmin), 1), "fmax": round(float(fmax), 1),
        "data": base64.b64encode(u8.tobytes()).decode("ascii"),
    }


_DEFAULT_BAND = (3000.0, 6000.0)


def _detect_band(f: np.ndarray, psd: np.ndarray, sr: int):
    """Find where the harshness actually sits and return a band to target.

    Fits a smooth spectral trend (2nd-order in log-freq) and looks for the
    frequency where the spectrum pokes *above* the trend the most in 2.5-12 kHz
    -- the resonance / sheen. Bands the region ~+/- half-octave around it. Falls
    back to the default 3-6 kHz when there's no distinct excess (broadband).
    Returns (band, f0, height_db).
    """
    fmax = min(12000.0, 0.95 * sr / 2.0)
    sel = (f >= 1000.0) & (f <= fmax)
    if sel.sum() < 8:
        return _DEFAULT_BAND, None, 0.0
    ff, pp = f[sel], 10.0 * np.log10(psd[sel] + 1e-20)
    logf = np.log10(ff)
    trend = np.polyval(np.polyfit(logf, pp, 2), logf)
    excess = np.clip(pp - trend, 0.0, None)

    reg = ff >= 2500.0
    if not reg.any() or float(excess[reg].max()) < 1.2:
        return _DEFAULT_BAND, None, float(excess[reg].max()) if reg.any() else 0.0

    idx = np.where(reg)[0]
    pk = idx[int(np.argmax(excess[idx]))]
    f0, h = float(ff[pk]), float(excess[pk])
    lo, hi = f0 / 1.5, f0 * 1.5
    lo, hi = max(2000.0, lo), min(fmax, hi)
    if hi - lo < 1500.0:
        c = (lo + hi) / 2.0; lo, hi = max(2000.0, c - 900.0), c + 900.0
    if hi - lo > 5000.0:
        lo, hi = max(2000.0, f0 - 2500.0), min(fmax, f0 + 2500.0)
    return (round(lo / 50) * 50.0, round(hi / 50) * 50.0), f0, h


def _detect_mud(f: np.ndarray, psd: np.ndarray) -> float:
    """Mud-cut depth (dB, <= 0) from how much 200-400 Hz pokes above neighbours."""
    def dens(lo, hi):
        sel = (f >= lo) & (f < hi)
        return 10.0 * np.log10(float(psd[sel].mean()) + 1e-20) if sel.any() else -120.0
    excess = dens(200, 400) - 0.5 * (dens(100, 200) + dens(400, 800))
    return -round(min(3.0, max(0.5, 1.0 + max(0.0, excess) * 0.5)), 1)


def _harsh_start(env_db_ref: np.ndarray, duration: float) -> float:
    """Time (s) of the loudest sustained band energy, minus a lead-in -- where
    the preview scrubber should land so you hear the worst of it."""
    e = np.asarray(env_db_ref, dtype=float)
    if e.size < 20 or duration <= 0:
        return 0.0
    win = max(1, min(e.size // 4, 500))
    sm = np.convolve(e, np.ones(win) / win, mode="same")
    m = int(e.size * 0.05)
    seg = sm[m:e.size - m] if e.size - 2 * m > 4 else sm
    idx = m + int(np.argmax(seg)) if e.size - 2 * m > 4 else int(np.argmax(sm))
    return round(max(0.0, (idx / e.size) * duration - 3.0), 1)


def _analyze(audio: np.ndarray, sr: int, duration: float):
    """Full smart-tuner analysis. Returns (band, mud_gain, env_db_ref, dict).

    Decides: WHERE (adaptive band from the resonance), the low-mid mud depth,
    the preset STRENGTH (brightness in the *targeted* band vs mids), the
    static<->dynamic LEAN (envelope crest), a CONFIDENCE flag when borderline,
    and where the harshness lives in time (preview start).
    """
    mono = audio if audio.ndim == 1 else audio.mean(axis=1)
    f, psd = signal.welch(mono, fs=sr, nperseg=int(min(8192, len(mono))))

    band, f0, res_h = _detect_band(f, psd, sr)
    mud_gain = _detect_mud(f, psd)
    env_db_ref = dsp.band_envelope_db(audio, sr, band=band)
    harsh_start = _harsh_start(env_db_ref, duration)

    def dens(lo, hi):
        sel = (f >= lo) & (f < min(hi, sr / 2.0))
        return 10.0 * np.log10(float(psd[sel].mean()) + 1e-20) if sel.any() else -120.0

    brightness = float(dens(band[0], band[1]) - dens(200, 2000))
    crest = (float(np.percentile(env_db_ref, 95) - np.percentile(env_db_ref, 50))
             if np.asarray(env_db_ref).size > 4 else 8.0)

    # preset STRENGTH from brightness (pink-referenced boundaries)
    bounds = [(-13, "Off"), (-10, "Gentle"), (-5, "Standard"), (1e9, "Aggressive")]
    preset = next(name for thr, name in bounds if brightness < thr)
    reasons = [("band already tame" if preset == "Off" else
                {"Gentle": "mild", "Standard": "moderate", "Aggressive": "hot"}[preset]
                + f" band energy ({brightness:+.0f} dB vs mids)")]

    # CONFIDENCE: flag when brightness sits within 1.2 dB of a boundary
    confidence = "high"
    for thr, _ in bounds[:-1]:
        if abs(brightness - thr) < 1.2:
            confidence = "borderline"
            reasons.append("borderline call — worth A/B-ing the neighbouring preset")
            break

    static_db = threshold_pctl = ratio = None
    custom = False
    if preset != "Off":
        base = dsp.PRESETS[preset]
        static_db, threshold_pctl, ratio = base["static_db"], base["pctl"], base["ratio"]
        if crest < 6:
            static_db = round(max(-4.0, base["static_db"] * 1.6), 1); custom = True
            reasons.append(f"steady sheen (crest {crest:.0f} dB) → more static cut")
        elif crest > 12:
            static_db = round(base["static_db"] * 0.5, 1); custom = True
            reasons.append(f"transient/spiky (crest {crest:.0f} dB) → lean dynamic")
        else:
            reasons.append(f"mixed steady/transient (crest {crest:.0f} dB)")

    band_note = None
    shifted = band != _DEFAULT_BAND
    if shifted and preset != "Off":
        band_note = (f"Harshness centred ~{(f0 or (band[0]+band[1])/2)/1000:.1f} kHz "
                     f"({res_h:.0f} dB over trend) — targeting {band[0]/1000:.1f}"
                     f"–{band[1]/1000:.1f} kHz instead of the usual 3–6 kHz.")

    suggest = {
        "preset": preset, "intensity": 100, "custom": custom,
        "static_db": static_db, "threshold_pctl": threshold_pctl, "ratio": ratio,
        "reasons": reasons, "band_note": band_note, "confidence": confidence,
        "band": [round(band[0], 1), round(band[1], 1)],
        "band_display": f"{band[0]/1000:.1f}–{band[1]/1000:.1f} kHz",
        "mud_db": mud_gain, "harsh_start": harsh_start,
        "measured": {"brightness": round(brightness, 1), "crest": round(crest, 1)},
    }
    return band, mud_gain, env_db_ref, suggest


def _input_health(audio: np.ndarray, sr: int, input_lufs, input_tp: float) -> list:
    """Advisory warnings about the *source* file (#4) + loudness forecast (#5)."""
    warnings = []
    peak = float(np.max(np.abs(audio)))
    if input_tp > 0.0 or peak >= 0.999:
        n_hot = int(np.sum(np.abs(audio) >= 0.999))
        warnings.append(f"Source already clips (true peak {input_tp:+.1f} dBFS"
                        + (f", {n_hot} samples at full scale" if n_hot else "")
                        + ") — de-harsh can't undo clipping.")
    dc = float(np.mean(audio))
    if abs(dc) > 0.003:
        warnings.append(f"DC offset detected ({dc:+.3f}); a high-pass would fix it.")
    if input_lufs is not None:
        rms = 20.0 * np.log10(float(np.sqrt(np.mean(audio ** 2))) + 1e-12)
        peak_db = 20.0 * np.log10(peak + 1e-12)
        crest_db = peak_db - rms
        if input_lufs > -10.0 and crest_db < 9.0:
            warnings.append(f"Looks already loudness-maximised ({input_lufs:.0f} LUFS, "
                            f"crest {crest_db:.0f} dB) — likely brick-walled; de-harsh only.")
        # #5 loudness forecast
        predicted_tp = input_tp + (-14.0 - input_lufs)
        if predicted_tp > -1.0:
            warnings.append(f"Peaky track — normalizing to −14 would hit {predicted_tp:+.0f} dBTP, "
                            "so it'll land a touch under −14 to keep peaks ≤ −1 dBTP (by design).")
    return warnings


def _controls_from_request(data: dict):
    """Parse preset / intensity / optional manual threshold+ratio."""
    preset = data.get("preset", "Standard")
    if preset not in dsp.PRESETS:
        abort(400, f"unknown preset {preset!r}")
    try:
        intensity = float(data.get("intensity", 100))
    except (TypeError, ValueError):
        abort(400, "intensity must be a number")
    intensity = max(0.0, min(150.0, intensity))

    threshold_pctl = ratio = static_db = None
    if data.get("custom"):
        try:
            threshold_pctl = float(data["threshold_pctl"])
            ratio = float(data["ratio"])
            static_db = min(0.0, float(data["static_db"]))
        except (KeyError, TypeError, ValueError):
            abort(400, "custom mode needs numeric threshold_pctl, ratio and static_db")
    return preset, intensity, threshold_pctl, ratio, static_db


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}, 200


@app.get("/")
def index():
    return render_template("index.html", presets=list(dsp.PRESETS))


@app.post("/upload")
def upload():
    upload = request.files.get("file")
    if upload is None or upload.filename == "":
        abort(400, "no file uploaded")
    if not upload.filename.lower().endswith(".wav"):
        abort(400, "please upload a .wav file")

    uid = uuid.uuid4().hex
    path = os.path.join(_TMP, f"{uid}.wav")
    upload.save(path)

    try:
        audio, sr = sf.read(path, always_2d=False)
    except Exception as exc:  # noqa: BLE001
        try:
            os.remove(path)
        except OSError:
            pass
        abort(400, f"could not read WAV: {exc}")

    duration = audio.shape[0] / sr
    channels = 1 if audio.ndim == 1 else audio.shape[1]
    input_lufs = dsp.integrated_lufs(audio, sr)
    input_tp = dsp.true_peak_db(audio, sr)

    # Smart-tuner analysis: adaptive de-harsh band (targeted at the actual
    # resonance), adaptive mud depth, preset/lean suggestion, and the
    # whole-track band-envelope reference computed FOR THAT band (reused by
    # every preview so a clip matches the full render). Band + mud_gain are
    # track properties kept server-side, not user controls.
    try:
        band, mud_gain, env_db_ref, suggest = _analyze(audio, sr, duration)
    except Exception:  # noqa: BLE001 -- fall back to the default band on failure
        app.logger.exception("analyze failed")
        band, mud_gain, suggest = None, None, None
        env_db_ref = dsp.band_envelope_db(audio, sr)

    # Loudness AFTER the mud cut (chosen depth) -> previews gain off this so the
    # A/B level matches the export. De-harsh's own LUFS effect is negligible.
    _mud = dsp._MUD_GAIN_DB if mud_gain is None else mud_gain
    gain_lufs = dsp.integrated_lufs(dsp.cut_mud(audio, sr, gain_db=_mud), sr)
    if not np.isfinite(gain_lufs):
        gain_lufs = input_lufs

    meta = {
        "sr": sr,
        "duration": duration,
        "channels": channels,
        "input_lufs": None if not np.isfinite(input_lufs) else round(float(input_lufs), 2),
        "input_tp": round(float(input_tp), 2),
    }
    _remember(_UPLOADS, uid, {
        "path": path, "meta": meta, "env_db_ref": env_db_ref,
        "band": list(band) if band is not None else None, "mud_gain": mud_gain,
        "gain_lufs": None if not np.isfinite(gain_lufs) else float(gain_lufs),
    })

    try:
        spectrogram = _spectrogram(audio, sr)
    except Exception:  # noqa: BLE001 -- viz is optional, never fail the upload
        app.logger.exception("spectrogram failed")
        spectrogram = None

    try:
        warnings = _input_health(audio, sr, meta["input_lufs"], float(input_tp))
    except Exception:  # noqa: BLE001
        app.logger.exception("health failed")
        warnings = []

    return jsonify({"id": uid, "filename": upload.filename, "spectrogram": spectrogram,
                    "suggest": suggest, "warnings": warnings, **meta})


def _read_segment(path: str, start_s: float, dur_s: float):
    with sf.SoundFile(path) as f:
        sr = f.samplerate
        total = len(f)
        start = max(0, min(int(start_s * sr), max(0, total - 1)))
        n = max(1, min(int(dur_s * sr), total - start))
        f.seek(start)
        seg = f.read(n, dtype="float64", always_2d=False)
    return seg, sr


@app.post("/preview")
def preview():
    data = request.get_json(silent=True) or {}
    rec = _get_upload(data.get("id", ""))
    meta = rec["meta"]
    preset, intensity, threshold_pctl, ratio, static_db = _controls_from_request(data)

    try:
        dur = float(data.get("duration", 10))
        start = float(data.get("start", 0))
    except (TypeError, ValueError):
        abort(400, "start and duration must be numbers")
    dur = max(1.0, min(60.0, dur))
    need_original = bool(data.get("need_original", True))

    seg, sr = _read_segment(rec["path"], start, dur)
    # gain off the post-EQ (post-mud) whole-track loudness so the preview level
    # matches the export; fall back to raw input if unavailable.
    gain_lufs = rec.get("gain_lufs") if rec.get("gain_lufs") is not None else meta["input_lufs"]
    env_ref = rec["env_db_ref"]
    band = tuple(rec["band"]) if rec.get("band") else None       # adaptive band
    mud_gain = rec.get("mud_gain")                               # adaptive mud

    processed = dsp.process(
        seg, sr, preset=preset, intensity=intensity,
        threshold_pctl=threshold_pctl, ratio=ratio, static_db=static_db,
        env_db_ref=env_ref, measured_lufs=gain_lufs, band=band, mud_gain=mud_gain,
    )
    # level-matched original (same loudness gain + ceiling, no EQ) for a fair A/B
    original = dsp.normalize_loudness(seg, sr, measured_lufs=gain_lufs)

    dh = dsp.deharsh_metrics(seg, sr, preset=preset, intensity=intensity,
                             threshold_pctl=threshold_pctl, ratio=ratio,
                             static_db=static_db, env_db_ref=env_ref, band=band)
    gr_series = dsp.deharsh_gr_series(seg, sr, preset=preset, intensity=intensity,
                                      threshold_pctl=threshold_pctl, ratio=ratio,
                                      static_db=static_db, env_db_ref=env_ref, band=band)

    resp = {
        "processed_wav": _wav_data_uri(processed, sr),
        "spectrum": _spectrum_pair(original, processed, sr),
        "gr_series": gr_series,
        "band": list(band) if band else list(_DEFAULT_BAND),  # for the band highlight
        "metrics": {
            "input_lufs": meta["input_lufs"],
            "target_lufs": -14.0,
            "ceiling_dbtp": -1.0,
            "processed_tp": round(float(dsp.true_peak_db(processed, sr)), 2),
            "deharsh_peak_db": dh["peak_gr_db"],
            "deharsh_duty": dh["duty_pct"],
            "seg_start": round(float(start), 2),
            "seg_dur": round(float(seg.shape[0] / sr), 2),
        },
    }
    if need_original:
        resp["original_wav"] = _wav_data_uri(original, sr)
    return jsonify(resp)


@app.post("/process")
def process_full():
    data = request.get_json(silent=True) or {}
    rec = _get_upload(data.get("id", ""))
    preset, intensity, threshold_pctl, ratio, static_db = _controls_from_request(data)

    audio, sr = sf.read(rec["path"], always_2d=False)
    band = tuple(rec["band"]) if rec.get("band") else None
    processed = dsp.process(audio, sr, preset=preset, intensity=intensity,
                            threshold_pctl=threshold_pctl, ratio=ratio,
                            static_db=static_db, band=band, mud_gain=rec.get("mud_gain"))

    out_lufs = dsp.integrated_lufs(processed, sr)
    out_tp = dsp.true_peak_db(processed, sr)

    did = uuid.uuid4().hex
    out_path = os.path.join(_TMP, f"{did}_out.wav")
    sf.write(out_path, processed, sr, subtype="PCM_24")
    base = os.path.splitext(os.path.basename(data.get("filename", "track")))[0] or "track"
    _remember(_DOWNLOADS, did, {"path": out_path, "name": f"{base}_processed.wav"})

    return jsonify({
        "download_id": did,
        "metrics": {
            "output_lufs": None if not np.isfinite(out_lufs) else round(float(out_lufs), 2),
            "output_tp": round(float(out_tp), 2),
            "input_lufs": rec["meta"]["input_lufs"],
            "input_tp": rec["meta"]["input_tp"],
        },
    })


@app.get("/download/<did>")
def download(did: str):
    with _LOCK:
        rec = _DOWNLOADS.get(did)
    if rec is None:
        abort(404, "result not found (it may have expired) -- process again")
    return send_file(rec["path"], mimetype="audio/wav", as_attachment=True,
                     download_name=rec["name"])


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
def _json_error(err):
    return jsonify({"error": getattr(err, "description", str(err))}), err.code


@app.errorhandler(Exception)
def _unhandled(err):
    # never leak a stack-trace HTML page to the fetch() client -- return JSON
    app.logger.exception("unhandled error")
    return jsonify({"error": f"server error: {type(err).__name__}"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port)
