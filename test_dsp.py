#!/usr/bin/env python3
"""CLI sanity-check for the DSP core (no GUI).

Loads a WAV, runs de-harsh -> mud cut -> loudness normalize, prints before/after
integrated LUFS and true peak, and writes the processed WAV so you can listen.

    python test_dsp.py input.wav
    python test_dsp.py input.wav --preset Aggressive --intensity 120
    python test_dsp.py input.wav -o out.wav
    python test_dsp.py --selftest        # synthetic signal, no file needed

The point of this script is to check the *numbers* and hear the de-harshing
without opening the web app -- a quick DSP sanity check after any change.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import soundfile as sf

import dsp


def _fmt_lufs(v: float) -> str:
    return "  -inf (silent)" if not np.isfinite(v) else f"{v:8.2f} LUFS"


def _report(label: str, audio: np.ndarray, sr: int) -> tuple[float, float]:
    lufs = dsp.integrated_lufs(audio, sr)
    tp = dsp.true_peak_db(audio, sr)
    print(f"  {label:<8}  {_fmt_lufs(lufs)}    true peak {tp:7.2f} dBTP")
    return lufs, tp


def run_file(path: str, out_path: str, preset: str, intensity: float,
             target_lufs: float, ceiling_dbtp: float) -> None:
    audio, sr = sf.read(path, always_2d=False)
    ch = 1 if audio.ndim == 1 else audio.shape[1]
    dur = audio.shape[0] / sr
    print(f"\n{os.path.basename(path)}  ({sr} Hz, {ch} ch, {dur:.1f} s)")
    print(f"preset={preset}  intensity={intensity:.0f}%  "
          f"target={target_lufs:.1f} LUFS  ceiling={ceiling_dbtp:.1f} dBTP")

    print("\n  stage      integrated loudness    true peak")
    print("  " + "-" * 52)
    in_lufs, in_tp = _report("input", audio, sr)

    processed = dsp.process(audio, sr, preset, intensity, target_lufs, ceiling_dbtp)
    out_lufs, out_tp = _report("output", processed, sr)

    print("  " + "-" * 52)
    if np.isfinite(in_lufs) and np.isfinite(out_lufs):
        print(f"  loudness moved {out_lufs - in_lufs:+.2f} dB "
              f"(target was {target_lufs - in_lufs:+.2f} dB)")
        if abs(out_lufs - target_lufs) > 0.75:
            print(f"  note: output is {out_lufs - target_lufs:+.2f} dB off target "
                  f"-- true-peak ceiling likely constrained the level")
    print(f"  true peak moved {out_tp - in_tp:+.2f} dB "
          f"(ceiling {ceiling_dbtp:.1f} dBTP {'OK' if out_tp <= ceiling_dbtp + 0.05 else 'EXCEEDED'})")

    sf.write(out_path, processed, sr, subtype="PCM_24")
    print(f"\n  wrote {out_path}")


def make_selftest_signal(sr: int = 44100, dur: float = 4.0) -> np.ndarray:
    """Broadband-ish noise with a harsh 4.5 kHz resonance + mud, ~-12 LUFS.

    Not a real Suno export -- just enough to prove the chain runs and the
    numbers move in the right direction.
    """
    n = int(sr * dur)
    t = np.arange(n) / sr
    rng = np.random.default_rng(0)
    pink = np.cumsum(rng.standard_normal(n))
    pink /= np.max(np.abs(pink)) + 1e-9
    resonance = 0.35 * np.sin(2 * np.pi * 4500 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 2 * t))
    mud = 0.25 * np.sin(2 * np.pi * 300 * t)
    mono = 0.4 * pink + resonance + mud
    mono /= np.max(np.abs(mono)) + 1e-9
    mono *= 0.5
    return np.column_stack([mono, mono])  # stereo


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Sanity-check the Suno DSP core.")
    p.add_argument("input", nargs="?", help="input WAV path")
    p.add_argument("-o", "--output", help="output WAV path (default: <input>_processed.wav)")
    p.add_argument("--preset", default="Standard", choices=list(dsp.PRESETS),
                   help="de-harsh preset (default: Standard)")
    p.add_argument("--intensity", type=float, default=100.0,
                   help="de-harsh intensity 0-150%% (default: 100)")
    p.add_argument("--target-lufs", type=float, default=-14.0)
    p.add_argument("--ceiling-dbtp", type=float, default=-1.0)
    p.add_argument("--selftest", action="store_true",
                   help="run on a synthetic signal instead of a file")
    args = p.parse_args(argv)

    if args.selftest:
        sr = 44100
        audio = make_selftest_signal(sr)
        tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_selftest_in.wav")
        sf.write(tmp, audio, sr)
        out = os.path.join(os.path.dirname(tmp), "_selftest_processed.wav")
        run_file(tmp, out, args.preset, args.intensity, args.target_lufs, args.ceiling_dbtp)
        return 0

    if not args.input:
        p.error("give an input WAV, or use --selftest")
    if not os.path.isfile(args.input):
        p.error(f"no such file: {args.input}")

    out_path = args.output or (os.path.splitext(args.input)[0] + "_processed.wav")
    run_file(args.input, out_path, args.preset, args.intensity,
             args.target_lufs, args.ceiling_dbtp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
