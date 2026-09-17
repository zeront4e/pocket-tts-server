#
# Copyright 2026 zeront4e (https://github.com/zeront4e)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

# PocketTTS post-processing pipeline + effects engine (pure numpy/scipy).
#
# Fixes known model artifacts that appear especially on the first generations
# after startup (cold start):
#   - leading clicks / pops (large transients in the first ~50 ms)
#   - inaudible output (very low level)
#   - trailing noise tails (faint hiss / echo after the speech ends)
# and provides optional intentional effects (reverb, echo, EQ, ...).
#
# Two execution modes, same stages:
#   * process(), offline, on the full float32 buffer (reference implementation,
#     used for tests).
#   * StreamingPostProcessor, online, per generated chunk (PocketTTS yields
#     one per decoded latent, ~80 ms of audio). This is what the sidecar's /tts uses, so post-
#     processed audio reaches the client as soon as each sentence is decoded
#     instead of after the whole generation.
#
# The fast path (clean input) costs ~0.1 ms; the heavy path (denoise + gate)
# costs a few ms per typical chunk, measured on CPU.

import json
import math
import struct
import time

import numpy as np
from scipy import signal as sps
from scipy.fft import irfft, rfft

SR = 24000

# STFT (OLA) parameters for the Wiener denoiser / spectral flatness.
# Custom OLA (not scipy stft/istft): validated round-trip to ~1e-15.
_NPERSEG = 256
_HOP = 64  # 75% overlap, COLA for hamming
_WINDOW = np.hamming(_NPERSEG)

# Artifact detection thresholds (see plan / benchmark results).
INAUDIBLE_PEAK = 0.10
TAIL_RMS = 0.002
TAIL_FLATNESS = 0.35
DETECT_LAG_MS = 200     # search for a tail starting this long after speech end
DETECT_LAG_END_MS = 600 # never search further than this after the speech end

# Wiener denoiser: a "noise" window quieter than this is digital silence, not
# noise, denoising against it would drive the gain to the floor and erase
# quiet speech, so it is skipped. NOISE_PSD_FLOOR keeps the gain from ever
# collapsing to zero if a faint but real noise estimate has near-zero bins.
NOISE_EST_RMS_MIN = 0.0002
NOISE_PSD_FLOOR = 1e-8

# Gate
GATE_HOLD = 0.02
GATE_ATTACK_MS = 5.0
GATE_RELEASE_MS = 20.0
GATE_FLOOR_FRAC = 0.25

# Trim / normalize
TRIM_RMS = 0.0005
TRIM_KEEP_MS = 50
TARGET_PEAK = 0.95


def _stft(x):
    pad = _NPERSEG // 2
    xp = np.concatenate([[0.0] * pad, np.ascontiguousarray(x, dtype=np.float64), [0.0] * pad])
    nframes = (len(xp) - _NPERSEG) // _HOP + 1
    idx = np.arange(nframes)[:, None] * _HOP + np.arange(_NPERSEG)[None, :]
    return rfft(xp[idx] * _WINDOW, axis=1)


def _istft(z, n):
    """Inverse of _stft; returns exactly n samples (the length of the input)."""
    nframes = z.shape[0]
    frames = irfft(z, n=_NPERSEG, axis=1) * _WINDOW
    out = np.zeros(nframes * _HOP + _NPERSEG)
    norm = np.zeros_like(out)
    for i in range(nframes):
        a = i * _HOP
        out[a:a + _NPERSEG] += frames[i]
        norm[a:a + _NPERSEG] += _WINDOW ** 2
    out = out / np.where(norm > 1e-9, norm, 1e-9)
    pad = _NPERSEG // 2
    return out[pad:pad + n]


def _pad_frames(x, n_frames, step):
    """Reshape x[0 : n_frames*step] into (n_frames, step), zero-padded if needed."""
    need = n_frames * step
    y = x[:need] if len(x) >= need else np.pad(x, (0, need - len(x)))
    return y.reshape(n_frames, step)


def _frame_rms(x):
    n_frames = max(0, 1 + (len(x) - _NPERSEG) // _HOP)
    if n_frames == 0:
        return np.zeros(0)
    return np.sqrt(np.mean(_pad_frames(x, n_frames, _HOP) ** 2, axis=1))


def declick(x):
    """Remove the leading cold-start transient (click/pop in the first ~10 ms).

    Observed shape: a single near-full-scale sample at index 0 decaying to
    silence within ~1 ms, with no sustained speech before the real onset.
    Discriminator: the 10-50 ms region. If it is quiet, the first 10 ms is a
    pre-speech transient and everything above a small threshold is replaced by
    the local median. If real speech is present that early, only isolated
    extreme spikes are removed.
    """
    zone = int(SR * 0.010)  # 10 ms
    if len(x) < zone * 2:
        return x
    head_zone = x[:zone]
    if float(np.max(np.abs(head_zone))) <= 0.08:
        return x
    after = x[zone:int(SR * 0.050)] if len(x) >= int(SR * 0.050) else x[zone:]
    if len(after) < _NPERSEG:
        return x
    out = x.copy()
    if float(np.sqrt(np.mean(after ** 2))) > 0.03:
        # Real speech present early: only kill isolated extreme spikes.
        h = np.abs(head_zone)
        flag = h > 0.5
        for i in np.where(flag)[0]:
            lo, hi = max(0, i - 4), min(zone, i + 5)
            neigh = h[lo:hi]
            neigh[i - lo] = 0.0
            if neigh.size and neigh.max() < 0.15:
                out[i] = float(np.median(head_zone[lo:hi]))
        return out
    # Pre-speech transient: replace everything above the threshold.
    baseline = float(np.median(after))
    mad = float(np.median(np.abs(after - baseline))) if len(after) else 0.0
    thr = max(0.05, 10 * mad)
    flag = np.abs(head_zone - baseline) > thr
    if not flag.any():
        return x
    out[:zone][flag] = baseline
    return out


def detect(x):
    """Classify the (declicked) buffer.

    Returns a dict with speech_start/speech_end (frame indices), inaudible and
    tail flags, and the quietest-window noise estimate (for the denoiser).
    """
    rms = _frame_rms(x)
    n_frames = len(rms)

    inaudible = bool(len(x) > 0 and np.max(np.abs(x)) < INAUDIBLE_PEAK)

    # Locate speech by a 1 % max envelope on frame RMS (robust to a loud tail).
    if n_frames and rms.max() > TRIM_RMS:
        voiced = np.where(rms > 0.01 * rms.max())[0]
        s, e = int(voiced[0]), int(voiced[-1])
    else:
        s, e = 0, n_frames

    # Tail test: a low-level but noisy region shortly after the speech end.
    tail = False
    tail_start = None
    if not inaudible and n_frames:
        a = e + int(SR * DETECT_LAG_MS / 1000 / _HOP)
        b = min(n_frames, e + int(SR * DETECT_LAG_END_MS / 1000 / _HOP))
        if a < b:
            seg = x[a * _HOP:b * _HOP]
            if len(seg) >= _NPERSEG:
                seg_rms = float(np.sqrt(np.mean(seg ** 2)))
                flat = float(spectral_flatness(seg))
                if seg_rms > TAIL_RMS and flat > TAIL_FLATNESS:
                    tail = True
                    tail_start = a

    # Noise estimate: quietest 300 ms window over the whole buffer.
    noise = np.zeros(0)
    if n_frames:
        win = min(max(1, int(SR * 300 / 1000 / _HOP)), n_frames)
        if win < n_frames:
            cum = np.convolve(rms ** 2, np.ones(win), mode="valid")
            q = int(np.argmin(cum))
            noise = x[q * _HOP:(q + win) * _HOP]
        else:
            noise = x

    return {
        "speech_start": s,
        "speech_end": e,
        "inaudible": inaudible,
        "tail": tail,
        "tail_start_frame": tail_start,
        "noise": noise,
    }


def spectral_flatness(x, nperseg=512, hop=128):
    """Geometric/arithmetic mean of the spectrum (0 = tonal, 1 = noise-like)."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) < nperseg:
        x = np.pad(x, (0, nperseg - len(x)))
    if hop >= len(x):
        return 1.0
    n = 1 + (len(x) - nperseg) // hop
    w = np.hanning(nperseg)
    log_sum = 0.0
    lin_sum = 0.0
    for k in range(n):
        spec = np.abs(np.fft.rfft(x[k * hop:k * hop + nperseg] * w)) ** 2 + 1e-12
        log_sum += float(np.mean(np.log(spec)))
        lin_sum += float(np.mean(spec))
    geomean = np.exp(log_sum / n)
    return float(np.clip(geomean / (lin_sum / n), 0.0, 1.0))


def wiener_denoise(x, noise, oversub=1.5, floor=0.05):
    """Spectral-subtraction Wiener filter with an estimated noise spectrum.

    Skips (returns x unchanged) if there is no usable noise estimate: a window
    that is digital silence (below NOISE_EST_RMS_MIN) would drive the gain to
    the floor and erase quiet speech, and a too-short window cannot be
    STFT'd.
    """
    if len(noise) < _NPERSEG:
        return x
    noise_rms = float(np.sqrt(np.mean(noise ** 2)))
    if noise_rms < NOISE_EST_RMS_MIN:
        return x
    z = _stft(x)
    nz = _stft(noise)
    # Average the noise frames (a few hundred of them for a 300 ms window)
    # into a single stable PSD row, broadcast over all signal frames.
    nz = nz[: min(64, nz.shape[0])].mean(axis=0, keepdims=True)
    power = np.abs(z) ** 2
    # Absolute PSD floor so the gain never collapses to zero in bins where the
    # noise estimate is (near) zero.
    npow = np.maximum(np.abs(nz) ** 2, NOISE_PSD_FLOOR)
    gain = power / (power + oversub * npow)
    gain = np.maximum(gain, floor)
    return _istft(z * gain, len(x))


def tail_gate(x, info):
    """Smooth gate that silences the noise tail after the speech ends."""
    n = len(x)
    if n == 0:
        return x, 0.0
    frame_rms = _frame_rms(x)
    n_frames = len(frame_rms)
    if n_frames == 0:
        return x, 0.0

    end = min(info.get("speech_end", n_frames), n_frames)
    thr = max(GATE_HOLD, GATE_FLOOR_FRAC * float(frame_rms.max()))

    open_mask = np.zeros(n_frames, dtype=bool)
    open_mask[:end] = True
    if info.get("tail") and info.get("tail_start_frame") is not None:
        open_mask[info["tail_start_frame"]:] = False

    tau_a = max(1.0, GATE_ATTACK_MS / 1000.0 * SR / _HOP)
    tau_r = max(1.0, GATE_RELEASE_MS / 1000.0 * SR / _HOP)
    alpha_a = 1 - np.exp(-1.0 / tau_a)
    alpha_r = 1 - np.exp(-1.0 / tau_r)
    g = np.zeros(n_frames)
    for i in range(1, n_frames):
        if open_mask[i]:
            g[i] = g[i - 1] + alpha_a * (1.0 - g[i - 1])
        else:
            g[i] = g[i - 1] * (1.0 - alpha_r)

    per_sample = np.interp(np.linspace(0, n_frames - 1, n), np.arange(n_frames), g)
    out = x * per_sample
    tail_rms = float(np.sqrt(np.mean(out[end * _HOP:] ** 2))) if end * _HOP < n else 0.0
    return out, tail_rms


def trim(x, keep_ms=TRIM_KEEP_MS):
    """Cut leading/trailing silence, keeping ``keep_ms`` of context."""
    if len(x) == 0:
        return x
    rms = _frame_rms(x)
    if len(rms) == 0:
        return x
    voiced = np.where(rms > TRIM_RMS)[0]
    if len(voiced) == 0:
        return x
    keep = max(1, int(SR * keep_ms / 1000 / _HOP))
    a = max(0, int(voiced[0]) - keep)
    b = min(len(rms), int(voiced[-1]) + keep + 1)
    return x[a * _HOP:min(len(x), b * _HOP)]


def normalize(x, target=TARGET_PEAK):
    if len(x) == 0:
        return x
    peak = float(np.max(np.abs(x)))
    if peak < 1e-6:
        return x
    return (x * (target / peak)).astype(np.float32)


def soft_limit(x, ceiling=0.99):
    if len(x) == 0:
        return x
    over = np.abs(x) > ceiling
    if not over.any():
        return x
    out = x.copy()
    overshoot = (np.abs(x[over]) - ceiling) / max(1e-9, 1 - ceiling)
    out[over] = np.sign(x[over]) * (ceiling + (1 - ceiling) * np.tanh(overshoot))
    return out


# ---------------------------------------------------------------------------
# Effects engine
# ---------------------------------------------------------------------------

def _feedback_delay(x, d, fb):
    """y[n] = x[n] + fb * y[n-d]  (comb / echo, fast via lfilter)."""
    a = np.zeros(d + 1)
    a[0], a[d] = 1.0, -fb
    b = np.zeros(d + 1)
    b[0] = 1.0
    return sps.lfilter(b, a, x)


def _rbj_coeffs(f0, fs, g, q=1.0, kind="peaking"):
    """RBJ biquad coefficients (Audio-EQ-Cookbook formulas)."""
    A = 10 ** (g / 40.0)
    w0 = 2 * np.pi * f0 / fs
    cosw = np.cos(w0)
    sinw = np.sin(w0)
    alpha = sinw / (2 * q)
    if kind == "lowshelf":
        sqA = np.sqrt(A)
        b = [sqA + A * 2 * alpha - sqA, 2 * (A - 1), sqA - A * 2 * alpha - sqA]
        a = [sqA + A * 2 * alpha + sqA, -2 * (A + 1), sqA - A * 2 * alpha + sqA]
    elif kind == "highshelf":
        sqA = np.sqrt(A)
        b = [sqA - A * 2 * alpha - sqA, 2 * (A - 1), sqA + A * 2 * alpha - sqA]
        a = [sqA - A * 2 * alpha + sqA, -2 * (A + 1), sqA + A * 2 * alpha + sqA]
    else:  # peaking
        b = [1 + alpha * A, -2 * cosw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cosw, 1 - alpha / A]
    return [c / a[0] for c in b], [c / a[0] for c in a]


def fx_eq(x, freq=1000.0, gain_db=0.0, q=1.0, kind="peaking"):
    if kind not in ("peaking", "lowshelf", "highshelf"):
        raise ValueError(f"eq kind must be peaking/lowshelf/highshelf, got {kind}")
    if not (20 <= float(freq) <= 12000):
        raise ValueError("eq freq must be in [20, 12000] Hz")
    b, a = _rbj_coeffs(float(freq), SR, float(gain_db), float(q), kind)
    return sps.lfilter(b, a, x)


def fx_highpass(x, freq=80.0):
    b, a = sps.butter(4, min(12000.0, float(freq)), btype="highpass", fs=SR)
    return sps.lfilter(b, a, x)


def fx_lowpass(x, freq=8000.0):
    b, a = sps.butter(4, max(100.0, float(freq)), btype="lowpass", fs=SR)
    return sps.lfilter(b, a, x)


def fx_echo(x, delay_ms=250, feedback=0.4, mix=0.3):
    d = max(1, int(SR * float(delay_ms) / 1000))
    fb = float(np.clip(feedback, 0.0, 0.9))
    y = _feedback_delay(x, d, fb)
    return x + float(mix) * y


def fx_reverb(x, wet=0.3, size=0.5):
    """Schroeder reverb: 4 parallel combs + 2 series allpasses (all lfilter)."""
    wet = float(np.clip(wet, 0.0, 1.0))
    comb_fb = 0.35 + 0.2 * float(np.clip(size, 0.0, 1.0))
    out = None
    for d_ms in (110, 118, 127, 136):
        y = _feedback_delay(x, int(SR * d_ms / 1000), comb_fb)
        out = y if out is None else out + y
    out /= 4.0
    for a_coeff in (0.5, 0.75):
        d = 15
        b, a = _allpass_coeffs(d, a_coeff)
        out = sps.lfilter(b, a, out)
    return (1.0 - wet) * x + wet * out


def fx_compressor(x, threshold_db=-18.0, ratio=3.0, attack_ms=1.0, release_ms=100.0):
    thr = 10 ** (float(threshold_db) / 20.0)
    ratio = max(1.0, float(ratio))
    n = len(x)
    env = 0.0
    out = np.empty(n)
    for i in range(n):
        amp = abs(x[i])
        if amp > env:
            env = amp
        else:
            env = max(0.0, env - thr * 1e-3 / max(1, int(SR * float(release_ms) / 1000)))
        if env > thr:
            excess = env - thr
            gain = (thr + excess / ratio) / env
        else:
            gain = 1.0
        out[i] = x[i] * gain
    return out


def fx_fade(x, attack_ms=50, release_ms=200):
    out = x.copy()
    n = len(x)
    na = min(n, int(SR * float(attack_ms) / 1000))
    nr = min(n, int(SR * float(release_ms) / 1000))
    if na > 0:
        out[:na] *= np.linspace(0.0, 1.0, na)
    if nr > 0 and nr < n:
        out[n - nr:] *= np.linspace(1.0, 0.0, nr)
    return out


def fx_bitcrush(x, bits=12):
    steps = 2 ** int(np.clip(bits, 4, 15))
    return np.round(x * (steps / 2)) * (2 / steps)


# Formant-shifting parameters (STFT spectral-envelope rescaling, see fx_formant).
_FORM_NPERSEG = 1024   # ~42 ms analysis window
_FORM_HOP = 256        # 75 % overlap (COLA for Hann)
_FORM_SIGMA_HZ = 100.0 # envelope smoothing: blurs the harmonic comb, keeps formants
_FORM_DETAIL_CLIP = 12.0


def _gauss_kernel(sigma_bins):
    """Symmetric Gaussian lowpass kernel (DC-centered), normalized to sum 1."""
    m = int(3 * sigma_bins)
    k = np.arange(-m, m + 1)
    kern = np.exp(-0.5 * (k / sigma_bins) ** 2)
    return kern / kern.sum()


def _formant_shift_frame(X, kern, k, nf, f, detail_clip=_FORM_DETAIL_CLIP):
    """Formant-shift ONE STFT frame: rescale the spectral envelope by ``f``
    (moving the formants) while keeping the phase and the comb shape (pitch).

    envelope = Gaussian-smoothed magnitude (the formant structure);
    detail   = magnitude / envelope (the harmonic comb = the pitch texture).
    The output keeps the comb at its original frequencies (pitch preserved) but
    replaces the envelope with itself read from freq/f, so every formant peak at
    F moves to f*F. Multiplicative (no additive residual) so both up- and
    down-shifts reposition the formant energy correctly.
    """
    mag = np.abs(X)
    env = np.exp(np.convolve(np.log(mag + 1e-9), kern, mode="same"))
    env = np.maximum(env, 1e-4 * (env.max() + 1e-9))  # division floor (silence)
    detail = np.clip(mag / env, 0.0, detail_clip)
    pos = np.clip(k / f, 0.0, nf - 1)
    i0 = np.floor(pos).astype(np.int64)
    i1 = np.minimum(i0 + 1, nf - 1)
    fr = pos - i0
    newenv = env[i0] + fr * (env[i1] - env[i0])
    return (newenv * detail) * np.exp(1j * np.angle(X))


def fx_formant(x, semitones=0.0):
    """Formant shift: moves the vocal-tract resonances (timbre) by ``semitones``
    WITHOUT changing the fundamental pitch or the clip duration.

    Positive = brighter / smaller-sounding (more female), negative = darker /
    larger-sounding (more male). Implemented as an overlap-add STFT whose
    per-frame spectral envelope is rescaled on the frequency axis by
    ``2**(semitones/12)``; the phase and the harmonic comb (the pitch) are
    left untouched, so f0 and duration are preserved exactly.
    """
    s = float(np.clip(float(semitones), -12.0, 12.0))
    x = np.ascontiguousarray(x, dtype=np.float64)
    if len(x) < 2 or s == 0.0:
        return x.astype(np.float32)
    f = 2.0 ** (s / 12.0)
    nperseg = _FORM_NPERSEG
    hop = _FORM_HOP
    win = np.hanning(nperseg)
    pad = nperseg // 2
    xp = np.concatenate([[0.0] * pad, x, [0.0] * pad])
    nframes = (len(xp) - nperseg) // hop + 1
    idx = np.arange(nframes)[:, None] * hop + np.arange(nperseg)[None, :]
    X = rfft(xp[idx] * win, axis=1)
    nf = X.shape[1]
    df = SR / nperseg
    kern = _gauss_kernel(max(1.0, _FORM_SIGMA_HZ / df))
    k = np.arange(nf)
    Y = np.empty_like(X)
    for i in range(nframes):
        Y[i] = _formant_shift_frame(X[i], kern, k, nf, f)
    frames = irfft(Y, n=nperseg, axis=1) * win
    out = np.zeros(nframes * hop + nperseg)
    wsum = np.zeros_like(out)
    for i in range(nframes):
        a = i * hop
        out[a:a + nperseg] += frames[i]
        wsum[a:a + nperseg] += win ** 2
    out = out / np.where(wsum > 1e-9, wsum, 1e-9)
    return out[pad:pad + len(x)].astype(np.float32)


def fx_chop(x, freq=44.0, depth=0.8):
    """Amplitude "chopper" (the classic robot voice): volume pulses at ``freq`` Hz.

    The gain oscillates between ``1-depth`` and 1, so ``depth`` 0 is unchanged
    and 1 fully gates the audio off for half the cycle.
    """
    f = float(freq)
    if not (1.0 <= f <= 200.0):
        raise ValueError("chop freq must be in [1, 200] Hz")
    depth = float(np.clip(float(depth), 0.0, 1.0))
    if len(x) == 0 or depth == 0.0:
        return x
    t = np.arange(len(x)) / SR
    gain = 1.0 - depth * (0.5 + 0.5 * np.sin(2.0 * np.pi * f * t))
    return (x * gain).astype(np.float32)


_EFFECTS = {
    "reverb": fx_reverb,
    "echo": fx_echo,
    "eq": fx_eq,
    "highpass": fx_highpass,
    "lowpass": fx_lowpass,
    "compressor": fx_compressor,
    "fade": fx_fade,
    "bitcrush": fx_bitcrush,
    "formant": fx_formant,
    "chop": fx_chop,
}

PRESETS = {
    "none": [],
    "cathedral": [
        {"type": "eq", "freq": 3000, "gain_db": 3, "q": 0.7, "kind": "peaking"},
        {"type": "reverb", "wet": 0.55, "size": 0.9},
    ],
    "broadcast": [
        {"type": "highpass", "freq": 90},
        {"type": "lowpass", "freq": 9000},
        {"type": "eq", "freq": 3200, "gain_db": 2.5, "q": 0.8, "kind": "peaking"},
        {"type": "compressor", "threshold_db": -18, "ratio": 3.5},
    ],
    "phone": [
        {"type": "highpass", "freq": 300},
        {"type": "lowpass", "freq": 3400},
    ],
    "robot": [
        # Formant shift (brighter, robotic) first, then the chopper, then
        # crunch + top-cut so the gated edges stay gritty, not clicky.
        {"type": "formant", "semitones": 2},
        {"type": "chop", "freq": 44, "depth": 0.85},
        {"type": "bitcrush", "bits": 8},
        {"type": "lowpass", "freq": 6000},
    ],
    # Formant shifts (timbre only, pitch and duration unchanged) that make the
    # voice appear female (brighter) or male (darker).
    "Female formant": [
        {"type": "formant", "semitones": 5},
    ],
    "Male formant": [
        {"type": "formant", "semitones": -5},
    ],
}


def parse_effects(value):
    """Parse the ``effects`` request param.

    Accepts a preset name or a JSON string/array of effect objects.
    Returns (effects_list, error_string_or_None).
    """
    if value is None or value == "" or value == "none":
        return [], None
    if isinstance(value, list):
        items = value
    else:
        s = str(value).strip()
        if s in PRESETS:
            return PRESETS[s], None
        try:
            items = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            names = ", ".join(sorted(PRESETS))
            return None, f"effects must be a preset name ({names}) or a JSON array"
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list):
            return None, "effects JSON must be an array of effect objects"
    for it in items:
        if not isinstance(it, dict) or "type" not in it or it["type"] not in _EFFECTS:
            names = ", ".join(sorted(_EFFECTS))
            return None, f"unknown or malformed effect (known types: {names})"
    return items, None


def apply_effects(x, effects):
    for it in effects:
        fn = _EFFECTS[it["type"]]
        kwargs = {k: v for k, v in it.items() if k != "type"}
        try:
            x = fn(x, **kwargs)
        except (ValueError, OverflowError, ZeroDivisionError, TypeError) as e:
            return None, f"effect {it['type']} failed: {e}"
    return x, None


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def process(x, sr, postprocess, effects):
    """Run the pipeline. Returns (pcm_float32, info_dict).

    ``postprocess``: "auto" | "full" | "off".
    ``effects``: parsed list of effect dicts (empty list = none).
    """
    x = np.ascontiguousarray(x, dtype=np.float32)
    info = {"path": "off"}

    if postprocess == "off" and not effects:
        return x, info

    # 1) Declick (always cheap, fixes the dominant cold-start artifact).
    x = declick(x)

    d = detect(x)
    info["inaudible"] = d["inaudible"]
    info["tail"] = d["tail"]

    heavy = postprocess == "full" or d["inaudible"] or d["tail"] or bool(effects)

    if heavy:
        # 2) Wiener denoise (noise estimated from the quietest window).
        x = wiener_denoise(x, d["noise"])
        # 3) Tail gate (re-detect: the noise floor shifted after denoising).
        x, tail_rms = tail_gate(x, detect(x))
        info["tail_rms"] = tail_rms
        info["path"] = "heavy"
    else:
        info["path"] = "fast"

    # 4) Trim + normalize (also lifts inaudible output).
    x = trim(x)
    x = normalize(x)

    # 5) Effects (renormalize after: wet mixes can raise the level).
    if effects:
        x, err = apply_effects(x, effects)
        if err:
            raise ValueError(err)
        x = normalize(x)
        x = soft_limit(x)

    return x, info


def encode_wav16(pcm, sr):
    """Float32 [-1,1] -> 16-bit PCM WAV bytes with a correct header."""
    pcm = np.clip(pcm, -1.0, 1.0)
    data = (pcm * 32767.0).astype("<i2").tobytes()
    n = len(data)
    header = (
        b"RIFF" + struct.pack("<I", 36 + n) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, int(sr), int(sr) * 2, 2, 16)
        + b"data" + struct.pack("<I", n)
    )
    return header + data


# ---------------------------------------------------------------------------
# Streaming (per-chunk) pipeline
# ---------------------------------------------------------------------------
#
# StreamingPostProcessor is the online counterpart of process(): feed it the
# generated chunks in order and it returns a processed chunk, so the audio can
# be written into the streaming WAV container while it is being generated.
#
# Deliberate differences vs. the offline process():
#   * peak normalization -> adaptive leveler: each chunk is scaled so its peak
#     is 0.95 unless the running peak (max seen so far) is louder, in which
#     case the chunk is lifted at most to 50 % of the running peak. Loudness
#     therefore stays within ~6 dB of the loudest chunk instead of one global
#     normalization pass.
#   * tail gate -> online expander: after EXP_HANGOVER_MS of below-threshold
#     silence the gate closes (noise-like content is verified via spectral
#     flatness, mirroring the offline tail detection; tonal quiet content and
#     inaudible chunks are left alone). Side effect: pauses longer than
#     ~200 ms are tightened to ~220 ms.
#   * the Wiener noise spectrum is the quietest 300 ms window seen so far
#     (updated per chunk) instead of over the full buffer.
#   * the `fade` effect's release ramp is not applied (the gate has already
#     silenced the ending).

# Online tail gate
VOICED_REL = 0.15      # a frame counts as voiced when rms > max(GATE_HOLD, VOICED_REL * loudness reference)
VOICED_REL_INAUDIBLE = 0.10  # inaudible chunks: voiced when rms > max(TRIM_RMS, VOICED_REL_INAUDIBLE * own peak rms)
# Cap on the relative voiced threshold: keeps it from being anchored to the
# single loudest chunk, so quiet (de-stressed) syllables are not treated as
# silence and gated out. The loudness reference also decays (PEAK_RELEASE_MS)
# after a pause instead of staying at the global max forever.
VOICED_REL_CAP = 0.05
PEAK_RELEASE_MS = 800.0
# "Closed" is a soft duck, not a hard cut: the gate never attenuates below this,
# so residual quiet speech is lowered (still audible) rather than erased.
GATE_GAIN_FLOOR = 0.1
EXP_HANGOVER_MS = 200  # below-threshold silence before the gate may close (== DETECT_LAG_MS)
EXP_RECHECK_MS = 200   # flatness re-check period while the gate stays open in quiet

# Leveler: chunks with less voiced content than this are silence/noise and
# must NOT be amplified (a noise burst is worse than quiet output).
LEVEL_MIN_RMS = 0.004
# The per-chunk gain is ramped from the previous chunk's gain over this window
# so the output stays continuous at chunk boundaries (a constant-gain jump
# where the waveform is non-zero is an audible click).
LEVEL_RAMP_MS = 15.0


class _Iir:
    """Causal lfilter with state carried across chunks."""

    __slots__ = ("b", "a", "zi")

    def __init__(self, b, a):
        self.b = np.asarray(b, dtype=np.float64)
        self.a = np.asarray(a, dtype=np.float64)
        self.zi = sps.lfilter_zi(self.b, self.a).ravel()

    def push(self, x):
        y, zf = sps.lfilter(self.b, self.a, np.asarray(x, dtype=np.float64), zi=self.zi)
        self.zi = zf
        return y.astype(np.float32)


def _comb_coeffs(d, fb):
    a = np.zeros(d + 1)
    a[0], a[d] = 1.0, -fb
    b = np.zeros(d + 1)
    b[0] = 1.0
    return b, a


def _allpass_coeffs(d, c):
    # y[n] = c*x[n] + x[n-d] - c*y[n-d]  (|H| = 1 at all frequencies)
    b = np.zeros(d + 1)
    b[0], b[d] = c, 1.0
    a = np.zeros(d + 1)
    a[0], a[d] = 1.0, c
    return b, a


class _Compressor:
    """Same per-sample envelope follower as fx_compressor, with state."""

    __slots__ = ("thr", "ratio", "env", "rel")

    def __init__(self, threshold_db, ratio, attack_ms, release_ms):
        self.thr = 10 ** (float(threshold_db) / 20.0)
        self.ratio = max(1.0, float(ratio))
        self.env = 0.0
        self.rel = self.thr * 1e-3 / max(1, int(SR * float(release_ms) / 1000))

    def push(self, x):
        n = len(x)
        if n == 0:
            return x
        out = np.empty(n, dtype=np.float64)
        env, thr, ratio, rel = self.env, self.thr, self.ratio, self.rel
        for i in range(n):
            amp = abs(x[i])
            if amp > env:
                env = amp
            else:
                env = max(0.0, env - rel)
            if env > thr:
                gain = (thr + (env - thr) / ratio) / env
            else:
                gain = 1.0
            out[i] = x[i] * gain
        self.env = env
        return out.astype(np.float32)


class _Formant:
    """Streaming formant shift (the online twin of fx_formant).

    Runs the same overlap-add STFT envelope-rescaling, but frame by frame as
    audio arrives. The per-frame shift is identical to the offline pass; only
    the windowing/accumulation is kept in state so the output is
    sample-continuous across chunk boundaries:

      * ``pin``   -- the not-yet-analyzed input tail; a frame is formed (hop
                     apart, contiguous across chunks) whenever it holds a full
                     window, and the consumed hop is discarded.
      * ``s``/``w`` -- the overlap-add accumulator and window-sum, kept as a
                     rolling buffer (``base`` = absolute sample of s[0]). A
                     sample is emitted once every frame that covers it has been
                     added (i.e. once frame index floor(p/hop) is processed),
                     which makes the output continuous and adds a fixed
                     algorithmic latency of ~ (nperseg-hop) samples.

    Because the envelope is rescaled on the frequency axis, formants move by
    ``f`` while the phase and the harmonic comb (the pitch) -- and therefore f0
    and the duration -- are preserved.
    """

    __slots__ = ("f", "nperseg", "hop", "win", "kern", "k", "nf",
                 "pin", "s", "w", "base", "emitted", "frame_idx")

    def __init__(self, f):
        self.f = float(f)
        self.nperseg = _FORM_NPERSEG
        self.hop = _FORM_HOP
        self.win = np.hanning(self.nperseg)
        self.kern = _gauss_kernel(max(1.0, _FORM_SIGMA_HZ / (SR / self.nperseg)))
        self.nf = self.nperseg // 2 + 1
        self.k = np.arange(self.nf)
        self.pin = np.zeros(0, dtype=np.float64)
        self.s = np.zeros(0, dtype=np.float64)
        self.w = np.zeros(0, dtype=np.float64)
        self.base = 0        # absolute sample index of self.s[0]
        self.emitted = 0     # number of output samples drained so far
        self.frame_idx = 0   # global analysis-frame index

    def push(self, x):
        x = np.asarray(x, dtype=np.float64)
        if len(x) == 0 or self.f == 1.0:
            return x.astype(np.float32) if len(x) else x
        self.pin = np.concatenate([self.pin, x]) if self.pin.size else x
        # Form as many contiguous (hop-spaced) analysis frames as we have input.
        while len(self.pin) >= self.nperseg:
            frame = self.pin[:self.nperseg]
            Y = _formant_shift_frame(rfft(frame * self.win), self.kern, self.k, self.nf, self.f)
            yf = np.real(irfft(Y, n=self.nperseg)) * self.win
            idx0 = self.frame_idx * self.hop - self.base
            need = idx0 + self.nperseg
            if len(self.s) < need:
                pd = need - len(self.s)
                self.s = np.concatenate([self.s, np.zeros(pd)])
                self.w = np.concatenate([self.w, np.zeros(pd)])
            self.s[idx0:idx0 + self.nperseg] += yf
            self.w[idx0:idx0 + self.nperseg] += self.win ** 2
            self.pin = self.pin[self.hop:]
            self.frame_idx += 1
        # Emit every sample whose covering frames are all in: p with
        # floor(p/hop) < frame_idx, i.e. p < frame_idx*hop.
        last_complete = self.frame_idx * self.hop
        if last_complete > self.emitted and self.w.size >= last_complete - self.base:
            i0 = self.emitted - self.base
            i1 = last_complete - self.base
            out = self.s[i0:i1] / np.where(self.w[i0:i1] > 1e-9, self.w[i0:i1], 1e-9)
            self.s = self.s[i1:]
            self.w = self.w[i1:]
            self.base = last_complete
            self.emitted = last_complete
            return out.astype(np.float32)
        return np.zeros(0, dtype=np.float32)


class _Chop:
    """Streaming amplitude chopper; the phase is the running sample count."""

    __slots__ = ("freq", "depth", "count")

    def __init__(self, freq, depth):
        self.freq = float(freq)
        self.depth = float(depth)
        self.count = 0

    def push(self, x):
        n = len(x)
        if n:
            t = (self.count + np.arange(n)) / SR
            gain = 1.0 - self.depth * (0.5 + 0.5 * np.sin(2.0 * np.pi * self.freq * t))
            x = x * gain
            self.count += n
        return np.asarray(x, dtype=np.float32)


class StreamingEffects:
    """Stateful chain of the (causal) effects, applied chunk by chunk."""

    def __init__(self, effects):
        self.stages = []
        fade_attack = 0
        for it in effects:
            t = it["type"]
            kw = {k: v for k, v in it.items() if k != "type"}
            if t == "eq":
                kind = kw.get("kind", "peaking")
                if kind not in ("peaking", "lowshelf", "highshelf"):
                    raise ValueError(f"eq kind must be peaking/lowshelf/highshelf, got {kind}")
                freq = float(kw.get("freq", 1000.0))
                if not (20 <= freq <= 12000):
                    raise ValueError("eq freq must be in [20, 12000] Hz")
                b, a = _rbj_coeffs(freq, SR, float(kw.get("gain_db", 0.0)), float(kw.get("q", 1.0)), kind)
                self.stages.append(("iir", _Iir(b, a)))
            elif t == "highpass":
                b, a = sps.butter(4, min(12000.0, float(kw.get("freq", 80.0))), btype="highpass", fs=SR)
                self.stages.append(("iir", _Iir(b, a)))
            elif t == "lowpass":
                b, a = sps.butter(4, max(100.0, float(kw.get("freq", 8000.0))), btype="lowpass", fs=SR)
                self.stages.append(("iir", _Iir(b, a)))
            elif t == "echo":
                d = max(1, int(SR * float(kw.get("delay_ms", 250)) / 1000))
                fb = float(np.clip(kw.get("feedback", 0.4), 0.0, 0.9))
                mix = float(kw.get("mix", 0.3))
                self.stages.append(("echo", _Iir(*_comb_coeffs(d, fb)), mix))
            elif t == "reverb":
                wet = float(np.clip(kw.get("wet", 0.3), 0.0, 1.0))
                comb_fb = 0.35 + 0.2 * float(np.clip(kw.get("size", 0.5), 0.0, 1.0))
                combs = [_Iir(*_comb_coeffs(int(SR * d_ms / 1000), comb_fb)) for d_ms in (110, 118, 127, 136)]
                aps = [_Iir(*_allpass_coeffs(15, c)) for c in (0.5, 0.75)]
                self.stages.append(("reverb", combs, aps, wet))
            elif t == "compressor":
                self.stages.append(
                    (
                        "comp",
                        _Compressor(
                            kw.get("threshold_db", -18.0),
                            kw.get("ratio", 3.0),
                            kw.get("attack_ms", 1.0),
                            kw.get("release_ms", 100.0),
                        ),
                    )
                )
            elif t == "bitcrush":
                self.stages.append(("crush", int(np.clip(kw.get("bits", 12), 4, 15))))
            elif t == "formant":
                st_ = float(np.clip(float(kw.get("semitones", 0.0)), -12.0, 12.0))
                self.stages.append(("formant", _Formant(2.0 ** (st_ / 12.0))))
            elif t == "chop":
                f = float(kw.get("freq", 44.0))
                if not (1.0 <= f <= 200.0):
                    raise ValueError("chop freq must be in [1, 200] Hz")
                self.stages.append(("chop", _Chop(f, float(np.clip(float(kw.get("depth", 0.8)), 0.0, 1.0)))))
            elif t == "fade":
                # Only the attack ramp can be applied online; the release is
                # skipped (the tail gate has already silenced the ending).
                fade_attack = max(fade_attack, int(SR * float(kw.get("attack_ms", 50)) / 1000))
            else:
                raise ValueError(f"unknown effect type: {t}")
        self._fade_left = fade_attack

    def push(self, x):
        if len(x) and self._fade_left > 0:
            n = min(self._fade_left, len(x))
            x = x.copy()
            x[:n] *= np.linspace(0.0, 1.0, n)
            self._fade_left -= n
        for st in self.stages:
            kind = st[0]
            if kind == "iir":
                x = st[1].push(x)
            elif kind == "echo":
                x = x + st[2] * st[1].push(x)
            elif kind == "reverb":
                _, combs, aps, wet = st
                out = None
                for c in combs:
                    y = c.push(x)
                    out = y if out is None else out + y
                out /= 4.0
                for a_ in aps:
                    out = a_.push(out)
                x = (1.0 - wet) * x + wet * out
            elif kind == "comp":
                x = st[1].push(x)
            elif kind == "crush":
                steps = 2 ** st[1]
                x = np.round(x * (steps / 2)) * (2 / steps)
            elif kind == "formant":
                x = st[1].push(x)
            elif kind == "chop":
                x = st[1].push(x)
        return x


class _Gate:
    """Online tail gate (expander), state carried across chunks.

    Stays open while the signal is voiced (or quiet-but-tonal / inaudible,
    which the caller bypasses entirely). After EXP_HANGOVER_MS of below-
    threshold, noise-like silence it ducks toward GATE_GAIN_FLOOR (release)
    and stays there until voiced again (attack), a soft duck, never a hard
    cut to zero.

    The voiced threshold is relative to a decaying loudness reference (fast
    attack, PEAK_RELEASE_MS release) that tracks the recent speech level
    instead of the single loudest chunk, and is capped at VOICED_REL_CAP so
    quiet syllables are not misread as silence.
    """

    __slots__ = ("g", "closed", "sil", "peak_rms")

    def __init__(self):
        self.g = 0.0  # start closed, like the offline gate before speech start
        self.closed = False
        self.sil = 0
        self.peak_rms = 0.0

    def push(self, x, inaudible=False, chunk_rms_max=0.0):
        n = len(x)
        if n == 0:
            return x
        rms = _frame_rms(x)
        nf = len(rms)
        if nf == 0:
            return x
        # Decaying loudness reference: jumps up on attack, decays on release so
        # it tracks the recent level rather than the global max.
        if chunk_rms_max > self.peak_rms:
            self.peak_rms = chunk_rms_max
        else:
            decay = math.exp(-(n / SR) / (PEAK_RELEASE_MS / 1000.0))
            self.peak_rms = max(chunk_rms_max, self.peak_rms * decay)
        if inaudible:
            # Voicing relative to the chunk's own level: inaudible speech
            # passes, its (equally inaudible) noise tail is still gated.
            voiced_thr = max(TRIM_RMS, VOICED_REL_INAUDIBLE * chunk_rms_max)
        else:
            voiced_thr = max(GATE_HOLD, min(VOICED_REL * self.peak_rms, VOICED_REL_CAP))

        alpha_a = 1 - np.exp(-1.0 / max(1.0, GATE_ATTACK_MS / 1000.0 * SR / _HOP))
        alpha_r = 1 - np.exp(-1.0 / max(1.0, GATE_RELEASE_MS / 1000.0 * SR / _HOP))
        hangover = max(1, int(EXP_HANGOVER_MS / 1000.0 * SR / _HOP))
        check = max(1, int(EXP_RECHECK_MS / 1000.0 * SR / _HOP))
        flat_win = int(EXP_HANGOVER_MS / 1000.0 * SR)

        g = self.g
        closed = self.closed
        sil = self.sil
        gbuf = np.empty(nf)
        for i in range(nf):
            end = min(n, (i + 1) * _HOP)
            if rms[i] > voiced_thr:
                sil = 0
                closed = False
            else:
                sil += 1
                if sil >= hangover and (sil - hangover) % check == 0:
                    seg = x[max(0, end - flat_win):end]
                    flat = spectral_flatness(seg) if len(seg) >= 128 else 1.0
                    if flat > TAIL_FLATNESS or rms[i] * 2 < GATE_HOLD:
                        closed = True
            if closed:
                g = max(GATE_GAIN_FLOOR, g * (1.0 - alpha_r))
            else:
                g = g + alpha_a * (1.0 - g)
            gbuf[i] = g
        self.g = float(g)
        self.closed = closed
        self.sil = sil

        per_sample = np.interp(np.arange(n) / _HOP, np.arange(nf), gbuf)
        return (x * per_sample).astype(np.float32)


def _trim_leading(x, keep_ms=TRIM_KEEP_MS, inaudible=False):
    """Cut leading silence, keeping ``keep_ms`` (trailing part untouched).

    For inaudible chunks the threshold is relative to the chunk's own peak
    (VOICED_REL), because residual noise (e.g. from the declicked click)
    would otherwise count as "voiced" and defeat the trim; for audible
    chunks the absolute TRIM_RMS is used, like the offline trim.
    """
    if len(x) == 0:
        return x
    rms = _frame_rms(x)
    if len(rms) == 0:
        return x
    thr = max(TRIM_RMS, VOICED_REL * float(rms.max())) if inaudible else TRIM_RMS
    voiced = np.where(rms > thr)[0]
    if len(voiced) == 0:
        return x
    keep = max(1, int(SR * keep_ms / 1000 / _HOP))
    a = max(0, int(voiced[0]) - keep)
    return x[a * _HOP:]


class StreamingPostProcessor:
    """Per-chunk (streaming) post-processing; the online twin of process().

    Usage:
        spp = StreamingPostProcessor(sr, "auto", effects)
        for chunk in generated_chunks:
            yield spp.process_chunk(chunk)

    ``postprocess`` is "auto" or "full"; "off" is accepted only together with
    effects (same pipeline, the denoiser then only fires for inaudible output
   , mirroring the offline process() twin, where off+effects runs the heavy
    path).
    """

    def __init__(self, sr, postprocess, effects):
        if sr != SR:
            raise ValueError(f"StreamingPostProcessor expects {SR} Hz, got {sr}")
        if postprocess not in ("auto", "full", "off"):
            raise ValueError("postprocess must be 'auto', 'full', or 'off'")
        self.mode = postprocess
        self.fx = StreamingEffects(effects) if effects else None
        self._first = True
        self._run_peak = 0.0
        self._prev_gain = 1.0  # gain actually applied to the last chunk (leveler continuity)
        self._noise = np.zeros(0, dtype=np.float32)
        self._noise_rms2 = float("inf")
        self._gate = _Gate()
        self.t_pp_ms = 0.0  # accumulated processing time (for logging)

    def _update_noise(self, x):
        """Track the quietest 300 ms window seen so far (Wiener noise PSD)."""
        if len(x) < _NPERSEG:
            return
        rms = _frame_rms(x)
        nf = len(rms)
        win = min(max(1, int(SR * 300 / 1000 / _HOP)), nf)
        if win >= nf:
            cand, cand_rms2 = x, float(np.mean(x ** 2))
        else:
            q = int(np.argmin(np.convolve(rms ** 2, np.ones(win), mode="valid")))
            cand = x[q * _HOP : (q + win) * _HOP]
            cand_rms2 = float(np.mean(cand ** 2))
        if cand_rms2 < self._noise_rms2:
            self._noise = cand
            self._noise_rms2 = cand_rms2

    def _level(self, x):
        """Adaptive leveler: peak 0.95, quiet chunks lifted to >= 50 % of the
        running peak (loudness stays within ~6 dB of the loudest chunk).
        Chunks without voiced content (silence/noise) are left untouched.

        The gain applied to a chunk is ramped (smoothstep) from the previous
        chunk's gain over the first LEVEL_RAMP_MS. PocketTTS yields contiguous
        audio, so two adjacent chunks share the same boundary sample; scaling
        them by different constant gains would make that sample jump (an
        audible click). Ramping keeps the output continuous at the boundary.
        """
        if len(x) == 0:
            self._prev_gain = 1.0
            return x
        rms = _frame_rms(x)
        if len(rms) == 0 or float(rms.max()) < LEVEL_MIN_RMS:
            self._prev_gain = 1.0
            return x
        p = float(np.max(np.abs(x)))
        if p < 1e-6:
            self._prev_gain = 1.0
            return x
        ref = max(p, self._run_peak * 0.5)
        self._run_peak = max(self._run_peak, p)
        target = TARGET_PEAK / ref
        prev = self._prev_gain
        n = len(x)
        ramp = min(n, int(SR * LEVEL_RAMP_MS / 1000.0))
        if ramp > 1 and abs(target - prev) > 1e-6:
            t = np.linspace(0.0, 1.0, ramp)
            curve = prev + (target - prev) * (t * t * (3.0 - 2.0 * t))
            gain = np.concatenate([curve, np.full(n - ramp, target)])
        else:
            gain = target
        self._prev_gain = target
        return (x * gain).astype(np.float32)

    def process_chunk(self, x):
        t0 = time.time()
        x = np.ascontiguousarray(x, dtype=np.float32)

        first = self._first
        if first:
            # First chunk: remove the leading click (both the click and the
            # leading silence only ever exist at the start of the stream).
            x = declick(x)
            self._first = False

        inaudible = len(x) > 0 and float(np.max(np.abs(x))) < INAUDIBLE_PEAK
        if first:
            x = _trim_leading(x, inaudible=inaudible)

        rms = _frame_rms(x)
        chunk_rms_max = float(rms.max()) if len(rms) else 0.0

        self._update_noise(x)
        if self.mode == "full" or inaudible:
            x = wiener_denoise(x, self._noise)

        x = self._gate.push(x, inaudible=inaudible, chunk_rms_max=chunk_rms_max)
        x = self._level(x)

        if self.fx is not None:
            x = self.fx.push(x)
        x = soft_limit(x)

        self.t_pp_ms += (time.time() - t0) * 1000
        return x
