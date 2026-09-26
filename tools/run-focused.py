#!/usr/bin/env python3
"""One retained Linux focused run; never deletes fixtures or changes power."""
import argparse
import datetime
import fcntl
import json
import os
import pathlib
import signal
import subprocess
import time

DISK_STOP_BYTES = 8 * 1024**3
CPU_TYPES = ("TCPU", "TCPU_PCI", "x86_pkg_temp")


def test_environment(values):
    admitted = {}
    for item in values:
        name, separator, value = item.partition("=")
        if not separator or name in admitted:
            raise ValueError("Each test selector must be unique NAME=VALUE")
        if name in ("T1642_HANDOFF_BASELINE", "TASK_STALENESS_BASELINE", "T1644_RENDERER_PREFS_BASELINE", "TOOLSENABLED_TEST_RETAIN_FIXTURES"):
            if value != "1":
                raise ValueError(name + " only admits the explicit value 1")
        elif name == "T839_IMAGE_FIXTURE_ROOT":
            if not os.path.isabs(value) or any(ord(char) < 32 for char in value):
                raise ValueError(name + " requires an absolute fixture path")
        else:
            raise ValueError("Test environment selector is not allowed: " + name)
        admitted[name] = value
    return admitted


def observe():
    cpu = {}
    for entry in pathlib.Path("/sys/class/thermal").glob("thermal_zone*"):
        try:
            kind = (entry / "type").read_text().strip()
            if kind in CPU_TYPES:
                cpu[kind] = int((entry / "temp").read_text())
        except OSError:
            continue
    space = os.statvfs("/")
    return {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "cpu": cpu, "freeBytes": space.f_bavail * space.f_frsize}


def process_identity(pid):
    try:
        fields = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[19]
    except (OSError, IndexError):
        return None


def descendants(pid):
    found = {}
    def walk(parent):
        try:
            children = pathlib.Path(f"/proc/{parent}/task/{parent}/children").read_text().split()
        except OSError:
            return
        for value in children:
            child = int(value)
            identity = process_identity(child)
            if identity is not None and child not in found:
                found[child] = identity
                walk(child)
    walk(pid)
    return found


def send_group(pid, value):
    try:
        os.killpg(pid, value)
    except ProcessLookupError:
        pass


def terminate_tree(child, known):
    # Capture descendants before the group leader exits and reparents them.
    known.update(descendants(child.pid))
    send_group(child.pid, signal.SIGCONT)
    send_group(child.pid, signal.SIGTERM)
    for pid, identity in known.items():
        if process_identity(pid) == identity:
            try:
                os.kill(pid, signal.SIGCONT)
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # The leader may exit while a descendant ignores TERM. Its process group
    # and the observed escaped descendants still belong to this invocation.
    send_group(child.pid, signal.SIGKILL)
    for pid, identity in known.items():
        if process_identity(pid) == identity:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    child.wait()


def run_child(command, *, cwd, env, output, seconds, receipt, observe_fn=observe, interval=0.5):
    started = time.monotonic()
    child = None
    paused = False
    known = {}
    receipt.update(samples=[], transitions=[], maxCpuMilliC=dict(receipt.get("cpu", {})),
                   guard={"sampleSeconds": interval, "pauseMilliC": 74000,
                          "resumeBelowMilliC": 68000, "signals": ["SIGSTOP", "SIGCONT"],
                          "diskStopBytes": DISK_STOP_BYTES, "timeoutIncludesPausedTime": True})
    def sample():
        current = observe_fn()
        receipt["samples"].append(current)
        for kind, value in current["cpu"].items():
            receipt["maxCpuMilliC"][kind] = max(value, receipt["maxCpuMilliC"].get(kind, value))
        return current
    try:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        receipt["pid"] = child.pid
        while child.poll() is None:
            known.update(descendants(child.pid))
            time.sleep(interval)
            current = sample()
            if child.poll() is not None:
                break
            reason = None
            if "x86_pkg_temp" not in current["cpu"]:
                reason = "CPU sensor unavailable"
            elif current["freeBytes"] < DISK_STOP_BYTES:
                reason = "disk stop line"
            elif time.monotonic() - started >= seconds:
                reason = "wall timeout including paused time"
            if reason:
                receipt["aborted"] = reason
                break
            peak = max(current["cpu"].values())
            if not paused and peak >= 74000:
                send_group(child.pid, signal.SIGSTOP)
                paused = True
                receipt["transitions"].append({**current, "signal": "SIGSTOP"})
            elif paused and peak < 68000:
                send_group(child.pid, signal.SIGCONT)
                paused = False
                receipt["transitions"].append({**current, "signal": "SIGCONT"})
    except BaseException as error:
        receipt["aborted"] = "runner exception"
        receipt["exceptionType"] = type(error).__name__
        raise
    finally:
        if child is not None:
            terminate_tree(child, known)
            receipt["exitCode"] = child.returncode
        receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
        receipt["maxPackageMilliC"] = receipt["maxCpuMilliC"].get("x86_pkg_temp")
    return receipt["exitCode"]


def main():
    parser = argparse.ArgumentParser()
    for name in ("app", "engine", "node", "lock", "out"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--seconds", type=int, default=55)
    parser.add_argument("--env", action="append", default=[], metavar="NAME=VALUE",
                        help="Explicit reviewed test selector; retained verbatim in the receipt")
    parser.add_argument("--node-arg", action="append", default=[],
                        choices=("--experimental-vm-modules",),
                        help="Reviewed Node option, for example --node-arg=--experimental-vm-modules")
    parser.add_argument("suites", nargs="+")
    args = parser.parse_args()
    if len(args.suites) != 1:
        parser.error("Focused admission allows exactly one test file per run")
    if args.seconds <= 0:
        parser.error("The timeout must be positive")
    try:
        selected_env = test_environment(args.env)
    except ValueError as error:
        parser.error(str(error))
    prefix = pathlib.Path(args.out)
    def interrupted(number, _frame):
        raise InterruptedError("Focused runner received signal " + str(number))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with open(args.lock, "a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("REFUSED: lane focused.lock busy")
            return 75
        admission = observe()
        admission["lockHeld"] = args.lock
        admission["testEnvironment"] = selected_env
        admission["nodeArgs"] = list(args.node_arg)
        print(json.dumps(admission), flush=True)
        if ("x86_pkg_temp" not in admission["cpu"] or max(admission["cpu"].values()) >= 68000
                or admission["freeBytes"] < DISK_STOP_BYTES):
            print("REFUSED: actual CPU must be below 68000mC and free space at least 8GiB")
            return 75
        env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "USER", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR") if key in os.environ}
        env.update(selected_env)
        env.update(TOOLSENABLED_TEST_STRICT="1", MC_CANONICAL_ROOT=args.engine)
        command = ["nice", "-n", "10", "ionice", "-c3", "timeout", "--signal=TERM", "--kill-after=5s",
                   str(args.seconds) + "s", args.node, *args.node_arg, "--test",
                   "--import=./tools/test/lib/isolate-native-state-root.mjs",
                   "--test-reporter=tap", "--test-concurrency=1", *args.suites]
        admission["command"] = command
        admission["appBase"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.app, text=True).strip()
        # Reserve both paths before starting a process; never replace an old receipt.
        with open(str(prefix) + "-admission.json", "x") as receipt_file:
            try:
                with open(str(prefix) + ".tap", "x") as output:
                    run_child(command, cwd=args.app, env=env, output=output,
                              seconds=args.seconds, receipt=admission)
            except BaseException as error:
                admission.setdefault("exceptionType", type(error).__name__)
                admission.setdefault("exitCode", 1)
            finally:
                json.dump(admission, receipt_file, indent=2)
                receipt_file.write("\n")
                receipt_file.flush()
                os.fsync(receipt_file.fileno())
        print(json.dumps({"exitCode": admission["exitCode"], "elapsedSeconds": admission.get("elapsedSeconds"),
                          "admission": str(prefix) + "-admission.json", "tap": str(prefix) + ".tap"}))
        return admission["exitCode"] if not admission.get("aborted") else 1


if __name__ == "__main__":
    raise SystemExit(main())
