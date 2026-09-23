import stat
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import runtime_paths
from protocol import VoiceError


class PathFenceTests(unittest.TestCase):
    def test_missing_and_relative_bootstrap_paths_fail(self):
        for value in (None, "", "relative-directory"):
            with self.assertRaises(VoiceError):
                runtime_paths._absolute(value)

    def test_outside_fence_is_rejected_before_filesystem_access(self):
        root = Path.cwd()
        with patch.object(runtime_paths, "_profile_root", root), patch.object(Path, "lstat") as probe:
            with self.assertRaises(VoiceError):
                runtime_paths.fenced_path(root.parent / "outside-runtime-fence")
            probe.assert_not_called()

    def test_reparse_point_is_never_followed(self):
        root = Path.cwd()
        attributes = SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        with patch.object(runtime_paths, "_profile_root", root), patch.object(Path, "lstat", return_value=attributes):
            with self.assertRaises(VoiceError):
                runtime_paths.fenced_path(root / "models")

    def test_read_only_resources_never_expand_the_writable_fence(self):
        root = Path.cwd()
        assets = root.parent / "installed-fixture"
        with patch.object(runtime_paths, "_profile_root", root), patch.object(runtime_paths, "_asset_root", assets), patch.object(runtime_paths, "_reject_reparse"):
            self.assertEqual(runtime_paths.asset_path(assets / "models/model.bin"), assets / "models/model.bin")
            with self.assertRaises(VoiceError):
                runtime_paths.fenced_path(assets / "cache")

    def test_models_come_from_declared_assets_without_a_user_data_copy(self):
        root = Path.cwd()
        assets = root / "installed-fixture"
        with patch.object(runtime_paths, "_profile_root", root), patch.object(runtime_paths, "_asset_root", assets), patch.object(runtime_paths, "_model_root", assets / "models"), patch.object(runtime_paths, "_reject_reparse"):
            self.assertEqual(runtime_paths.model_paths(root / "state")["kokoro"], assets / "models/kokoro-v1.0.onnx")


if __name__ == "__main__":
    unittest.main()
