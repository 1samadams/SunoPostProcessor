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
    # whole-track band envelope distribution -> sets the de-harsh threshold
    # percentile; kept server-side (not sent to the client) and reused for
    # every preview so a clip matches the full render.
    env_db_ref = dsp.band_envelope_db(audio, sr)
    # Loudness AFTER the (static) mud cut. The final export normalizes off the
    # post-EQ loudness, so previews must gain off this -- not the raw input --
    # or the A/B plays at a different level than the download. De-harsh's own
    # effect on LUFS is negligible (it only touches brief spikes), so post-mud
    # is a faithful stand-in for post-full-chain loudness.
    gain_lufs = dsp.integrated_lufs(dsp.cut_mud(audio, sr), sr)
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
        "gain_lufs": None if not np.isfinite(gain_lufs) else float(gain_lufs),
    })

    return jsonify({"id": uid, "filename": upload.filename, **meta})


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

    processed = dsp.process(
        seg, sr, preset=preset, intensity=intensity,
        threshold_pctl=threshold_pctl, ratio=ratio, static_db=static_db,
        env_db_ref=env_ref, measured_lufs=gain_lufs,
    )
    # level-matched original (same loudness gain + ceiling, no EQ) for a fair A/B
    original = dsp.normalize_loudness(seg, sr, measured_lufs=gain_lufs)

    dh = dsp.deharsh_metrics(seg, sr, preset=preset, intensity=intensity,
                             threshold_pctl=threshold_pctl, ratio=ratio,
                             static_db=static_db, env_db_ref=env_ref)
    gr_series = dsp.deharsh_gr_series(seg, sr, preset=preset, intensity=intensity,
                                      threshold_pctl=threshold_pctl, ratio=ratio,
                                      static_db=static_db, env_db_ref=env_ref)

    resp = {
        "processed_wav": _wav_data_uri(processed, sr),
        "spectrum": _spectrum_pair(original, processed, sr),
        "gr_series": gr_series,
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
    processed = dsp.process(audio, sr, preset=preset, intensity=intensity,
                            threshold_pctl=threshold_pctl, ratio=ratio,
                            static_db=static_db)

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
