"""Speech to text host: newline-delimited JSON over stdio.

Loads the model once and keeps it resident, because a cold load costs seconds
and a transcription costs milliseconds.

MODEL CHOICE, measured on this machine (RTX 4070 Laptop, fp16, 4 utterances of
synthesized speech containing the project's jargon):

    model              VRAM    median latency   real-time factor   WER
    tiny.en            241 MB     136 ms            36x            5.0%
    small.en           729 MB     218 ms            23x            3.1%
    distil-large-v3   2145 MB     340 ms            15x            3.1%
    large-v3-turbo    2281 MB     345 ms            14x            3.1%

small.en is the pick: identical accuracy to models three times its size, a third
of the latency of the large ones, and small enough to sit alongside a resident
7B in Ollama inside the verified 2.6 GB of shared headroom. Override with
SCRIBE_STT_MODEL if a different tradeoff is ever wanted.

CUDA NOTE: ctranslate2 needs cuDNN 9 and there is no CUDA toolkit on this
machine. torch 2.5.1+cu121 bundles the DLLs, so making torch's lib directory
visible before importing faster_whisper is what makes GPU inference work at all.
Verified: without the shim, the CUDA backend fails to load.
"""

import io
import json
import math
import os
import re
import sys
import time
import traceback

_CUDA_NOTE = "not attempted"
_CUDA_CONFIGURED = False
_DLL_HANDLE = None

MODEL_NAME = os.environ.get("SCRIBE_STT_MODEL", "small.en")
STATE = {"model": None, "device": None, "loaded_ms": 0}
MAX_REQUEST_CHARS = 1024 * 1024
MAX_AUDIO_BYTES = 40 * 1024 * 1024
MAX_PROMPT_CHARS = 2000
MAX_TRANSCRIPT_CHARS = 100000


class Refused(Exception):
    pass


def configure_stdio():
    """Use UTF-8 in the host process without making the module unimportable."""
    for stream, write_through in ((sys.stdin, False), (sys.stdout, True), (sys.stderr, True)):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(
                encoding="utf-8", errors="replace", newline="\n",
                write_through=write_through,
            )
        elif hasattr(stream, "buffer"):
            wrapped = io.TextIOWrapper(
                stream.buffer, encoding="utf-8", errors="replace", newline="\n",
                write_through=write_through,
            )
            if stream is sys.stdin:
                sys.stdin = wrapped
            elif stream is sys.stdout:
                sys.stdout = wrapped
            else:
                sys.stderr = wrapped


def configure_cuda():
    """Make torch's bundled CUDA libraries visible once, immediately before load."""
    global _CUDA_CONFIGURED, _CUDA_NOTE, _DLL_HANDLE
    if _CUDA_CONFIGURED:
        return
    _CUDA_CONFIGURED = True
    try:
        import torch
        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            if hasattr(os, "add_dll_directory"):
                # Keep the handle alive; closing or collecting it removes the
                # directory from Windows' DLL search path.
                _DLL_HANDLE = os.add_dll_directory(lib)
            os.environ["PATH"] = lib + os.pathsep + os.environ.get("PATH", "")
            _CUDA_NOTE = "torch cuDNN shim applied"
        else:
            _CUDA_NOTE = "torch library directory not found"
    except Exception as e:  # torch missing is survivable, we fall back to CPU
        _CUDA_NOTE = "torch shim failed: %s" % e


def log(msg):
    sys.stderr.write("[stt] %s\n" % msg)
    sys.stderr.flush()


def reply(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, allow_nan=False) + "\n")
        sys.stdout.flush()
        return True
    except BrokenPipeError:
        return False


def request_lines(stream):
    """Yield bounded protocol lines, draining an oversized line before continuing."""
    while True:
        line = stream.readline(MAX_REQUEST_CHARS + 2)
        if line == "":
            return
        oversized = len(line.encode("utf-8")) > MAX_REQUEST_CHARS
        if oversized and not line.endswith("\n"):
            while line and not line.endswith("\n"):
                line = stream.readline(MAX_REQUEST_CHARS + 2)
        yield None if oversized else line


def load():
    """Load once, preferring the GPU, falling back to CPU rather than dying."""
    if STATE["model"] is not None:
        return STATE["model"]
    configure_cuda()
    from faster_whisper import WhisperModel
    for device, compute in (("cuda", "float16"), ("cpu", "int8")):
        try:
            t0 = time.perf_counter()
            m = WhisperModel(MODEL_NAME, device=device, compute_type=compute)
            STATE["model"] = m
            STATE["device"] = device
            STATE["loaded_ms"] = int((time.perf_counter() - t0) * 1000)
            log("loaded %s on %s in %d ms (%s)" % (MODEL_NAME, device, STATE["loaded_ms"], _CUDA_NOTE))
            return m
        except Exception as e:
            log("could not load on %s: %s: %s" % (device, type(e).__name__, str(e)[:200]))
    raise RuntimeError("could not load the speech model on either GPU or CPU")


def cmd_ping(_):
    return {"pong": True, "pid": os.getpid(), "model": MODEL_NAME,
            "device": STATE["device"], "ready": STATE["model"] is not None}


def cmd_warm(_):
    load()
    return {"model": MODEL_NAME, "device": STATE["device"], "load_ms": STATE["loaded_ms"]}


def cmd_transcribe(m):
    path = m.get("path")
    if not isinstance(path, str) or not os.path.isfile(path):
        raise ValueError("no such audio file: %s" % path)
    size = os.path.getsize(path)
    if size <= 0:
        raise Refused("audio file is empty")
    if size > MAX_AUDIO_BYTES:
        raise Refused("audio file is too large (%d bytes; limit %d)" %
                      (size, MAX_AUDIO_BYTES))
    beam = m.get("beam", 1)
    if isinstance(beam, bool) or not isinstance(beam, (int, float)):
        raise Refused("beam must be an integer from 1 to 10")
    if isinstance(beam, float) and (
            not math.isfinite(beam) or not beam.is_integer()):
        raise Refused("beam must be an integer from 1 to 10")
    beam = int(beam)
    if beam < 1 or beam > 10:
        raise Refused("beam must be an integer from 1 to 10")
    language = m.get("language")
    if language is None or language == "":
        language = "en"
    elif (not isinstance(language, str)
          or not re.fullmatch(r"[A-Za-z-]{2,16}", language)):
        raise Refused("language must be a short language code")
    prompt = m.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        raise Refused("prompt must be a string")
    if prompt is not None and len(prompt) > MAX_PROMPT_CHARS:
        raise Refused("prompt is too long")

    model = load()
    t0 = time.perf_counter()
    # vad_filter uses Silero under the hood to drop silence before decoding,
    # which is both faster and stops the model hallucinating text into silence.
    segments, info = model.transcribe(
        path,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
        beam_size=beam,
        language=language,
        condition_on_previous_text=False,
        # Steer the decoder toward the vocabulary this project actually uses.
        initial_prompt=prompt or
        "LEAN, QuantConnect, QuantCode-Bench, determinacy, saturate, backtest, "
        "the semantic edge, McNair, paragraph, benchmark.",
    )
    parts = []
    transcript_chars = 0
    for segment in segments:
        part = getattr(segment, "text", None)
        if not isinstance(part, str):
            raise Refused("speech model returned an invalid transcript segment")
        transcript_chars += len(part) + (1 if parts else 0)
        if transcript_chars > MAX_TRANSCRIPT_CHARS:
            raise Refused("transcript exceeded the safe output limit")
        parts.append(part)
    text = " ".join(parts).strip()
    took = time.perf_counter() - t0
    return {
        "text": text,
        "ms": int(took * 1000),
        "audio_s": round(info.duration, 2),
        "rtf": round(info.duration / took, 1) if took > 0 else None,
        "device": STATE["device"],
        "model": MODEL_NAME,
        "language": info.language,
    }


COMMANDS = {"ping": cmd_ping, "warm": cmd_warm, "transcribe": cmd_transcribe}


def handle_line(line):
    mid = None
    try:
        if line is None or len(line.encode("utf-8")) > MAX_REQUEST_CHARS:
            raise Refused("Request line is too large.")
        try:
            msg = json.loads(
                line,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError("invalid JSON constant %s" % value)),
            )
        except (json.JSONDecodeError, ValueError) as e:
            raise Refused("Invalid JSON: %s" % e)
        if not isinstance(msg, dict):
            raise Refused("Request must be a JSON object.")
        mid = msg.get("id")
        fn = COMMANDS.get(msg.get("cmd"))
        if fn is None:
            raise Refused("unknown command: %s" % msg.get("cmd"))
        return {"id": mid, "ok": True, "result": fn(msg)}
    except (Refused, ValueError) as e:
        return {"id": mid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    except Exception as e:
        log(traceback.format_exc())
        return {"id": mid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def main():
    configure_stdio()
    log("ready pid=%d model=%s" % (os.getpid(), MODEL_NAME))
    if not reply({"id": None, "ok": True, "result": {"hello": True, "model": MODEL_NAME}}):
        return
    for line in request_lines(sys.stdin):
        line = None if line is None else line.strip()
        if not line:
            if line is None and not reply(handle_line(None)):
                break
            continue
        if not reply(handle_line(line)):
            break
    log("stdin closed, exiting")


if __name__ == "__main__":
    main()
