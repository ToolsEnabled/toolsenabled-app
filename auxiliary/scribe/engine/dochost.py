"""Persistent document host: newline-delimited JSON over stdio.

Exists so the document is parsed once per session rather than once per edit.
Opening the 333-paragraph target costs 24 ms and a python-docx import costs
more, which is affordable once and not affordable per keystroke.

Protocol, one JSON object per line in each direction:

    ->  {"id": 7, "cmd": "replace", "pid": "A1B2C3D4", "find": "...", ...}
    <-  {"id": 7, "ok": true,  "result": {...}}
    <-  {"id": 7, "ok": false, "error": "human readable", "detail": {...}}

stdout carries protocol lines and nothing else. Anything worth saying to a human
goes to stderr. A stray print() here corrupts the stream, so there are none.
"""

import io
import json
import math
import os
import re
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from docmodel import ScribeDoc, DocError  # noqa: E402

STATE = {"doc": None}
MAX_REQUEST_CHARS = 1024 * 1024


def configure_stdio():
    """Use UTF-8 in the host process without making the module unimportable."""
    for stream, write_through in ((sys.stdin, False), (sys.stdout, True), (sys.stderr, True)):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(
                encoding="utf-8", errors="replace", newline="\n",
                write_through=write_through,
            )
        elif hasattr(stream, "buffer"):
            wrapped = io.TextIOWrapper(
                stream.buffer, encoding="utf-8", errors="replace", newline="\n",
                write_through=write_through,
            )
            if stream is sys.stdin:
                sys.stdin = wrapped
            elif stream is sys.stdout:
                sys.stdout = wrapped
            else:
                sys.stderr = wrapped


def log(msg):
    sys.stderr.write("[dochost] %s\n" % msg)
    sys.stderr.flush()


def reply(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return True
    except BrokenPipeError:
        return False


def request_lines(stream):
    """Yield bounded protocol lines, draining an oversized line before continuing."""
    while True:
        line = stream.readline(MAX_REQUEST_CHARS + 2)
        if line == "":
            return
        oversized = len(line.encode("utf-8")) > MAX_REQUEST_CHARS
        if oversized and not line.endswith("\n"):
            while line and not line.endswith("\n"):
                line = stream.readline(MAX_REQUEST_CHARS + 2)
        yield None if oversized else line


def int_field(message, name, default, minimum=None, maximum=None):
    value = message.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DocError("%s must be an integer" % name)
    if isinstance(value, float) and (
            not math.isfinite(value) or not value.is_integer()):
        raise DocError("%s must be an integer" % name)
    value = int(value)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def string_field(message, name, default=None, allow_empty=False):
    value = message.get(name, default)
    if not isinstance(value, str) or (not allow_empty and value == ""):
        kind = "a string" if allow_empty else "a non-empty string"
        raise DocError("%s must be %s" % (name, kind))
    return value


def format_props(message):
    """Validate every formatting value before docmodel can split a run."""
    props = {k: message[k] for k in
             ("b", "i", "u", "color", "highlight", "size") if k in message}
    for name in ("b", "i"):
        if name in props and not isinstance(props[name], bool):
            raise DocError("%s must be a boolean" % name)
    if "u" in props:
        underline = props["u"]
        allowed = {
            "single", "double", "thick", "dotted", "dash", "dotDash",
            "dotDotDash", "wave", "words",
        }
        clearing = (
            underline is None
            or underline is False
            or (isinstance(underline, str) and underline == "")
        )
        if underline is True or (
                not clearing
                and (not isinstance(underline, str) or underline not in allowed)):
            raise DocError("u must be empty, false, or a supported underline style")
    if "color" in props:
        color = props["color"]
        if not isinstance(color, str) or (
                color and not re.fullmatch(r"#?[0-9A-Fa-f]{6}", color)):
            raise DocError("color must be empty or a 6-digit hex string")
    if "highlight" in props:
        highlight = props["highlight"]
        allowed = {
            "", "black", "blue", "cyan", "green", "magenta", "red",
            "yellow", "white", "darkBlue", "darkCyan", "darkGreen",
            "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray",
        }
        if (highlight is not None
                and (not isinstance(highlight, str) or highlight not in allowed)):
            raise DocError("highlight must be empty or a supported Word highlight name")
    if "size" in props:
        size = props["size"]
        if isinstance(size, bool) or not isinstance(size, (int, float)):
            raise DocError("size must be a finite number from 1 to 400")
        if not math.isfinite(size) or size < 1 or size > 400:
            raise DocError("size must be a finite number from 1 to 400")
    return props


def need_doc():
    if STATE["doc"] is None:
        raise DocError("No document is open. Send {cmd:'open', path:'...'} first.")
    return STATE["doc"]


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_ping(_):
    return {"pong": True, "pid": os.getpid()}


def expected_package_sha256(message):
    value = message.get("expect_package_sha256")
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise DocError("The expected document package fingerprint is invalid.")
    return value


def assert_loaded_package(d, expected):
    if expected is not None and d.package_sha256 != expected:
        raise DocError(
            "The document package changed outside Scribe. Reopen it before editing.",
            package_changed=True,
            expected_package_sha256=expected,
            actual_package_sha256=d.package_sha256)


def document_info(d, stamp_save=None, **extra):
    return {
        "path": d.path,
        "count": len(d.paragraphs()),
        "stamped": d._stamped,
        "stamps_persisted": stamp_save is not None,
        "rev": d.rev,
        "package_sha256": (
            stamp_save["package_sha256"] if stamp_save is not None
            else d.package_sha256
        ),
        **extra,
    }


def cmd_open(m):
    path = string_field(m, "path")
    if not os.path.isfile(path):
        raise DocError("No such file: %s" % path, path=path)
    if not path.lower().endswith(".docx"):
        raise DocError("Only .docx is supported, got: %s" % path, path=path)
    expected = expected_package_sha256(m)
    d = ScribeDoc(path).open()
    assert_loaded_package(d, expected)
    # Paragraph ids are durable identities, not an in-memory rendering aid.
    # Persist any repairs before the server can snapshot this package for its
    # first undo checkpoint. save() first creates the ordinary exact backup,
    # so the user's pre-Scribe bytes remain recoverable.
    stamp_save = d.save(expect_package_sha256=d.package_sha256) if d._stamped else None
    STATE["doc"] = d
    log("opened %s (%d paragraphs, %d stamped)" % (path, len(d.paragraphs()), d._stamped))
    return document_info(d, stamp_save)


def cmd_reconcile(m):
    """Load current package bytes for read-only recovery without saving stamps."""
    path = string_field(m, "path")
    if not os.path.isfile(path):
        raise DocError("No such file: %s" % path, path=path)
    if not path.lower().endswith(".docx"):
        raise DocError("Only .docx is supported, got: %s" % path, path=path)
    d = ScribeDoc(path).open()
    STATE["doc"] = d
    log("reconciled read-only %s (%d paragraphs)" % (path, len(d.paragraphs())))
    return document_info(d)


def cmd_close(_):
    STATE["doc"] = None
    return {"closed": True}


def cmd_model(_):
    return need_doc().model()


def cmd_read(m):
    d = need_doc()
    start = int_field(m, "from", 0, minimum=0, maximum=10000000)
    end = None if m.get("to") is None else int_field(
        m, "to", 0, minimum=-1, maximum=10000000)
    return {"paragraphs": d.read(start, end)}


def cmd_find(m):
    d = need_doc()
    q = string_field(m, "query")
    if len(q) > 10000:
        raise DocError("query is too long")
    regex = m.get("regex", False)
    if not isinstance(regex, bool):
        raise DocError("regex must be a boolean")
    limit = int_field(m, "limit", 50, minimum=1, maximum=500)
    return {"hits": d.find(q, regex=regex, limit=limit)}


def cmd_replace(m):
    d = need_doc()
    pid = string_field(m, "pid")
    find = string_field(m, "find")
    replacement = string_field(m, "replace", "", allow_empty=True)
    occurrence = m.get("occurrence")
    if occurrence is not None:
        occurrence = int_field(m, "occurrence", 1, minimum=1)
    return d.replace(pid, find, replacement,
                     expect_hash=m.get("expect_hash"), occurrence=occurrence)


def cmd_set_text(m):
    d = need_doc()
    return d.set_text(string_field(m, "pid"),
                      string_field(m, "text", "", allow_empty=True),
                      expect_hash=m.get("expect_hash"))


def cmd_merge(m):
    d = need_doc()
    return d.merge(
        string_field(m, "first_pid"),
        string_field(m, "second_pid"),
        string_field(m, "first_text", "", allow_empty=True),
        string_field(m, "second_text", "", allow_empty=True),
        expect_first_hash=m.get("expect_first_hash"),
        expect_second_hash=m.get("expect_second_hash"),
    )


def cmd_insert(m):
    d = need_doc()
    style = m.get("style")
    if style is not None and not isinstance(style, str):
        raise DocError("style must be a string")
    return d.insert(string_field(m, "after_pid"),
                    string_field(m, "text", "", allow_empty=True), style=style,
                    expect_hash=m.get("expect_hash"))


def cmd_delete(m):
    d = need_doc()
    return d.delete(string_field(m, "pid"), expect_hash=m.get("expect_hash"))


def cmd_format(m):
    d = need_doc()
    props = format_props(m)
    occurrence = m.get("occurrence")
    if occurrence is not None:
        occurrence = int_field(m, "occurrence", 1, minimum=1)
    return d.format(string_field(m, "pid"), string_field(m, "find"),
                    expect_hash=m.get("expect_hash"),
                    expect_format_hash=m.get("expect_format_hash"),
                    occurrence=occurrence, **props)


def cmd_format_batch(m):
    d = need_doc()
    changes = m.get("changes")
    if not isinstance(changes, list):
        raise DocError("changes must be a list")
    return d.format_batch(changes)


def cmd_save(m):
    if os.environ.get("SCRIBE_TRANSACTION_TEST") == "1":
        delay = m.get("__test_delay_before_save_ms", 0)
        if (isinstance(delay, (int, float)) and not isinstance(delay, bool)
                and math.isfinite(delay) and delay > 0):
            time.sleep(min(float(delay), 1000) / 1000.0)
    return need_doc().save(
        expect_package_sha256=expected_package_sha256(m))


def cmd_reload(_):
    """Re-read the file from disk, discarding in-memory state.

    Used after an undo, which restores the .docx underneath us.
    """
    d = need_doc()
    path = d.path
    backup = d.backup_path
    expected = expected_package_sha256(_)
    nd = ScribeDoc(path).open()
    assert_loaded_package(nd, expected)
    # New checkpoints are already stamped because cmd_open persists ids before
    # the first transaction. A checkpoint written by an older Scribe may not
    # be. Before normalizing such a legacy snapshot, preserve its exact package
    # bytes under a collision-resistant sibling name. The original session
    # backup remains the normal save baseline, while this additional recovery
    # point protects opaque OOXML from the normalization round trip.
    normalization_backup = nd.create_exact_backup() if nd._stamped else None
    nd.backup_path = (
        backup if backup and os.path.isfile(backup)
        else normalization_backup
    )
    stamp_save = (
        nd.save(expect_package_sha256=nd.package_sha256)
        if nd._stamped else None
    )
    STATE["doc"] = nd
    return document_info(
        nd,
        stamp_save,
        normalization_backup=normalization_backup,
    )


def cmd_stats(_):
    d = need_doc()
    ps = d.paragraphs()
    return {"paragraphs": len(ps), "chars": sum(len(d.text_of(p)) for p in ps),
            "rev": d.rev, "path": d.path, "backup": d.backup_path}


COMMANDS = {
    "ping": cmd_ping, "open": cmd_open, "close": cmd_close, "model": cmd_model,
    "reconcile": cmd_reconcile,
    "read": cmd_read, "find": cmd_find, "replace": cmd_replace, "set_text": cmd_set_text,
    "merge": cmd_merge, "insert": cmd_insert,
    "delete": cmd_delete, "format": cmd_format,
    "format_batch": cmd_format_batch, "save": cmd_save,
    "reload": cmd_reload, "stats": cmd_stats,
}


def handle_line(line):
    mid = None
    try:
        if line is None or len(line.encode("utf-8")) > MAX_REQUEST_CHARS:
            raise DocError("Request line is too large.")
        try:
            msg = json.loads(
                line,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError("invalid JSON constant %s" % value)),
            )
        except (json.JSONDecodeError, ValueError) as e:
            raise DocError("Invalid JSON: %s" % e)
        if not isinstance(msg, dict):
            raise DocError("Request must be a JSON object.")
        mid = msg.get("id")
        fn = COMMANDS.get(msg.get("cmd"))
        if fn is None:
            raise DocError("Unknown command: %s. Known: %s"
                           % (msg.get("cmd"), ", ".join(sorted(COMMANDS))))
        return {"id": mid, "ok": True, "result": fn(msg)}
    except DocError as e:
        return {"id": mid, "ok": False, "error": e.message, "detail": e.detail}
    except KeyError as e:
        return {"id": mid, "ok": False, "error": "Missing required field: %s" % e,
                "detail": {}}
    except Exception as e:
        log("unhandled: %s" % traceback.format_exc())
        return {"id": mid, "ok": False, "error": "%s: %s" % (type(e).__name__, e),
                "detail": {}}


def main():
    configure_stdio()
    log("ready pid=%d" % os.getpid())
    for line in request_lines(sys.stdin):
        line = None if line is None else line.strip()
        if not line:
            if line is None and not reply(handle_line(None)):
                break
            continue
        if not reply(handle_line(line)):
            break
    log("stdin closed, exiting")


if __name__ == "__main__":
    main()
