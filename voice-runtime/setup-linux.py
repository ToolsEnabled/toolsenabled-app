"""Install the existing speech runtime in an explicit Linux owner directory."""
import argparse
import os
import platform
import subprocess
import sys
import venv
from pathlib import Path

from runtime_paths import configure_paths, fenced_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-root', required=True)
    parser.add_argument('--data-root', required=True)
    parser.add_argument('--temp-root', required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or platform.machine() not in ('x86_64', 'AMD64'):
        parser.error('This installer is for Linux x86-64')
    if sys.version_info[:2] != (3, 12):
        parser.error('Run this installer with the tested CPython 3.12 interpreter')
    data = configure_paths(args.profile_root, args.data_root, args.temp_root)
    environment = fenced_path(data / 'venv')
    python = fenced_path(environment / 'bin/python')
    if not python.is_file():
        # Copies keep the interpreter inside the same path fence as the models.
        venv.EnvBuilder(with_pip=True, symlinks=False).create(environment)
    fenced_path(python)
    prefix = subprocess.check_output([str(python), '-I', '-c', 'import sys;print(sys.prefix)'], text=True).strip()
    if Path(prefix) != environment:
        raise RuntimeError('The interpreter does not belong to the selected voice environment')
    source = Path(__file__).absolute().parent
    env = {**os.environ, 'PIP_CONFIG_FILE': os.devnull, 'PIP_INDEX_URL': 'https://pypi.org/simple',
        'PIP_EXTRA_INDEX_URL': '', 'PIP_CACHE_DIR': str(fenced_path(data / 'pip-cache')), 'PIP_NO_INPUT': '1'}
    pip = [str(python), '-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:']
    subprocess.run([*pip, '--no-binary=docopt', '-c', str(source / 'requirements.lock.txt'),
        '-r', str(source / 'requirements.txt')], env=env, check=True)
    # These distributions share module files. Always install the GPU wheel last.
    subprocess.run([*pip, '--force-reinstall', '--no-deps', 'onnxruntime-gpu==1.24.4'], env=env, check=True)
    subprocess.run([str(python), '-I', '-m', 'pip', 'check'], env=env, check=True)
    from espeak_paths import install_espeak_data
    install_espeak_data(data, environment / 'lib/python3.12/site-packages/espeakng_loader/espeak-ng-data')
    print('Voice runtime Python: ' + str(python))


if __name__ == '__main__':
    main()
