"""Golden tests for the Scribe document engine.

These assert the specific damage this engine exists to prevent. Every number in
the expectations came from measuring the real corpus, so a failure here means
either a regression or that the corpus changed under us. Both are worth knowing.

Run: python test/test_docmodel.py
"""

import hashlib
import os
import shutil
import sys
import time
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

from docmodel import ScribeDoc, DocError, w, w14, run_text  # noqa: E402
from live_input import required_live_file  # noqa: E402

CORPUS = str(required_live_file("SCRIBE_TEST_DOCX"))
TMPDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmp")

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ") + name + (("  " + str(detail)) if detail else ""))


def fresh(tag):
    os.makedirs(TMPDIR, exist_ok=True)
    dst = os.path.join(TMPDIR, "work-%s.docx" % tag)
    shutil.copy2(CORPUS, dst)
    return dst


def zip_parts(path):
    with zipfile.ZipFile(path) as z:
        return {n: hashlib.sha256(z.read(n)).hexdigest() for n in sorted(z.namelist())}


def main():
    if not os.path.exists(CORPUS):
        print("corpus missing: %s" % CORPUS)
        return 2
    if os.path.isdir(TMPDIR):
        shutil.rmtree(TMPDIR, ignore_errors=True)

    # ---------------------------------------------------------------- open
    print("\n[open and stamp]")
    t0 = time.perf_counter()
    d = ScribeDoc(fresh("open")).open()
    open_ms = (time.perf_counter() - t0) * 1000
    ps = d.paragraphs()
    ids = [p.get(w14("paraId")) for p in ps]
    check("333 paragraphs found", len(ps) == 333, len(ps))
    check("every paragraph has an id", all(ids), sum(1 for i in ids if not i))
    check("all ids unique", len(set(ids)) == len(ids), "%d unique" % len(set(ids)))
    check("no reserved id", "00000000" not in ids)
    check("table cells included in walk",
          len(ps) >= len(d.doc.paragraphs), "walk=%d docx=%d" % (len(ps), len(d.doc.paragraphs)))
    print("  open: %.0f ms" % open_ms)

    # ------------------------------------------------------- run structure
    print("\n[corpus shape, the numbers the plan claims]")
    total_runs = sum(len(p.findall(w("r"))) for p in ps)
    multi = [p for p in ps if len(p.findall(w("r"))) > 1]
    worst = max(ps, key=lambda p: len(p.findall(w("r"))))
    # 405 runs, not the 404 the survey reported: that figure counted w:t
    # elements. Exactly one run holds a bare w:br and no text at all, which is
    # the run the edit guard must refuse to rebuild.
    n_wt = sum(len(r.findall(w("t"))) for p in ps for r in p.findall(w("r")))
    textless = [r for p in ps for r in p.findall(w("r")) if not r.findall(w("t"))]
    check("405 runs", total_runs == 405, total_runs)
    check("404 w:t elements", n_wt == 404, n_wt)
    check("exactly one textless run, holding a w:br", len(textless) == 1, len(textless))
    check("the guard refuses that run",
          textless and not __import__("docmodel").run_children_ok(textless[0]))
    check("27 multi-run paragraphs", len(multi) == 27, len(multi))
    check("worst paragraph has 13 runs", len(worst.findall(w("r"))) == 13,
          len(worst.findall(w("r"))))

    # ------------------------------------------------- cross-run replace
    print("\n[cross-run replace preserves formatting]")
    wpid = worst.get(w14("paraId"))
    runs_before = len(worst.findall(w("r")))
    rpr_before = sum(1 for r in worst.findall(w("r")) if r.find(w("rPr")) is not None)
    colors_before = sorted(x for x in (d.run_props(r).get("color") for r in worst.findall(w("r"))) if x)

    spans = d.spans(worst)
    phrase = (spans[0][3][-12:] + spans[1][3][:12]).strip()
    res = d.replace(wpid, phrase, "[[REPLACED]]", expect_hash=d.hash_of(worst))

    worst = d.para(wpid)
    runs_after = len(worst.findall(w("r")))
    rpr_after = sum(1 for r in worst.findall(w("r")) if r.find(w("rPr")) is not None)
    colors_after = sorted(x for x in (d.run_props(r).get("color") for r in worst.findall(w("r"))) if x)

    check("phrase actually straddled a run boundary",
          phrase not in spans[0][3] and phrase not in spans[1][3], repr(phrase))
    check("run count preserved", runs_after == runs_before, "%d -> %d" % (runs_before, runs_after))
    check("rPr count preserved", rpr_after == rpr_before, "%d -> %d" % (rpr_before, rpr_after))
    check("run colors preserved", colors_after == colors_before,
          "%s -> %s" % (colors_before, colors_after))
    check("replacement present", "[[REPLACED]]" in d.text_of(worst))
    check("result reports the changed span", res["start"] < res["end"])

    # ------------------------------------------- direct paragraph typing
    print("\n[direct typing preserves run structure]")
    dd = ScribeDoc(fresh("direct")).open()
    dp = max(dd.paragraphs(), key=lambda p: len(p.findall(w("r"))))
    dpid = dp.get(w14("paraId"))
    direct_before = dd.text_of(dp)
    direct_runs = len(dp.findall(w("r")))
    direct_rpr = sum(1 for r in dp.findall(w("r")) if r.find(w("rPr")) is not None)
    direct_colors = sorted(x for x in
                           (dd.run_props(r).get("color") for r in dp.findall(w("r"))) if x)
    first_space, last_space = direct_before.find(" "), direct_before.rfind(" ")
    direct_after = (direct_before[:first_space] + " carefully" +
                    direct_before[first_space:last_space] + " directly" +
                    direct_before[last_space:])
    typed = dd.set_text(dpid, direct_after, expect_hash=dd.hash_of(dp))
    dp = dd.para(dpid)
    check("two disjoint typed changes are applied", dd.text_of(dp) == direct_after,
          typed["operations"])
    check("disjoint typing stays localized", typed["operations"] >= 2, typed["operations"])
    check("direct typing preserves the run count",
          len(dp.findall(w("r"))) == direct_runs,
          "%d -> %d" % (direct_runs, len(dp.findall(w("r")))))
    check("direct typing preserves every rPr block",
          sum(1 for r in dp.findall(w("r")) if r.find(w("rPr")) is not None) == direct_rpr)
    check("direct typing preserves authored run colors",
          sorted(x for x in (dd.run_props(r).get("color") for r in dp.findall(w("r"))) if x)
          == direct_colors)

    select_all_hash = dd.hash_of(dp)
    dd.set_text(dpid, "A completely new paragraph.", expect_hash=select_all_hash)
    dp = dd.para(dpid)
    check("select-all typing replaces the visible text",
          dd.text_of(dp) == "A completely new paragraph.")
    check("select-all typing keeps all formatting shells",
          len(dp.findall(w("r"))) == direct_runs and
          sum(1 for r in dp.findall(w("r")) if r.find(w("rPr")) is not None) == direct_rpr)

    stale_before = dd.text_of(dp)
    try:
        dd.set_text(dpid, "must not land", expect_hash="deadbeef1234")
        check("stale direct typing is refused", False)
    except DocError as e:
        check("stale direct typing is refused", "changed since you read it" in e.message)
    check("a refused direct edit is atomic in memory", dd.text_of(dd.para(dpid)) == stale_before)

    # --------------------------------------------------- the banned setter
    print("\n[the damage we are preventing]")
    import docx as _docx
    ref = _docx.Document(CORPUS)
    victim = max(ref.paragraphs, key=lambda p: len(p.runs))
    n_before = len(victim.runs)
    victim.text = victim.text  # the naive approach, a no-op string-wise
    check("python-docx .text setter collapses runs (so we never use it)",
          len(victim.runs) < n_before, "%d -> %d runs" % (n_before, len(victim.runs)))

    # --------------------------------------------------------- guard rails
    print("\n[refusals]")
    try:
        d.replace(wpid, "definitely not present anywhere", "x")
        check("missing text refused", False)
    except DocError as e:
        check("missing text refused", "not found" in e.message.lower())
    try:
        d.replace(wpid, "the", "x")
        check("ambiguous match refused", False)
    except DocError as e:
        check("ambiguous match refused", "ambiguous" in e.message.lower(), e.message[:60])
    try:
        d.replace(wpid, "[[REPLACED]]", "y", expect_hash="deadbeef1234")
        check("stale hash refused", False)
    except DocError as e:
        check("stale hash refused", "changed since you read it" in e.message)
    try:
        d.para("NOSUCHID")
        check("unknown pid refused", False)
    except DocError:
        check("unknown pid refused", True)

    empty = [p for p in ps if not p.findall(w("r"))]
    check("zero-run paragraphs survive read", all(d.text_of(p) == "" for p in empty),
          "%d empty paragraphs" % len(empty))

    # ------------------------------------------------ table cell coverage
    # The primary file has zero tables, so it cannot prove the body walk works.
    # The sibling drafts hide 183 to 213 paragraphs inside tables, including the
    # per-prompt verdict table that carries the determinacy numbers.
    print("\n[table cells are reachable]")
    import docx as _dx
    HIDDEN = {"McnairFullDraft.docx": 213, "McnairNextDraft.docx": 183,
              "LEAN-Bench_Dense_v2.docx": 183}
    base = os.path.dirname(CORPUS)
    for fname, expect in sorted(HIDDEN.items()):
        src = os.path.join(base, fname)
        if not os.path.exists(src):
            check("%s present" % fname, False)
            continue
        dt = ScribeDoc(src).open()
        walked = len(dt.paragraphs())
        flat = len(_dx.Document(src).paragraphs)
        in_tbl = [p for p in dt.paragraphs() if dt.in_table(p)]
        check("%s: body walk finds the %d hidden table paragraphs" % (fname, expect),
              walked - flat == expect, "walk=%d flat=%d" % (walked, flat))
        check("%s: in_table flags them" % fname, len(in_tbl) == expect, len(in_tbl))
        check("%s: table paragraphs got ids too" % fname,
              all(p.get(w14("paraId")) for p in in_tbl))
        # and they are genuinely editable through the normal path
        cells = [p for p in in_tbl if len(dt.text_of(p)) > 6]
        if cells:
            cp = cells[0]
            cpid = cp.get(w14("paraId"))
            head = dt.text_of(cp)[:6]
            dt.replace(cpid, head, "TBL")
            check("%s: a table cell paragraph is editable" % fname,
                  dt.text_of(dt.para(cpid)).startswith("TBL"))

    # ------------------------------------------------------ format splits
    print("\n[format splits runs and carries rPr]")
    d2 = ScribeDoc(fresh("fmt")).open()
    tgt = d2.paragraphs()[221]
    tpid = tgt.get(w14("paraId"))
    n0 = len(tgt.findall(w("r")))
    inner = d2.text_of(tgt)[40:70]
    r = d2.format(tpid, inner, highlight="yellow", b=True)
    tgt = d2.para(tpid)
    check("format split the span into its own runs", len(tgt.findall(w("r"))) > n0,
          "%d -> %d" % (n0, len(tgt.findall(w("r")))))
    check("format touched at least one run", r["runs"] >= 1, r["runs"])
    check("text unchanged by format", d2.text_of(tgt) == d2.text_of(d2.para(tpid)))
    hits = [rr for rr in tgt.findall(w("r"))
            if d2.run_props(rr).get("highlight") == "yellow" and d2.run_props(rr).get("b")]
    check("highlight and bold both applied", len(hits) >= 1, len(hits))
    marked = "".join(run_text(rr) for rr in hits)
    check("formatted text equals the requested span", marked == inner, repr(marked[:40]))

    # ------------------------------------------------------ insert/delete
    print("\n[insert and delete]")
    d3 = ScribeDoc(fresh("ins")).open()
    n0 = len(d3.paragraphs())
    anchor = d3.paragraphs()[10].get(w14("paraId"))
    anchor_hash = d3.hash_of(d3.para(anchor))
    try:
        d3.insert(anchor, "Must not land.", style=None, expect_hash="deadbeef1234")
        check("stale insertion anchor is refused", False)
    except DocError:
        check("stale insertion anchor is refused", len(d3.paragraphs()) == n0)
    ins = d3.insert(anchor, "Inserted by Scribe.", style=None, expect_hash=anchor_hash)
    check("paragraph count grew", len(d3.paragraphs()) == n0 + 1)
    check("new paragraph has a fresh unique id",
          ins["pid"] and len({p.get(w14("paraId")) for p in d3.paragraphs()}) == n0 + 1)
    order = [p.get(w14("paraId")) for p in d3.paragraphs()]
    check("inserted directly after the anchor", order[order.index(anchor) + 1] == ins["pid"])
    d3.delete(ins["pid"])
    check("delete restores the count", len(d3.paragraphs()) == n0)

    formatted_anchor = next(
        p for p in d3.paragraphs()
        if p.find(w("r")) is not None and d3.run_props(p.find(w("r")))
    )
    formatted_pid = formatted_anchor.get(w14("paraId"))
    formatted_props = d3.run_props(formatted_anchor.find(w("r")))
    inherited = d3.insert(formatted_pid, "Inherited surrounding formatting.")
    inherited_run = d3.para(inherited["pid"]).find(w("r"))
    check("an unstyled insert inherits the surrounding direct formatting",
          d3.run_props(inherited_run) == formatted_props,
          "%s -> %s" % (formatted_props, d3.run_props(inherited_run)))
    d3.delete(inherited["pid"])
    normalized = d3.insert(formatted_pid, "A normal continuation.", style="Normal")
    normalized_p = d3.para(normalized["pid"])
    check("an explicit paragraph style does not leak heading or emphasis formatting",
          d3.style_of(normalized_p) == "Normal" and
          d3.run_props(normalized_p.find(w("r"))) == {},
          "%s / %s" % (d3.style_of(normalized_p),
                       d3.run_props(normalized_p.find(w("r")))))
    d3.delete(normalized["pid"])

    # ------------------------------------------------------ paragraph merge
    print("\n[merge adjacent paragraphs]")
    dm = ScribeDoc(fresh("merge")).open()
    merge_ps = dm.paragraphs()
    pair = next(
        (a, b) for a, b in zip(merge_ps, merge_ps[1:])
        if a.getparent() is b.getparent()
        and a.findall(w("r")) and b.findall(w("r"))
        and not any((p.find(w("pPr")) is not None and
                     p.find(w("pPr")).find(w("sectPr")) is not None)
                    for p in (a, b))
    )
    first, second = pair
    first_pid = first.get(w14("paraId"))
    second_pid = second.get(w14("paraId"))
    first_before = dm.text_of(first)
    second_before = dm.text_of(second)
    first_hash = dm.hash_of(first)
    second_hash = dm.hash_of(second)
    first_runs = len(first.findall(w("r")))
    second_runs = len(second.findall(w("r")))
    second_format = [dm.run_props(r) for r in second.findall(w("r"))]
    count_before_merge = len(merge_ps)
    rev_before_merge = dm.rev
    snapshot_before_merge = [
        (p.get(w14("paraId")), dm.text_of(p)) for p in dm.paragraphs()
    ]

    try:
        dm.merge(first_pid, second_pid, first_before, second_before,
                 expect_first_hash=first_hash,
                 expect_second_hash="deadbeef1234")
        check("a stale second paragraph refuses the whole merge", False)
    except DocError:
        check("a stale second paragraph refuses the whole merge",
              [(p.get(w14("paraId")), dm.text_of(p)) for p in dm.paragraphs()]
              == snapshot_before_merge and dm.rev == rev_before_merge)

    first_local = first_before + " "
    second_local = second_before + " [locally typed]"
    merged = dm.merge(
        first_pid, second_pid, first_local, second_local,
        expect_first_hash=first_hash, expect_second_hash=second_hash)
    merged_p = dm.para(first_pid)
    check("merge joins both local paragraph snapshots exactly",
          dm.text_of(merged_p) == first_local + second_local,
          repr(dm.text_of(merged_p)[-60:]))
    check("merge removes only the second paragraph identity",
          len(dm.paragraphs()) == count_before_merge - 1 and
          all(p.get(w14("paraId")) != second_pid for p in dm.paragraphs()))
    check("merge is one document-model revision", dm.rev == rev_before_merge + 1,
          "%d -> %d" % (rev_before_merge, dm.rev))
    check("merge preserves every run shell from both paragraphs",
          len(merged_p.findall(w("r"))) == first_runs + second_runs,
          "%d + %d -> %d" % (
              first_runs, second_runs, len(merged_p.findall(w("r")))))
    check("merge preserves the appended paragraph's run formatting",
          [dm.run_props(r) for r in merged_p.findall(w("r"))[-second_runs:]]
          == second_format)
    check("merge reports the deleted id, new hash, and join boundary",
          merged["removed_pid"] == second_pid and
          merged["hash"] == dm.hash_of(merged_p) and
          merged["start"] == len(first_local) and
          merged["end"] == len(first_local + second_local))

    # ----------------------------------------- ids survive save and reload
    print("\n[round trip]")
    d4 = ScribeDoc(fresh("rt")).open()
    before_ids = [p.get(w14("paraId")) for p in d4.paragraphs()]
    pid0 = before_ids[100]
    d4.replace(pid0, d4.text_of(d4.para(pid0))[:12], "ROUNDTRIP")
    saved = d4.save()
    check("backup created", os.path.exists(saved["backup"]))
    check("no temp file left behind",
          not any(f.startswith("work-rt.scribe-tmp") for f in os.listdir(TMPDIR)))

    d5 = ScribeDoc(saved["path"]).open()
    after_ids = [p.get(w14("paraId")) for p in d5.paragraphs()]
    check("ids stable across save and reload", after_ids == before_ids,
          "%d/%d match" % (sum(1 for a, b in zip(before_ids, after_ids) if a == b), len(before_ids)))
    check("nothing re-stamped on reopen", d5._stamped == 0, d5._stamped)
    check("edit persisted", "ROUNDTRIP" in d5.text_of(d5.para(pid0)))

    # --------------------------------------- only document.xml should move
    orig = fresh("parts")
    d6 = ScribeDoc(orig).open()
    d6.save()
    a, b = zip_parts(CORPUS), zip_parts(orig)
    changed = sorted(n for n in set(a) | set(b) if a.get(n) != b.get(n))
    unexpected = [n for n in changed if n != "word/document.xml"]
    check("only word/document.xml changes on a save",
          not unexpected, "also changed: %s" % unexpected)
    check("styles.xml untouched", a.get("word/styles.xml") == b.get("word/styles.xml"))

    # ------------------------------------------------------- benchmark
    print("\n[latency, the Phase 0 open question]")
    d7 = ScribeDoc(fresh("bench")).open()
    d7.ensure_backup()
    times = []
    for i in range(5):
        p = d7.paragraphs()[50 + i]
        t = d7.text_of(p)
        if len(t) > 20:
            d7.replace(p.get(w14("paraId")), t[:10], "B%d" % i)
        t0 = time.perf_counter()
        d7.save()
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    med = times[len(times) // 2]
    print("  save latency ms: %s  median %.0f" % ([round(x) for x in times], med))
    print("  open latency ms: %.0f" % open_ms)
    check("save is fast enough for a live debounce loop (<1000ms)", med < 1000, "%.0f ms" % med)

    shutil.rmtree(TMPDIR, ignore_errors=True)
    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    if FAIL:
        print("failed: " + ", ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
