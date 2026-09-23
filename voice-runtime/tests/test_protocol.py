import asyncio
import unittest

from protocol import Binding, EventJournal, MAX_REPLY_CHUNK, ReplyState, VoiceError, provider_error


class ReplyTests(unittest.TestCase):
    def setUp(self):
        self.binding = Binding("session-1", "coordinator", 7)
        self.state = ReplyState(self.binding)

    def reply(self, **overrides):
        return {"targetAgentId": "coordinator", "generation": 7, "speechEpoch": 0,
                "utteranceId": "reply-1", "text": "", "final": False, **overrides}

    def test_stream_preserves_words_across_chunk_boundaries(self):
        self.assertEqual(self.state.accept(self.reply(text="Hel")), [])
        self.assertEqual(self.state.accept(self.reply(text="lo world. ")), [("reply-1", "Hello world.", 0)])
        self.assertEqual(self.state.accept(self.reply(text="How are you?", final=True)), [("reply-1", "How are you?", 0)])

    def test_final_flushes_without_punctuation(self):
        self.state.accept(self.reply(text="A short answer"))
        self.assertEqual(self.state.accept(self.reply(final=True))[0][1], "A short answer")

    def test_stale_agent_and_generation_are_rejected(self):
        for change in ({"targetAgentId": "another-agent"}, {"generation": 6}):
            with self.assertRaises(VoiceError) as context:
                self.state.accept(self.reply(text="Do not speak", **change))
            self.assertEqual(context.exception.code, "stale_binding")

    def test_interrupt_rejects_delayed_first_chunk(self):
        self.state.interrupt()
        with self.assertRaises(VoiceError) as context:
            self.state.accept(self.reply(text="Old response", final=True))
        self.assertEqual(context.exception.code, "stale_speech")

    def test_interrupt_invalidates_known_utterance_even_with_new_epoch(self):
        self.state.accept(self.reply(text="Pending"))
        self.state.interrupt()
        with self.assertRaises(VoiceError) as context:
            self.state.accept(self.reply(speechEpoch=1, text="Old response", final=True))
        self.assertEqual(context.exception.code, "stale_utterance")
        self.assertEqual(self.state.pending_chars, 0)

    def test_final_cannot_be_replayed(self):
        self.state.accept(self.reply(text="Once", final=True))
        with self.assertRaises(VoiceError):
            self.state.accept(self.reply(text="Again", final=True))

    def test_closed_session_never_accepts(self):
        self.state.closed = True
        with self.assertRaises(VoiceError):
            self.state.accept(self.reply(text="No"))

    def test_bounds_and_required_epoch(self):
        for change in ({"text": "a" * (MAX_REPLY_CHUNK + 1)}, {"speechEpoch": None},
                       {"speechEpoch": True}, {"generation": True}, {"text": "\x00"}):
            with self.assertRaises(VoiceError):
                self.state.accept(self.reply(**change))

    def test_new_turn_and_utterance_remain_usable(self):
        self.state.interrupt()
        phrases = self.state.accept(self.reply(utteranceId="new", speechEpoch=1, text="New turn", final=True))
        self.assertTrue(self.state.valid("new", 1))
        self.assertEqual(phrases, [("new", "New turn", 1)])


class EventTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_wakes_and_binds_every_event(self):
        journal = EventJournal(Binding("session", "agent", 2))
        waiter = asyncio.create_task(journal.poll(0, 1000))
        await asyncio.sleep(0)
        journal.emit("transcript.final", text="Hello")
        result = await waiter
        self.assertEqual(result["lastSequence"], 1)
        self.assertEqual(result["events"][0]["targetAgentId"], "agent")

    async def test_event_gap_is_explicit(self):
        journal = EventJournal(Binding("session", "agent", 2), capacity=2)
        for _ in range(3):
            journal.emit("state", state="listening")
        with self.assertRaises(VoiceError) as context:
            await journal.poll(0, 0)
        self.assertEqual(context.exception.code, "event_gap")

    async def test_events_and_text_are_bounded(self):
        journal = EventJournal(Binding("session", "agent", 2), capacity=2)
        journal.emit("transcript.final", text="a" * 10000)
        self.assertEqual(len(journal.events[0]["text"]), 8192)


class CloudErrorTests(unittest.TestCase):
    def test_quota_and_rate_limit_are_distinct(self):
        self.assertEqual(provider_error(429, "insufficient_quota").code, "cloud_quota_exhausted")
        self.assertEqual(provider_error(429).code, "cloud_rate_limited")
        self.assertFalse(provider_error(429, "insufficient_quota").retryable)
        self.assertTrue(provider_error(429).retryable)

    def test_auth_and_server_failure_are_explicit(self):
        self.assertEqual(provider_error(401).code, "cloud_key_rejected")
        self.assertEqual(provider_error(503).code, "cloud_unavailable")


if __name__ == "__main__":
    unittest.main()

