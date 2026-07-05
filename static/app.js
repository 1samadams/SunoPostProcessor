"use strict";

// t = threshold percentile (grabs loudest 100−t %), r = ratio, s = static cut dB
const PRESET_BASE = {
  Off: null,
  Gentle: { t: 96, r: 2, s: -1.0 },
  Standard: { t: 91, r: 3, s: -1.5 },
  Aggressive: { t: 84, r: 5, s: -3.0 },
};

const state = {
  id: null, filename: null, sr: 0, duration: 0, channels: 1, inputLufs: null,
  preset: "Standard", intensity: 100,
  custom: false, threshold: 91, ratio: 3, static: -1.5,
  band: [3000, 6000],   // adaptive de-harsh band (smart tuner picks it)
  dur: 10, start: 0,
  lastSegKey: null, seq: 0,
};

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const toast = (msg) => {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 4200);
};

// ---------------------------------------------------------------------------
// audio A/B: two elements play in sync, volume gates which one you hear
// ---------------------------------------------------------------------------
const aOrig = new Audio(), aProc = new Audio();
[aOrig, aProc].forEach((a) => { a.preload = "auto"; });
let active = "orig", playing = false;

function loadAudio(el, src) {
  return new Promise((resolve) => {
    const done = () => { el.removeEventListener("canplay", done); resolve(); };
    el.addEventListener("canplay", done);
    el.src = src;
    el.load();
  });
}
function applyGains() {
  aOrig.volume = active === "orig" ? 1 : 0;
  aProc.volume = active === "proc" ? 1 : 0;
}
function setActive(which) {
  active = which;
  $("ab-orig").dataset.active = which === "orig" ? "1" : "0";
  $("ab-proc").dataset.active = which === "proc" ? "1" : "0";
  applyGains();
}
async function togglePlay() {
  if (!aProc.src) return;
  if (playing) {
    aOrig.pause(); aProc.pause(); playing = false; $("play").innerHTML = "&#9658;";
  } else {
    const t = (active === "orig" ? aOrig : aProc).currentTime || 0;
    try { aOrig.currentTime = t; aProc.currentTime = t; } catch (e) {}
    applyGains();
    await Promise.allSettled([aOrig.play(), aProc.play()]);
    playing = true; $("play").innerHTML = "&#10073;&#10073;";
  }
}
// keep the muted element locked to the audible one; drive scrubber
aProc.addEventListener("timeupdate", () => {
  const lead = active === "orig" ? aOrig : aProc;
  const follow = active === "orig" ? aProc : aOrig;
  if (Math.abs(follow.currentTime - lead.currentTime) > 0.08) {
    try { follow.currentTime = lead.currentTime; } catch (e) {}
  }
  const d = lead.duration || state.dur || 1;
  const frac = Math.min(1, lead.currentTime / d);
  $("scrub-fill").style.width = `${frac * 100}%`;
  $("time").textContent = fmtTime(lead.currentTime);
  const ph = $("gr-playhead");
  ph.style.left = `${frac * 100}%`; ph.classList.add("on");
});
function onEnded() {
  playing = false; $("play").innerHTML = "&#9658;";
  $("scrub-fill").style.width = "0%";
  $("gr-playhead").classList.remove("on");
  try { aOrig.currentTime = 0; aProc.currentTime = 0; } catch (e) {}
}
aOrig.addEventListener("ended", onEnded);
aProc.addEventListener("ended", onEnded);

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------
const drop = $("drop");
$("browse").addEventListener("click", (e) => { e.stopPropagation(); $("file").click(); });
drop.addEventListener("click", () => $("file").click());
$("change").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => { if (e.target.files[0]) doUpload(e.target.files[0]); });
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) doUpload(f);
});

async function doUpload(file) {
  if (!file.name.toLowerCase().endsWith(".wav")) { toast("Please choose a .wav file"); return; }
  $("uploading").classList.remove("hidden");
  $("browse").parentElement.parentElement.classList.add("hidden");
  const fd = new FormData(); fd.append("file", file);
  try {
    const r = await fetch("/upload", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "upload failed");
    Object.assign(state, {
      id: data.id, filename: data.filename, sr: data.sr, duration: data.duration,
      channels: data.channels, inputLufs: data.input_lufs, start: 0, lastSegKey: null,
    });
    $("fname").textContent = data.filename;
    $("fdetail").textContent =
      `${data.sr.toLocaleString()} Hz · ${data.channels === 1 ? "mono" : "stereo"} · `
      + `${fmtTime(data.duration)} · in ${data.input_lufs ?? "–"} LUFS · ${data.input_tp} dBTP`;
    $("start").max = Math.max(0, data.duration - state.dur).toFixed(1);
    $("start").value = 0; $("start-val").textContent = "0:00";
    $("workspace").classList.remove("hidden");
    renderWarnings(data.warnings);
    applySuggestion(data.suggest);   // sets state.band before we draw the map
    if (data.spectrogram) {
      specgram = decodeSpectrogram(data.spectrogram);
      $("specgram-card").classList.remove("hidden");
      drawSpectrogram(specgram);
    } else {
      specgram = null; $("specgram-card").classList.add("hidden");
    }
    refreshPreview(true);
  } catch (err) {
    toast(err.message);
    $("drop").classList.remove("hidden");
  } finally {
    $("uploading").classList.add("hidden");
    $("drop").querySelector(".drop-inner").classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
$("presets").addEventListener("click", (e) => {
  const b = e.target.closest(".seg"); if (!b) return;
  hideSuggest();
  state.preset = b.dataset.preset;
  [...$("presets").children].forEach((s) => s.dataset.active = s === b ? "1" : "0");
  // snap advanced sliders to preset, leave custom mode
  state.custom = false; $("custom").checked = false;
  syncAdvancedDisabled();
  const base = PRESET_BASE[state.preset];
  if (base) {
    state.threshold = base.t; state.ratio = base.r; state.static = base.s;
    $("threshold").value = base.t; $("ratio").value = base.r; $("static").value = base.s;
    updateAdvancedLabels();
  }
  markPresetModified(false);
  refreshPreview(false);
});
$("durs").addEventListener("click", (e) => {
  const b = e.target.closest(".seg"); if (!b) return;
  state.dur = +b.dataset.dur;
  [...$("durs").children].forEach((s) => s.dataset.active = s === b ? "1" : "0");
  const max = Math.max(0, state.duration - state.dur);
  $("start").max = max.toFixed(1);
  if (state.start > max) { state.start = max; $("start").value = max; $("start-val").textContent = fmtTime(max); }
  refreshPreview(true);
});
$("intensity").addEventListener("input", (e) => {
  hideSuggest();
  state.intensity = +e.target.value; $("intensity-val").textContent = `${state.intensity}%`;
  refreshPreview(false);
});
$("start").addEventListener("input", (e) => {
  state.start = +e.target.value; $("start-val").textContent = fmtTime(state.start);
  refreshPreview(true);
});
$("custom").addEventListener("change", (e) => {
  hideSuggest();
  state.custom = e.target.checked; syncAdvancedDisabled(); markPresetModified(state.custom);
  refreshPreview(false);
});
function enterCustom() {
  hideSuggest();
  if (!state.custom) { state.custom = true; $("custom").checked = true; syncAdvancedDisabled(); markPresetModified(true); }
}
$("static").addEventListener("input", (e) => {
  state.static = +e.target.value; updateAdvancedLabels(); enterCustom(); refreshPreview(false);
});
$("threshold").addEventListener("input", (e) => {
  state.threshold = +e.target.value; updateAdvancedLabels(); enterCustom(); refreshPreview(false);
});
$("ratio").addEventListener("input", (e) => {
  state.ratio = +e.target.value; updateAdvancedLabels(); enterCustom(); refreshPreview(false);
});
$("ab-orig").addEventListener("click", () => setActive("orig"));
$("ab-proc").addEventListener("click", () => setActive("proc"));
$("play").addEventListener("click", togglePlay);

function syncAdvancedDisabled() {
  const off = state.preset === "Off";
  $("static").disabled = !state.custom || off;
  $("threshold").disabled = !state.custom || off;
  $("ratio").disabled = !state.custom || off;
}
function updateAdvancedLabels() {
  const s = +state.static;
  $("static-val").textContent = `${s < 0 ? "−" : ""}${Math.abs(s).toFixed(1)} dB`;
  $("threshold-val").textContent = `grabs top ${Math.round(100 - state.threshold)}%`;
  $("ratio-val").textContent = `${(+state.ratio).toFixed(1)}:1`;
}
function markPresetModified(on) {
  [...$("presets").children].forEach((s) => s.classList.toggle("mod", on && s.dataset.active === "1"));
}

// ---------------------------------------------------------------------------
// auto-suggest: apply the machine's picked settings + show why
// ---------------------------------------------------------------------------
function applySuggestion(sug) {
  const banner = $("suggest");
  if (!sug) { banner.classList.add("hidden"); return; }

  if (sug.band) state.band = sug.band;            // adaptive de-harsh band
  state.preset = sug.preset;
  [...$("presets").children].forEach((s) => s.dataset.active = s.dataset.preset === sug.preset ? "1" : "0");
  state.intensity = sug.intensity;
  $("intensity").value = sug.intensity; $("intensity-val").textContent = `${sug.intensity}%`;

  const base = PRESET_BASE[sug.preset];
  if (sug.custom && sug.static_db != null) {
    state.custom = true; $("custom").checked = true;
    state.static = sug.static_db; state.threshold = sug.threshold_pctl; state.ratio = sug.ratio;
  } else {
    state.custom = false; $("custom").checked = false;
    if (base) { state.static = base.s; state.threshold = base.t; state.ratio = base.r; }
  }
  $("static").value = state.static; $("threshold").value = state.threshold; $("ratio").value = state.ratio;
  updateAdvancedLabels(); syncAdvancedDisabled(); markPresetModified(sug.custom);

  // auto-jump the preview to where the harshness actually lives
  if (sug.harsh_start != null) {
    const max = Math.max(0, state.duration - state.dur);
    state.start = Math.min(sug.harsh_start, max);
    $("start").value = state.start; $("start-val").textContent = fmtTime(state.start);
  }

  let extra = "";
  if (sug.custom && base && sug.static_db != null) {
    extra = sug.static_db < base.s - 0.3 ? " + extra static"
      : sug.static_db > base.s + 0.3 ? " (leaner, more dynamic)" : "";
  }
  $("suggest-title").textContent = sug.preset === "Off"
    ? "Auto: leave it — already clean" : `Auto-picked: ${sug.preset}${extra}`;
  const conf = $("suggest-conf");
  conf.classList.toggle("hidden", sug.confidence !== "borderline");
  const parts = [];
  if (sug.band_display && sug.preset !== "Off") parts.push(`targeting ${sug.band_display}`);
  if (sug.mud_db != null) parts.push(`mud ${sug.mud_db} dB`);
  if (sug.harsh_start) parts.push(`preview @ ${fmtTime(sug.harsh_start)}`);
  $("suggest-sub").textContent = parts.join(" · ");
  const ul = $("suggest-reasons"); ul.innerHTML = "";
  (sug.reasons || []).forEach((r) => { const li = document.createElement("li"); li.textContent = r; ul.appendChild(li); });
  const note = $("suggest-note");
  if (sug.band_note) { note.textContent = "⚠ " + sug.band_note; note.classList.remove("hidden"); }
  else note.classList.add("hidden");
  banner.classList.remove("hidden");
}
const hideSuggest = () => $("suggest").classList.add("hidden");

function renderWarnings(warnings) {
  const el = $("warnings");
  if (!warnings || !warnings.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.innerHTML = '<div class="w-head">Heads up</div><ul>'
    + warnings.map((w) => `<li>${w.replace(/</g, "&lt;")}</li>`).join("") + "</ul>";
  el.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// preview (debounced)
// ---------------------------------------------------------------------------
let debounceTimer = null;
function refreshPreview(segmentChanged) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runPreview(segmentChanged), 320);
}

async function runPreview(segmentChanged) {
  if (!state.id) return;
  const segKey = `${state.dur}@${state.start}`;
  const needOriginal = segmentChanged || segKey !== state.lastSegKey;
  const mySeq = ++state.seq;
  $("render-status").classList.remove("hidden");

  const body = {
    id: state.id, preset: state.preset, intensity: state.intensity,
    custom: state.custom, threshold_pctl: state.threshold, ratio: state.ratio,
    static_db: state.static,
    duration: state.dur, start: state.start, need_original: needOriginal,
  };
  try {
    const r = await fetch("/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "preview failed");
    if (mySeq !== state.seq) return; // a newer request superseded this one
    state.lastSegKey = segKey;
    await applyPreview(data, needOriginal);
    if (data.band) state.band = data.band;   // keep highlight synced to server
    lastSpectrum = data.spectrum; lastGr = data.gr_series;
    drawSpectrum(data.spectrum);
    drawSpectrumDiff(data.spectrum);
    drawGRTimeline(data.gr_series);
    updateMetrics(data.metrics);
  } catch (err) {
    if (mySeq === state.seq) toast(err.message);
  } finally {
    if (mySeq === state.seq) $("render-status").classList.add("hidden");
  }
}

async function applyPreview(data, reloadOriginal) {
  const wasPlaying = playing;
  const lead = active === "orig" ? aOrig : aProc;
  const keepT = reloadOriginal ? 0 : (lead.currentTime || 0);

  const loads = [loadAudio(aProc, data.processed_wav)];
  if (reloadOriginal && data.original_wav) loads.push(loadAudio(aOrig, data.original_wav));
  await Promise.all(loads);

  try { aProc.currentTime = keepT; aOrig.currentTime = keepT; } catch (e) {}
  applyGains();
  if (wasPlaying) { await Promise.allSettled([aOrig.play(), aProc.play()]); }
}

function cls(el, ok, warn) {
  el.classList.remove("good", "warn", "bad");
  if (ok) el.classList.add("good"); else if (warn) el.classList.add("warn"); else el.classList.add("bad");
}
function updateMetrics(m) {
  $("m-in").textContent = m.input_lufs ?? "–";
  $("m-tp").textContent = m.processed_tp.toFixed(1);
  cls($("m-tp"), m.processed_tp <= m.ceiling_dbtp + 0.05, false);
  const dh = m.deharsh_peak_db;  // peak gain reduction on the worst spike (<= 0)
  $("m-dh").textContent = dh.toFixed(1);
  $("m-dh").title = dh < 0 ? `engaging ${m.deharsh_duty}% of the clip` : "de-harsh off / not engaging";
  // reduction is always <= 0; green when actively working, neutral otherwise (never "bad")
  $("m-dh").classList.remove("good", "warn", "bad");
  if (dh <= -0.5) $("m-dh").classList.add("good");
  updateLoudness(m);
}

// ---------------------------------------------------------------------------
// spectrum + gain-reduction timeline + spectral difference
// ---------------------------------------------------------------------------
let lastSpectrum = null, lastGr = null;

function drawSpectrum(spec) {
  const cv = $("spectrum");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 640, H = 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const f = spec.freqs, o = spec.orig_db, p = spec.proc_db;
  const fmin = f[0], fmax = f[f.length - 1];
  const all = o.concat(p);
  let dbMax = Math.max(...all) + 4, dbMin = Math.min(...all) - 2;
  if (dbMax - dbMin < 20) dbMin = dbMax - 20;
  const pad = 6;
  const x = (freq) => pad + (Math.log10(freq) - Math.log10(fmin)) /
    (Math.log10(fmax) - Math.log10(fmin)) * (W - 2 * pad);
  const y = (db) => pad + (1 - (db - dbMin) / (dbMax - dbMin)) * (H - 2 * pad);

  // highlighted bands
  const band = (lo, hi, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x(lo), pad, x(hi) - x(lo), H - 2 * pad);
  };
  band(200, 400, "rgba(251,191,36,.10)");
  band(state.band[0], state.band[1], "rgba(124,92,255,.13)");

  // gridlines
  ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.font = "10px system-ui"; ctx.lineWidth = 1;
  [100, 1000, 10000].forEach((fr) => {
    if (fr < fmin || fr > fmax) return;
    const xx = x(fr);
    ctx.beginPath(); ctx.moveTo(xx, pad); ctx.lineTo(xx, H - pad); ctx.stroke();
    ctx.fillText(fr >= 1000 ? `${fr / 1000}k` : `${fr}`, xx + 3, H - pad - 2);
  });

  const line = (arr, color, width, alpha) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < f.length; i++) {
      const xx = x(f[i]), yy = y(arr[i]);
      i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  };
  line(o, "#6b7280", 1.5, 0.9);
  line(p, "#22d3ee", 2, 1);
}

// exact dB removed/added at each frequency (processed − original)
function drawSpectrumDiff(spec) {
  const cv = $("specdiff");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 640, H = 70;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

  const f = spec.freqs, fmin = f[0], fmax = f[f.length - 1];
  const diff = spec.proc_db.map((v, i) => v - spec.orig_db[i]);
  let mag = Math.min(12, Math.max(2, Math.ceil(Math.max(...diff.map(Math.abs)))));
  const pad = 6;
  const x = (fr) => pad + (Math.log10(fr) - Math.log10(fmin)) /
    (Math.log10(fmax) - Math.log10(fmin)) * (W - 2 * pad);
  const y = (d) => pad + (1 - (Math.max(-mag, Math.min(mag, d)) + mag) / (2 * mag)) * (H - 2 * pad);

  const band = (lo, hi, c) => { ctx.fillStyle = c; ctx.fillRect(x(lo), pad, x(hi) - x(lo), H - 2 * pad); };
  band(200, 400, "rgba(251,191,36,.10)");
  band(state.band[0], state.band[1], "rgba(124,92,255,.13)");

  ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.3)"; ctx.font = "9px system-ui";
  ctx.fillText(`+${mag}`, 2, y(mag) + 8); ctx.fillText(`−${mag} dB`, 2, y(-mag) - 2);

  ctx.beginPath();
  for (let i = 0; i < f.length; i++) { const xx = x(f[i]), yy = y(diff[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
  ctx.lineTo(x(fmax), y(0)); ctx.lineTo(x(fmin), y(0)); ctx.closePath();
  ctx.fillStyle = "rgba(251,191,36,.16)"; ctx.fill();
  ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < f.length; i++) { const xx = x(f[i]), yy = y(diff[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
  ctx.stroke();
}

// de-harsh gain reduction (dB, <= 0) across the clip; playhead tracks playback
function drawGRTimeline(series) {
  const cv = $("grtl");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 640, H = 70;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

  const n = series.length, pad = 6;
  const range = Math.min(18, Math.max(6, Math.ceil(-Math.min(0, ...series))));
  const x = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (db) => pad + (-Math.max(-range, Math.min(0, db)) / range) * (H - 2 * pad);

  ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.fillStyle = "rgba(255,255,255,.3)";
  ctx.font = "9px system-ui"; ctx.lineWidth = 1;
  for (let g = Math.max(3, Math.round(range / 3)); g < range; g += Math.max(3, Math.round(range / 3))) {
    const yy = y(-g); ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - pad, yy); ctx.stroke();
    ctx.fillText(`−${g}`, 2, yy - 1);
  }
  ctx.strokeStyle = "rgba(255,255,255,.15)"; ctx.beginPath();
  ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke();

  ctx.beginPath(); ctx.moveTo(x(0), y(0));
  for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(series[i]));
  ctx.lineTo(x(n - 1), y(0)); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(124,92,255,.12)"); grad.addColorStop(1, "rgba(124,92,255,.45)");
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = "#7c5cff"; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < n; i++) { const xx = x(i), yy = y(series[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
  ctx.stroke();

  $("gr-scale").textContent = `0 to −${range} dB`;
}

// ---------------------------------------------------------------------------
// whole-track spectrogram (input harshness map)
// ---------------------------------------------------------------------------
const MAGMA = (() => {
  const a = [[0, 0, 0, 4], [.25, 81, 18, 124], [.5, 183, 55, 121], [.75, 252, 137, 97], [1, 252, 253, 191]];
  const r = new Uint8Array(256), g = new Uint8Array(256), b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255; let lo = a[0], hi = a[a.length - 1];
    for (let k = 0; k < a.length - 1; k++) if (x >= a[k][0] && x <= a[k + 1][0]) { lo = a[k]; hi = a[k + 1]; break; }
    const t = (x - lo[0]) / ((hi[0] - lo[0]) || 1);
    r[i] = lo[1] + (hi[1] - lo[1]) * t; g[i] = lo[2] + (hi[2] - lo[2]) * t; b[i] = lo[3] + (hi[3] - lo[3]) * t;
  }
  return { r, g, b };
})();
let specgram = null;  // {n_time,n_freq,fmin,fmax,bytes}

function decodeSpectrogram(sg) {
  const bin = atob(sg.data), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return { n_time: sg.n_time, n_freq: sg.n_freq, fmin: sg.fmin, fmax: sg.fmax, bytes: u };
}

function drawSpectrogram(sg) {
  const cv = $("specgram"), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const T = sg.n_time, F = sg.n_freq, bytes = sg.bytes;
  const off = document.createElement("canvas"); off.width = T; off.height = F;
  const octx = off.getContext("2d"), img = octx.createImageData(T, F);
  for (let fi = 0; fi < F; fi++) {
    const dst = (F - 1 - fi) * T;                 // invert: high freq at top
    for (let ti = 0; ti < T; ti++) {
      const v = bytes[fi * T + ti], p = (dst + ti) * 4;
      img.data[p] = MAGMA.r[v]; img.data[p + 1] = MAGMA.g[v]; img.data[p + 2] = MAGMA.b[v]; img.data[p + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, T, F, 0, 0, W, H);

  const lo = Math.log10(sg.fmin), hi = Math.log10(sg.fmax);
  const yOf = (fr) => (1 - (Math.log10(fr) - lo) / (hi - lo)) * H;
  const [bLo, bHi] = state.band;
  ctx.fillStyle = "rgba(124,92,255,.16)";
  ctx.fillRect(0, yOf(bHi), W, yOf(bLo) - yOf(bHi));             // targeted de-harsh band
  ctx.strokeStyle = "rgba(124,92,255,.55)"; ctx.lineWidth = 1;
  [bLo, bHi].forEach((fr) => { const y = yOf(fr); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });

  const ax = $("sg-yaxis"); ax.innerHTML = "";
  [100, 1000, 3000, 6000, 10000].forEach((fr) => {
    if (fr < sg.fmin || fr > sg.fmax) return;
    const s = document.createElement("span");
    s.style.top = `${(yOf(fr) / H) * 100}%`;
    s.textContent = fr >= 1000 ? `${fr / 1000}k` : `${fr}`;
    ax.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// graphical loudness / true-peak meter
// ---------------------------------------------------------------------------
const pct = (v, lo, hi) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
function updateLoudness(m) {
  if (m.input_lufs == null) return;
  const LMIN = -24, LMAX = -6;
  $("lufs-fill").style.width = `${pct(m.target_lufs, LMIN, LMAX)}%`;
  $("lufs-target").style.left = `${pct(m.target_lufs, LMIN, LMAX)}%`;
  $("lufs-in").style.left = `${pct(m.input_lufs, LMIN, LMAX)}%`;
  $("lufs-txt").textContent = `${m.input_lufs}→${m.target_lufs}`;
  const PMIN = -18, PMAX = 0;
  $("tp-fill").style.width = `${pct(m.processed_tp, PMIN, PMAX)}%`;
  $("tp-ceil").style.left = `${pct(m.ceiling_dbtp, PMIN, PMAX)}%`;
  $("tp2-txt").textContent = `${m.processed_tp}`;
}

let _resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeT);
  _resizeT = setTimeout(() => {
    if (lastSpectrum) { drawSpectrum(lastSpectrum); drawSpectrumDiff(lastSpectrum); }
    if (lastGr) drawGRTimeline(lastGr);
    if (specgram) drawSpectrogram(specgram);
  }, 150);
});

// ---------------------------------------------------------------------------
// commit: full track
// ---------------------------------------------------------------------------
$("commit").addEventListener("click", async () => {
  if (!state.id) return;
  const btn = $("commit"); btn.disabled = true;
  const st = $("commit-status");
  st.classList.remove("hidden");
  st.innerHTML = `<span class="spinner"></span> Processing full track (${fmtTime(state.duration)})…`;
  try {
    const r = await fetch("/process", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.id, filename: state.filename, preset: state.preset,
        intensity: state.intensity, custom: state.custom,
        threshold_pctl: state.threshold, ratio: state.ratio, static_db: state.static,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "processing failed");
    const m = data.metrics;
    const a = document.createElement("a");
    a.href = `/download/${data.download_id}`;
    a.textContent = "Download processed WAV";
    st.innerHTML =
      `✅ Done — output <strong>${m.output_lufs ?? "–"} LUFS</strong>, `
      + `true peak <strong>${m.output_tp} dBTP</strong> `
      + `(was ${m.input_lufs ?? "–"} LUFS / ${m.input_tp} dBTP). `;
    st.appendChild(a);
    a.click();
  } catch (err) {
    st.innerHTML = ""; st.textContent = "⚠ " + err.message;
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// keyboard: space toggles play
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && state.id && e.target.tagName !== "INPUT" && e.target.tagName !== "BUTTON") {
    e.preventDefault(); togglePlay();
  }
});

updateAdvancedLabels();
syncAdvancedDisabled();
