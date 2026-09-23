import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import runtime_paths
from espeak_paths import install_espeak_data
from protocol import VoiceError

@unittest.skipUnless(sys.platform == "linux", "Linux eSpeak path installation")
class EspeakInstallationTests(unittest.TestCase):
    def test_copy_is_repeatable_but_refuses_changed_installed_data(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
            root = Path(folder); source = root / 'package'; source.mkdir()
            (source / 'phontab').write_bytes(b'phoneme data')
            with patch.object(runtime_paths, '_profile_root', root):
                result = install_espeak_data(root, source)
                self.assertEqual((result / 'phontab').read_bytes(), b'phoneme data')
                self.assertEqual(install_espeak_data(root, source), result)
                (result / 'phontab').write_bytes(b'changed')
                with self.assertRaises(VoiceError): install_espeak_data(root, source)
                self.assertEqual((result / 'phontab').read_bytes(), b'changed')

    def test_long_destination_fails_before_creating_data(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
            root = Path(folder)
            with patch.object(runtime_paths, '_profile_root', root):
                target = root / ('x' * 160)
                with self.assertRaises(VoiceError): install_espeak_data(target, root)
                self.assertFalse(target.exists())

    def test_package_symlink_is_refused(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
            root = Path(folder); source = root / 'package'; source.mkdir()
            (root / 'original').write_bytes(b'data')
            (source / 'phontab').symlink_to(root / 'original')
            with patch.object(runtime_paths, '_profile_root', root):
                with self.assertRaises(VoiceError): install_espeak_data(root, source)
                self.assertFalse((root / 'espeak-ng-data/phontab').exists())
