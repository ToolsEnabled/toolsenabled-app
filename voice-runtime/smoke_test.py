"""Real CUDA + WebRTC round trip using generated audio, never a microphone.

Runs a temporary hidden worker and always terminates it. No cloud key or API
request, audio file, browser permission, user device, or agent task is involved.
"""

import asyncio
import argparse
import json
import os
import secrets
import subprocess
import sys
import time
from contextlib import suppress
from fractions import Fraction
from pathlib import Path

from runtime_paths import configure_paths, fenced_path


async def main(args):
    data = configure_paths(args.profile_root, args.data_root, args.temp_root, args.asset_root, args.model_root)
    from loguru import logger
    logger.remove()
    import aiohttp
    import av
    import numpy as np
    from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription

    class GeneratedTrack(AudioStreamTrack):
        def __init__(self):
            super().__init__()
            self.samples = bytearray()
            self.pts = 0
            self.next_time = None

        async def recv(self):
            loop = asyncio.get_running_loop()
            if self.next_time is None:
                self.next_time = loop.time()
            await asyncio.sleep(max(0, self.next_time - loop.time()))
            self.next_time += 0.02
            data = bytes(self.samples[:1920])
            del self.samples[:1920]
            data += bytes(1920 - len(data))
            frame = av.AudioFrame(format="s16", layout="mono", samples=960)
            frame.planes[0].update(data)
            frame.sample_rate, frame.pts, frame.time_base = 48000, self.pts, Fraction(1, 48000)
            self.pts += 960
            return frame

    worker_path = fenced_path(Path(__file__).absolute().with_name("worker.py"))
    process = await asyncio.create_subprocess_exec(sys.executable, "-E", "-s", "-B", "-u", str(worker_path),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=str(worker_path.parent), creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    diagnostics = bytearray()

    async def drain_errors():
        while chunk := await process.stderr.read(4096):
            diagnostics.extend(chunk)
            del diagnostics[:-16384]

    drain_task = asyncio.create_task(drain_errors())
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    source = GeneratedTrack()
    received, track_tasks = bytearray(), []
    token = secrets.token_urlsafe(48)
    process.stdin.write((json.dumps({"token": token, "profileRoot": args.profile_root,
        "dataRoot": str(data), "tempRoot": args.temp_root,
        "assetRoot": args.asset_root, "modelRoot": args.model_root}) + "\n").encode())
    await process.stdin.drain()
    started = time.monotonic()
    try:
        ready = json.loads(await asyncio.wait_for(process.stdout.readline(), 15))
        assert ready["type"] == "ready", ready
        url = f"http://127.0.0.1:{ready['port']}"
        headers = {"Authorization": "Bearer " + token}
        timeout = aiohttp.ClientTimeout(total=180)
        async with aiohttp.ClientSession(headers=headers, timeout=timeout, trust_env=False) as client:
            async def call(method, path, body=None):
                async with client.request(method, url + path, json=body) as response:
                    result = await response.json()
                    assert response.status < 400, (response.status, result)
                    return result

            health = await call("GET", "/health")
            assert health["speechOnly"] and health["local"]["gpuAvailable"]
            print(json.dumps({"step": "worker_ready", "pid": ready["pid"]}), flush=True)
            binding = {"sessionId": secrets.token_hex(16), "targetAgentId": "synthetic-test-agent", "generation": 1}
            session = await call("POST", "/sessions", {**binding, "provider": {"stt": "local", "tts": "local"}})
            base = "/sessions/" + session["sessionId"]
            print(json.dumps({"step": "cuda_models_ready", "seconds": round(time.monotonic() - started, 2)}), flush=True)
            cursor = 0
            all_events = []
            pending_events = []

            async def until(kind, seconds=25):
                nonlocal cursor
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    if not pending_events:
                        result = await call("GET", base + f"/events?after={cursor}&waitMs=1000")
                        cursor = result["lastSequence"]
                        all_events.extend(result["events"])
                        pending_events.extend(result["events"])
                    while pending_events:
                        event = pending_events.pop(0)
                        assert event["type"] != "error", event
                        if event["type"] == kind:
                            return event
                raise AssertionError(f"No {kind} event; observed {[event['type'] for event in all_events]}")

            @pc.on("track")
            def incoming(track):
                async def receive():
                    resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)
                    while True:
                        frame = await track.recv()
                        for converted in resampler.resample(frame):
                            received.extend(converted.to_ndarray().astype(np.int16).tobytes())
                            if len(received) > 48000 * 2 * 20:
                                del received[:len(received) - 48000 * 2 * 20]
                track_tasks.append(asyncio.create_task(receive()))

            pc.addTrack(source)
            channel = pc.createDataChannel("voice")
            await pc.setLocalDescription(await pc.createOffer())
            answer = await call("POST", base + "/offer", {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp})
            await pc.setRemoteDescription(RTCSessionDescription(type=answer["type"], sdp=answer["sdp"]))
            # Data channel label 'voice' is intentional; RTVI is disabled.
            await asyncio.wait_for(_wait_connected(pc), 15)
            await until("state")
            print(json.dumps({"step": "webrtc_connected", "dataChannel": channel.label}), flush=True)
            if args.probe_stream:
                # Test-only stdin protocol, not a worker endpoint or product
                # capability. Each phrase is synthesized, carried over WebRTC,
                # then fed back as generated audio to real VAD and CUDA STT.
                # No microphone, speakers, model tools or cloud service.
                print(json.dumps({"step": "probe_ready", "binding": binding}), flush=True)
                from protocol import Binding, ReplyState
                for _ in range(40):
                    line = await asyncio.to_thread(sys.stdin.readline)
                    if not line:
                        break
                    command = json.loads(line)
                    if command.get("op") == "close":
                        break
                    assert command.get("op") == "roundtrip"
                    text, request_id = command.get("text"), command.get("id")
                    assert isinstance(text, str) and 0 < len(text) <= 4096
                    assert isinstance(request_id, str) and 0 < len(request_id) <= 64
                    # The product intentionally stops playback between bounded
                    # phrases. Transcribe each complete phrase, not just the
                    # first playback.stopped event of a multi-sentence reply.
                    phrases = ReplyState(Binding.parse(binding)).accept({**binding,
                        "speechEpoch": 0, "utteranceId": request_id, "text": text, "final": True})
                    transcripts, pcm_bytes = [], 0
                    for index, (_, phrase, _) in enumerate(phrases):
                        interrupted = await call("POST", base + "/interrupt", binding)
                        received.clear()
                        await call("POST", base + "/reply", {**binding,
                            "speechEpoch": interrupted["speechEpoch"], "utteranceId": request_id + "-" + str(index),
                            "text": phrase, "final": True})
                        await until("playback.started")
                        await until("playback.stopped")
                        await asyncio.sleep(0.2)  # Receive the trailing RTP audio.
                        reference = bytes(received)
                        assert len(reference) > 4800, "No generated speech reached WebRTC"
                        pcm_bytes += len(reference)
                        source.samples.extend(reference + bytes(48000 * 2))
                        transcripts.append(await until("transcript.final", 40))
                    print(json.dumps({"step": "roundtrip", "id": request_id,
                        "pcmBytes": pcm_bytes, "events": transcripts}), flush=True)
                await call("DELETE", base)
                print(json.dumps({"step": "session_closed"}), flush=True)
                return
            received.clear()
            await call("POST", base + "/reply", {**binding, "speechEpoch": 0,
                "utteranceId": "reference", "text": "The blue lantern is on the desk.", "final": True})
            await until("playback.started")
            await until("playback.stopped")
            assert len(received) > 48000, "No synthesized audio reached the remote WebRTC track"
            reference = bytes(received)
            print(json.dumps({"step": "webrtc_synthesis_passed", "pcmBytes": len(reference)}), flush=True)
            await call("POST", base + "/reply", {**binding, "speechEpoch": 0,
                "utteranceId": "interrupt-me", "text": "This spoken answer will be interrupted. " * 8, "final": True})
            await until("playback.started")
            source.samples.extend(reference)
            user_started = await until("speech.started")
            assert user_started["speechEpoch"] > 0
            transcript = await until("transcript.final", 40)
            assert "lantern" in transcript["text"].lower(), transcript
            async with client.post(url + base + "/reply", json={**binding, "speechEpoch": 0,
                    "utteranceId": "late-first-chunk", "text": "Must not speak", "final": True}) as response:
                assert response.status == 409, await response.text()
            print(json.dumps({"step": "barge_in_and_transcription_passed", "transcript": transcript["text"],
                              "speechEpoch": transcript["speechEpoch"]}), flush=True)
            await call("DELETE", base)
            print(json.dumps({"step": "session_closed"}), flush=True)
    except Exception:
        if diagnostics:
            # The smoke worker receives no user text/key; bounded diagnostics aid
            # dependency debugging without recording any production session.
            print(diagnostics.decode("utf-8", "replace").replace("\x00", ""), file=sys.stderr)
        raise
    finally:
        for task in track_tasks:
            task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await task
        await pc.close()
        process.stdin.close()
        with suppress(Exception):
            await process.stdin.wait_closed()
        try:
            await asyncio.wait_for(process.wait(), 20)
        except TimeoutError:
            process.kill()
            await process.wait()
        await drain_task
        if args.probe_stream:
            assert process.returncode == 0, process.returncode
            print(json.dumps({"step": "worker_exited", "seconds": round(time.monotonic() - started, 2)}), flush=True)
    assert process.returncode == 0, process.returncode
    print(json.dumps({"step": "worker_exited", "seconds": round(time.monotonic() - started, 2)}), flush=True)


async def _wait_connected(pc):
    while pc.connectionState != "connected":
        if pc.connectionState in ("closed", "failed"):
            raise AssertionError("WebRTC failed to connect")
        await asyncio.sleep(0.05)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-root", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--temp-root", required=True)
    parser.add_argument("--asset-root")
    parser.add_argument("--model-root")
    parser.add_argument("--probe-stream", action="store_true",
                        help="Test-only generated-speech round trips requested as stdin JSON.")
    asyncio.run(main(parser.parse_args()))
