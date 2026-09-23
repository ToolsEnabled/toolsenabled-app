"""Read-only regression coverage for Scribe's current persisted content.

The active session is allowed to keep changing while this suite runs.  Tests
first capture a quiescent, double-read filesystem snapshot, then inspect or
mutate only copies under the operating system's temporary directory.

Run:
    python test/test_current_content.py
"""

import hashlib
import json
import re
import shutil
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

from lxml import etree


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine"
sys.path.insert(0, str(ENGINE))

from docmodel import DocError, ScribeDoc, run_children_ok, w, w14  # noqa: E402


STATE_FILE = ROOT / "data" / "state.json"
DOCUMENTS = ROOT / "data" / "documents"
CHECKPOINTS = ROOT / "data" / "checkpoints"

REQUIRED_PACKAGE_PARTS = {
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
}
CONTINUATION_STATUSES = {
    "open",
    "accepting",
    "accepted",
    "dismissed",
    "stale",
    "superseded",
}
PROPOSAL_STATUSES = {
    "open",
    "accepted",
    "dismissed",
    "stale",
    "superseded",
}
SNAPSHOT_ATTEMPTS = 20


class SnapshotChanged(RuntimeError):
    """The persisted session changed while a candidate snapshot was copied."""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def portable_state_path(raw_path, local_dir):
    """Resolve persisted Windows paths after the repository has been moved."""
    name = str(raw_path).replace("\\", "/").rsplit("/", 1)[-1]
    configured = Path(raw_path)
    if configured.is_file():
        return configured
    return Path(local_dir) / name


def run_property_xml(paragraph):
    out = []
    for run in paragraph.findall(w("r")):
        prop = run.find(w("rPr"))
        out.append(None if prop is None else etree.tostring(prop))
    return out


def paragraph_id(paragraph):
    return paragraph.get(w14("paraId"))


def has_section_boundary(paragraph):
    props = paragraph.find(w("pPr"))
    return props is not None and props.find(w("sectPr")) is not None


def paths_equal(first, second):
    return str(Path(first).resolve()).casefold() == str(Path(second).resolve()).casefold()


def copy_with_hash_guard(source, destination):
    """Copy one source only if its bytes remain stable across the copy."""
    source = Path(source)
    destination = Path(destination)
    before = sha256(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    copied = sha256(destination)
    after = sha256(source)
    if before != copied or copied != after:
        raise SnapshotChanged("%s changed while it was copied" % source)
    return after


def read_state_bytes():
    raw = STATE_FILE.read_bytes()
    state = json.loads(raw.decode("utf-8"))
    if not isinstance(state, dict):
        raise SnapshotChanged("state.json did not contain an object")
    return raw, state


def capture_current_snapshot(root):
    """Copy one self-consistent view without locking or writing live content."""
    root = Path(root)
    last_error = None
    for attempt in range(SNAPSHOT_ATTEMPTS):
        candidate = root / ("attempt-%02d" % attempt)
        copied_sources = {}
        try:
            before_bytes, state = read_state_bytes()
            active_source = portable_state_path(state["docPath"], DOCUMENTS)
            if not active_source.is_file():
                raise SnapshotChanged("the active document was unavailable")

            document_sources_before = sorted(
                (path for path in DOCUMENTS.glob("*.docx") if path.is_file()),
                key=lambda path: path.name.casefold(),
            )
            document_names_before = [path.name for path in document_sources_before]
            document_copies = []
            active_copy = None

            for index, source in enumerate(document_sources_before):
                destination = candidate / "documents" / ("%03d-%s" % (index, source.name))
                copied_sources[source] = copy_with_hash_guard(source, destination)
                document_copies.append((source.name, destination))
                if paths_equal(source, active_source):
                    active_copy = destination

            if active_copy is None:
                active_copy = candidate / "active" / active_source.name
                copied_sources[active_source] = copy_with_hash_guard(
                    active_source, active_copy)
                document_copies.append((active_source.name, active_copy))

            checkpoint_records = state.get("checkpoints", [])
            if not isinstance(checkpoint_records, list):
                raise SnapshotChanged("state checkpoints were not a list")
            checkpoint_copies = []
            for index, record in enumerate(checkpoint_records):
                if not isinstance(record, dict) or "file" not in record:
                    raise SnapshotChanged("a checkpoint record was incomplete")
                source = portable_state_path(record["file"], CHECKPOINTS)
                destination = candidate / "checkpoints" / ("%03d.docx" % index)
                copied_sources[source] = copy_with_hash_guard(source, destination)
                checkpoint_copies.append(destination)

            # Give a concurrent atomic save a chance to publish its state update,
            # then prove both the state and every copied source are unchanged.
            time.sleep(0.01)
            after_bytes, _after_state = read_state_bytes()
            document_names_after = sorted(
                path.name for path in DOCUMENTS.glob("*.docx") if path.is_file())
            if before_bytes != after_bytes:
                raise SnapshotChanged("state.json changed during the snapshot")
            if sorted(document_names_before) != document_names_after:
                raise SnapshotChanged("the document archive set changed during the snapshot")
            for source, expected_hash in copied_sources.items():
                if sha256(source) != expected_hash:
                    raise SnapshotChanged("%s changed after it was copied" % source)

            copy_hashes = {
                destination: sha256(destination)
                for _name, destination in document_copies
            }
            copy_hashes.update({
                destination: sha256(destination)
                for destination in checkpoint_copies
            })
            return {
                "state": state,
                "active_name": active_source.name,
                "active": active_copy,
                "documents": document_copies,
                "checkpoints": checkpoint_copies,
                "copy_hashes": copy_hashes,
            }
        except (KeyError, OSError, UnicodeError, json.JSONDecodeError,
                SnapshotChanged) as error:
            last_error = error
            time.sleep(0.01)
    raise RuntimeError(
        "could not capture a stable current-content snapshot after %d attempts: %s"
        % (SNAPSHOT_ATTEMPTS, last_error)
    )


def capture_active_copy(root):
    """Capture just the active document for an isolated engine regression."""
    root = Path(root)
    last_error = None
    for attempt in range(SNAPSHOT_ATTEMPTS):
        try:
            before_bytes, state = read_state_bytes()
            source = portable_state_path(state["docPath"], DOCUMENTS)
            destination = root / ("attempt-%02d" % attempt) / source.name
            expected_hash = copy_with_hash_guard(source, destination)
            time.sleep(0.01)
            after_bytes, _after_state = read_state_bytes()
            if before_bytes != after_bytes or sha256(source) != expected_hash:
                raise SnapshotChanged("the active session changed during the copy")
            return destination
        except (KeyError, OSError, UnicodeError, json.JSONDecodeError,
                SnapshotChanged) as error:
            last_error = error
            time.sleep(0.01)
    raise RuntimeError(
        "could not capture a stable active document after %d attempts: %s"
        % (SNAPSHOT_ATTEMPTS, last_error)
    )


class CurrentContentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory(prefix="scribe-current-snapshot-")
        try:
            cls.snapshot = capture_current_snapshot(cls.tempdir.name)
        except Exception:
            cls.tempdir.cleanup()
            raise
        cls.state = cls.snapshot["state"]
        cls.active = cls.snapshot["active"]

    @classmethod
    def tearDownClass(cls):
        try:
            for path, expected_hash in cls.snapshot["copy_hashes"].items():
                if sha256(path) != expected_hash:
                    raise AssertionError("a read-only snapshot was unexpectedly modified")
        finally:
            cls.tempdir.cleanup()

    def test_active_document_model_invariants(self):
        self.assertEqual(
            self.snapshot["active_name"],
            str(self.state["docPath"]).replace("\\", "/").rsplit("/", 1)[-1],
        )
        self.assertTrue(self.active.is_file())
        self.assertTrue(zipfile.is_zipfile(self.active))

        doc = ScribeDoc(self.active).open()
        paragraphs = doc.paragraphs()
        model = doc.model()
        self.assertGreater(len(paragraphs), 0)
        self.assertEqual(model["count"], len(paragraphs))
        self.assertEqual(len(model["paragraphs"]), len(paragraphs))
        self.assertGreaterEqual(doc._stamped, 0)
        self.assertLessEqual(doc._stamped, len(paragraphs))

        ids = [paragraph_id(paragraph) for paragraph in paragraphs]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("00000000", ids)
        self.assertTrue(all(
            isinstance(pid, str) and re.fullmatch(r"[0-9A-Fa-f]{8}", pid)
            for pid in ids
        ))

        for paragraph, rendered in zip(paragraphs, model["paragraphs"]):
            with self.subTest(pid=paragraph_id(paragraph)):
                text = doc.text_of(paragraph)
                self.assertEqual(rendered["pid"], paragraph_id(paragraph))
                self.assertEqual(rendered["text"], text)
                self.assertEqual(rendered["hash"], doc.hash_of(paragraph))
                self.assertEqual(
                    "".join(run["text"] for run in rendered["runs"]),
                    text,
                )
                self.assertIsInstance(rendered["style"], str)
                self.assertTrue(rendered["style"])

    def test_active_docx_archive_and_xml_invariants(self):
        self.assertTrue(zipfile.is_zipfile(self.active))
        with zipfile.ZipFile(self.active) as archive:
            self.assertIsNone(archive.testzip())
            names = archive.namelist()
            self.assertEqual(len(names), len(set(names)))
            self.assertTrue(REQUIRED_PACKAGE_PARTS.issubset(names))
            xml_bytes = archive.read("word/document.xml")

        root = etree.fromstring(xml_bytes)
        paragraphs = root.findall(".//" + w("p"))
        direct_runs = sum(len(paragraph.findall(w("r"))) for paragraph in paragraphs)
        descendant_runs = sum(
            len(paragraph.findall(".//" + w("r"))) for paragraph in paragraphs)
        persisted_ids = [
            paragraph_id(paragraph)
            for paragraph in paragraphs
            if paragraph_id(paragraph) is not None
        ]

        self.assertGreater(len(paragraphs), 0)
        self.assertGreaterEqual(descendant_runs, direct_runs)
        self.assertEqual(
            len(persisted_ids),
            len(paragraphs),
            "every active paragraph id must already be persisted; "
            "ScribeDoc.open() must not mask missing ids by stamping the snapshot in memory",
        )
        self.assertEqual(len(persisted_ids), len(set(persisted_ids)))
        self.assertNotIn("00000000", persisted_ids)
        self.assertTrue(all(
            re.fullmatch(r"[0-9A-Fa-f]{8}", pid) for pid in persisted_ids))

    def test_document_archives_are_parseable_and_model_consistent(self):
        documents = self.snapshot["documents"]
        self.assertGreaterEqual(len(documents), 1)
        self.assertIn(self.active, [path for _name, path in documents])

        for name, path in documents:
            with self.subTest(document=name):
                self.assertTrue(zipfile.is_zipfile(path))
                with zipfile.ZipFile(path) as archive:
                    self.assertIsNone(archive.testzip())
                    names = archive.namelist()
                    self.assertEqual(len(names), len(set(names)))
                    etree.fromstring(archive.read("word/document.xml"))

                doc = ScribeDoc(path).open()
                paragraphs = doc.paragraphs()
                ids = [paragraph_id(paragraph) for paragraph in paragraphs]
                self.assertGreater(len(paragraphs), 0)
                self.assertEqual(len(ids), len(set(ids)))
                self.assertNotIn("00000000", ids)
                self.assertTrue(all(
                    isinstance(pid, str) and re.fullmatch(r"[0-9A-Fa-f]{8}", pid)
                    for pid in ids
                ))
                model = doc.model()
                self.assertEqual(model["count"], len(paragraphs))
                self.assertEqual(
                    [item["pid"] for item in model["paragraphs"]],
                    ids,
                )

    def test_state_checkpoints_and_continuation_anchors(self):
        rev = self.state.get("rev")
        self.assertIsInstance(rev, int)
        self.assertNotIsInstance(rev, bool)
        self.assertGreaterEqual(rev, 0)

        records = self.state.get("checkpoints")
        self.assertIsInstance(records, list)
        self.assertLessEqual(len(records), 50)
        self.assertEqual(len(records), len(self.snapshot["checkpoints"]))
        checkpoint_ids = [record.get("id") for record in records]
        self.assertTrue(all(isinstance(item, str) and item for item in checkpoint_ids))
        self.assertEqual(len(checkpoint_ids), len(set(checkpoint_ids)))
        checkpoint_revs = [record.get("rev") for record in records]
        self.assertTrue(all(
            isinstance(item, int) and not isinstance(item, bool)
            and 0 <= item <= rev
            for item in checkpoint_revs
        ))
        self.assertEqual(checkpoint_revs, sorted(checkpoint_revs))

        for record, path in zip(records, self.snapshot["checkpoints"]):
            with self.subTest(checkpoint=record.get("id")):
                self.assertIsInstance(record.get("file"), str)
                self.assertTrue(record["file"])
                self.assertTrue(path.is_file())
                self.assertTrue(zipfile.is_zipfile(path))
                with zipfile.ZipFile(path) as archive:
                    self.assertIsNone(archive.testzip())
                doc = ScribeDoc(path).open()
                ids = [paragraph_id(paragraph) for paragraph in doc.paragraphs()]
                self.assertGreater(len(ids), 0)
                self.assertEqual(len(ids), len(set(ids)))
                self.assertNotIn("00000000", ids)

        active_doc = ScribeDoc(self.active).open()
        active_by_id = {
            paragraph_id(paragraph): paragraph
            for paragraph in active_doc.paragraphs()
        }
        proposals = self.state.get("proposals", [])
        self.assertIsInstance(proposals, list)
        self.assertLessEqual(len(proposals), 30)
        proposal_ids = []
        for proposal in proposals:
            self.assertIsInstance(proposal, dict)
            self.assertIn(proposal.get("status"), PROPOSAL_STATUSES)
            for field in ("id", "anchor_pid"):
                self.assertIsInstance(proposal.get(field), str)
                self.assertTrue(proposal[field])
            self.assertIn(proposal.get("mode"), {"insert", "replace"})
            proposal_ids.append(proposal["id"])
            if proposal["status"] == "open":
                self.assertIsInstance(proposal.get("anchor_hash"), str)
                self.assertTrue(proposal["anchor_hash"])
                self.assertIn(proposal["anchor_pid"], active_by_id)
                paragraph = active_by_id[proposal["anchor_pid"]]
                self.assertEqual(
                    active_doc.hash_of(paragraph),
                    proposal["anchor_hash"],
                )
        self.assertEqual(len(proposal_ids), len(set(proposal_ids)))

        continuations = self.state.get("continuations", [])
        self.assertIsInstance(continuations, list)
        self.assertLessEqual(len(continuations), 10)
        continuation_ids = []
        for continuation in continuations:
            self.assertIsInstance(continuation, dict)
            self.assertIn(continuation.get("status"), CONTINUATION_STATUSES)
            for field in ("id", "anchor_pid", "anchor_hash"):
                self.assertIsInstance(continuation.get(field), str)
                self.assertTrue(continuation[field])
            continuation_ids.append(continuation["id"])
            if continuation["status"] == "open":
                self.assertIn(continuation["anchor_pid"], active_by_id)
                paragraph = active_by_id[continuation["anchor_pid"]]
                self.assertEqual(
                    active_doc.hash_of(paragraph),
                    continuation["anchor_hash"],
                )
        self.assertEqual(len(continuation_ids), len(set(continuation_ids)))


class CurrentContentEngineRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot_tempdir = tempfile.TemporaryDirectory(
            prefix="scribe-current-engine-snapshot-")
        try:
            cls.active_snapshot = capture_active_copy(cls.snapshot_tempdir.name)
            cls.active_snapshot_hash = sha256(cls.active_snapshot)
        except Exception:
            cls.snapshot_tempdir.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            if sha256(cls.active_snapshot) != cls.active_snapshot_hash:
                raise AssertionError(
                    "the immutable active-document snapshot was unexpectedly modified")
        finally:
            cls.snapshot_tempdir.cleanup()

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="scribe-current-content-")
        self.addCleanup(self.tempdir.cleanup)
        self.work = Path(self.tempdir.name) / self.active_snapshot.name
        copy_with_hash_guard(self.active_snapshot, self.work)
        self.doc = ScribeDoc(self.work).open()

    def safe_paragraphs(self, nonempty=None):
        candidates = []
        for paragraph in self.doc.paragraphs():
            runs = paragraph.findall(w("r"))
            text = self.doc.text_of(paragraph)
            if nonempty is True and not text:
                continue
            if nonempty is False and text:
                continue
            if any(not run_children_ok(run) for run in runs):
                continue
            if has_section_boundary(paragraph):
                continue
            candidates.append(paragraph)
        return candidates

    def safe_paragraph(self, nonempty=None):
        candidates = self.safe_paragraphs(nonempty)
        if not candidates:
            self.skipTest("the current document has no suitable editable paragraph")
        return candidates[0]

    def safe_body_anchor(self):
        body = self.doc._body()
        candidates = [
            paragraph for paragraph in self.safe_paragraphs()
            if paragraph.getparent() is body
        ]
        if not candidates:
            self.skipTest("the current document has no safe body-level paragraph")
        return candidates[0]

    def merge_pair(self):
        candidates = []
        for first in self.safe_paragraphs():
            second = first.getnext()
            if second is None or second.tag != w("p"):
                continue
            if first.getparent() is not second.getparent():
                continue
            if has_section_boundary(second):
                continue
            if any(not run_children_ok(run) for run in second.findall(w("r"))):
                continue
            score = (
                int(first.getparent() is self.doc._body()),
                int(bool(self.doc.text_of(first) or self.doc.text_of(second))),
                len(first.findall(w("r"))) + len(second.findall(w("r"))),
            )
            candidates.append((score, first, second))
        if not candidates:
            self.skipTest("the current document has no safely mergeable paragraph pair")
        _score, first, second = max(candidates, key=lambda item: item[0])
        return first, second

    def test_empty_find_is_rejected_without_mutating(self):
        paragraph = self.safe_paragraph()
        pid = paragraph_id(paragraph)
        before_xml = etree.tostring(paragraph)
        before_rev = self.doc.rev

        with self.assertRaisesRegex(DocError, "non-empty string"):
            self.doc.replace(
                pid,
                "",
                "must not land",
                expect_hash=self.doc.hash_of(paragraph),
                occurrence=1,
            )
        with self.assertRaisesRegex(DocError, "non-empty string"):
            self.doc.format(
                pid,
                "",
                expect_hash=self.doc.hash_of(paragraph),
                occurrence=1,
                b=True,
            )

        self.assertEqual(self.doc.rev, before_rev)
        self.assertEqual(etree.tostring(paragraph), before_xml)

    def test_format_requires_a_property_before_splitting(self):
        paragraph = self.safe_paragraph(nonempty=True)
        pid = paragraph_id(paragraph)
        text = self.doc.text_of(paragraph)
        before_xml = etree.tostring(paragraph)
        before_runs = len(paragraph.findall(w("r")))
        before_rev = self.doc.rev

        with self.assertRaisesRegex(DocError, "at least one formatting property"):
            self.doc.format(
                pid,
                text,
                expect_hash=self.doc.hash_of(paragraph),
            )

        self.assertEqual(self.doc.rev, before_rev)
        self.assertEqual(len(paragraph.findall(w("r"))), before_runs)
        self.assertEqual(etree.tostring(paragraph), before_xml)

        # False is still a real operation: it clears direct formatting and must
        # not be mistaken for a missing property.
        self.doc.format(
            pid,
            text,
            expect_hash=self.doc.hash_of(paragraph),
            b=False,
        )
        self.assertEqual(self.doc.rev, before_rev + 1)

    def test_identical_replace_is_an_explicit_noop(self):
        paragraph = self.safe_paragraph(nonempty=True)
        pid = paragraph_id(paragraph)
        phrase = self.doc.text_of(paragraph)
        before_xml = etree.tostring(paragraph)
        before_rev = self.doc.rev

        result = self.doc.replace(
            pid,
            phrase,
            phrase,
            expect_hash=self.doc.hash_of(paragraph),
        )

        self.assertTrue(result["noop"])
        self.assertEqual(result["before"], result["after"])
        self.assertEqual(self.doc.rev, before_rev)
        self.assertEqual(etree.tostring(paragraph), before_xml)

    def test_full_replace_preserves_all_run_property_shells(self):
        candidates = [
            paragraph for paragraph in self.safe_paragraphs(nonempty=True)
            if len(self.doc.text_of(paragraph)) <= 2000
        ] or self.safe_paragraphs(nonempty=True)
        if not candidates:
            self.skipTest("the current document has no safely replaceable paragraph")
        paragraph = max(candidates, key=lambda item: len(item.findall(w("r"))))
        pid = paragraph_id(paragraph)
        original = self.doc.text_of(paragraph)

        self.doc.format(
            pid,
            original,
            expect_hash=self.doc.hash_of(paragraph),
            b=True,
        )
        before_props = run_property_xml(paragraph)
        before_run_count = len(paragraph.findall(w("r")))

        result = self.doc.replace(
            pid,
            original,
            "Replacement paragraph.",
            expect_hash=self.doc.hash_of(paragraph),
        )
        self.assertEqual(result["after"], "Replacement paragraph.")
        self.assertEqual(len(paragraph.findall(w("r"))), before_run_count)
        self.assertEqual(run_property_xml(paragraph), before_props)
        span_texts = [span[3] for span in self.doc.spans(paragraph)]
        self.assertEqual("".join(span_texts), "Replacement paragraph.")
        self.assertTrue(all(not text for text in span_texts[1:]))

        self.doc.save()
        reopened = ScribeDoc(self.work).open()
        reopened_paragraph = reopened.para(pid)
        self.assertEqual(
            len(reopened_paragraph.findall(w("r"))),
            before_run_count,
        )
        self.assertEqual(run_property_xml(reopened_paragraph), before_props)
        self.assertEqual(
            reopened.text_of(reopened_paragraph),
            "Replacement paragraph.",
        )

    def test_current_trailing_empty_run_survives_replace(self):
        candidates = []
        for paragraph in self.safe_paragraphs(nonempty=True):
            spans = self.doc.spans(paragraph)
            if len(spans) > 1 and spans[-1][3] == "":
                candidates.append(paragraph)
        if not candidates:
            self.skipTest("the current document has no trailing empty run shell")
        paragraph = candidates[0]
        pid = paragraph_id(paragraph)
        original = self.doc.text_of(paragraph)
        before_props = run_property_xml(paragraph)
        before_run_count = len(paragraph.findall(w("r")))

        self.doc.replace(
            pid,
            original,
            original + " updated",
            expect_hash=self.doc.hash_of(paragraph),
        )
        self.assertEqual(len(paragraph.findall(w("r"))), before_run_count)
        self.assertEqual(run_property_xml(paragraph), before_props)
        self.assertEqual(self.doc.spans(paragraph)[-1][3], "")

    def test_deleted_paragraph_id_is_never_reused_in_session(self):
        anchor = self.safe_body_anchor()
        anchor_pid = paragraph_id(anchor)
        first = self.doc.insert(
            anchor_pid,
            "Same insertion",
            expect_hash=self.doc.hash_of(anchor),
        )
        self.doc.delete(first["pid"])
        second = self.doc.insert(
            anchor_pid,
            "Same insertion",
            expect_hash=self.doc.hash_of(anchor),
        )

        self.assertNotEqual(first["pid"], second["pid"])
        ids = [paragraph_id(paragraph) for paragraph in self.doc.paragraphs()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_empty_current_paragraph_can_be_typed_and_cleared(self):
        candidates = [
            paragraph for paragraph in self.safe_paragraphs(nonempty=False)
            if paragraph.findall(w("r"))
        ]
        if candidates:
            paragraph = candidates[0]
        else:
            anchor = self.safe_body_anchor()
            inserted = self.doc.insert(
                paragraph_id(anchor),
                "",
                expect_hash=self.doc.hash_of(anchor),
            )
            paragraph = self.doc.para(inserted["pid"])
        pid = paragraph_id(paragraph)
        before_props = run_property_xml(paragraph)
        before_run_count = len(paragraph.findall(w("r")))
        self.assertEqual(self.doc.text_of(paragraph), "")

        self.doc.set_text(pid, "Draft text", expect_hash=self.doc.hash_of(paragraph))
        self.assertEqual(self.doc.text_of(paragraph), "Draft text")
        self.doc.set_text(pid, "", expect_hash=self.doc.hash_of(paragraph))
        self.assertEqual(self.doc.text_of(paragraph), "")
        self.assertEqual(len(paragraph.findall(w("r"))), before_run_count)
        self.assertEqual(run_property_xml(paragraph), before_props)

    def test_direct_bold_heading_requires_explicit_body_style(self):
        """Explicit body style must not inherit a heading's direct bold run."""
        heading = next((
            paragraph for paragraph in self.safe_paragraphs(nonempty=True)
            if self.doc.style_of(paragraph).casefold() == "normal"
            and paragraph.find(w("r")) is not None
            and self.doc.run_props(paragraph.find(w("r"))).get("b")
        ), None)

        if heading is None:
            normal = next((
                paragraph for paragraph in self.safe_paragraphs(nonempty=True)
                if self.doc.style_of(paragraph).casefold() == "normal"
            ), None)
            if normal is None:
                anchor = self.safe_body_anchor()
                inserted = self.doc.insert(
                    paragraph_id(anchor),
                    "Dynamic heading",
                    style="Normal",
                    expect_hash=self.doc.hash_of(anchor),
                )
                normal = self.doc.para(inserted["pid"])
            self.doc.format(
                paragraph_id(normal),
                self.doc.text_of(normal),
                expect_hash=self.doc.hash_of(normal),
                b=True,
            )
            heading = normal

        heading_pid = paragraph_id(heading)
        self.assertEqual(self.doc.style_of(heading).casefold(), "normal")
        self.assertTrue(self.doc.run_props(heading.find(w("r"))).get("b"))

        inherited = self.doc.insert(
            heading_pid,
            "Unstyled insertion",
            expect_hash=self.doc.hash_of(heading),
        )
        inherited_run = self.doc.para(inherited["pid"]).find(w("r"))
        self.assertTrue(self.doc.run_props(inherited_run).get("b"))

        body = self.doc.insert(
            heading_pid,
            "Explicit body insertion",
            style="Normal",
            expect_hash=self.doc.hash_of(heading),
        )
        body_paragraph = self.doc.para(body["pid"])
        self.assertEqual(self.doc.style_of(body_paragraph).casefold(), "normal")
        self.assertEqual(self.doc.run_props(body_paragraph.find(w("r"))), {})

    def test_current_adjacent_paragraphs_merge_and_round_trip(self):
        first, second = self.merge_pair()
        first_pid = paragraph_id(first)
        second_pid = paragraph_id(second)
        first_text = self.doc.text_of(first)
        second_text = self.doc.text_of(second)
        expected_props = run_property_xml(first) + run_property_xml(second)
        expected_run_count = (
            len(first.findall(w("r"))) + len(second.findall(w("r"))))
        before_rev = self.doc.rev

        result = self.doc.merge(
            first_pid,
            second_pid,
            first_text,
            second_text,
            expect_first_hash=self.doc.hash_of(first),
            expect_second_hash=self.doc.hash_of(second),
        )

        merged = self.doc.para(first_pid)
        self.assertEqual(self.doc.rev, before_rev + 1)
        self.assertEqual(result["pid"], first_pid)
        self.assertEqual(result["removed_pid"], second_pid)
        self.assertEqual(result["join_offset"], len(first_text))
        self.assertEqual(result["after"], first_text + second_text)
        self.assertEqual(self.doc.text_of(merged), first_text + second_text)
        self.assertEqual(len(merged.findall(w("r"))), expected_run_count)
        self.assertEqual(run_property_xml(merged), expected_props)
        with self.assertRaisesRegex(DocError, "No paragraph"):
            self.doc.para(second_pid)

        self.doc.save()
        reopened = ScribeDoc(self.work).open()
        reopened_merged = reopened.para(first_pid)
        self.assertEqual(
            reopened.text_of(reopened_merged),
            first_text + second_text,
        )
        self.assertEqual(
            len(reopened_merged.findall(w("r"))),
            expected_run_count,
        )
        self.assertEqual(run_property_xml(reopened_merged), expected_props)
        with self.assertRaisesRegex(DocError, "No paragraph"):
            reopened.para(second_pid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
