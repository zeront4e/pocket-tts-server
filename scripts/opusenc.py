# Ogg/Opus encoder for the sidecar's `format=opus` path (PyAV libopus).
#
# PocketTTS yields mono float32 chunks at 24 kHz (~80 ms each). The 24 kHz
# PCM is fed DIRECTLY to libopus at its native 24 kHz rate (480-sample / 20 ms
# frames), no resampling. Encoding at 24 kHz instead of upsampled 48 kHz
# avoids wasting the limited bitrate on the empty 12–24 kHz band (the source
# has no content above 12 kHz), which at low bitrates causes audible
# quantization crackle in the speech band. The decoder still outputs 48 kHz
# (Opus always decodes to 48 kHz); the upper band is just silent.
#
# The encoder wraps an in-process FFmpeg container that writes Ogg pages
# straight out through a `push(bytes)` callback (no subprocess, no host
# ffmpeg binary).
#
# Streaming note: FFmpeg's Ogg muxer only writes a page once it holds at least
# `page_duration` of media (muxer option, default 1,000,000 µs = 1 s), and it
# additionally keeps one full page buffered before writing the previous one.
# Left at the default, /tts/stream + opus would not deliver a single audio byte
# until ~1 s of media was encoded. We set `page_duration` to 80 ms (one model
# chunk) so pages flush with per-chunk granularity, like the WAV path.
# (`buffer_size` on av.open() only changes the size of each write() call, not
# the flush cadence.)

from fractions import Fraction

import numpy as np
import av

# libopus valid bitrate range.
MIN_BITRATE = 6000
MAX_BITRATE = 510000


def clamp_bitrate(bitrate: int) -> int:
    """Clamp a bitrate in bps to libopus's [6, 510] kbps range."""
    b = int(bitrate)
    if b < MIN_BITRATE:
        return MIN_BITRATE
    if b > MAX_BITRATE:
        return MAX_BITRATE
    return b


class _SinkFile:
    """File-like object PyAV writes into; every write() is forwarded to `push`."""

    def __init__(self, push):
        self._push = push

    def write(self, data):
        self._push(bytes(data))
        return len(data)

    def seek(self, *args):
        return 0

    def tell(self):
        return 0

    def flush(self):
        pass

    def close(self):
        pass

    def read(self, n=-1):
        return b""


class OpusWriter:
    """Encodes mono float32 chunks (at the model's native sample rate, 24 kHz)
    into Ogg/Opus, pushing bytes as they are produced. Mirrors the surface of
    pocket_tts's StreamingWAVWriter (`write_pcm_data` / `finalize`) so the
    sidecar generation loop is shared.

    No resampling: the PCM is fed to libopus at its original rate. Opus
    natively supports 8/12/16/24/48 kHz input; at 24 kHz the encoder limits
    its bandwidth to 0–12 kHz (superwideband), allocating all bits to the
    speech band. The decoder always outputs 48 kHz.
    """

    def __init__(self, push, sample_rate: int = 24000, bitrate: int = 32000):
        self._sr = int(sample_rate)
        self._frame = int(self._sr * 0.020)  # 20 ms frames
        self._buf = np.zeros(0, np.float32)
        self._closed = False

        # Flush Ogg pages every 80 ms of media instead of the muxer default
        # (1 s of media per page): otherwise the first audio byte of a
        # /tts/stream response waits ~1 s behind the headers.
        self._container = av.open(
            _SinkFile(push), mode="w", format="ogg", options={"page_duration": "80000"}
        )
        self._stream = self._container.add_stream("libopus", rate=self._sr, layout="mono")
        self._stream.bit_rate = clamp_bitrate(bitrate)
        self._stream.codec_context.time_base = Fraction(1, self._sr)
        self._tb = Fraction(1, self._sr)

    def _push_frames(self, samples: np.ndarray):
        if len(samples):
            if len(self._buf):
                self._buf = np.concatenate([self._buf, samples])
            else:
                self._buf = np.ascontiguousarray(samples, dtype=np.float32)
        while len(self._buf) >= self._frame:
            frame_samples = self._buf[:self._frame]
            self._buf = self._buf[self._frame:]
            frame = av.AudioFrame.from_ndarray(
                frame_samples[None, :], format="fltp", layout="mono"
            )
            frame.sample_rate = self._sr
            frame.time_base = self._tb
            for packet in self._stream.encode(frame):
                self._container.mux(packet)

    def write_pcm_data(self, data):
        """Accepts a torch tensor or array-like of mono float samples at self._sr."""
        if self._closed:
            return
        x = np.asarray(data, dtype=np.float32).reshape(-1)
        if x.size == 0:
            return
        self._push_frames(x)

    def finalize(self):
        """Pad any partial frame, flush the encoder, and close the container
        (writes the final Ogg page). Idempotent."""
        if self._closed:
            return
        try:
            if len(self._buf):
                rem = len(self._buf) % self._frame
                if rem:
                    self._buf = np.concatenate(
                        [self._buf, np.zeros(self._frame - rem, np.float32)]
                    )
                self._push_frames(self._buf)
                self._buf = np.zeros(0, np.float32)
            for packet in self._stream.encode(None):
                self._container.mux(packet)
        finally:
            try:
                self._container.close()
            except Exception:
                pass
            self._closed = True
