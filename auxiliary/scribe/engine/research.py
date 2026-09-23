"""Retrieval host: the corpus index, source reading, and guarded SQL.

Same stdio JSON-lines contract as dochost.py. Lives in Python because the corpus
is .docx and .pdf, and the extractors are here.

Ripgrep is not on this machine, so the index is built here: walk the roots once,
extract text, cache it keyed by (path, mtime, size), then search in memory.
The whole curated corpus is roughly 4 M chars, which is small enough that a
linear scan is faster than maintaining anything cleverer.

Three hazards this file exists to handle, all measured beforehand:

  1. Some files exist in up to SIX byte-identical copies. Without content-hash
     dedup a query returns the same hit six times and crowds out real matches.
  2. Three PDFs extract to zero text and would silently pass as empty strings,
     reporting "nothing found" for a question the corpus can actually answer.
  3. leanbench.db has a NULL trap: trade_pass IS NULL means the gate was never
     reached, not that it failed. COALESCE-ing it to 0 reports a 79.9 percent
     failure rate against a true 37.7 percent.
"""

import hashlib
import io
import json
import math
import os
import re
import sqlite3
import sys
import time
import traceback
from urllib.parse import quote

try:
    import regex as timeout_regex
except ImportError:  # Plain-text search remains available without this optional package.
    timeout_regex = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, "data", "cache")
CONFIG = os.path.join(ROOT, "sources.json")

STATE = {"docs": [], "built_at": None, "stats": {}}
MAX_REQUEST_CHARS = 1024 * 1024
MAX_QUERY_CHARS = 10000
MAX_READ_CHARS = 100000
DB_QUERY_TIMEOUT_S = 5.0
DB_PROGRESS_OPS = 1000
REGEX_SEARCH_TIMEOUT_S = 1.0


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


def log(m):
    sys.stderr.write("[research] %s\n" % m)
    sys.stderr.flush()


def reply(o):
    try:
        sys.stdout.write(json.dumps(o, ensure_ascii=False, allow_nan=False) + "\n")
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


def int_value(value, name, default, minimum=None, maximum=None):
    if value is None:
        value = default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Refused("%s must be an integer" % name)
    if isinstance(value, float) and (
            not math.isfinite(value) or not value.is_integer()):
        raise Refused("%s must be an integer" % name)
    value = int(value)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def string_value(value, name, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise Refused("%s must be a%s string" % (name, "" if allow_empty else " non-empty"))
    return value


class Refused(Exception):
    pass


def load_config():
    with open(CONFIG, encoding="utf-8") as f:
        config = json.load(f)
    if not isinstance(config, dict):
        raise Refused("Research sources configuration must be a JSON object.")
    if config.get("configured") is not True:
        raise Refused(
            "Research sources are not configured. Add current-account roots or "
            "databases to sources.json, then set configured to true."
        )
    return config


# --------------------------------------------------------------------------
# extraction
# --------------------------------------------------------------------------

def extract(path, ext):
    """Return (text, warning). Never raises: a bad file must not stop the index."""
    try:
        if ext in (".md", ".txt", ".py", ".csv"):
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read(), None
        if ext == ".docx":
            import docx
            d = docx.Document(path)
            from docx.oxml.ns import qn
            parts = []
            for p in d.element.body.iter(qn("w:p")):
                t = "".join(n.text or "" for n in p.iter(qn("w:t")))
                if t.strip():
                    parts.append(t)
            return "\n".join(parts), None
        if ext == ".pdf":
            import fitz
            doc = fitz.open(path)
            try:
                pages = [pg.get_text() for pg in doc]
                n = doc.page_count
            finally:
                doc.close()
            text = "\n".join(pages)
            # A PDF that yields almost nothing is a scan or an image. Say so,
            # rather than letting it pass as an empty string and reporting
            # "nothing found" for a source that genuinely has content.
            if n and len(text.strip()) / max(n, 1) < 200:
                return text, "extracted %d chars over %d pages: likely a scan, no text layer" % (len(text.strip()), n)
            return text, None
    except Exception as e:
        return "", "extract failed: %s: %s" % (type(e).__name__, e)
    return "", None


def cache_path(path, mtime, size):
    key = hashlib.sha1(("%s|%s|%s" % (path, mtime, size)).encode("utf8")).hexdigest()
    return os.path.join(CACHE, key + ".txt")


def write_cache(path, text):
    """Write one cache entry atomically so a killed index cannot poison it."""
    tmp = "%s.tmp-%d" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


def excluded(p, patterns):
    q = p.replace("\\", "/").lower()
    for pat in patterns:
        if pat.lower().replace("\\", "/") in q:
            return True
    return False


def cmd_index(m):
    cfg = load_config()
    os.makedirs(CACHE, exist_ok=True)
    force = m.get("force", False)
    if not isinstance(force, bool):
        raise Refused("force must be a boolean")
    exts = {str(ext).lower() for ext in cfg.get("extensions", [])}
    excl = [str(pattern) for pattern in cfg.get("exclude", [])]
    max_bytes = int_value(
        cfg.get("maxFileBytes"), "maxFileBytes", 3000000, minimum=1,
        maximum=100000000)
    max_files = int_value(
        cfg.get("maxFiles"), "maxFiles", 4000, minimum=1, maximum=100000)

    t0 = time.monotonic()
    docs, seen_hashes, warnings = [], {}, []
    scanned = skipped_dupe = extracted = cached = 0
    truncated = False

    for root in cfg.get("roots", []):
        if not isinstance(root, dict) or not isinstance(root.get("path"), str):
            warnings.append("ignored malformed root entry")
            continue
        base = root["path"]
        root_name = root.get("name")
        if not isinstance(root_name, str) or not root_name:
            root_name = os.path.basename(os.path.normpath(base)) or "root"
        priority = int_value(
            root.get("priority"), "root priority", 0, minimum=-1000, maximum=1000)
        if not os.path.isabs(base):
            base = os.path.normpath(os.path.join(ROOT, base))
        if not os.path.isdir(base):
            warnings.append("root missing: %s" % base)
            continue
        max_depth = root.get("depth")
        if max_depth is not None:
            max_depth = int_value(max_depth, "root depth", 0, minimum=0, maximum=100)
        base_depth = base.rstrip("\\/").count(os.sep)

        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort(key=str.casefold)
            filenames.sort(key=str.casefold)
            if excluded(dirpath, excl):
                dirnames[:] = []
                continue
            if max_depth is not None and dirpath.count(os.sep) - base_depth >= max_depth:
                dirnames[:] = []
            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in exts:
                    continue
                fp = os.path.join(dirpath, fn)
                if excluded(fp, excl):
                    continue
                try:
                    st = os.stat(fp)
                except OSError:
                    continue
                if st.st_size > max_bytes or st.st_size == 0:
                    continue
                if len(docs) >= max_files:
                    truncated = True
                    break
                scanned += 1

                cp = cache_path(fp, st.st_mtime_ns, st.st_size)
                wp = cp[:-4] + ".warn"
                text, warn = None, None
                if not force and os.path.exists(cp):
                    try:
                        with open(cp, encoding="utf-8") as f:
                            text = f.read()
                        cached += 1
                        # Warnings must survive caching. A scanned PDF that is
                        # flagged on the first index and silently forgotten on
                        # every later one is worse than never flagging it: the
                        # problem looks fixed.
                        if os.path.exists(wp):
                            with open(wp, encoding="utf-8") as f:
                                warn = f.read().strip() or None
                    except OSError:
                        text = None
                if text is None:
                    text, warn = extract(fp, ext)
                    extracted += 1
                    try:
                        write_cache(cp, text)
                        if warn:
                            write_cache(wp, warn)
                        elif os.path.exists(wp):
                            os.remove(wp)
                    except OSError:
                        pass
                if warn:
                    warnings.append("%s: %s" % (os.path.basename(fp), warn))
                if not text.strip():
                    continue

                # Dedupe on CONTENT, not path. Six identical copies of the same
                # file would otherwise return six identical hits.
                h = hashlib.sha256(text.encode("utf8", "replace")).hexdigest()
                if h in seen_hashes:
                    skipped_dupe += 1
                    seen_hashes[h]["also_at"].append(fp)
                    continue

                rec = {
                    "path": fp, "root": root_name, "priority": priority,
                    "mtime": st.st_mtime, "size": st.st_size, "ext": ext,
                    "text": text, "lower": text.lower(), "also_at": [],
                }
                seen_hashes[h] = rec
                docs.append(rec)
            if truncated:
                break
        if truncated:
            break

    if truncated:
        warnings.append("hit maxFiles=%d, index truncated" % max_files)

    STATE["docs"] = docs
    STATE["built_at"] = time.time()
    STATE["stats"] = {
        "files": len(docs), "scanned": scanned, "duplicates_skipped": skipped_dupe,
        "extracted": extracted, "from_cache": cached,
        "chars": sum(len(d["text"]) for d in docs),
        "seconds": round(time.monotonic() - t0, 2),
        "warnings": warnings[:20],
    }
    log("indexed %d files (%d chars) in %.1fs" %
        (len(docs), STATE["stats"]["chars"], STATE["stats"]["seconds"]))
    return STATE["stats"]


def ensure_index():
    if STATE["built_at"] is None:
        cmd_index({})


# --------------------------------------------------------------------------
# search
# --------------------------------------------------------------------------

def cmd_search(m):
    ensure_index()
    q = string_value(m.get("query"), "query").strip()
    if len(q) > MAX_QUERY_CHARS:
        raise Refused("query is too long")
    limit = int_value(m.get("limit"), "limit", 12, minimum=1, maximum=40)
    scope = m.get("scope")
    if scope is not None and not isinstance(scope, str):
        raise Refused("scope must be a string")
    use_regex = m.get("regex", False)
    if not isinstance(use_regex, bool):
        raise Refused("regex must be a boolean")

    if use_regex:
        if timeout_regex is None:
            raise Refused(
                "Safe regex search is unavailable. Retry as a plain-text search.")
        try:
            pat = timeout_regex.compile(q, timeout_regex.IGNORECASE)
        except timeout_regex.error as e:
            raise Refused("bad regex: %s" % e)
        regex_deadline = time.monotonic() + REGEX_SEARCH_TIMEOUT_S
    else:
        pat = None
        ql = q.lower()

    hits = []
    for d in STATE["docs"]:
        if scope and d["root"] != scope:
            continue
        positions = []
        if pat:
            remaining = regex_deadline - time.monotonic()
            if remaining <= 0:
                raise Refused("regex search timed out")
            try:
                for mm in pat.finditer(d["text"], timeout=remaining):
                    positions.append(mm.start())
                    if len(positions) >= 5:
                        break
            except TimeoutError:
                raise Refused("regex search timed out")
        else:
            i = d["lower"].find(ql)
            while i >= 0 and len(positions) < 5:
                positions.append(i)
                i = d["lower"].find(ql, i + 1)
        if not positions:
            continue

        snippets = []
        for p in positions[:3]:
            lo, hi = max(0, p - 130), min(len(d["text"]), p + 200)
            snippets.append(d["text"][lo:hi].replace("\n", " ").strip())

        hits.append({
            "path": d["path"],
            "name": os.path.basename(d["path"]),
            "root": d["root"],
            "mtime": time.strftime("%Y-%m-%d", time.localtime(d["mtime"])),
            "matches": len(positions),
            "snippets": snippets,
            "duplicates": len(d["also_at"]),
            # Priority first, then how often it matched, then recency. The drop
            # folder outranks the wider tree by construction.
            "_score": d["priority"] * 1000 + len(positions) * 10 + d["mtime"] / 1e9,
        })

    hits.sort(key=lambda h: -h["_score"])
    for h in hits:
        del h["_score"]
    return {"query": q, "hits": hits[:limit], "searched": len(STATE["docs"]),
            "total_matches": len(hits)}


def cmd_read(m):
    ensure_index()
    raw_want = string_value(m.get("path"), "path")
    want = raw_want.replace("\\", "/").lower()
    exact = [
        d for d in STATE["docs"]
        if d["path"].replace("\\", "/").lower() == want
    ]
    matches = exact or [
        d for d in STATE["docs"]
        if (d["path"].replace("\\", "/").lower().endswith("/" + want)
            or os.path.basename(d["path"]).lower() == want)
    ]
    if not matches:
        raise Refused("Not in the index: %s. Use corpus_search first, and pass a path it returned." % m.get("path"))
    if len(matches) > 1:
        raise Refused(
            "Ambiguous indexed path %r matches %d files. Pass the full path returned by "
            "corpus_search." % (raw_want, len(matches)))
    doc = matches[0]
    start = int_value(m.get("from"), "from", 0, minimum=0,
                      maximum=len(doc["text"]))
    requested_end = int_value(
        m.get("to"), "to", start + 6000, minimum=start,
        maximum=len(doc["text"]))
    end = min(requested_end, start + MAX_READ_CHARS)
    return {
        "path": doc["path"], "root": doc["root"],
        "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(doc["mtime"])),
        "chars": len(doc["text"]), "from": start, "to": end,
        "text": doc["text"][start:end],
        "truncated": end < len(doc["text"]),
    }


# --------------------------------------------------------------------------
# guarded SQL
# --------------------------------------------------------------------------

WRITE_WORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma)\b", re.I)

MANDATORY = "status='completed'"


def cmd_db(m):
    cfg = load_config()
    name = m.get("db") or "leanbench"
    if not isinstance(name, str):
        raise Refused("db must be a string")
    sql = string_value(m.get("sql"), "sql").strip().rstrip(";")
    if len(sql) > MAX_QUERY_CHARS:
        raise Refused("sql is too long")

    entry = next((d for d in cfg.get("databases", [])
                  if isinstance(d, dict) and d.get("name") == name), None)
    if not entry:
        raise Refused("Unknown database %r. Known: %s"
                      % (name, ", ".join(
                          str(d.get("name")) for d in cfg.get("databases", [])
                          if isinstance(d, dict) and d.get("name"))))
    db_path = entry.get("path")
    if not isinstance(db_path, str):
        raise Refused("Database %r has no valid path." % name)
    if not os.path.isabs(db_path):
        db_path = os.path.normpath(os.path.join(ROOT, db_path))
    if not os.path.isfile(db_path):
        raise Refused("Database file missing: %s" % db_path)

    if WRITE_WORDS.search(sql):
        raise Refused("Read only. That statement would modify or attach a database.")
    if not re.match(r"^\s*(select|with)\b", sql, re.I):
        raise Refused("Only SELECT (or WITH ... SELECT) is allowed.")

    low = sql.lower()

    # The single most consequential mistake available against this database.
    if re.search(r"coalesce\s*\(\s*trade_pass", low) or re.search(r"ifnull\s*\(\s*trade_pass", low):
        raise Refused(
            "Refused: COALESCE(trade_pass, 0) is wrong on this data. trade_pass IS NULL means "
            "the gate was never reached, not that it failed. It is non-NULL only where "
            "compile_pass=1 AND backtest_pass=1. Treating NULL as a failure reports a 79.9% "
            "failure rate against a true 37.7%, an inflation of 2.12x. "
            "Use: SUM(trade_pass=0) / SUM(trade_pass IS NOT NULL).")

    if re.search(r"select\s+\*\s+from\s+calls", low):
        raise Refused(
            "Refused: SELECT * FROM calls pulls lean_results_json, which is 107.9 MB, "
            "96.5% of the whole database. Name the columns you need.")

    warnings = []
    if "from calls" in low or "join calls" in low:
        if MANDATORY not in low.replace('"', "'").replace(" ", "").replace("status='completed'", MANDATORY):
            if "status" not in low:
                warnings.append(
                    "No status filter. `calls` holds 192 completed, 54 started (abandoned "
                    "in-flight), 13 error, and 5 excluded rows. Unfiltered aggregates mix them.")
        if "benchmark_version" not in low:
            warnings.append(
                "No benchmark_version filter. The table mixes v2.0 (129), v1.0 (55) and NULL (80), "
                "and the judge rubric changed between them. Every v2.0 completed row has "
                "overall_pass=0, which looks like a catastrophic regression if pooled.")
        if "excluded_reason" not in low:
            warnings.append("No excluded_reason filter. 5 rows are excluded (tooling_parity).")

    con = None
    deadline = time.monotonic() + DB_QUERY_TIMEOUT_S
    timed_out = False

    def stop_slow_query():
        nonlocal timed_out
        if time.monotonic() >= deadline:
            timed_out = True
            return 1
        return 0

    try:
        uri_path = quote(db_path.replace("\\", "/"), safe="/:")
        con = sqlite3.connect("file:%s?mode=ro" % uri_path, uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        con.set_progress_handler(stop_slow_query, DB_PROGRESS_OPS)
        cur = con.execute(sql)
        fetched = cur.fetchmany(201)
        rows = fetched[:200]
        rows_truncated = len(fetched) > 200
        cols = [c[0] for c in cur.description] if cur.description else []
        out = []
        for r in rows:
            d = {}
            for index, c in enumerate(cols):
                v = r[index]
                if isinstance(v, str) and len(v) > 300:
                    v = v[:300] + "…(truncated)"
                if isinstance(v, (bytes, bytearray, memoryview)):
                    raw = bytes(v)
                    preview = raw[:64].hex()
                    v = "<blob %d bytes: %s%s>" % (
                        len(raw), preview, "\u2026" if len(raw) > 64 else "")
                elif isinstance(v, float) and not math.isfinite(v):
                    v = str(v)
                d[c] = v
            out.append(d)
    except sqlite3.Error as e:
        if timed_out:
            raise Refused("SQL query timed out after %.1f seconds." % DB_QUERY_TIMEOUT_S)
        raise Refused("SQL error: %s" % e)
    finally:
        if con is not None:
            con.close()

    return {"db": name, "sql": sql, "columns": cols, "rows": out,
            "row_count": len(out), "truncated": rows_truncated,
            "warnings": warnings, "note": entry.get("note")}


def cmd_stats(_):
    ensure_index()
    return STATE["stats"]


def cmd_sources(_):
    cfg = load_config()
    return {"roots": [{k: r[k] for k in ("name", "path", "priority") if k in r}
                      for r in cfg.get("roots", []) if isinstance(r, dict)],
            "databases": [{"name": d["name"], "note": d.get("note")}
                          for d in cfg.get("databases", [])
                          if isinstance(d, dict) and "name" in d]}


COMMANDS = {"index": cmd_index, "search": cmd_search, "read": cmd_read,
            "db": cmd_db, "stats": cmd_stats, "sources": cmd_sources,
            "ping": lambda m: {"pong": True, "pid": os.getpid()}}


def handle_line(line):
    mid = None
    try:
        if line is None or len(line.encode("utf-8")) > MAX_REQUEST_CHARS:
            raise Refused("Request line is too large.")
        try:
            msg = json.loads(
                line,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError("invalid JSON constant %s" % value)),
            )
        except (json.JSONDecodeError, ValueError) as e:
            raise Refused("Invalid JSON: %s" % e)
        if not isinstance(msg, dict):
            raise Refused("Request must be a JSON object.")
        mid = msg.get("id")
        fn = COMMANDS.get(msg.get("cmd"))
        if fn is None:
            raise Refused("Unknown command: %s" % msg.get("cmd"))
        return {"id": mid, "ok": True, "result": fn(msg)}
    except Refused as e:
        return {"id": mid, "ok": False, "error": str(e), "detail": {}}
    except Exception as e:
        log("unhandled: %s" % traceback.format_exc())
        return {"id": mid, "ok": False,
                "error": "%s: %s" % (type(e).__name__, e), "detail": {}}


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
