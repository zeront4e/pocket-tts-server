"""Thin sidecar entry point: loads the PocketTTS model with env-configured
temperature/quantization, then serves the stock pocket_tts FastAPI app with an
interruptible /tts endpoint.

Replaces `pocket-tts serve`, which does not expose a temperature option.

The stock /tts endpoint pushes every generated chunk into an unbounded queue
from a background thread, so it keeps generating (and burning CPU) long after
the client has disconnected. This wrapper swaps in a drop-in replacement that
polls the client connection and stops generation at the next chunk boundary
 (on the wire the request/response contract is identical: same form fields,
 same chunked audio StreamingResponse, WAV or Ogg/Opus). Note: A sentence whose latents are
already being computed runs to completion! The LM loop has no cancellation
point and Python threads cannot be killed.

Post-processing: The model's first generations after startup often carry a
leading click and (less often) a noise tail, and can come out far below
audible level. When the `postprocess` form field is not "off" (default:
"auto"), every generated chunk (PocketTTS yields one per decoded latent,
~80 ms of audio) is run through the streaming pipeline in postproc.py
(StreamingPostProcessor: Declick on the first chunk, optional Wiener denoise,
online tail gate, adaptive level, stateful `effects`, soft limit) and written
 into the same placeholder-header streaming WAV as soon as it is generated, so
 the first bytes reach the client after the first chunk, not after the whole
 generation. "off" keeps the raw model output byte-for-byte.

Output format: The `format` form field selects the container (default "wav").
"opus" wraps the same per-chunk pipeline in an in-process Ogg/Opus encoder
(the 24 kHz PCM is fed DIRECTLY to libopus at its native rate, no
resampling, the decoder still outputs 48 kHz; see opusenc.py). `bitrate`
(kbps, 6..510, default 32) sets the Opus bitrate. The Bun server resolves the defaults from
the OUTPUT_FORMAT / OPUS_BITRATE env vars and always sends both form fields,
so this wrapper only falls back to wav/32k when they are absent.

Environment:
  CONFIG_PATH   path to the model config YAML (set by the Bun server)
  SIDECAR_PORT  port to bind (default 8081)
  TEMP          sampling temperature (default 0.7)
  QUANTIZE      "0" to disable int8 quantization (default: enabled)
"""
import asyncio
import os
import pathlib
import queue
import tempfile
import threading
import time
from typing import Optional

import numpy as np
import torch
import uvicorn
from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

import pocket_tts.main
import opusenc
import postproc
from pocket_tts.data.audio import StreamingWAVWriter
from pocket_tts.default_parameters import get_default_voice_for_language
from pocket_tts.models.tts_model import TTSModel
from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES

config_path = os.environ.get("CONFIG_PATH", "./config/german_24l.yaml")
port = int(os.environ.get("SIDECAR_PORT", "8081"))
temp = float(os.environ.get("TEMP", "0.7"))
quantize = os.environ.get("QUANTIZE", "1") not in ("0", "false", "False", "")

print(f"[sidecar-wrapper] config={config_path} temp={temp} quantize={quantize}")
pocket_tts.main.tts_model = TTSModel.load_model(config=config_path, temp=temp, quantize=quantize)


# ---------------------------------------------------------------------------
# Interruptible /tts
# ---------------------------------------------------------------------------

# How often the response generator wakes up to check for client disconnect.
_DISCONNECT_POLL_S = 0.25
# Bounded so the writer thread applies backpressure instead of buffering the
# whole file in RAM; also keeps the queue from growing unboundedly on cancel.
_QUEUE_MAX_CHUNKS = 64

# The PocketTTS model is NOT thread-safe: concurrent generations mutate the
# shared KV caches / offsets in place and corrupt each other. A single global
# lock serializes every generation end-to-end (including backpressure waits).
_GEN_LOCK = threading.Lock()

# Each request owns a threading.Event that its response generator sets when the
# client goes away. Generations are serialized by _GEN_LOCK, so at most one is
# "active" (mutating model state) at a time; _ACTIVE_STOP points at the active
# request's event. The (monkey-patched) per-step flow-LM call reads _ACTIVE_STOP
# and unwinds the LM loop at the next step instead of running to EOS in a
# background thread, which is what left orphan generation/decoder threads
# mutating the model state after the client had disconnected.
#
# The event is per-request (not one shared global) because requests queue up on
# _GEN_LOCK: a client whose request is still QUEUED may disconnect while a
# DIFFERENT request is actively generating. With a shared event that disconnect
# would truncate the innocent active request; with per-request events the queued
# request's (already set) event just makes it unwind at its very first step once
# it becomes active.
_ACTIVE_STOP: Optional[threading.Event] = None

# The pristine prompt offset (read under _GEN_LOCK in _generate) of the voice
# state the active generation is mutating. Lets the per-chunk rewind patch
# below restore the stock "fresh state per sentence chunk" semantics in place.
_ACTIVE_PROMPT_END: Optional[int] = None

# Imported voice states, keyed by (absolute path, mtime_ns). Avoids re-uploading
# and re-importing the ~74 MB .safetensors voice state on every request, the
# single biggest first-chunk latency cost for custom (cloned) voices.
_STATE_CACHE: dict = {}
_STATE_CACHE_LOCK = threading.Lock()


class _Cancelled(Exception):
    pass


def _get_cached_voice_state(path: str) -> dict:
    """Import a .safetensors voice state once per (path, mtime) and cache it.

    Importing a cloned-voice state means loading its ~74 MB of KV cache onto the
    device. Doing that on every request dominated first-chunk latency, so the
    result is cached in memory and keyed by the file's mtime (a re-clone of the
    same name bumps the mtime and transparently re-imports).
    """
    mtime = os.stat(path).st_mtime_ns
    key = (path, mtime)
    with _STATE_CACHE_LOCK:
        cached = _STATE_CACHE.get(key)
    if cached is not None:
        return cached

    model = pocket_tts.main.tts_model
    state = model.get_state_for_audio_prompt(pathlib.Path(path), truncate=False)

    with _STATE_CACHE_LOCK:
        # A concurrent request may have imported the same key while we were
        # (un)locking; prefer whatever is already cached.
        cached = _STATE_CACHE.get(key)
        if cached is not None:
            return cached
        _STATE_CACHE[key] = state
        # Bound the cache so a long-lived server with many distinct voices does
        # not hold every 74 MB state in RAM forever.
        while len(_STATE_CACHE) > 8:
            _STATE_CACHE.pop(next(iter(_STATE_CACHE)))
    return state


def _reset_state_offsets(state: dict, prompt_end: int) -> None:
    """Rewind a (mutated-in-place) voice state back to its pristine prompt.

    With copy_state=False the model appends to the KV caches and advances every
    module's `offset` tensor in place. The prompt region of each cache
    [0:prompt_end] is never rewritten, attention only ever reads [0:offset) —
    so rewinding every offset back to prompt_end makes the state equivalent to a
    fresh prompt state. No re-import or deep copy required.
    """
    for module_state in state.values():
        offset = module_state.get("offset")
        if offset is not None:
            offset.fill_(prompt_end)


def _quiesce_model_threads(timeout: float = 5.0) -> None:
    """Best-effort: wait for a generation's internal (daemon) threads to drain
    before the next generation may start.

    The model spawns a generation thread and a decoder thread per sentence and
    only joins the decoder on the normal path. On abort the decoder join is
    skipped, so those threads can linger briefly. The stop-flag makes an
    interrupted generation unwind within one LM step, so this usually returns
    almost immediately. We treat the model as settled once the OS-thread count
    has been stable for a short window; a timeout only logs (the lock still
    serializes).
    """
    deadline = time.monotonic() + timeout
    last = threading.active_count()
    stable_since = time.monotonic()
    while time.monotonic() < deadline:
        count = threading.active_count()
        if count != last:
            last = count
            stable_since = time.monotonic()
        elif time.monotonic() - stable_since >= 0.1:
            return
        time.sleep(0.005)
    print(
        f"[sidecar-wrapper] quiescence timeout: {threading.active_count()} threads still active",
        flush=True,
    )


def _resolve_model_state(
    text: str,
    voice_url: Optional[str],
    voice_path: Optional[str],
    voice_wav: Optional[UploadFile],
) -> dict:
    """Resolve the voice to a shared in-memory model_state (dict).

    The state is reused in place across requests (copy_state=False); the worker
    rewinds it to its pristine prompt position after each generation (see
    _reset_state_offsets). The pristine prompt offset is read under the
    generation lock, NOT here, reading it here (before the lock) could observe
    a state that a concurrent generation has already advanced.
    """
    model = pocket_tts.main.tts_model

    voice_sources = 0
    if voice_url is not None and voice_url.strip() != "":
        voice_sources += 1
    if voice_path is not None and voice_path.strip() != "":
        voice_sources += 1
    if voice_wav is not None:
        voice_sources += 1
    if voice_sources > 1:
        raise HTTPException(
            status_code=400,
            detail="Provide at most one of voice_url, voice_path, or voice_wav",
        )

    if voice_path is not None and voice_path.strip() != "":
        path = os.path.abspath(voice_path.strip())
        if not path.lower().endswith(".safetensors"):
            raise HTTPException(status_code=400, detail="voice_path must point to a .safetensors file")
        if not os.path.isfile(path):
            raise HTTPException(status_code=400, detail=f"voice_path does not exist: {path}")
        return _get_cached_voice_state(path)

    if voice_url is None and voice_wav is None:
        voice_url = get_default_voice_for_language(str(model.origin))

    if voice_url is not None:
        if not (
            voice_url.startswith("http://")
            or voice_url.startswith("https://")
            or voice_url.startswith("hf://")
            or voice_url in _ORIGINS_OF_PREDEFINED_VOICES
        ):
            raise HTTPException(
                status_code=400, detail="voice_url must start with http://, https://, or hf://"
            )
        return model._cached_get_state_for_audio_prompt(voice_url)

    suffix = pathlib.Path(voice_wav.filename).suffix if voice_wav.filename else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        content = voice_wav.file.read()
        temp_file.write(content)
        temp_file.flush()
        temp_file_path = temp_file.name
    try:
        return model.get_state_for_audio_prompt(pathlib.Path(temp_file_path), truncate=True)
    finally:
        os.unlink(temp_file_path)


def _put_or_drop(out_queue: queue.Queue, data: bytes, stop_event: threading.Event):
    """Queue a chunk; give up (drop) if the client is already gone."""
    while True:
        try:
            out_queue.put(data, timeout=0.2)
            return
        except queue.Full:
            if stop_event.is_set():
                return


def _generate(
    text: str,
    model_state: dict,
    out_queue: queue.Queue,
    stop_event: threading.Event,
    spp: Optional[postproc.StreamingPostProcessor],
    fmt: str = "wav",
    bitrate_kbps: int = 32,
):
    """Worker thread: run generation, push audio bytes into out_queue.

    The whole generation (model driving + backpressure waits + state rewind +
    quiescence) runs under _GEN_LOCK so that only one request ever mutates the
    shared model state at a time. Generation runs in place on model_state
    (copy_state=False). The state is rewound to prompt_end BEFORE every
    sentence chunk after the first (the _patched_short monkey-patch, stock
    PocketTTS deep-copies the pristine state per chunk; continuing on the
    previous chunk's state truncates the text via early EOS) and a final
    rewind when the request is done, so the cached voice state stays pristine
    for the next request.

    Chunks are written into the response container chunk-wise as audio is
    generated (true streaming either way). The post-processing pipeline is
    orthogonal and applies to both formats:
      * raw (spp is None, i.e. postprocess == "off" and no effects): the
        stock behaviour, model chunks go straight into the writer.
      * processed: every chunk (PocketTTS yields one per decoded latent,
        ~80 ms of audio) is run through postproc.StreamingPostProcessor on
        this thread and the result is written immediately. The added latency
        is the per-chunk postproc time (a few ms) on top of the generation
        time. If processing a chunk fails, the request never fails: that chunk
        (and the rest) is sent raw.

    Output container:
      * wav (default): the stock placeholder-header streaming WAV.
      * opus: the same per-chunk pipeline wrapped in an in-process Ogg/Opus
        encoder (24 kHz PCM fed directly to libopus, no resampling, see
        opusenc.py). Encoding a chunk never fails the request: on error we
        stop and flush what we have.
    """
    model = pocket_tts.main.tts_model
    sr = model.config.mimi.sample_rate

    class _FileLike:
        def write(self, data):
            # The _checked generator is what actually stops the loop; once
            # stopped we simply drop data (e.g. a stray write triggered by
            # the wave writer's close during GC after a cancellation).
            _put_or_drop(out_queue, data, stop_event)

        def flush(self):
            pass

    def _checked(gen):
        try:
            for chunk in gen:
                if stop_event.is_set():
                    raise _Cancelled
                yield chunk
        finally:
            try:
                gen.close()
            except Exception:
                pass

    model_gen = model.generate_audio_stream(
        model_state=model_state, text_to_generate=text, copy_state=False
    )

    # Same logic as pocket_tts.data.audio.stream_audio_chunks, inlined so the
    # wave writer can be closed deterministically on cancellation (otherwise
    # its GC-time __del__ spews "seek not supported" tracebacks). For opus the
    # writer is opusenc.OpusWriter, which exposes the same write_pcm_data /
    # finalize surface (finalize() is idempotent, so the finally block below
    # can call it on both paths).
    if fmt == "opus":
        writer = opusenc.OpusWriter(
            push=lambda data: _put_or_drop(out_queue, data, stop_event),
            sample_rate=sr,
            bitrate=bitrate_kbps * 1000,
        )
        is_opus = True
    else:
        wav = _FileLike()
        writer = StreamingWAVWriter(wav, sr)
        writer.write_header(sr)
        is_opus = False

    n_chunks = 0
    t_gen = time.time()
    try:
        with _GEN_LOCK:
            # Register this request as the active generation: the patched LM
            # step consults _ACTIVE_STOP, so only THIS request's disconnect can
            # unwind it (a queued request's disconnect must not truncate the
            # request that is currently active).
            global _ACTIVE_STOP, _ACTIVE_PROMPT_END
            _ACTIVE_STOP = stop_event
            # Read the pristine prompt offset now that we hold the lock: the
            # state is guaranteed to be in its pre-generation position (either
            # just resolved, or already rewound by the previous request). We
            # MUST read it here, not at request start, a concurrent in-flight
            # generation would otherwise leave a non-pristine offset behind.
            prompt_end = model._flow_lm_current_end(model_state)
            _ACTIVE_PROMPT_END = prompt_end
            try:
                if stop_event.is_set():
                    # The client is already gone (it disconnected while this
                    # request was still queued on _GEN_LOCK): skip generation
                    # entirely, no prompting, no AR steps, nothing to rewind.
                    pass
                else:
                    for chunk in _checked(model_gen):
                        x = np.asarray(chunk, dtype=np.float32)
                        if spp is not None:
                            try:
                                x = spp.process_chunk(x)
                            except Exception as e:
                                # Never fail the request over post-processing: send
                                # this and all further chunks raw.
                                print(f"[sidecar-wrapper] postprocessing failed ({e}); sending raw audio", flush=True)
                                spp = None
                        try:
                            writer.write_pcm_data(torch.from_numpy(np.ascontiguousarray(x)))
                        except Exception as e:
                            # Never fail the request over encoding: stop and flush
                            # what we have. Signal stop so the model unwinds at the
                            # next step instead of running to EOS in the background.
                            print(f"[sidecar-wrapper] {fmt} encoding failed ({e}); stopping early", flush=True)
                            stop_event.set()
                            break
                        n_chunks += 1
                    writer.finalize()
            except _Cancelled:
                pass
            finally:
                try:
                    if is_opus:
                        writer.finalize()
                    else:
                        # finalize() already closed it on the normal path; on
                        # cancellation/skip close it here. Patch _patchheader to
                        # a no-op first in ALL cases: the streaming _FileLike
                        # has no tell()/seek(), and close() (including the one
                        # Wave_write.__del__ triggers at GC time) would otherwise
                        # crash while patching the placeholder header.
                        writer.wave_writer._patchheader = lambda: None
                        writer.wave_writer.close()
                except Exception:
                    pass

                # Stop the LM loop at the next step in ANY case where it may
                # still be running (cancellation, early encoding failure, or an
                # unexpected worker exception): without this the AR thread
                # would run to EOS in the background and keep mutating the
                # shared model state.
                stop_event.set()

                # Let the model's internal generation/decoder threads drain
                # BEFORE the rewind: on the paths above the AR thread may still
                # be running its (stop-flag-terminated) tail steps, and their
                # increment_steps would race with the rewind's offset.fill_,
                # leaving a non-pristine offset that the NEXT request would
                # read as its prompt_end (persistent conditioning drift).
                _quiesce_model_threads()

                # Final rewind: restore the in-place-mutated voice state to its
                # pristine prompt position so the next request for this voice
                # starts clean. (A no-op when generation was skipped.)
                try:
                    _reset_state_offsets(model_state, prompt_end)
                except Exception as e:
                    print(f"[sidecar-wrapper] state rewind failed ({e})", flush=True)

                # Deregister: the next generation (different request, different
                # event) may now start.
                _ACTIVE_STOP = None
                _ACTIVE_PROMPT_END = None
    except Exception as e:
        print(f"[sidecar-wrapper] generation failed ({e}); ending stream", flush=True)

    gen_ms = (time.time() - t_gen) * 1000
    if spp is not None:
        print(
            f"[sidecar-wrapper] gen={gen_ms:.0f}ms postproc={spp.t_pp_ms:.0f}ms "
            f"mode={spp.mode} chunks={n_chunks} "
            f"effects={len(spp.fx.stages) if spp.fx else 0} stages",
            flush=True,
        )

    try:
        out_queue.put(None, timeout=5)  # sentinel: end the response stream
    except queue.Full:
        pass  # client already gone


def _install_interruptible_tts():
    from pocket_tts.main import web_app

    model = pocket_tts.main.tts_model

    # Monkey-patch the per-step flow-LM call so an interrupted request unwinds
    # the LM loop at the NEXT step (returning EOS) instead of running to EOS in
    # a background thread. This is what prevents orphan generation/decoder
    # threads from mutating the shared model state after the client is gone —
    # the root cause of the wedged-sidecar / leaked-threads bug.
    #
    # Only the autoregressive hot loop is affected: it calls the step with
    # backbone_input_latents set and no text tokens. The one-shot prompting
    # calls (text tokens, or audio conditioning) are left untouched.
    _orig_step = model._run_flow_lm_and_increment_step

    def _patched_step(
        model_state,
        text_tokens=None,
        backbone_input_latents=None,
        audio_conditioning=None,
    ):
        active = _ACTIVE_STOP
        if (
            active is not None
            and active.is_set()
            and backbone_input_latents is not None
            and text_tokens is None
        ):
            is_eos = torch.ones((1, 1), dtype=torch.float32, device=backbone_input_latents.device)
            return backbone_input_latents, is_eos
        return _orig_step(model_state, text_tokens, backbone_input_latents, audio_conditioning)

    model._run_flow_lm_and_increment_step = _patched_step

    # Stock PocketTTS generates every sentence chunk of a multi-sentence text
    # from a FRESH copy of the pristine voice state (copy_state=True deep-copies
    # per chunk). Each chunk's autoregressive loop starts with a NaN BOS token,
    # and the model has only ever seen [voice prompt][BOS][text][audio], never
    # [prompt][text][audio][BOS][new text]. Continuing the 2nd+ chunk on the
    # PREVIOUS chunk's state (plain copy_state=False) makes the model emit EOS
    # within 1-2 steps of every chunk after the first: long texts are silently
    # truncated to their first sentence chunk (the early-EOS bug).
    #
    # Restore the stock per-chunk semantics in place: before every chunk rewind
    # the active state's offsets back to the request's prompt_end. The prompt
    # region of each KV cache [0:prompt_end] is never rewritten by generation
    # (writes always start at offset >= prompt_end), so a rewound state is
    # exactly the fresh per-chunk state the deep copy would have provided, at
    # zero copy cost. The first chunk is a no-op (offset is already pristine).
    _orig_short = model._generate_audio_stream_short_text

    def _patched_short(model_state, text_to_generate, frames_after_eos, copy_state):
        prompt_end = _ACTIVE_PROMPT_END
        if prompt_end is not None and not copy_state:
            _reset_state_offsets(model_state, prompt_end)
        return _orig_short(
            model_state=model_state,
            text_to_generate=text_to_generate,
            frames_after_eos=frames_after_eos,
            copy_state=copy_state,
        )

    model._generate_audio_stream_short_text = _patched_short

    for route in list(web_app.router.routes):
        if getattr(route, "path", None) == "/tts" and "POST" in getattr(route, "methods", set()):
            web_app.router.routes.remove(route)

    @web_app.post("/tts")
    async def text_to_speech(
        request: Request,
        text: str = Form(...),
        voice_url: Optional[str] = Form(None),
        voice_path: Optional[str] = Form(None),
        voice_wav: Optional[UploadFile] = File(None),
        postprocess: Optional[str] = Form(None),
        effects: Optional[str] = Form(None),
        format: Optional[str] = Form(None),
        bitrate: Optional[str] = Form(None),
    ):
        if not text.strip():
            raise HTTPException(status_code=400, detail="Text cannot be empty")

        # Resolve off the event loop: a cache-miss voice import (74 MB
        # .safetensors + prompt encoding) or a raw-audio clone (voice_wav)
        # runs full model forwards that can take ~1 s; blocking the loop here
        # would stall the disconnect polls of every in-flight stream.
        model_state = await asyncio.to_thread(
            _resolve_model_state, text, voice_url, voice_path, voice_wav
        )

        pp_mode = (postprocess or "auto").strip().lower()
        if pp_mode not in ("auto", "full", "off"):
            raise HTTPException(status_code=400, detail="postprocess must be 'auto', 'full', or 'off'")
        effect_list, effect_err = postproc.parse_effects(effects)
        if effect_err:
            raise HTTPException(status_code=400, detail=effect_err)

        fmt = (format or "wav").strip().lower()
        if fmt not in ("wav", "opus"):
            raise HTTPException(status_code=400, detail="format must be 'wav' or 'opus'")

        bitrate_kbps = 32
        if bitrate is not None and str(bitrate).strip() != "":
            try:
                bitrate_kbps = int(float(str(bitrate)))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="bitrate must be an integer (kbps)")
            if not (6 <= bitrate_kbps <= 510):
                raise HTTPException(status_code=400, detail="bitrate must be between 6 and 510 (kbps)")

        spp: Optional[postproc.StreamingPostProcessor] = None
        if pp_mode != "off" or effect_list:
            try:
                spp = postproc.StreamingPostProcessor(
                    pocket_tts.main.tts_model.config.mimi.sample_rate, pp_mode, effect_list
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        out_queue: queue.Queue = queue.Queue(maxsize=_QUEUE_MAX_CHUNKS)
        # Per-request stop signal (see _ACTIVE_STOP): set when THIS client goes
        # away. Never a shared global, requests queue on _GEN_LOCK, so a
        # queued request's disconnect must not truncate the active one.
        stop_event = threading.Event()

        worker = threading.Thread(
            target=_generate,
            args=(text, model_state, out_queue, stop_event, spp, fmt, bitrate_kbps),
            daemon=True,
        )

        worker.start()

        async def body():
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        data = await asyncio.to_thread(out_queue.get, _DISCONNECT_POLL_S)
                    except queue.Empty:
                        continue
                    if data is None:
                        break  # clean end (sentinel)
                    yield data
            finally:
                # Set the stop event on EVERY exit path, not only when the
                # 0.25 s disconnect poll caught the client. A client that dies
                # mid-stream closes this generator with GeneratorExit /
                # cancellation at the yield WITHOUT the poll ever seeing it —
                # if we didn't set the event there, the worker would keep
                # generating into a dead queue and spin forever in
                # _put_or_drop while holding _GEN_LOCK (the wedged-sidecar
                # bug). Setting it after a clean end is harmless: the event is
                # per-request, the worker has already finished, and nothing
                # else ever reads it.
                stop_event.set()

        media_type = "audio/opus" if fmt == "opus" else "audio/wav"
        ext = "opus" if fmt == "opus" else "wav"

        return StreamingResponse(
            body(),
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename=generated_speech.{ext}"},
        )


_install_interruptible_tts()

if __name__ == "__main__":
    uvicorn.run("pocket_tts.main:web_app", host="127.0.0.1", port=port)
