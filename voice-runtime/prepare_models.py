"""Explicit model provisioning; never runs implicitly during a voice session."""

import hashlib
import json
import argparse
import urllib.request
from pathlib import Path

from runtime_paths import configure_paths, fenced_path, model_paths

MODEL_ASSETS = json.loads(Path(__file__).with_name("model-assets.json").read_text(encoding="utf-8"))


def download(url, path, expected_size, expected_hash=None):
    path = fenced_path(path)
    if path.is_file() and path.stat().st_size == expected_size:
        with path.open("rb") as existing:
            digest = hashlib.file_digest(existing, "sha256").hexdigest()
        if not expected_hash or digest == expected_hash:
            return {"file": path.name, "bytes": expected_size, "sha256": digest}
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = fenced_path(path.with_suffix(path.suffix + ".download"))
    digest, count = hashlib.sha256(), 0
    request = urllib.request.Request(url, headers={"User-Agent": "ToolsEnabled-Voice-Provisioner/1"})
    # No proxy credentials, ambient token lookup, or authentication is used.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=60) as response, staging.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > expected_size:
                raise RuntimeError("Model download exceeded its declared size.")
            output.write(chunk)
            digest.update(chunk)
    if count != expected_size or (expected_hash and digest.hexdigest() != expected_hash):
        raise RuntimeError("Model download failed integrity verification.")
    staging.replace(path)
    return {"file": path.name, "bytes": count, "sha256": digest.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-root", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--temp-root", required=True)
    args = parser.parse_args()
    data = configure_paths(args.profile_root, args.data_root, args.temp_root)
    records = []
    for asset in MODEL_ASSETS["files"]:
        print(json.dumps({"type": "download", "model": asset["path"]}), flush=True)
        records.append(download(asset["url"], data / "models" / asset["path"], asset["bytes"], asset["sha256"]))
    print(json.dumps({"type": "models_ready", "whisperRevision": MODEL_ASSETS["whisperRevision"], "files": records}), flush=True)


if __name__ == "__main__":
    main()
