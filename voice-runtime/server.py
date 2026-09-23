"""Loopback-only authenticated host control; no browser CORS or public endpoint."""

from __future__ import annotations

import asyncio
import copy
import hmac
import time
from contextlib import suppress

from aiohttp import web

from protocol import Binding, EventJournal, PROTOCOL_VERSION, ReplyState, VoiceError, integer
from speech_models import ModelStore, provider_config


class VoiceSession:
    def __init__(self, binding):
        self.binding = binding
        self.replies = ReplyState(binding)
        self.journal = EventJournal(binding)
        self.media = None
        self.lock = asyncio.Lock()
        self.last_seen = time.monotonic()

    def public(self):
        return {**self.binding.public(), "speechEpoch": self.replies.epoch}

    def emit(self, kind, **fields):
        fields.setdefault("speechEpoch", self.replies.epoch)
        return self.journal.emit(kind, **fields)

    def error(self, error, stage="runtime"):
        self.emit("error", stage=stage, **error.public())

    async def interrupt(self, user_speech=False):
        # Never cancel an agent task: this runtime has no agent executor at all.
        self.replies.interrupt()
        if user_speech:
            self.emit("speech.started")
        if self.media:
            await self.media.interrupt()
        self.emit("playback.stopped", reason="barge_in" if user_speech else "interrupted")
        return self.public()

    async def close(self):
        if self.replies.closed:
            return
        self.replies.closed = True
        self.replies.interrupt()
        if self.media:
            await self.media.close()
        self.emit("state", state="closed")


class RuntimeServer:
    def __init__(self, token, data_root, *, model_store=None, media_factory=None):
        self.token = token
        self.models = model_store or ModelStore(data_root)
        self.media_factory = media_factory
        self.session = None
        self.session_ids = set()
        self.create_lock = asyncio.Lock()
        self.app = web.Application(client_max_size=131072, middlewares=[self.boundary])
        self.app.add_routes([
            web.get("/health", self.health), web.post("/sessions", self.create),
            web.get("/sessions/{session_id}/events", self.events),
            web.post("/sessions/{session_id}/offer", self.offer),
            web.post("/sessions/{session_id}/reply", self.reply),
            web.post("/sessions/{session_id}/interrupt", self.interrupt),
            web.delete("/sessions/{session_id}", self.delete)])

    @web.middleware
    async def boundary(self, request, handler):
        # The Electron main process is the only HTTP client. Renderer pages get
        # a narrow IPC proxy and never receive the bearer or cloud credential.
        if request.remote not in ("127.0.0.1", "::1"):
            return web.json_response({"error": {"code": "loopback_required"}}, status=403)
        host = request.headers.get("Host", "").split(":", 1)[0]
        if host != "127.0.0.1" or request.headers.get("Origin") is not None:
            return web.json_response({"error": {"code": "origin_rejected"}}, status=403)
        expected = "Bearer " + self.token
        supplied = request.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            return web.json_response({"error": {"code": "unauthorized"}}, status=401)
        try:
            response = await handler(request)
        except VoiceError as error:
            response = web.json_response({"error": error.public()}, status=error.status)
        except web.HTTPException as error:
            response = web.json_response({"error": {"code": "invalid_request", "message": "The voice request is invalid or too large."}}, status=error.status)
        except (ValueError, TypeError, KeyError):
            response = web.json_response({"error": {"code": "invalid_request", "message": "The voice request is malformed."}}, status=400)
        except Exception:
            # Raw exceptions may contain provider keys, text, or account paths.
            response = web.json_response({"error": {"code": "runtime_error", "message": "The voice runtime failed. Reconnect voice."}}, status=500)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def body(self, request):
        if request.content_type != "application/json":
            raise VoiceError("invalid_request", "Use an application/json request body.", 415)
        body = await request.json()
        if not isinstance(body, dict):
            raise VoiceError("invalid_request", "The voice request must be an object.")
        return body

    def get_session(self, request):
        session = self.session
        if session is None or request.match_info["session_id"] != session.binding.session_id:
            raise VoiceError("session_not_found", "This voice session no longer exists.", 404)
        session.last_seen = time.monotonic()
        return session

    async def health(self, _):
        return web.json_response({"protocolVersion": PROTOCOL_VERSION, "runtime": "pipecat",
                                  "speechOnly": True, "local": self.models.capability()})

    async def create(self, request):
        body = await self.body(request)
        binding = Binding.parse(body)
        if "/" in binding.session_id:
            raise VoiceError("invalid_request", "sessionId cannot contain path separators.")
        config = provider_config(body.get("provider", {}))
        async with self.create_lock:
            if self.session and not self.session.replies.closed:
                raise VoiceError("session_active", "Close the active voice session before starting another.", 409)
            if binding.session_id in self.session_ids:
                raise VoiceError("session_reused", "Use a fresh identifier for each voice session.", 409)
            if len(self.session_ids) >= 1024:
                raise VoiceError("runtime_limit", "Restart the voice runtime after this long session history.", 409)
            session = VoiceSession(binding)
            self.session, self.session_ids = session, self.session_ids | {binding.session_id}
            session.emit("state", state="preparing")
            try:
                await self.models.prepare(config)
                if session.replies.closed:
                    raise VoiceError("session_closed", "Voice setup was canceled.", 410)
                if self.media_factory is None:
                    from media import MediaSession
                    factory = MediaSession
                else:
                    factory = self.media_factory
                session.media = factory(session, config, self.models)
                # A cold CUDA/PTX warmup can outlast the host-idle deadline.
                # The host is awaiting this POST and cannot poll events yet;
                # start its idle budget only after media has become available.
                session.last_seen = time.monotonic()
                session.emit("state", state="ready")
                return web.json_response(session.public(), status=201)
            except Exception as error:
                config.pop("apiKey", None)
                if isinstance(error, VoiceError):
                    session.error(error)
                await session.close()
                raise

    async def events(self, request):
        session = self.get_session(request)
        after = int(request.query.get("after", "0"))
        wait = int(request.query.get("waitMs", "25000"))
        return web.json_response(await session.journal.poll(after, wait))

    async def offer(self, request):
        session = self.get_session(request)
        body = await self.body(request)
        async with session.lock:
            if not session.media or session.replies.closed:
                raise VoiceError("session_not_ready", "Voice setup is not ready.", 409)
            return web.json_response(await session.media.offer(body))

    async def reply(self, request):
        session = self.get_session(request)
        body = await self.body(request)
        async with session.lock:
            if not session.media:
                raise VoiceError("session_not_ready", "Voice setup is not ready.", 409)
            # Check capacity before mutating the assembler so a retry cannot lose text.
            text = body.get("text", "")
            if not isinstance(text, str):
                raise VoiceError("invalid_request", "Reply text must be a string.")
            session.media.check_capacity(len(text) + session.replies.pending_chars)
            candidate = copy.deepcopy(session.replies)
            phrases = candidate.accept(body)
            session.media.enqueue(phrases)
            session.replies = candidate
            return web.json_response({**session.public(), "accepted": True})

    async def interrupt(self, request):
        session = self.get_session(request)
        body = await self.body(request)
        async with session.lock:
            session.binding.check(body)
            return web.json_response(await session.interrupt())

    async def delete(self, request):
        session = self.get_session(request)
        async with session.lock:
            await session.close()
        return web.json_response({**session.public(), "closed": True})

    async def watchdog(self):
        while True:
            await asyncio.sleep(5)
            await self.expire_idle()

    async def expire_idle(self):
        session = self.session
        # No media connection or microphone exists while models are preparing.
        # Explicit DELETE/EOF cancellation still closes that pending session.
        if session and session.media is not None and not session.replies.closed and time.monotonic() - session.last_seen > 90:
            session.error(VoiceError("host_disconnected", "The app stopped polling voice events; the microphone connection was closed.", 410))
            await session.close()

    async def close(self):
        if self.session:
            await self.session.close()
