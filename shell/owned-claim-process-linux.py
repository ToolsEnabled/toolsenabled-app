"""Own one claim's descendant lifetime; never inspect unrelated processes.

Linux adopts orphan descendants into this subreaper. Signals use pidfds after
waitid(P_PIDFD) confirms child ownership; an exit receipt requires ECHILD.
See man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html and
man7.org/linux/man-pages/man2/pidfd_send_signal.2.html.
"""

import ctypes
import json
import os
import select
import signal
import sys
import time


def receipt(value):
    try:
        os.write(3, (json.dumps(value, separators=(",", ":")) + "\n").encode())
    except (BrokenPipeError, OSError):
        pass  # The parent left; owned children must still be cleaned up.


def child_snapshot():
    # This single-threaded supervisor never reaps between this kernel child
    # snapshot and pidfd acquisition. An exited child keeps its PID until wait.
    with open("/proc/self/task/%d/children" % os.getpid(), "r", encoding="ascii") as stream:
        value = stream.read(1024 * 1024 + 1)
    if len(value) > 1024 * 1024:
        raise RuntimeError("OWNED_CHILD_SET_UNREADABLE")
    return [int(item) for item in value.split()]


def prepare():
    if not sys.platform.startswith("linux") or not all(hasattr(os, name) for name in
            ("pidfd_open", "P_PIDFD", "waitid", "WNOWAIT")) or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("OWNERSHIP_UNAVAILABLE")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise RuntimeError("OWNERSHIP_UNAVAILABLE")
    fd = os.pidfd_open(os.getpid())
    try:
        # ECHILD proves that the kernel recognized P_PIDFD before any CLI can
        # run. EINVAL/ENOSYS (unsupported kernel) refuses at this boundary.
        try:
            os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            pass
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    child_snapshot()


def supervise(command, private_stdin=False):
    cancelled = False
    started = False
    root_pid = None
    root_exit = None
    had_remaining_children = False
    owned = {}
    control = b""
    cleanup_at = None
    control_open = True

    def request_cancel(_signal=None, _frame=None):
        nonlocal cancelled, cleanup_at
        cancelled = True
        if cleanup_at is None:
            cleanup_at = time.monotonic()

    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    receipt({"type": "ready"})
    os.set_blocking(0, False)
    while not started and not cancelled:
        readable, _, _ = select.select([0], [], [], 0.1)
        if not readable:
            continue
        data = os.read(0, 128)
        if not data:
            request_cancel()
            break
        control += data
        if len(control) > 128:
            request_cancel()
            break
        if b"\n" not in control:
            continue
        line, control = control.split(b"\n", 1)
        if line != b"START" or control:
            request_cancel()
            break
        root_pid = os.fork()
        if root_pid == 0:
            try:
                # The CLI must not retain the private control/receipt channel.
                os.close(3)
                source = 4 if private_stdin else os.open("/dev/null", os.O_RDONLY)
                os.dup2(source, 0)
                if source > 2:
                    os.close(source)
                os.set_blocking(0, True)
                os.execv(command[0], command)
            except BaseException:
                os._exit(127)
        if private_stdin:
            os.close(4)
        started = True
        receipt({"type": "started"})

    if not started:
        receipt({"type": "complete", "quiescent": True, "started": False,
                 "cancelled": cancelled, "exitCode": None, "hadRemainingChildren": False})
        return

    while True:
        try:
            # Only kernel children of this supervisor enter the registry. No
            # numeric signal is issued; each pidfd is independently checked with
            # waitid before use, and then retained until that child is reaped.
            for pid in child_snapshot():
                if pid in owned:
                    continue
                try:
                    fd = os.pidfd_open(pid)
                    try:
                        os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    except BaseException:
                        os.close(fd)
                        raise
                    owned[pid] = fd
                except ProcessLookupError:
                    continue

            finished = []
            for pid, fd in list(owned.items()):
                event = os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if event is not None:
                    if pid == root_pid and root_exit is None:
                        root_exit = event.si_status if event.si_code == os.CLD_EXITED else -event.si_status
                        if cleanup_at is None:
                            cleanup_at = time.monotonic()
                    finished.append((pid, fd))

            if cleanup_at is not None:
                # A newly adopted child may do work after the root exits and
                # itself exit between observer polls. It still belongs to the
                # remaining descendant set even when it is already waitable.
                if root_exit is not None and any(pid != root_pid for pid in owned):
                    had_remaining_children = True
                sig = signal.SIGKILL if time.monotonic() - cleanup_at >= 0.25 else signal.SIGTERM
                for pid, fd in list(owned.items()):
                    if (pid, fd) in finished:
                        continue
                    try:
                        signal.pidfd_send_signal(fd, sig)
                    except ProcessLookupError:
                        pass

            for pid, fd in finished:
                os.waitid(os.P_PIDFD, fd, os.WEXITED)
                os.close(fd)
                del owned[pid]

            try:
                os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                receipt({"type": "complete", "quiescent": True, "started": True,
                         "cancelled": cancelled, "exitCode": root_exit,
                         "hadRemainingChildren": had_remaining_children})
                return

            readable, _, _ = select.select([0] if control_open else [], [], [], 0.025)
            if readable:
                data = os.read(0, 128)
                if not data:
                    control_open = False
                    request_cancel()
                else:
                    control += data
                    if len(control) > 128 or b"\n" in control:
                        request_cancel()
                        control = b""

        except BaseException:
            # A broken observer must not abandon its already-started mutation
            # tree. Retain ownership, try only known pidfds, and retry the
            # kernel child reconciliation. The parent answers bounded UNKNOWN
            # meanwhile; there is no successful receipt until ECHILD.
            request_cancel()
            for fd in list(owned.values()):
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except OSError:
                    pass
            time.sleep(0.025)


def main():
    try:
        prepare()
        position = 2 if len(sys.argv) > 1 and sys.argv[1] == "--private-stdin" else 1
        if len(sys.argv) <= position or not os.path.isabs(sys.argv[position]):
            raise RuntimeError("OWNERSHIP_INPUT_INVALID")
    except BaseException:
        receipt({"type": "complete", "quiescent": True, "started": False,
                 "cancelled": False, "exitCode": None, "hadRemainingChildren": False})
        return
    # A failure after spawning emits no successful receipt. The caller keeps
    # the persistent disconnect fence closed when ownership cannot be proved.
    arguments = sys.argv[1:]
    private_stdin = arguments[0] == "--private-stdin"
    if private_stdin:
        arguments = arguments[1:]
    supervise(arguments, private_stdin)


if __name__ == "__main__":
    main()
