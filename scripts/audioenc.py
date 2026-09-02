# Streaming audio encoders for the sidecar's non-WAV output formats
# (mp3, aac, flac, pcm), built on PyAV (already a dependency via opusenc).
#
# PocketTTS yields mono float32 chunks at 24 kHz (~80 ms each). Every writer
# mirrors the surface of pocket_tts's StreamingWAVWriter / opusenc.OpusWriter
# (`write_pcm_data` + an idempotent `finalize`) and pushes encoded bytes through
# a `push(bytes)` callback as they are produced, so the sidecar generation loop
# is shared across every container. All encoders run at the model's native
# 24 kHz rate (no resampling), matching the Opus path.
#
# AAC is written as ADTS (a streaming format with no container metadata), NOT
# as an m4a/mp4 container: the sidecar streams through a NON-seekable byte
# sink, and the MP4 muxer would have to seek back to write its `moov` atom,
# which corrupts the output when seek is a no-op. ADTS needs no seeking and
# decodes identically for our purposes.
#
# FLAC is the one exception that needs seeking: its muxer writes a header at
# the start and seeks back at finalize to patch STREAMINFO total_samples. A
# no-op seek sink would leave total_samples=0 (Duration: N/A), so FlacWriter
# buffers in a seekable in-memory sink and flushes the whole file at
# finalize() (it does not stream per chunk; mp3/aac/opus do).

import io

import numpy as np
import av
from fractions import Fraction

from opusenc import _SinkFile


class _SeekableSink(io.BytesIO):
    """A seekable in-memory sink for PyAV, used for formats whose muxer must
    seek back to patch a header written at the start (FLAC's STREAMINFO
    total_samples). opusenc's `_SinkFile` reports a no-op success on seek(),
    which would make the muxer "patch" a position it never rewinds to and leave
    a header with total_samples=0 (Duration: N/A). Buffering in memory lets the
    muxer seek for real; the whole buffer is flushed through `push` on close.

    Trade-off: a seekable format is delivered whole at finalize() instead of
    streaming per chunk. Only FLAC needs this; mp3/aac/opus are pure streaming
    and keep using the non-seekable `_SinkFile`.
    """

    def __init__(self, push):
        super().__init__()
        self._push = push
        self._flushed = False

    def close(self):
        # Idempotent: flush the buffered bytes exactly once, through `push`.
        # Do NOT close the underlying BytesIO: PyAV may close/seek it again on
        # GC, and a live buffer keeps those operations safe.
        if not self._flushed:
            self._flushed = True
            data = self.getvalue()
            if data:
                self._push(bytes(data))


class _FrameWriter:
    """Buffers mono float32 samples and feeds fixed-size frames to an in-process
    FFmpeg (PyAV) encoder, pushing bytes via `push()` as they are produced.

    Base class for the container writers (mp3/aac/flac). Mirrors opusenc's
    buffering: incoming samples are accumulated and only whole `frame`-sized
    chunks are handed to the encoder, so the codec always sees its natural
    frame size. `seekable=True` (FLAC) uses an in-memory sink so the muxer can
    patch its header; the other formats stream through the non-seekable sink.
    """

    def __init__(
        self,
        push,
        sample_rate: int,
        frame_size: int,
        container_format: str,
        codec: str,
        bitrate: int | None = None,
        seekable: bool = False,
    ):
        self._sr = int(sample_rate)
        self._frame = int(frame_size)
        self._buf = np.zeros(0, np.float32)
        self._closed = False

        sink = _SeekableSink(push) if seekable else _SinkFile(push)
        self._sink = sink
        self._container = av.open(sink, mode="w", format=container_format)
        self._stream = self._container.add_stream(codec, rate=self._sr, layout="mono")
        if bitrate:
            self._stream.bit_rate = int(bitrate)
        self._tb = Fraction(1, self._sr)
        self._stream.codec_context.time_base = self._tb

    def _encode_frames(self, samples: np.ndarray):
        frame = av.AudioFrame.from_ndarray(samples[None, :], format="fltp", layout="mono")
        frame.sample_rate = self._sr
        frame.time_base = self._tb
        for packet in self._stream.encode(frame):
            self._container.mux(packet)

    def _push_frames(self, samples: np.ndarray):
        if len(samples):
            if len(self._buf):
                self._buf = np.concatenate([self._buf, samples])
            else:
                self._buf = np.ascontiguousarray(samples, dtype=np.float32)
        while len(self._buf) >= self._frame:
            chunk = self._buf[: self._frame]
            self._buf = self._buf[self._frame :]
            self._encode_frames(chunk)

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
        (writes the final bytes). Idempotent."""
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
            # PyAV defers closing a file-like output to GC of the container;
            # close the sink explicitly so a seekable sink (FLAC) flushes its
            # buffer NOW, deterministically, not at an arbitrary GC point.
            try:
                self._sink.close()
            except Exception:
                pass
            self._closed = True


class Mp3Writer(_FrameWriter):
    """MP3 (libmp3lame), 1152-sample MPEG frames, default 128 kbps."""

    def __init__(self, push, sample_rate: int = 24000, bitrate: int = 128000):
        super().__init__(push, sample_rate, 1152, "mp3", "libmp3lame", bitrate)


class AacWriter(_FrameWriter):
    """AAC (ADTS stream), 1024-sample frames, default 128 kbps.

    Written as ADTS (see the module docstring): the sidecar streams through a
    non-seekable sink, so an m4a/mp4 container is not an option here.
    """

    def __init__(self, push, sample_rate: int = 24000, bitrate: int = 128000):
        super().__init__(push, sample_rate, 1024, "adts", "aac", bitrate)


class FlacWriter(_FrameWriter):
    """FLAC (lossless), 2048-sample frames. `bitrate` is ignored (lossless).

    Uses a seekable in-memory sink (seekable=True) so the muxer can patch the
    STREAMINFO total_samples; the output is delivered whole at finalize().
    """

    def __init__(self, push, sample_rate: int = 24000):
        super().__init__(push, sample_rate, 2048, "flac", "flac", None, seekable=True)


class PcmWriter:
    """Raw 16-bit little-endian mono PCM (no container, no header).

    Matches OpenAI's `pcm` response format. There is no encoding step, so every
    sample is converted and pushed immediately and `finalize()` is a no-op
    (idempotent, kept for interface parity with the container writers).
    """

    def __init__(self, push, sample_rate: int = 24000):
        self._push = push
        self._closed = False

    def write_pcm_data(self, data):
        if self._closed:
            return
        x = np.asarray(data, dtype=np.float32).reshape(-1)
        if x.size == 0:
            return
        int16 = np.clip((x * 32767.0), -32768, 32767).astype("<i2")
        self._push(int16.tobytes())

    def finalize(self):
        self._closed = True
