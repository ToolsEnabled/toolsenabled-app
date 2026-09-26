"""Hidden child entry point. Bootstrap JSON is stdin-only, stdout is JSON-only."""

import asyncio
import json
import logging
import os
import re
import sys
import threading
from contextlib import suppress

from protocol import PROTOCOL_VERSION, VoiceError
from runtime_paths import configure_paths


def bootstrap():
    line = sys.stdin.buffer.readline(16385)
    if not line or len(line) > 16384:
        raise VoiceError("invalid_bootstrap", "Voice bootstrap is missing or too large.")
    body = json.loads(line)
    token = body.get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise VoiceError("invalid_bootstrap", "Voice bootstrap requires a random bearer token.")
    data = configure_paths(body.get("profileRoot"), body.get("dataRoot"), body.get("tempRoot"),
                           body.get("assetRoot"), body.get("modelRoot"))
    return token, data


async def serve(token, data):
    from aiohttp import web
    from loguru import logger
    logger.remove()
    logging.disable(logging.CRITICAL)
    from server import RuntimeServer
    runtime = RuntimeServer(token, data)
    runner = web.AppRunner(runtime.app, access_log=None, shutdown_timeout=5)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    print(json.dumps({"type": "ready", "protocolVersion": PROTOCOL_VERSION,
                      "port": port, "pid": os.getpid()}), flush=True)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()

    def watch_stdin():
        # The parent keeps the pipe open. EOF on app exit/crash terminates media.
        while sys.stdin.buffer.read(1):
            pass
        with suppress(RuntimeError):
            loop.call_soon_threadsafe(stopped.set)

    threading.Thread(target=watch_stdin, name="voice-parent-pipe", daemon=True).start()
    watchdog = asyncio.create_task(runtime.watchdog())
    try:
        await stopped.wait()
    finally:
        watchdog.cancel()
        with suppress(asyncio.CancelledError):
            await watchdog
        await runtime.close()
        await runner.cleanup()


def main():
    try:
        token, data = bootstrap()
        asyncio.run(serve(token, data))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        public = error.public() if isinstance(error, VoiceError) else {
            "code": "runtime_start_failed", "message": "Voice runtime startup failed. Repair its dependencies and try again."}
        print(json.dumps({"type": "error", **public}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
