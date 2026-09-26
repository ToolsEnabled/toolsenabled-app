import unittest

from aiohttp.test_utils import TestClient, TestServer

from protocol import VoiceError
from server import RuntimeServer


class FakeModels:
    def capability(self):
        return {"gpuAvailable": False, "test": True}

    async def prepare(self, config):
        pass


class FakeMedia:
    def __init__(self, session, config, models):
        self.closed = False
        self.config = config
        self.phrases = []

    def check_capacity(self, _):
        pass

    def enqueue(self, phrases):
        self.phrases.extend(phrases)

    async def offer(self, body):
        return {"type": "answer", "sdp": "test-only"}

    async def interrupt(self):
        self.phrases.clear()

    async def close(self):
        self.closed = True
        self.config.pop("apiKey", None)


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = RuntimeServer("x" * 48, None, model_store=FakeModels(), media_factory=FakeMedia)
        self.client = TestClient(TestServer(self.runtime.app, host="127.0.0.1"))
        await self.client.start_server()
        self.headers = {"Authorization": "Bearer " + "x" * 48}
        self.session = {"sessionId": "session-1", "targetAgentId": "coordinator", "generation": 3,
                        "provider": {"stt": "local", "tts": "local"}}

    async def asyncTearDown(self):
        await self.runtime.close()
        await self.client.close()

    async def create(self):
        response = await self.client.post("/sessions", json=self.session, headers=self.headers)
        self.assertEqual(response.status, 201)
        return await response.json()

    async def test_health_requires_bearer(self):
        response = await self.client.get("/health")
        self.assertEqual(response.status, 401)
        response = await self.client.get("/health", headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())["speechOnly"])

    async def test_browser_origin_and_rebinding_rejected(self):
        for headers in ({**self.headers, "Origin": "https://example.com"},
                        {**self.headers, "Origin": "null"},
                        {**self.headers, "Host": "example.com"}):
            response = await self.client.get("/health", headers=headers)
            self.assertEqual(response.status, 403)

    async def test_session_binding_and_single_session(self):
        created = await self.create()
        self.assertEqual(created["speechEpoch"], 0)
        response = await self.client.post("/sessions", json={**self.session, "sessionId": "second"}, headers=self.headers)
        self.assertEqual(response.status, 409)

    async def test_interrupt_rejects_old_generation_and_speech_epoch(self):
        await self.create()
        body = {"targetAgentId": "coordinator", "generation": 3}
        response = await self.client.post("/sessions/session-1/interrupt", json=body, headers=self.headers)
        self.assertEqual((await response.json())["speechEpoch"], 1)
        reply = {**body, "speechEpoch": 0, "utteranceId": "late", "text": "Late", "final": True}
        response = await self.client.post("/sessions/session-1/reply", json=reply, headers=self.headers)
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"]["code"], "stale_speech")
        response = await self.client.post("/sessions/session-1/reply", json={**reply, "speechEpoch": 1}, headers=self.headers)
        self.assertEqual(response.status, 200)

    async def test_event_poll_and_close_release_media(self):
        await self.create()
        response = await self.client.get("/sessions/session-1/events?after=0&waitMs=0", headers=self.headers)
        self.assertEqual(len((await response.json())["events"]), 2)
        response = await self.client.delete("/sessions/session-1", headers=self.headers)
        self.assertTrue((await response.json())["closed"])
        self.assertTrue(self.runtime.session.media.closed)
        response = await self.client.post("/sessions", json=self.session, headers=self.headers)
        self.assertEqual(response.status, 409)

    async def test_cloud_key_never_returned(self):
        key = "unit-test-placeholder-key"
        self.session["provider"] = {"stt": "openai", "tts": "openai", "apiKey": key}
        result = await self.create()
        self.assertNotIn(key, str(result))
        response = await self.client.get("/sessions/session-1/events?after=0&waitMs=0", headers=self.headers)
        self.assertNotIn(key, await response.text())
        await self.runtime.close()
        self.assertNotIn("apiKey", self.runtime.session.media.config)

    async def test_invalid_and_oversize_payload(self):
        response = await self.client.post("/sessions", json=[], headers=self.headers)
        self.assertEqual(response.status, 400)
        response = await self.client.post("/sessions", json={"oversize": "a" * 140000}, headers=self.headers)
        self.assertEqual(response.status, 413)

    async def test_invalid_cloud_key_reports_missing_without_echo(self):
        self.session["provider"] = {"stt": "openai", "tts": "local"}
        response = await self.client.post("/sessions", json=self.session, headers=self.headers)
        self.assertEqual((await response.json())["error"]["code"], "cloud_key_missing")

    async def test_cold_prepare_is_not_host_idle_and_ready_resets_deadline(self):
        during_prepare = []

        async def cold_prepare(_):
            session = self.runtime.session
            session.last_seen -= 200
            await self.runtime.expire_idle()
            during_prepare.append((session.media, session.replies.closed))

        self.runtime.models.prepare = cold_prepare
        await self.create()
        self.assertEqual(during_prepare, [(None, False)])
        await self.runtime.expire_idle()
        self.assertFalse(self.runtime.session.replies.closed)

    async def test_ready_session_still_expires_without_host_polling(self):
        await self.create()
        self.runtime.session.last_seen -= 100
        await self.runtime.expire_idle()
        self.assertTrue(self.runtime.session.replies.closed)
        self.assertTrue(self.runtime.session.media.closed)
        errors = [event for event in self.runtime.session.journal.events if event["type"] == "error"]
        self.assertEqual(errors[-1]["code"], "host_disconnected")

    async def test_explicit_close_during_prepare_is_not_revived(self):
        async def canceled_prepare(_):
            await self.runtime.close()

        self.runtime.models.prepare = canceled_prepare
        response = await self.client.post("/sessions", json=self.session, headers=self.headers)
        self.assertEqual(response.status, 410)
        self.assertEqual((await response.json())["error"]["code"], "session_closed")
        self.assertIsNone(self.runtime.session.media)


if __name__ == "__main__":
    unittest.main()
