"use strict";

// t = threshold percentile (grabs loudest 100−t %), r = ratio, s = static cut dB
const PRESET_BASE = {
  Off: null,
  Gentle: { t: 96, r: 2, s: -1.0 },
  Standard: { t: 91, r: 3, s: -1.5 },
  Aggressive: { t: 84, r: 5, s: -3.0 },
};

// CRT amber phosphor palette (mirrors --tokens in style.css; used by canvas draws)
const PAL = {
  bg: "#080b09", accent: "#ffc46b", accent2: "#ff9d3d",
  orig: "#6a5a34", proc: "#ffc46b", band: "#ff9d3d", mud: "#e0b060",
  grid: "#3a2e12", muted: "#9c8f72", text: "#f0e6d2",
  good: "#ffc46b", warn: "#ffb454", bad: "#ff6b4a",
};
const alpha = (hex, a) => {
  hex = hex.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

const state = {
  id: null, filename: null, sr: 0, duration: 0, channels: 1, inputLufs: null,
  preset: "Standard", intensity: 100,
  custom: false, threshold: 91, ratio: 3, static: -1.5,
  band: [3000, 6000],   // adaptive de-harsh band (smart tuner picks it)
  mudDb: null, cleanup: [],   // for the live "will apply" commit plan
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
// audio A/B: three elements play in sync (aProc is the master clock), volume
// gates which one you hear — Original, Processed, or Removed (what's cut).
// ---------------------------------------------------------------------------
const aOrig = new Audio(), aProc = new Audio(), aDiff = new Audio();
const A_ALL = [aOrig, aProc, aDiff];
A_ALL.forEach((a) => { a.preload = "auto"; });
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
  aDiff.volume = active === "diff" ? 1 : 0;
}
function setActive(which) {
  if (which === "diff" && !aDiff.src) return;
  active = which;
  $("ab-orig").dataset.active = which === "orig" ? "1" : "0";
  $("ab-proc").dataset.active = which === "proc" ? "1" : "0";
  $("ab-diff").dataset.active = which === "diff" ? "1" : "0";
  $("ab-hint").classList.toggle("hidden", which !== "diff");
  applyGains();
  flashRedraw();
  if (lastSpectrum) drawSpectrum(lastSpectrum);   // re-emphasise the active curve
}
function flashRedraw() {
  const rn = $("render-status"); if (!rn) return;
  rn.classList.remove("hidden");
  clearTimeout(flashRedraw._t);
  flashRedraw._t = setTimeout(() => rn.classList.add("hidden"), 450);
}
async function togglePlay() {
  if (!aProc.src) return;
  if (playing) {
    A_ALL.forEach((a) => a.pause()); playing = false; $("play").innerHTML = "&#9658;";
  } else {
    const t = aProc.currentTime || 0;
    A_ALL.forEach((a) => { if (a.src) { try { a.currentTime = t; } catch (e) {} } });
    applyGains();
    await Promise.allSettled(A_ALL.filter((a) => a.src).map((a) => a.play()));
    playing = true; $("play").innerHTML = "&#10074;&#10074;";
  }
}
// aProc is the master clock; keep the others locked to it and drive the scrubber
aProc.addEventListener("timeupdate", () => {
  [aOrig, aDiff].forEach((a) => {
    if (a.src && Math.abs(a.currentTime - aProc.currentTime) > 0.08) {
      try { a.currentTime = aProc.currentTime; } catch (e) {}
    }
  });
  const d = aProc.duration || state.dur || 1;
  const frac = Math.min(1, aProc.currentTime / d);
  $("scrub-fill").style.width = `${frac * 100}%`;
  $("time").textContent = `${fmtTime(state.start + aProc.currentTime)} / ${fmtTime(d)}`;
  const ph = $("gr-playhead");
  ph.style.left = `${frac * 100}%`; ph.classList.add("on");
});
function onEnded() {
  playing = false; $("play").innerHTML = "&#9658;";
  $("scrub-fill").style.width = "0%";
  $("gr-playhead").classList.remove("on");
  A_ALL.forEach((a) => { try { a.currentTime = 0; } catch (e) {} });
}
aProc.addEventListener("ended", onEnded);

// ---------------------------------------------------------------------------
// upload — the CRT drop screen is the drop target; LOAD opens the file picker
// ---------------------------------------------------------------------------
const crt = document.querySelector(".crt");
$("load").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => { if (e.target.files[0]) doUpload(e.target.files[0]); });
["dragenter", "dragover"].forEach((ev) =>
  crt.addEventListener(ev, (e) => { e.preventDefault(); crt.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  crt.addEventListener(ev, (e) => { e.preventDefault(); crt.classList.remove("drag"); }));
crt.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) doUpload(f);
});

// EJECT -> back to the NO SIGNAL screen (production upload/empty state)
$("eject").addEventListener("click", () => {
  if (playing) togglePlay();
  A_ALL.forEach((a) => { a.pause(); a.removeAttribute("src"); a.load(); });
  state.id = null;
  showDrop(true);
});

function showDrop(on) {
  $("screen-work").style.display = on ? "none" : "block";
  $("screen-drop").style.display = on ? "block" : "none";
  $("panel").classList.toggle("off", on);
  $("topfile").classList.toggle("dim", on);
  if (on) { drawDropLine(); $("topfile-text").textContent = "no signal"; }
}

async function doUpload(file) {
  if (!file.name.toLowerCase().endsWith(".wav")) { toast("Please choose a .wav file"); return; }
  $("uploading").classList.remove("hidden");
  $("load").classList.add("hidden");
  const fd = new FormData(); fd.append("file", file);
  try {
    const r = await fetch("/upload", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "upload failed");
    Object.assign(state, {
      id: data.id, filename: data.filename, sr: data.sr, duration: data.duration,
      channels: data.channels, inputLufs: data.input_lufs, start: 0, lastSegKey: null,
    });
    $("topfile-text").textContent =
      `${data.filename} · ${(data.sr / 1000).toFixed(1)}k / `
      + `${data.channels === 1 ? "mono" : "stereo"} · ${fmtTime(data.duration)}`;
    $("start").max = Math.max(0, data.duration - state.dur).toFixed(1);
    $("start").value = 0; $("start-val").textContent = "0:00";
    showDrop(false);
    renderAssessment(data.assessment);
    renderWarnings(data.warnings);
    applySuggestion(data.suggest);   // sets state.band before we draw the map
    if (data.spectrogram) {
      specgram = decodeSpectrogram(data.spectrogram);
      drawSpectrogram(specgram);
    } else {
      specgram = null;
    }
    refreshPreview(true);
  } catch (err) {
    toast(err.message);
    showDrop(true);
  } finally {
    $("uploading").classList.add("hidden");
    $("load").classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
$("presets").addEventListener("click", (e) => {
  const b = e.target.closest(".seg"); if (!b) return;
  hideSuggestConf();
  state.preset = b.dataset.preset;
  [...$("presets").children].forEach((s) => s.dataset.active = s === b ? "1" : "0");
  // snap advanced sliders to preset, leave custom mode
  state.custom = false;
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
  hideSuggestConf();
  state.intensity = +e.target.value; $("intensity-val").textContent = `${state.intensity}%`;
  $("sug-title").textContent = `${state.preset.toUpperCase()} · ${state.intensity}%`;
  refreshPreview(false);
});
$("start").addEventListener("input", (e) => {
  state.start = +e.target.value; $("start-val").textContent = fmtTime(state.start);
  refreshPreview(true);
});
// moving any advanced slider hand-tunes (overrides the preset) — no checkbox needed
function enterCustom() {
  hideSuggestConf();
  if (!state.custom) { state.custom = true; markPresetModified(true); }
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
$("ab-diff").addEventListener("click", () => setActive("diff"));
$("play").addEventListener("click", togglePlay);

function updateAdvancedLabels() {
  const s = +state.static;
  $("static-val").textContent = `${s < 0 ? "−" : ""}${Math.abs(s).toFixed(1)} dB`;
  $("threshold-val").textContent = `top ${Math.round(100 - state.threshold)}%`;
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
  state.mudDb = sug.mud_db; state.cleanup = sug.cleanup || [];
  state.preset = sug.preset;
  [...$("presets").children].forEach((s) => s.dataset.active = s.dataset.preset === sug.preset ? "1" : "0");
  state.intensity = sug.intensity;
  $("intensity").value = sug.intensity; $("intensity-val").textContent = `${sug.intensity}%`;

  const base = PRESET_BASE[sug.preset];
  if (sug.custom && sug.static_db != null) {
    state.custom = true;
    state.static = sug.static_db; state.threshold = sug.threshold_pctl; state.ratio = sug.ratio;
  } else {
    state.custom = false;
    if (base) { state.static = base.s; state.threshold = base.t; state.ratio = base.r; }
  }
  $("static").value = state.static; $("threshold").value = state.threshold; $("ratio").value = state.ratio;
  updateAdvancedLabels(); markPresetModified(sug.custom);

  // auto-jump the preview to where the harshness actually lives
  if (sug.harsh_start != null) {
    const max = Math.max(0, state.duration - state.dur);
    state.start = Math.min(sug.harsh_start, max);
    $("start").value = state.start; $("start-val").textContent = fmtTime(state.start);
  }

  $("sug-title").textContent = `${sug.preset.toUpperCase()} · ${sug.intensity}%`;
  $("sug-conf").classList.toggle("hidden", sug.confidence !== "borderline");

  const lines = [];
  (sug.reasons || []).forEach((r) => lines.push({ text: r, cleanup: false }));
  (sug.cleanup || []).forEach((r) => lines.push({ text: r, cleanup: true }));
  const tail = [];
  if (sug.band_display && sug.preset !== "Off") tail.push(`targeting ${sug.band_display}`);
  if (sug.mud_db != null) tail.push(`mud ${sug.mud_db} dB`);
  if (sug.harsh_start) tail.push(`preview @ ${fmtTime(sug.harsh_start)}`);
  if (tail.length) lines.push({ text: tail.join(" · "), cleanup: false });

  $("sug-sub").innerHTML = lines.map((l) =>
    `<span class="rline${l.cleanup ? " cleanup" : ""}">${esc(l.text)}</span>`).join("");

  const note = $("sug-note");
  if (sug.band_note) { note.textContent = "⚠ " + sug.band_note; note.classList.remove("hidden"); }
  else note.classList.add("hidden");
  banner.classList.remove("hidden");
}
const hideSuggestConf = () => $("sug-conf").classList.add("hidden");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function renderWarnings(warnings) {
  const el = $("warnings");
  if (!warnings || !warnings.length) { el.classList.add("hidden"); return; }
  $("warnings-body").innerHTML = warnings.map((w) => `<span class="hline">${esc(w)}</span>`).join("");
  el.classList.remove("hidden");
}

function renderAssessment(a) {
  const el = $("assessment");
  if (!a) { el.classList.add("hidden"); return; }
  $("assess-headline").textContent = a.headline;
  $("assess-items").innerHTML = (a.items || []).map((it) =>
    `<div class="assess-item"><span class="assess-topic">${esc(it.topic)}</span>`
    + `<span class="assess-plain">${esc(it.plain)}</span>`
    + `<span class="assess-tech">${esc(it.tech)}</span></div>`).join("");
  $("assess-plan").innerHTML = `<strong>${esc(a.plan).replace("Plan:", "Plan:</strong>")}`;
  el.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// live "will apply" plan under the PROCESS button — exactly what commit renders
// ---------------------------------------------------------------------------
function updateCommitPlan() {
  const el = $("commit-note");
  if (!el) return;
  const parts = [];
  parts.push(state.preset === "Off" ? "de-harsh off"
    : `de-harsh ${state.preset.toLowerCase()}${state.custom ? " (custom)" : ""}`
      + (state.intensity !== 100 ? ` @ ${state.intensity}%` : ""));
  if (state.mudDb != null) parts.push(`mud ${state.mudDb} dB`);
  (state.cleanup || []).forEach((c) => {
    if (/rumble/.test(c)) parts.push("sub-HPF 30 Hz");
    else if (/clip/.test(c)) parts.push("de-clip");
  });
  parts.push("normalize −14 LUFS / −1 dBTP");
  el.textContent = parts.join(" · ");
}

// ---------------------------------------------------------------------------
// preview (debounced)
// ---------------------------------------------------------------------------
let debounceTimer = null;
function refreshPreview(segmentChanged) {
  updateCommitPlan();
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
    drawGRTimeline(data.gr_series);
    updateMetrics(data.metrics);
    if (specgram) drawSpectrogram(specgram);  // refresh band markers
  } catch (err) {
    if (mySeq === state.seq) toast(err.message);
  } finally {
    if (mySeq === state.seq) $("render-status").classList.add("hidden");
  }
}

async function applyPreview(data, reloadOriginal) {
  const wasPlaying = playing;
  const keepT = reloadOriginal ? 0 : (aProc.currentTime || 0);

  const loads = [loadAudio(aProc, data.processed_wav)];
  if (data.diff_wav) loads.push(loadAudio(aDiff, data.diff_wav));  // Removed monitor
  if (reloadOriginal && data.original_wav) loads.push(loadAudio(aOrig, data.original_wav));
  await Promise.all(loads);

  A_ALL.forEach((a) => { if (a.src) { try { a.currentTime = keepT; } catch (e) {} } });
  applyGains();
  if (wasPlaying) { await Promise.allSettled(A_ALL.filter((a) => a.src).map((a) => a.play())); }
}

// ---------------------------------------------------------------------------
// readouts + LED metering
// ---------------------------------------------------------------------------
function updateMetrics(m) {
  const neg = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
  $("m-in").textContent = m.input_lufs != null ? neg(m.input_lufs) : "−–";
  $("m-out").textContent = neg(m.target_lufs);
  $("m-tp").textContent = neg(m.processed_tp);
  const tpEl = $("m-tp");
  tpEl.classList.toggle("bad", m.processed_tp > m.ceiling_dbtp + 0.05);

  const dh = Math.abs(m.deharsh_peak_db);  // peak gain reduction magnitude
  $("m-dh").textContent = dh.toFixed(1);
  $("m-dh").title = m.deharsh_peak_db < 0 ? `engaging ${m.deharsh_duty}% of the clip` : "de-harsh off / not engaging";

  updateLadder(dh);
  updateLoudness(m);
}

function updateLadder(dh) {
  const lad = $("led-ladder"), segs = [...lad.children], n = segs.length;
  const lit = Math.round(Math.max(0, Math.min(1, dh / 8)) * n);
  segs.forEach((s, i) => {
    const on = i < lit, hot = i >= n - 2, warm = i >= n - 5;
    const col = hot ? PAL.bad : warm ? PAL.warn : PAL.good;
    s.style.opacity = on ? "1" : "0.16";
    s.style.background = on ? col : "#454545";
    s.style.boxShadow = on ? `0 0 5px ${col}` : "none";
  });
  $("gr-ladder-scale").textContent = `−${dh.toFixed(1)} dB FS`;
}

const pct = (v, lo, hi) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
function updateLoudness(m) {
  const LMIN = -24, LMAX = -6;
  $("lufs-fill").style.width = `${pct(m.target_lufs, LMIN, LMAX)}%`;
  $("lufs-target").style.left = `${pct(m.target_lufs, LMIN, LMAX)}%`;
  if (m.input_lufs != null) $("lufs-in").style.left = `${pct(m.input_lufs, LMIN, LMAX)}%`;
  const PMIN = -12, PMAX = 0;
  $("tp-fill").style.width = `${pct(m.processed_tp, PMIN, PMAX)}%`;
  $("tp-ceil").style.left = `${pct(m.ceiling_dbtp, PMIN, PMAX)}%`;
}

// ---------------------------------------------------------------------------
// canvas: helpers (device-pixel-ratio crisp, log-frequency axis)
// ---------------------------------------------------------------------------
function fitCanvas(cv, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 640, H = cssH;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

// ---------------------------------------------------------------------------
// CH1 spectrum (before/after), CRT-styled — real server magnitudes
// ---------------------------------------------------------------------------
let lastSpectrum = null, lastGr = null;

function drawSpectrum(spec) {
  const { ctx, W, H } = fitCanvas($("spectrum"), 250);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, W, H);

  const f = spec.freqs, o = spec.orig_db, p = spec.proc_db;
  const fmin = f[0], fmax = f[f.length - 1];
  const all = o.concat(p);
  let dbMax = Math.max(...all) + 4, dbMin = Math.min(...all) - 2;
  if (dbMax - dbMin < 20) dbMin = dbMax - 20;
  const pad = 6;
  const x = (fr) => pad + (Math.log10(fr) - Math.log10(fmin)) /
    (Math.log10(fmax) - Math.log10(fmin)) * (W - 2 * pad);
  const y = (db) => pad + (1 - (db - dbMin) / (dbMax - dbMin)) * (H - 2 * pad);

  // highlighted bands (adaptive de-harsh + mud)
  const bandFill = (lo, hi, c) => { ctx.fillStyle = c; ctx.fillRect(x(lo), pad, x(hi) - x(lo), H - 2 * pad); };
  bandFill(200, 400, alpha(PAL.mud, 0.09));
  bandFill(state.band[0], state.band[1], alpha(PAL.band, 0.10));

  // gridlines
  ctx.strokeStyle = alpha(PAL.grid, 0.9); ctx.fillStyle = PAL.muted;
  ctx.font = "11px 'Space Mono', monospace"; ctx.lineWidth = 1;
  [50, 100, 500, 1000, 5000, 10000].forEach((fr) => {
    if (fr < fmin || fr > fmax) return;
    const xx = x(fr);
    ctx.beginPath(); ctx.moveTo(xx, pad); ctx.lineTo(xx, H - 14); ctx.stroke();
    ctx.fillText(fr >= 1000 ? `${fr / 1000}k` : `${fr}`, xx + 3, H - 3);
  });

  const curve = (arr, color, w, fill) => {
    ctx.beginPath();
    for (let i = 0; i < f.length; i++) { const xx = x(f[i]), yy = y(arr[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
    if (fill) {
      ctx.lineTo(x(fmax), H); ctx.lineTo(x(fmin), H); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < f.length; i++) { const xx = x(f[i]), yy = y(arr[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
    }
    ctx.lineWidth = w; ctx.strokeStyle = color; ctx.lineJoin = "round";
    if (w > 1.5) { ctx.shadowColor = color; ctx.shadowBlur = 9; } else { ctx.shadowBlur = 0; }
    ctx.stroke(); ctx.shadowBlur = 0;
  };

  // emphasise processed unless the Original A/B source is active
  if (active === "orig") {
    curve(p, alpha(PAL.proc, 0.4), 1.3, null);
    curve(o, PAL.orig, 2.4, alpha(PAL.orig, 0.18));
  } else {
    curve(o, alpha(PAL.orig, 0.6), 1.3, null);
    curve(p, PAL.proc, 2.4, alpha(PAL.proc, 0.13));
  }
}

// ---------------------------------------------------------------------------
// CH2 de-harsh gain reduction across the clip (dB, <= 0); playhead tracks A/B
// dashed line = static floor, filled envelope = static + dynamic spikes
// ---------------------------------------------------------------------------
function drawGRTimeline(series) {
  const { ctx, W, H } = fitCanvas($("grtl"), 70);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = alpha(PAL.muted, 0.05); ctx.fillRect(0, 0, W, H);

  const n = series.length, pad = 0;
  const range = Math.min(18, Math.max(8, Math.ceil(-Math.min(0, ...series))));
  const x = (i) => (i / (n - 1)) * W;
  const yv = (db) => (-Math.max(-range, Math.min(0, db)) / range) * H;

  // static floor (the always-on cut), scaled by intensity, dashed
  const floor = Math.min(range, Math.abs(state.static) * (state.intensity / 100));
  const yFloor = (floor / range) * H;
  ctx.strokeStyle = alpha(PAL.muted, 0.5); ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, yFloor); ctx.lineTo(W, yFloor); ctx.stroke(); ctx.setLineDash([]);

  // filled envelope
  ctx.beginPath(); ctx.moveTo(0, 0);
  for (let i = 0; i < n; i++) ctx.lineTo(x(i), yv(series[i]));
  ctx.lineTo(W, 0); ctx.closePath();
  ctx.fillStyle = alpha(PAL.accent, 0.22); ctx.fill();

  // trace with glow
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const xx = x(i), yy = yv(series[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
  ctx.strokeStyle = PAL.accent; ctx.lineWidth = 1.6;
  ctx.shadowColor = PAL.accent; ctx.shadowBlur = 7; ctx.stroke(); ctx.shadowBlur = 0;

  $("gr-scale").textContent = `−${range} dB`;
}

// ---------------------------------------------------------------------------
// CH3 whole-track harshness waterfall — real spectrogram, amber heat ramp
// ---------------------------------------------------------------------------
function heatColor(t) {
  t = Math.pow(Math.max(0, Math.min(1, t)), 1.7);   // gamma so low-mid energy doesn't wash it out
  const S = [[5, 6, 5], [22, 14, 6], [70, 40, 10], [150, 84, 20], [230, 150, 50], [255, 214, 130]];
  const n = S.length - 1, pos = t * n, i = Math.floor(pos), fr = pos - i;
  const a = S[i], b = S[Math.min(i + 1, n)];
  return [Math.round(a[0] + (b[0] - a[0]) * fr), Math.round(a[1] + (b[1] - a[1]) * fr), Math.round(a[2] + (b[2] - a[2]) * fr)];
}
const HEAT_LUT = (() => {
  const r = new Uint8Array(256), g = new Uint8Array(256), b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { const c = heatColor(i / 255); r[i] = c[0]; g[i] = c[1]; b[i] = c[2]; }
  return { r, g, b };
})();
let specgram = null;  // {n_time,n_freq,fmin,fmax,bytes}

function decodeSpectrogram(sg) {
  const bin = atob(sg.data), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return { n_time: sg.n_time, n_freq: sg.n_freq, fmin: sg.fmin, fmax: sg.fmax, bytes: u };
}

function drawSpectrogram(sg) {
  const { ctx, W, H } = fitCanvas($("specgram"), 94);
  const T = sg.n_time, F = sg.n_freq, bytes = sg.bytes;
  const off = document.createElement("canvas"); off.width = T; off.height = F;
  const octx = off.getContext("2d"), img = octx.createImageData(T, F);
  for (let fi = 0; fi < F; fi++) {
    const dst = (F - 1 - fi) * T;                 // invert: high freq at top
    for (let ti = 0; ti < T; ti++) {
      const v = bytes[fi * T + ti], q = (dst + ti) * 4;
      img.data[q] = HEAT_LUT.r[v]; img.data[q + 1] = HEAT_LUT.g[v]; img.data[q + 2] = HEAT_LUT.b[v]; img.data[q + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, T, F, 0, 0, W, H);

  const lo = Math.log10(sg.fmin), hi = Math.log10(sg.fmax);
  const yOf = (fr) => (1 - (Math.log10(fr) - lo) / (hi - lo)) * H;
  const [bLo, bHi] = state.band;
  ctx.strokeStyle = "rgba(255,220,160,.6)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  [bLo, bHi].forEach((fr) => {
    if (fr < sg.fmin || fr > sg.fmax) return;
    const yy = yOf(fr); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,230,180,.95)"; ctx.font = "10px 'Space Mono', monospace";
  ctx.fillText(`${(bLo / 1000).toFixed(1)}–${(bHi / 1000).toFixed(1)} kHz`, 6, yOf(bHi) - 4);

  const ax = $("sg-yaxis"); ax.innerHTML = "";
  [100, 1000, 3000, 6000, 10000].forEach((fr) => {
    if (fr < sg.fmin || fr > sg.fmax) return;
    const s = document.createElement("span");
    s.style.top = `${(yOf(fr) / H) * 100}%`;
    s.textContent = fr >= 1000 ? `${fr / 1000}k` : `${fr}`;
    ax.appendChild(s);
  });
}

// NO SIGNAL scope line
function drawDropLine() {
  const cv = $("dropline"); if (!cv) return;
  const { ctx, W, H } = fitCanvas(cv, 70);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = PAL.accent; ctx.lineWidth = 1.6; ctx.shadowColor = PAL.accent; ctx.shadowBlur = 8;
  ctx.beginPath();
  for (let px = 0; px <= W; px += 2) { ctx.lineTo(px, H / 2 + Math.sin(px * 0.25) * (px % 60 < 3 ? 6 : 0.6)); }
  ctx.stroke(); ctx.shadowBlur = 0;
}

let _resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeT);
  _resizeT = setTimeout(() => {
    if ($("screen-drop").style.display !== "none") { drawDropLine(); return; }
    if (lastSpectrum) drawSpectrum(lastSpectrum);
    if (lastGr) drawGRTimeline(lastGr);
    if (specgram) drawSpectrogram(specgram);
  }, 150);
});

// ---------------------------------------------------------------------------
// commit: full track -> scorecard + download
// ---------------------------------------------------------------------------
$("commit").addEventListener("click", async () => {
  if (!state.id) return;
  const btn = $("commit"), note = $("commit-note"), st = $("commit-status");
  btn.disabled = true;
  btn.innerHTML = "&#9646;&#9646; RENDERING…";
  note.textContent = `processing full track (${fmtTime(state.duration)})…`;
  st.classList.add("hidden"); st.innerHTML = "";
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
    const out = data.metrics.output_lufs;
    const rows = (data.scorecard || []).map((row) =>
      `<li class="${row.ok ? "sc-ok" : "sc-no"}"><span class="sc-mark">${row.ok ? "✓" : "✗"}</span>`
      + `<span class="sc-text"><b>${esc(row.label)}</b> — <span class="sc-detail">${esc(row.detail)}</span></span></li>`).join("");
    st.innerHTML = `<div class="sc-head">✓ DONE — REPORT CARD</div>`
      + `<ul class="scorecard">${rows}</ul>`
      + `<a class="sc-dl" href="/download/${data.download_id}">▼ DOWNLOAD .WAV</a>`;
    st.classList.remove("hidden");
    btn.innerHTML = "&#10003; DONE — SEE REPORT";
    note.textContent = `rendered ${state.preset} · ${state.intensity}% → ${out != null ? out.toFixed(1) : "–"} LUFS`;
    st.querySelector(".sc-dl").click();
  } catch (err) {
    st.innerHTML = `<div class="sc-err">⚠ ${esc(err.message)}</div>`;
    st.classList.remove("hidden");
    btn.innerHTML = "&#9660; PROCESS FULL TRACK";
    note.textContent = "renders whole track · these exact settings";
    toast(err.message);
  } finally {
    btn.disabled = false;
    clearTimeout($("commit")._rt);
    $("commit")._rt = setTimeout(() => {
      btn.innerHTML = "&#9660; PROCESS FULL TRACK";
    }, 4000);
  }
});

// keyboard: space toggles play
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && state.id && e.target.tagName !== "INPUT" && e.target.tagName !== "BUTTON") {
    e.preventDefault(); togglePlay();
  }
});

// boot: NO SIGNAL until a file is analysed
updateAdvancedLabels();
showDrop(true);
