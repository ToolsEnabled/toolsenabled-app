"""Keep the pinned Linux eSpeak data below its native path-buffer limit."""
from pathlib import Path
import hashlib
import shutil
import sys

from protocol import VoiceError
from runtime_paths import fenced_path


def install_espeak_data(data, source):
    source = fenced_path(source)
    target = fenced_path(Path(data) / 'espeak-ng-data')
    if len(str(target).encode()) >= 160:
        raise VoiceError('speech_path_too_long', 'Install the local speech runtime at a shorter path inside your profile.')
    # Walk only validated directories; never follow a package symlink.
    def copy_directory(src, dst):
        fenced_path(src)
        fenced_path(dst).mkdir(parents=True, exist_ok=True)
        for entry in src.iterdir():
            entry = fenced_path(entry)
            output = fenced_path(dst / entry.name)
            if entry.is_dir():
                copy_directory(entry, output)
            elif entry.is_file():
                if output.exists():
                    if hashlib.sha256(output.read_bytes()).digest() != hashlib.sha256(entry.read_bytes()).digest():
                        raise VoiceError('speech_data_mismatch', 'Installed speech phoneme data differs; repair the runtime installation.')
                else:
                    shutil.copyfile(entry, output)
    copy_directory(source, target)
    return target


def espeak_config(data):
    if sys.platform != 'linux':
        return None
    import espeakng_loader
    from kokoro_onnx.config import EspeakConfig
    library = fenced_path(espeakng_loader.get_library_path())
    source = fenced_path(espeakng_loader.get_data_path())
    selected = source if len(str(source).encode()) < 160 else fenced_path(Path(data) / 'espeak-ng-data')
    if len(str(selected).encode()) >= 160 or not fenced_path(selected / 'phontab').is_file():
        raise VoiceError('speech_data_missing', 'Run local speech setup at a shorter path inside your profile, then reconnect.', 503)
    return EspeakConfig(data_path=str(selected), lib_path=str(library))
