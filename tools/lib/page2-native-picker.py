#!/usr/bin/env python3
"""Drive an owned X11 native chooser, without replacing Electron dialogs."""
import argparse
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path


def inside(candidate, root):
    return candidate == root or root in candidate.parents


def owned_path(value, root, must_exist=True):
    candidate = Path(value).absolute()
    if not inside(candidate, root):
        raise RuntimeError('Picker files must remain inside QA storage')
    for part in [candidate, *candidate.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise RuntimeError('Picker files cannot follow symbolic links')
    resolved = candidate.resolve(strict=must_exist)
    if not inside(resolved, root):
        raise RuntimeError('Picker files must remain inside QA storage')
    return resolved


def window_is_owned(window, qa_process_id, property_value):
    """Accept only the exact QA process or its bounded native transient chain."""
    seen = set()
    for _ in range(8):
        if window in seen:
            return False
        seen.add(window)
        process = re.search(r'=\s*(\d+)', property_value(window, '_NET_WM_PID'))
        if process and int(process.group(1)) == qa_process_id:
            return True
        parent = re.search(r'window id # (0x[0-9a-f]+)', property_value(window, 'WM_TRANSIENT_FOR'), re.I)
        if not parent or parent.group(1) == '0x0':
            return False
        window = parent.group(1)
    return False


def enter_native_path(selected, key, paste_text, copy_selected_text, settle, *, directory=False):
    """Accept only after the native location field returns the complete path."""
    expected = str(selected)
    key('ctrl+l')
    settle()
    key('ctrl+a')
    # GTK can consume the first slash of character-by-character typing while
    # switching into location mode. A native clipboard paste is atomic.
    paste_text(expected)
    settle()
    key('ctrl+a')
    # GTK completes an existing directory with one trailing separator.
    accepted = (expected, expected + '/') if directory else (expected,)
    if copy_selected_text() not in accepted:
        raise RuntimeError('The native location entry did not return the exact QA path; no acceptance was sent')
    # Return can navigate into a directory and change the chooser's selection.
    # Electron's GTK chooser labels its accept action Open for both files and
    # directories. Alt+S starts Search and discards the verified location.
    key('alt+o')


def native_clipboard_modules():
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gdk, GLib, Gtk
    return Gdk, GLib, Gtk


def owned_window_summaries(windows, qa_process_id, property_value):
    """Read titles only after proving the window belongs to this QA launch."""
    result = []
    for window in dict.fromkeys(windows):
        if not window_is_owned(window, qa_process_id, property_value):
            continue
        result.append({
            'window': window,
            'title': property_value(window, '_NET_WM_NAME')[:512],
            'pidProperty': property_value(window, '_NET_WM_PID')[:128],
            'transientFor': property_value(window, 'WM_TRANSIENT_FOR')[:128],
        })
        if len(result) == 32:
            break
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--qa-root', required=True)
    parser.add_argument('--expected-profile-root', required=True)
    parser.add_argument('--qa-process-id', required=True, type=int)
    parser.add_argument('--request-path', required=True)
    parser.add_argument('--result-path', required=True)
    parser.add_argument('--launch-record', required=True)
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    if Path(args.expected_profile_root).resolve() != Path.home().resolve():
        raise RuntimeError('The picker must run as the expected current account')
    qa_root = Path(args.qa_root).resolve(strict=True)
    request_path = owned_path(args.request_path, qa_root)
    result_path = owned_path(args.result_path, qa_root, False)
    if os.stat(f'/proc/{args.qa_process_id}').st_uid != os.getuid():
        raise RuntimeError('The QA process belongs to another account')
    # Electron sets process.title on Linux, which overwrites /proc/cmdline.
    # Bind the launch's real userData readback to the direct parent and the OS
    # process start time instead of treating the rewritten title as argv.
    launch_path = owned_path(args.launch_record, qa_root)
    if launch_path.stat().st_size > 65536:
        raise RuntimeError('Native launch record exceeds 64 KiB')
    launch = json.loads(launch_path.read_text())
    fields = Path(f'/proc/{args.qa_process_id}/stat').read_text().rsplit(')', 1)[1].split()
    if (launch.get('qaProcessId') != args.qa_process_id
            or launch.get('runnerPid') != os.getppid()
            or int(fields[1]) != os.getppid()
            or launch.get('startTicks') != fields[19]):
        raise RuntimeError('The QA process does not match this runner and its recorded OS start time')
    user_data = owned_path(launch.get('userData', ''), qa_root)
    if not user_data.is_dir():
        raise RuntimeError('The QA launch must use a user-data directory inside QA storage')
    if request_path.stat().st_size > 65536:
        raise RuntimeError('Native picker request exceeds 64 KiB')
    request = json.loads(request_path.read_text())
    operation = request['operation']
    title = request.get('title', '')
    if operation not in ('select-path', 'cancel') or not title:
        raise RuntimeError('This helper requires a named native select-path or cancel dialog')
    selected = None
    if operation == 'select-path':
        selected = owned_path(request['selectedPath'], qa_root)
    if args.validate_only:
        result_path.write_text(json.dumps({'ok': True, 'validationOnly': True, 'nativeInputSent': False}) + '\n')
        return

    def property_value(window, prop):
        result = subprocess.run(['xprop', '-id', window, prop], capture_output=True, text=True)
        return result.stdout if result.returncode == 0 else ''

    def owned_window(window):
        return window_is_owned(window, args.qa_process_id, property_value)

    def matching_windows():
        search = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + re.escape(title) + '$'], capture_output=True, text=True)
        return [window for window in search.stdout.splitlines() if owned_window(window)]

    receipt = {'ok': False, 'nativeInputSent': False, 'operation': operation,
               'qaProcessId': args.qa_process_id, 'inputBackend': 'x11-owned-focus',
               'selectedPath': str(selected) if selected else None}
    try:
        deadline = time.monotonic() + 12
        windows = []
        while time.monotonic() < deadline:
            windows = matching_windows()
            if len(windows) == 1:
                break
            if len(windows) > 1:
                raise RuntimeError('More than one matching owned native chooser; no input was sent')
            time.sleep(0.1)
        if len(windows) != 1:
            visible = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '.*'], capture_output=True, text=True)
            receipt['ownedVisibleWindows'] = owned_window_summaries(visible.stdout.splitlines(), args.qa_process_id, property_value)
            raise RuntimeError('Could not bind the native chooser to the QA process; use its interactive X11 desktop')
        window = windows[0]
        receipt['window'] = window

        wm = subprocess.run(['xprop', '-root', '_NET_SUPPORTED'], capture_output=True, text=True).stdout
        if '_NET_ACTIVE_WINDOW' in wm:
            subprocess.run(['xdotool', 'windowactivate', '--sync', window], check=True, timeout=3)
        subprocess.run(['xdotool', 'windowfocus', '--sync', window], check=True, timeout=3)
        # X11's active/focus properties can settle before GTK has handled its
        # FocusIn event. Let that native event drain before the first shortcut.
        time.sleep(0.3)

        def check_focus():
            focused = subprocess.run(['xdotool', 'getwindowfocus'], capture_output=True, text=True, check=True).stdout.strip()
            receipt['lastFocusedWindow'] = focused
            if focused != window or not owned_window(window):
                receipt['focusedWindowOwned'] = owned_window(focused)
                raise RuntimeError('The owned native chooser lost focus; no further input was sent')

        def key(value):
            check_focus()
            receipt['nativeInputSent'] = True
            subprocess.run(['xdotool', 'key', '--clearmodifiers', '--delay', '50', value], check=True)

        # GTK rejects addressed XSendEvent key events. Use native XTest input
        # only after activating and verifying the exact owned chooser, and
        # stop immediately if another window takes focus.
        if operation == 'select-path':
            Gdk, GLib, Gtk = native_clipboard_modules()
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            context = GLib.MainContext.default()

            def settle(duration=0.2):
                deadline = time.monotonic() + duration
                while time.monotonic() < deadline:
                    while context.pending():
                        context.iteration(False)
                    time.sleep(0.01)

            def paste_text(text):
                check_focus()
                clipboard.set_text(text, -1)
                key('ctrl+v')
                # Serve the actual native chooser's selection request.
                settle()

            def copy_selected_text():
                check_focus()
                # If GTK ignores Copy, the value offered by Paste must not
                # satisfy the readback check. Never read the previous owner
                # clipboard: replace it with an owned marker before Copy.
                clipboard.set_text('ToolsEnabled QA copy proof ' + str(uuid.uuid4()), -1)
                key('ctrl+c')
                settle()
                copied = []
                clipboard.request_text(lambda _clipboard, text, _data: copied.append(text), None)
                deadline = time.monotonic() + 1
                while not copied and time.monotonic() < deadline:
                    settle(0.02)
                check_focus()
                return copied[0] if copied else None

            enter_native_path(selected, key, paste_text, copy_selected_text, settle, directory=selected.is_dir())
            receipt['locationEntryVerified'] = True
        else:
            key('Escape')
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and window in matching_windows():
            time.sleep(0.1)
        if window in matching_windows():
            raise RuntimeError('The native chooser did not close after its requested action')
        receipt['ok'] = True
    except Exception as error:
        receipt['error'] = str(error)
        captures = [('window', '')]
        if receipt.get('lastFocusedWindow') != receipt.get('window'):
            captures.append(('lastFocusedWindow', '.focus'))
        for key, suffix in captures:
            target = receipt.get(key)
            if not target or not owned_window(target):
                continue
            try:
                import gi
                gi.require_version('Gdk', '3.0')
                gi.require_version('GdkX11', '3.0')
                from gi.repository import Gdk, GdkX11
                native = GdkX11.X11Window.foreign_new_for_display(Gdk.Display.get_default(), int(target))
                pixels = Gdk.pixbuf_get_from_window(native, 0, 0, native.get_width(), native.get_height())
                pixels.savev(str(result_path) + suffix + '.png', 'png', [], [])
            except Exception as capture_error:
                receipt['captureError' + suffix] = str(capture_error)
        raise
    finally:
        result_path.write_text(json.dumps(receipt) + '\n')


if __name__ == '__main__':
    main()
