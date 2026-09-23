"""Fail-closed tests for opt-in live Scribe input paths."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from live_input import required_live_file


class LiveInputTests(unittest.TestCase):
    def setUp(self):
        self.prior = os.environ.pop("SCRIBE_TEST_DOCX", None)

    def tearDown(self):
        if self.prior is None:
            os.environ.pop("SCRIBE_TEST_DOCX", None)
        else:
            os.environ["SCRIBE_TEST_DOCX"] = self.prior

    def test_missing_input_has_no_fallback(self):
        with self.assertRaisesRegex(RuntimeError, "is required"):
            required_live_file("SCRIBE_TEST_DOCX")

    def test_sibling_profile_refuses_before_realpath_probe(self):
        profile = os.path.abspath(os.environ.get("USERPROFILE") or str(Path.home()))
        candidate = os.path.join(os.path.dirname(profile), "DefinitelyOtherProfile", "never.docx")
        os.environ["SCRIBE_TEST_DOCX"] = candidate
        with mock.patch("live_input.os.path.realpath") as realpath:
            with self.assertRaisesRegex(RuntimeError, "different user profile"):
                required_live_file("SCRIBE_TEST_DOCX")
        realpath.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows namespace rule")
    def test_unc_refuses_before_realpath_probe(self):
        os.environ["SCRIBE_TEST_DOCX"] = r"\\localhost\untrusted-share\fixture.docx"
        with mock.patch("live_input.os.path.realpath") as realpath:
            with self.assertRaisesRegex(RuntimeError, "UNC or device namespace"):
                required_live_file("SCRIBE_TEST_DOCX")
        realpath.assert_not_called()

    def test_existing_explicit_file_is_returned(self):
        profile = Path(os.environ.get("USERPROFILE") or str(Path.home()))
        profile_temp = profile / "AppData" / "Local" / "Temp"
        with tempfile.NamedTemporaryFile(suffix=".docx", dir=profile_temp) as fixture:
            os.environ["SCRIBE_TEST_DOCX"] = fixture.name
            self.assertEqual(required_live_file("SCRIBE_TEST_DOCX"), Path(os.path.realpath(fixture.name)))


if __name__ == "__main__":
    unittest.main()
