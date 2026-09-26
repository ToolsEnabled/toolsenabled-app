"""Bounded, dependency-free control state for the speech-only sidecar."""

from __future__ import annotations

import asyncio
import re
from collections import deque
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_TEXT = 8192
MAX_REPLY_CHUNK = 4096
MAX_REPLY_TOTAL = 32768
MAX_UTTERANCES = 1024
MAX_EVENTS = 256


class VoiceError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, *, retryable=False):
        super().__init__(message)
        self.code, self.message, self.status, self.retryable = code, message, status, retryable

    def public(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


def identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}", value):
        raise VoiceError("invalid_request", f"{name} must be a bounded identifier.")
    return value


def integer(value: Any, name: str, maximum=2**53 - 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
        raise VoiceError("invalid_request", f"{name} must be a non-negative integer.")
    return value


@dataclass(frozen=True)
class Binding:
    session_id: str
    target_agent_id: str
    generation: int

    @classmethod
    def parse(cls, body: dict) -> "Binding":
        return cls(identifier(body.get("sessionId"), "sessionId"),
                   identifier(body.get("targetAgentId"), "targetAgentId"),
                   integer(body.get("generation"), "generation"))

    def public(self) -> dict:
        return {"sessionId": self.session_id, "targetAgentId": self.target_agent_id,
                "generation": self.generation}

    def check(self, body: dict) -> None:
        integer(body.get("generation"), "generation")
        if body.get("targetAgentId") != self.target_agent_id or body.get("generation") != self.generation:
            raise VoiceError("stale_binding", "This reply belongs to a different agent or session generation.", 409)


class EventJournal:
    def __init__(self, binding: Binding, capacity=MAX_EVENTS):
        self.binding = binding
        self.events = deque(maxlen=capacity)
        self.sequence = 0
        self.changed = asyncio.Event()

    def emit(self, kind: str, **fields) -> dict:
        self.sequence += 1
        if "text" in fields:
            fields["text"] = str(fields["text"])[:MAX_TEXT]
        event = {**fields, **self.binding.public(), "type": kind, "sequence": self.sequence}
        self.events.append(event)
        self.changed.set()
        return event

    async def poll(self, after: int, wait_ms: int) -> dict:
        integer(after, "after")
        integer(wait_ms, "waitMs", 25000)
        if after > self.sequence:
            raise VoiceError("invalid_cursor", "Event cursor is ahead of this session.")
        if after == self.sequence and wait_ms:
            self.changed.clear()
            try:
                await asyncio.wait_for(self.changed.wait(), wait_ms / 1000)
            except TimeoutError:
                pass
        if self.events and after < self.events[0]["sequence"] - 1:
            raise VoiceError("event_gap", "Voice events expired. Reconnect this voice session.", 409)
        events = [event for event in self.events if event["sequence"] > after]
        return {"events": events, "lastSequence": self.sequence}


class ReplyState:
    """Stream text into bounded phrases and invalidate in-flight speech on interruption.

    speechEpoch binds replies to a listening interval. The host forwards the epoch
    observed when it associated an agent response with a user turn, so even a first
    delayed chunk cannot revive speech from an interrupted turn.
    """

    def __init__(self, binding: Binding):
        self.binding = binding
        self.epoch = 0
        self.closed = False
        self.seen: dict[str, dict] = {}
        self.pending_chars = 0

    def accept(self, body: dict) -> list[tuple[str, str, int]]:
        self.binding.check(body)
        if self.closed:
            raise VoiceError("session_closed", "This voice session has ended.", 410)
        epoch = integer(body.get("speechEpoch"), "speechEpoch")
        if epoch != self.epoch:
            raise VoiceError("stale_speech", "Speech for this listening turn was interrupted.", 409)
        utterance = identifier(body.get("utteranceId"), "utteranceId")
        text = body.get("text", "")
        final = body.get("final", False)
        if not isinstance(text, str) or len(text) > MAX_REPLY_CHUNK or not isinstance(final, bool):
            raise VoiceError("invalid_request", "Reply chunks must contain at most 4096 characters and a boolean final flag.")
        if any(ord(character) < 32 and character not in "\t\n\r" for character in text):
            raise VoiceError("invalid_request", "Reply text contains control characters.")
        state = self.seen.get(utterance)
        if state is None:
            if len(self.seen) >= MAX_UTTERANCES:
                raise VoiceError("session_limit", "Reconnect voice after this long session.", 409)
            state = {"epoch": epoch, "total": 0, "pending": "", "final": False}
            self.seen[utterance] = state
        if state["epoch"] != epoch or state["final"]:
            raise VoiceError("stale_utterance", "This spoken reply has already ended or was interrupted.", 409)
        if state["total"] + len(text) > MAX_REPLY_TOTAL or self.pending_chars + len(text) > MAX_REPLY_TOTAL:
            raise VoiceError("reply_limit", "The spoken reply exceeds the voice buffer limit.", 413)
        state["total"] += len(text)
        state["pending"] += text
        self.pending_chars += len(text)
        phrases = []
        while state["pending"]:
            pending = state["pending"]
            boundary = re.search(r"[.!?](?:[\"')\]]*)\s+|\n", pending)
            cut = boundary.end() if boundary else 0
            if not cut and len(pending) >= 240:
                cut = pending.rfind(" ", 0, 240) + 1 or 240
            if not cut:
                if not final:
                    break
                cut = len(pending)
            phrase, state["pending"] = pending[:cut], pending[cut:]
            self.pending_chars -= cut
            if phrase.strip():
                phrases.append((utterance, phrase.strip(), epoch))
        state["final"] = final
        return phrases

    def interrupt(self) -> int:
        self.epoch += 1
        self.pending_chars = 0
        for state in self.seen.values():
            state["pending"] = ""
            state["final"] = True
        return self.epoch

    def valid(self, utterance: str, epoch: int) -> bool:
        return not self.closed and self.epoch == epoch and self.seen.get(utterance, {}).get("epoch") == epoch


def provider_error(status: int, provider_code: str = "") -> VoiceError:
    # Never reflect a provider body: it can contain text, account data, or secrets.
    if provider_code in {"insufficient_quota", "billing_hard_limit_reached", "billing_not_active"}:
        return VoiceError("cloud_quota_exhausted", "Cloud speech quota or credit is exhausted. Add credit or select local speech.", 402)
    if status in (401, 403):
        return VoiceError("cloud_key_rejected", "The cloud speech API key was rejected or lacks access.", 401)
    if status == 429:
        return VoiceError("cloud_rate_limited", "Cloud speech is rate limited. Wait before retrying or select local speech.", 429, retryable=True)
    if status >= 500:
        return VoiceError("cloud_unavailable", "The cloud speech provider is temporarily unavailable.", 502, retryable=True)
    return VoiceError("cloud_request_failed", "The cloud speech provider could not complete this request. Check the selected speech model and voice.", 502)

