"""Speech recognition/synthesis adapters. No chat, tools, or reasoning model."""

from __future__ import annotations

import asyncio
import io
import json
import threading
import wave
from contextlib import aclosing

import aiohttp
import numpy as np

from protocol import MAX_TEXT, VoiceError, provider_error
from runtime_paths import model_paths, model_readiness
from espeak_paths import espeak_config


def provider_config(body: dict) -> dict:
    if not isinstance(body, dict):
        raise VoiceError("invalid_request", "provider must be an object.")
    unknown = set(body) - {"stt", "tts", "apiKey", "sttModel", "ttsModel", "voice", "language"}
    if unknown:
        raise VoiceError("invalid_request", "The speech provider configuration contains unsupported fields.")
    config = {"stt": "local", "tts": "local", "language": "en", **body}
    if config["stt"] not in ("local", "openai") or config["tts"] not in ("local", "openai"):
        raise VoiceError("invalid_provider", "Choose local CUDA or OpenAI speech.")
    if "openai" in (config["stt"], config["tts"]):
        key = config.get("apiKey")
        if not isinstance(key, str) or not 8 <= len(key) <= 2048 or any(c.isspace() for c in key):
            raise VoiceError("cloud_key_missing", "Enter your cloud speech API key for this session.")
    else:
        config.pop("apiKey", None)
    for name in ("sttModel", "ttsModel", "voice", "language"):
        value = config.get(name)
        if value is not None and (not isinstance(value, str) or not value or len(value) > 128 or any(ord(c) < 32 for c in value)):
            raise VoiceError("invalid_request", f"Invalid {name} speech setting.")
    if config["stt"] == "local" and config.get("sttModel") not in (None, "large-v3-turbo"):
        raise VoiceError("invalid_model", "The installed local recognition model is large-v3-turbo.")
    if config["tts"] == "local" and config.get("ttsModel") not in (None, "kokoro-v1.0"):
        raise VoiceError("invalid_model", "The installed local voice model is Kokoro v1.0.")
    return config


class ModelStore:
    """One lazy resident copy of each local model per sidecar process."""

    def __init__(self, data_root):
        self.data = data_root
        self.whisper = None
        self.kokoro = None
        self._load_lock = asyncio.Lock()
        self._stt_lock = threading.Lock()

    def capability(self) -> dict:
        try:
            import ctranslate2
            import onnxruntime as ort
            gpu = ctranslate2.get_cuda_device_count()
            providers = ort.get_available_providers()
            return {"cudaDevices": gpu, "onnxProviders": providers,
                    "gpuAvailable": gpu > 0 and "CUDAExecutionProvider" in providers,
                    "models": model_readiness(self.data), "cpuFallback": False}
        except Exception:
            return {"gpuAvailable": False, "models": model_readiness(self.data),
                    "cpuFallback": False, "error": "gpu_dependencies_unavailable"}

    async def prepare(self, config: dict):
        if config["stt"] != "local" and config["tts"] != "local":
            return
        async with self._load_lock:
            await asyncio.to_thread(self._load, config)

    def _load(self, config):
        import ctranslate2
        import onnxruntime as ort
        paths = model_paths(self.data)
        if ctranslate2.get_cuda_device_count() < 1:
            raise VoiceError("gpu_unavailable", "Local speech requires a working NVIDIA CUDA GPU. CPU fallback is disabled.", 503)
        if not model_readiness(self.data)["ready"]:
            raise VoiceError("models_missing", "Local speech models are missing. Run the voice model setup, then reconnect.", 503)
        try:
            if config["stt"] == "local" and self.whisper is None:
                from faster_whisper import WhisperModel
                self.whisper = WhisperModel(str(paths["whisper"]), device="cuda", compute_type="float16",
                                            num_workers=1, cpu_threads=2, local_files_only=True)
                # Exercise CUDA kernels; enumerating a GPU is not proof of inference.
                self.transcribe(bytes(32000), "en")
            if config["tts"] == "local" and self.kokoro is None:
                from kokoro_onnx import Kokoro
                if "CUDAExecutionProvider" not in ort.get_available_providers():
                    raise RuntimeError("CUDAExecutionProvider unavailable")
                options = ort.SessionOptions()
                options.intra_op_num_threads = 2
                options.inter_op_num_threads = 1
                options.log_severity_level = 3
                session = ort.InferenceSession(str(paths["kokoro"]), sess_options=options,
                                               providers=[("CUDAExecutionProvider", {"device_id": 0,
                                                   "gpu_mem_limit": 2 * 1024**3,
                                                   "cudnn_conv_algo_search": "HEURISTIC"})])
                if session.get_providers()[0] != "CUDAExecutionProvider":
                    raise RuntimeError("GPU session fell back to CPU")
                session.disable_fallback()
                model = Kokoro.from_session(session, str(paths["voices"]), espeak_config=espeak_config(self.data))
                # Synthetic text only; audio is discarded, never played or recorded.
                samples, _ = model.create("Voice is ready.", voice="af_heart", lang="en-us")
                if len(samples) == 0:
                    raise RuntimeError("No synthesis audio")
                self.kokoro = model
        except VoiceError:
            raise
        except Exception as error:
            self.whisper = None
            self.kokoro = None
            raise VoiceError("gpu_initialization_failed", "CUDA speech initialization failed. Repair the voice GPU runtime and reconnect; CPU fallback is disabled.", 503) from error

    def transcribe(self, pcm: bytes, language: str) -> str:
        if self.whisper is None:
            raise VoiceError("stt_unavailable", "The local recognition model is not ready.", 503)
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        # faster-whisper returns a lazy iterator: consume it inside the worker
        # thread so CUDA generation cannot block the WebRTC/interrupt event loop.
        with self._stt_lock:
            segments, _ = self.whisper.transcribe(audio, language=language, beam_size=1,
                                                  condition_on_previous_text=False,
                                                  vad_filter=False, no_speech_threshold=0.6)
            return " ".join(segment.text.strip() for segment in segments
                            if segment.no_speech_prob < 0.6).strip()[:MAX_TEXT]


class SpeechProviders:
    def __init__(self, config: dict, models: ModelStore):
        self.config, self.models = config, models
        self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60, sock_read=30),
                                           trust_env=False, raise_for_status=False)

    async def close(self):
        await self.client.close()
        self.config.pop("apiKey", None)

    async def _check_response(self, response):
        if response.status < 400:
            return
        raw = await response.content.read(16385)
        code = ""
        if len(raw) <= 16384:
            try:
                error = json.loads(raw).get("error", {})
                code = error.get("code", "") if isinstance(error, dict) else ""
            except (ValueError, AttributeError):
                pass
        raise provider_error(response.status, code)

    async def transcribe(self, pcm):
        try:
            if self.config["stt"] == "local":
                return await asyncio.to_thread(self.models.transcribe, pcm, self.config["language"])
            audio = io.BytesIO()
            with wave.open(audio, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(pcm)
            form = aiohttp.FormData()
            form.add_field("file", audio.getvalue(), filename="speech.wav", content_type="audio/wav")
            form.add_field("model", self.config.get("sttModel", "gpt-4o-mini-transcribe"))
            form.add_field("language", self.config["language"])
            form.add_field("response_format", "json")
            async with self.client.post("https://api.openai.com/v1/audio/transcriptions", data=form,
                                        headers={"Authorization": "Bearer " + self.config["apiKey"]},
                                        allow_redirects=False) as response:
                await self._check_response(response)
                raw = await response.content.read(65537)
                if len(raw) > 65536:
                    raise VoiceError("cloud_response_limit", "The speech provider returned too much transcription data.", 502)
                return str(json.loads(raw).get("text", ""))[:MAX_TEXT]
        except VoiceError:
            raise
        except (aiohttp.ClientError, TimeoutError):
            raise VoiceError("speech_network_failed", "Cloud speech could not connect. Check your connection and retry.", 502, retryable=True)
        except Exception:
            raise VoiceError("transcription_failed", "Speech recognition failed. Reconnect voice to retry.", 503)

    async def synthesize(self, text):
        try:
            if self.config["tts"] == "local":
                languages = {"en": "en-us", "en-US": "en-us", "en-GB": "en-gb", "fr": "fr-fr", "zh": "cmn"}
                locale = languages.get(self.config["language"], self.config["language"])
                async with aclosing(self.models.kokoro.create_stream(
                        text, voice=self.config.get("voice", "af_heart"), lang=locale)) as stream:
                    async for samples, rate in stream:
                        yield (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes(), rate
            else:
                async with self.client.post("https://api.openai.com/v1/audio/speech",
                        headers={"Authorization": "Bearer " + self.config["apiKey"]},
                        json={"model": self.config.get("ttsModel", "gpt-4o-mini-tts"),
                              "voice": self.config.get("voice", "coral"), "input": text,
                              "response_format": "pcm"}, allow_redirects=False) as response:
                    await self._check_response(response)
                    pending, count = b"", 0
                    async for chunk in response.content.iter_chunked(4800):
                        pending += chunk
                        count += len(chunk)
                        if count > 24000 * 2 * 120:
                            raise VoiceError("audio_limit", "The synthesized speech exceeded its duration limit.", 502)
                        aligned = len(pending) & ~1
                        if aligned:
                            yield pending[:aligned], 24000
                            pending = pending[aligned:]
                    if pending:
                        raise VoiceError("invalid_audio", "The speech provider returned incomplete audio.", 502)
        except VoiceError:
            raise
        except (aiohttp.ClientError, TimeoutError):
            raise VoiceError("speech_network_failed", "Cloud speech could not connect. Check your connection and retry.", 502, retryable=True)
        except Exception:
            raise VoiceError("synthesis_failed", "Speech synthesis failed. Check the selected voice and reconnect.", 503)

