"""Pipecat WebRTC media graph attached to the existing host-managed agent."""

from __future__ import annotations

import asyncio
import uuid
from contextlib import aclosing, suppress
from dataclasses import dataclass

import pipecat.pipeline.worker as pipecat_worker

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
    ErrorFrame, Frame, InputAudioRawFrame, InterruptionFrame, TTSAudioRawFrame,
    TTSSpeakFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService, TextAggregationMode
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from protocol import MAX_TEXT, VoiceError
from speech_models import SpeechProviders

# Pipecat 1.8.1 unconditionally warms NLTK and may download tokenizer data.
# This graph already receives bounded phrases and uses TOKEN mode; it has no
# sentence tokenizer. Disable this one unused prewarm hook in our isolated
# process so voice startup never performs an implicit network/cache operation.
pipecat_worker.warm_deferred_imports = lambda: None

INPUT_RATE = 16000
OUTPUT_RATE = 24000
SEGMENT_BYTES = INPUT_RATE * 2 * 10
PREROLL_BYTES = INPUT_RATE * 2 // 2
MAX_QUEUED_SPEECH = 16384


@dataclass
class BoundSpeakFrame(TTSSpeakFrame):
    utterance_id: str = ""
    speech_epoch: int = 0


class SpeechInput(FrameProcessor):
    """Bounded VAD segments with recognition off the real-time media thread.

    Long turns produce accumulated partials every ten seconds and one final at
    VAD stop. No microphone samples are written to disk or sent to the host.
    """

    def __init__(self, owner):
        super().__init__()
        self.owner = owner
        self.buffer = bytearray()
        self.speaking = False
        self.turn_id = ""
        self.epoch = 0
        self.queue = asyncio.Queue(maxsize=3)
        self.worker = None

    async def setup(self, setup):
        await super().setup(setup)
        self.worker = self.create_task(self._recognize())

    async def cleanup(self):
        if self.worker:
            await self.cancel_task(self.worker)
        self.buffer.clear()
        while not self.queue.empty():
            self.queue.get_nowait()
            self.queue.task_done()
        await super().cleanup()

    def _segment(self, final):
        item = (bytes(self.buffer), final, self.turn_id, self.epoch)
        self.buffer.clear()
        try:
            self.queue.put_nowait(item)
        except asyncio.QueueFull:
            self.owner.session.error(VoiceError("transcription_backpressure",
                "Speech recognition could not keep up. Pause briefly and repeat the last sentence.", 429, retryable=True))

    async def _recognize(self):
        texts = {}
        while True:
            pcm, final, turn, epoch = await self.queue.get()
            try:
                text = await self.owner.providers.transcribe(pcm) if pcm else ""
                previous = texts.pop(turn, "")
                combined = (previous + " " + text).strip()[:MAX_TEXT]
                if (combined or final) and not self.owner.session.replies.closed:
                    self.owner.session.emit("transcript.final" if final else "transcript.partial",
                                            text=combined, utteranceId=turn, speechEpoch=epoch)
                if not final:
                    if len(texts) > 3:
                        texts.clear()
                    texts[turn] = combined
            except VoiceError as error:
                texts.pop(turn, None)
                self.owner.session.error(error, stage="stt")
            finally:
                self.queue.task_done()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.speaking = True
            self.turn_id = uuid.uuid4().hex
            await self.owner.session.interrupt(user_speech=True)
            self.epoch = self.owner.session.replies.epoch
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            if self.speaking:
                self.speaking = False
                self._segment(final=True)
                self.owner.session.emit("speech.stopped", utteranceId=self.turn_id)
        elif isinstance(frame, InputAudioRawFrame):
            self.buffer.extend(frame.audio)
            if not self.speaking:
                del self.buffer[:-PREROLL_BYTES]
            elif len(self.buffer) >= SEGMENT_BYTES:
                self._segment(final=False)
            return  # Microphone audio must never be echoed into the output track.
        await self.push_frame(frame, direction)


class HostSpeechTTS(TTSService):
    def __init__(self, owner):
        super().__init__(sample_rate=OUTPUT_RATE, push_start_frame=True,
                         push_stop_frames=True, stop_frame_timeout_s=30,
                         push_text_frames=False, pause_frame_processing=True,
                         text_aggregation_mode=TextAggregationMode.TOKEN,
                         settings=TTSSettings(model="host-public-reply", voice="selected", language=None))
        self.owner = owner
        self.binding = ("", -1)

    async def process_frame(self, frame, direction):
        if isinstance(frame, BoundSpeakFrame):
            if not self.owner.session.replies.valid(frame.utterance_id, frame.speech_epoch):
                self.owner.playback_done.set()
                return
            self.binding = (frame.utterance_id, frame.speech_epoch)
        await super().process_frame(frame, direction)

    async def run_tts(self, text, context_id):
        utterance, epoch = self.binding
        self.owner.context_epochs[context_id] = epoch
        try:
            async with aclosing(self.owner.providers.synthesize(text)) as stream:
                async for audio, rate in stream:
                    if not self.owner.session.replies.valid(utterance, epoch):
                        return
                    # Split even a local model's large chunk into bounded PCM frames.
                    for offset in range(0, len(audio), 4800):
                        yield TTSAudioRawFrame(audio=audio[offset:offset + 4800],
                                               sample_rate=rate, num_channels=1,
                                               context_id=context_id)
        except VoiceError as error:
            self.owner.session.error(error, stage="tts")
            self.owner.playback_done.set()
        finally:
            if len(self.owner.context_epochs) > 128:
                active = self.owner.session.replies.epoch
                self.owner.context_epochs = {key: value for key, value in self.owner.context_epochs.items() if value == active}


class PlaybackEvents(FrameProcessor):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            if self.owner.context_epochs.get(frame.context_id) != self.owner.session.replies.epoch:
                return
        if direction == FrameDirection.UPSTREAM:
            if isinstance(frame, BotStartedSpeakingFrame):
                self.owner.session.emit("playback.started", utteranceId=self.owner.current_utterance)
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self.owner.session.emit("playback.stopped", utteranceId=self.owner.current_utterance)
                self.owner.playback_done.set()
            elif isinstance(frame, ErrorFrame):
                self.owner.session.error(VoiceError("media_pipeline_error", "The voice media pipeline reported an error. Reconnect voice.", 503))
        await self.push_frame(frame, direction)


class MediaSession:
    def __init__(self, session, config, models):
        self.session = session
        self.providers = SpeechProviders(config, models)
        self.connection = None
        self.pipeline_worker = None
        self.runner = None
        self.run_task = None
        self.speak_task = None
        self.playback_done = asyncio.Event()
        self.speech_queue = asyncio.Queue(maxsize=64)
        self.queued_chars = 0
        self.current_utterance = ""
        self.context_epochs = {}
        self.closed = False
        self.pipeline_ready = asyncio.Event()

    async def offer(self, body):
        if self.connection:
            raise VoiceError("offer_already_applied", "Reconnect voice to create a new WebRTC connection.", 409)
        sdp = body.get("sdp")
        if body.get("type") != "offer" or not isinstance(sdp, str) or not 1 <= len(sdp) <= 65536:
            raise VoiceError("invalid_offer", "A bounded WebRTC SDP offer is required.")
        if "m=video" in sdp:
            raise VoiceError("invalid_offer", "Voice accepts an audio track and an optional data channel only.")
        self.connection = SmallWebRTCConnection(ice_servers=[], connection_timeout_secs=30)
        transport = SmallWebRTCTransport(self.connection, TransportParams(
            audio_in_enabled=True, audio_out_enabled=True,
            audio_in_sample_rate=INPUT_RATE, audio_out_sample_rate=OUTPUT_RATE,
            audio_in_channels=1, audio_out_channels=1,
            video_in_enabled=False, video_out_enabled=False))
        graph = Pipeline([transport.input(),
            VADProcessor(vad_analyzer=SileroVADAnalyzer(sample_rate=INPUT_RATE,
                params=VADParams(confidence=0.7, start_secs=0.12, stop_secs=0.65, min_volume=0.55))),
            SpeechInput(self), HostSpeechTTS(self), PlaybackEvents(self), transport.output()])
        self.pipeline_worker = PipelineWorker(graph, enable_rtvi=False, enable_turn_tracking=False,
            idle_timeout_secs=None, cancel_on_idle_timeout=False,
            params=PipelineParams(audio_in_sample_rate=INPUT_RATE, audio_out_sample_rate=OUTPUT_RATE))

        @self.pipeline_worker.event_handler("on_pipeline_started")
        async def started(*_):
            self.pipeline_ready.set()

        @transport.event_handler("on_client_connected")
        async def connected(*_):
            self.session.emit("state", state="listening")

        @transport.event_handler("on_client_disconnected")
        async def disconnected(*_):
            if not self.closed:
                self.session.emit("state", state="disconnected")
                asyncio.create_task(self.session.close())

        @self.pipeline_worker.event_handler("on_pipeline_error")
        async def pipeline_error(*_):
            self.session.error(VoiceError("media_pipeline_error", "The voice media pipeline failed. Reconnect voice.", 503))

        try:
            await self.connection.initialize(sdp=sdp, type="offer")
            answer = self.connection.get_answer()
            self.runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
            await self.runner.add_workers(self.pipeline_worker)
            self.run_task = asyncio.create_task(self._run_pipeline())
            self.speak_task = asyncio.create_task(self._speak())
            await asyncio.wait_for(self.pipeline_ready.wait(), 30)
            self.session.emit("state", state="connecting")
            return answer
        except Exception as error:
            await self.close()
            if isinstance(error, VoiceError):
                raise
            raise VoiceError("webrtc_setup_failed", "The local WebRTC audio connection could not start.", 503) from error

    async def _run_pipeline(self):
        try:
            await self.runner.run()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.session.error(VoiceError("media_pipeline_error", "The voice media pipeline stopped unexpectedly.", 503))
        finally:
            if not self.closed:
                asyncio.create_task(self.session.close())

    def check_capacity(self, text_size):
        if not self.pipeline_ready.is_set() or self.closed:
            raise VoiceError("media_not_ready", "Connect the microphone before sending a spoken reply.", 409)
        if self.queued_chars + text_size > MAX_QUEUED_SPEECH or self.speech_queue.qsize() >= 48:
            raise VoiceError("speech_backpressure", "The spoken reply buffer is full. Wait for playback to catch up.", 429, retryable=True)

    def enqueue(self, phrases):
        if len(phrases) + self.speech_queue.qsize() > 64:
            raise VoiceError("speech_backpressure", "Too many speech phrases are waiting for playback.", 429, retryable=True)
        for item in phrases:
            self.queued_chars += len(item[1])
            self.speech_queue.put_nowait(item)

    async def _speak(self):
        while True:
            utterance, text, epoch = await self.speech_queue.get()
            try:
                if not self.session.replies.valid(utterance, epoch):
                    continue
                self.current_utterance = utterance
                self.playback_done.clear()
                await self.pipeline_worker.queue_frame(BoundSpeakFrame(text=text,
                    append_to_context=False, utterance_id=utterance, speech_epoch=epoch))
                try:
                    await asyncio.wait_for(self.playback_done.wait(), 90)
                except TimeoutError:
                    self.session.error(VoiceError("playback_timeout", "Speech playback did not finish. Reconnect voice.", 503))
                    await self.session.interrupt()
            finally:
                self.queued_chars -= len(text)
                self.speech_queue.task_done()

    async def interrupt(self):
        while not self.speech_queue.empty():
            _, text, _ = self.speech_queue.get_nowait()
            self.queued_chars -= len(text)
            self.speech_queue.task_done()
        if self.pipeline_worker and not self.closed:
            await self.pipeline_worker.queue_frame(InterruptionFrame())
        self.playback_done.set()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        self.playback_done.set()
        for task in (self.speak_task,):
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        if self.pipeline_worker:
            with suppress(Exception):
                await asyncio.wait_for(self.pipeline_worker.cancel(), 5)
        if self.connection:
            with suppress(Exception):
                await asyncio.wait_for(self.connection.disconnect(), 5)
        if self.run_task:
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.wait_for(self.run_task, 5)
        while not self.speech_queue.empty():
            self.speech_queue.get_nowait()
            self.speech_queue.task_done()
        self.context_epochs.clear()
        await self.providers.close()

