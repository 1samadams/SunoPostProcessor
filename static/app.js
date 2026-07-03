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
  $("scrub-fill").style.width = `${Math.min(100, (lead.currentTime / d) * 100)}%`;
  $("time").textContent = fmtTime(lead.currentTime);
});
function onEnded() {
  playing = false; $("play").innerHTML = "&#9658;";
  $("scrub-fill").style.width = "0%";
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
  state.intensity = +e.target.value; $("intensity-val").textContent = `${state.intensity}%`;
  refreshPreview(false);
});
$("start").addEventListener("input", (e) => {
  state.start = +e.target.value; $("start-val").textContent = fmtTime(state.start);
  refreshPreview(true);
});
$("custom").addEventListener("change", (e) => {
  state.custom = e.target.checked; syncAdvancedDisabled(); markPresetModified(state.custom);
  refreshPreview(false);
});
function enterCustom() {
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
    drawSpectrum(data.spectrum);
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
  $("m-dh").title = `engaging ${m.deharsh_duty}% of the clip`;
  cls($("m-dh"), dh <= -0.5, dh < 0);
}

// ---------------------------------------------------------------------------
// spectrum
// ---------------------------------------------------------------------------
function drawSpectrum(spec) {
  const cv = $("spectrum");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 640, H = 220;
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
  band(3000, 6000, "rgba(124,92,255,.13)");

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
