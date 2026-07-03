"""Web wrapper around the DSP core, deployable on Railway.

This is the deployable *skeleton* for the web-app direction: single-file
upload -> process -> download, reusing the pure functions in dsp.py unchanged.
The rich UI (before/after spectrum + loudness plots, batch table, live preset
preview) is Phase 2 proper, to be built after the preset values are ear-tuned.

Run locally:   python app.py            # Flask dev server on :8000
Production:    gunicorn app:app         # see Procfile / railway.json
Health check:  GET /health              # used by Railway
"""

from __future__ import annotations

import io
import os

import soundfile as sf
from flask import Flask, abort, render_template_string, request, send_file

import dsp

app = Flask(__name__)
# WAVs are large; allow generous uploads. Railway request timeout still applies.
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suno Post-Processor</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto;
         padding: 0 1rem; line-height: 1.5; }
  h1 { margin-bottom: .25rem; }
  p.sub { color: #888; margin-top: 0; }
  form { display: grid; gap: 1rem; margin-top: 2rem; }
  label { font-weight: 600; }
  .row { display: grid; gap: .35rem; }
  input[type=range] { width: 100%; }
  button { padding: .7rem 1rem; font-size: 1rem; font-weight: 600; cursor: pointer; }
  code { background: rgba(128,128,128,.18); padding: .1rem .35rem; border-radius: 4px; }
  .note { color: #888; font-size: .9rem; }
</style>
</head>
<body>
  <h1>Suno Post-Processor</h1>
  <p class="sub">De-harsh &rarr; mud cut &rarr; normalize to -14 LUFS / -1 dBTP</p>

  <form action="/process" method="post" enctype="multipart/form-data">
    <div class="row">
      <label for="file">WAV file</label>
      <input id="file" type="file" name="file" accept=".wav,audio/wav" required>
    </div>
    <div class="row">
      <label for="preset">De-harsh preset</label>
      <select id="preset" name="preset">
        {% for p in presets %}
        <option value="{{ p }}"{{ ' selected' if p == 'Standard' else '' }}>{{ p }}</option>
        {% endfor %}
      </select>
    </div>
    <div class="row">
      <label for="intensity">Intensity: <span id="ival">100</span>%</label>
      <input id="intensity" type="range" name="intensity" min="0" max="150" value="100"
             oninput="document.getElementById('ival').textContent = this.value">
    </div>
    <button type="submit">Process &amp; download</button>
  </form>

  <p class="note">Skeleton build &mdash; single file in, processed WAV out. Preset
  thresholds are unvalidated placeholders pending ear-tuning. Plots, batch mode
  and saved settings come in a later phase.</p>
</body>
</html>"""


@app.get("/health")
def health():
    """Liveness probe for Railway."""
    return {"status": "ok"}, 200


@app.get("/")
def index():
    return render_template_string(_PAGE, presets=list(dsp.PRESETS))


@app.post("/process")
def process():
    upload = request.files.get("file")
    if upload is None or upload.filename == "":
        abort(400, "no file uploaded")
    if not upload.filename.lower().endswith(".wav"):
        abort(400, "please upload a .wav file")

    preset = request.form.get("preset", "Standard")
    if preset not in dsp.PRESETS:
        abort(400, f"unknown preset {preset!r}")
    try:
        intensity = float(request.form.get("intensity", 100))
    except ValueError:
        abort(400, "intensity must be a number")

    try:
        audio, sr = sf.read(io.BytesIO(upload.read()), always_2d=False)
    except Exception as exc:  # noqa: BLE001
        abort(400, f"could not read WAV: {exc}")

    processed = dsp.process(audio, sr, preset, intensity)

    buf = io.BytesIO()
    sf.write(buf, processed, sr, subtype="PCM_24", format="WAV")
    buf.seek(0)
    base = os.path.splitext(os.path.basename(upload.filename))[0]
    return send_file(buf, mimetype="audio/wav", as_attachment=True,
                     download_name=f"{base}_processed.wav")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port)
