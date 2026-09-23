"""Explicit account-fenced paths before importing model/cache libraries."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from protocol import VoiceError

_profile_root = None
_asset_root = None
_model_root = None
_dll_handles = []


def _absolute(value) -> Path:
    if not isinstance(value, (str, Path)) or not Path(value).is_absolute():
        raise VoiceError("unsafe_path", "Speech runtime storage paths must be explicit absolute paths.")
    return Path(os.path.abspath(value))


def _reject_reparse(path):
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            attrs = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(attrs.st_mode) or getattr(attrs, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise VoiceError("unsafe_path", "Speech runtime paths must not contain reparse points.")


def fenced_path(value: str | Path) -> Path:
    path = _absolute(value)
    if _profile_root is None or not path.is_relative_to(_profile_root):
        raise VoiceError("unsafe_path", "The speech runtime path is outside the host's profile fence.")
    # No target stat happens until its lexical path is inside the trusted fence.
    _reject_reparse(path)
    return path


def asset_path(value: str | Path) -> Path:
    """Read-only installed assets may be in the host's explicit resource root.

    Writable state still uses fenced_path, never this separate read boundary.
    """
    path = _absolute(value)
    if _profile_root is None or not (path.is_relative_to(_profile_root)
                                    or (_asset_root is not None and path.is_relative_to(_asset_root))):
        raise VoiceError("unsafe_path", "Speech assets are outside the host's declared resource root.")
    _reject_reparse(path)
    return path


def configure_paths(profile_root: str | Path, data_root: str | Path, temp_root: str | Path,
                    asset_root=None, model_root=None) -> Path:
    global _profile_root, _asset_root, _model_root
    profile = _absolute(profile_root)
    if len(profile.parts) < 3:
        raise VoiceError("unsafe_path", "The host must provide a specific owner profile fence.")
    _reject_reparse(profile)
    _profile_root = profile
    _asset_root = None
    if asset_root is not None:
        assets = _absolute(asset_root)
        # The trusted host may choose an installation under Program Files, but
        # may never turn another Windows owner's profile into an asset source.
        if len(assets.parts) < 3 or (len(assets.parts) > 1 and assets.parts[1].casefold() == "users"
                                    and not assets.is_relative_to(profile)):
            raise VoiceError("unsafe_path", "Speech assets cannot come from another owner profile.")
        _reject_reparse(assets)
        _asset_root = assets
    data = fenced_path(data_root)
    _model_root = asset_path(model_root) if model_root is not None else fenced_path(data / "models")
    data.mkdir(parents=True, exist_ok=True)
    temp = fenced_path(temp_root)
    temp.mkdir(parents=True, exist_ok=True)
    for name, relative in {"HF_HOME": "cache/huggingface", "HF_HUB_CACHE": "cache/huggingface/hub",
                           "HF_TOKEN_PATH": "cache/no-credential", "XDG_CACHE_HOME": "cache",
                           "NUMBA_CACHE_DIR": "cache/numba", "NLTK_DATA": "cache/nltk"}.items():
        os.environ[name] = str(fenced_path(data / relative))
    os.environ["TEMP"] = os.environ["TMP"] = str(temp)
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["PYTHONNOUSERSITE"] = "1"
    # Credentials are accepted only in session JSON; never inherit ambient keys.
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "OPENAI_API_KEY", "OPENAI_ORG_ID",
                 "OPENAI_PROJECT_ID", "OPENAI_BASE_URL", "PIPECAT_SETUP_FILES",
                 "PHONEMIZER_ESPEAK_LIBRARY", "PHONEMIZER_ESPEAK_PATH", "ESPEAK_DATA_PATH"):
        os.environ.pop(name, None)
    if os.name == "nt":
        bins = []
        prefix = asset_path(sys.prefix)
        for component in ("cuda_runtime", "cuda_nvrtc", "cublas", "cudnn", "cufft", "curand", "nvjitlink"):
            directory = asset_path(prefix / "Lib/site-packages/nvidia" / component / "bin")
            if directory.is_dir():
                _dll_handles.append(os.add_dll_directory(str(directory)))
                bins.append(str(directory))
        base = _absolute(sys.base_prefix)
        if base.is_relative_to(profile):
            fenced_path(base)
        elif len(base.parts) > 1 and base.parts[1].casefold() == "users":
            raise VoiceError("unsafe_path", "The base Python interpreter is outside the host's profile fence.")
        else:
            _reject_reparse(base)
        os.environ["PATH"] = os.pathsep.join([*bins, str(prefix / "Scripts"), str(base)])
    elif sys.platform == "linux" and sys.prefix != sys.base_prefix:
        # Linux dlopen does not discover CUDA wheels just because Python can
        # import them. Load their exact, fenced SONAMEs before either engine
        # imports CUDA. This also works in the worker spawned by smoke_test.py,
        # without changing the system loader or inheriting LD_LIBRARY_PATH.
        import ctypes
        prefix = fenced_path(sys.prefix)
        libraries = prefix / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages/nvidia"
        for component, name in (("nvjitlink", "libnvJitLink.so.12"),
                                ("cuda_runtime", "libcudart.so.12"),
                                ("cuda_nvrtc", "libnvrtc.so.12"),
                                ("cublas", "libcublasLt.so.12"),
                                ("cublas", "libcublas.so.12"),
                                ("cufft", "libcufft.so.11"),
                                ("curand", "libcurand.so.10"),
                                ("cudnn", "libcudnn.so.9")):
            library = fenced_path(libraries / component / "lib" / name)
            if library.is_file():
                try:
                    _dll_handles.append(ctypes.CDLL(str(library), mode=ctypes.RTLD_GLOBAL))
                except OSError as error:
                    raise VoiceError("gpu_dependencies_unavailable", "The installed CUDA speech libraries could not load. Repair the voice runtime.", 503) from error
    return data


def model_paths(data: Path) -> dict[str, Path]:
    root = _model_root if _model_root is not None else fenced_path(data / "models")
    return {"whisper": asset_path(root / "whisper-large-v3-turbo"),
            "kokoro": asset_path(root / "kokoro-v1.0.onnx"),
            "voices": asset_path(root / "voices-v1.0.bin")}


def model_readiness(data: Path) -> dict:
    paths = model_paths(data)
    missing = []
    for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"):
        if not asset_path(paths["whisper"] / name).is_file():
            missing.append("whisper/" + name)
    for name in ("kokoro", "voices"):
        if not paths[name].is_file():
            missing.append(name)
    return {"ready": not missing, "missing": missing}
