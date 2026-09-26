"""Fixed X11 input helper. JSON arrives on stdin; no shell or clipboard access."""
import ctypes as c
import json
import signal
import sys
import time


def main():
    action = json.loads(sys.stdin.read(32768))
    x = c.CDLL('libX11.so.6')
    xt = c.CDLL('libXtst.so.6')
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XOpenDisplay.restype = c.c_void_p
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError('X11 unavailable')
    for name, args, result in [
        ('XDefaultRootWindow', [c.c_void_p], c.c_ulong),
        ('XFlush', [c.c_void_p], c.c_int),
        ('XCloseDisplay', [c.c_void_p], c.c_int),
        ('XSync', [c.c_void_p, c.c_int], c.c_int),
        ('XKeysymToKeycode', [c.c_void_p, c.c_ulong], c.c_ubyte),
        ('XStringToKeysym', [c.c_char_p], c.c_ulong),
        ('XDisplayKeycodes', [c.c_void_p, c.POINTER(c.c_int), c.POINTER(c.c_int)], c.c_int),
        ('XGetKeyboardMapping', [c.c_void_p, c.c_ubyte, c.c_int, c.POINTER(c.c_int)], c.POINTER(c.c_ulong)),
        ('XChangeKeyboardMapping', [c.c_void_p, c.c_int, c.c_int, c.POINTER(c.c_ulong), c.c_int], c.c_int),
        ('XFree', [c.c_void_p], c.c_int),
    ]:
        fn = getattr(x, name)
        fn.argtypes, fn.restype = args, result
    x.XQueryPointer.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
                               c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint)]
    xt.XTestFakeMotionEvent.argtypes = [c.c_void_p, c.c_int, c.c_int, c.c_int, c.c_ulong]
    xt.XTestFakeButtonEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
    xt.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
    held_keys, held_buttons = set(), set()

    def key(code, down):
        if not code:
            raise RuntimeError('Key unavailable')
        xt.XTestFakeKeyEvent(display, code, int(down), 0)
        (held_keys.add if down else held_keys.discard)(code)
        x.XFlush(display)

    def button(code, down):
        xt.XTestFakeButtonEvent(display, code, int(down), 0)
        (held_buttons.add if down else held_buttons.discard)(code)
        x.XFlush(display)

    def move(px, py):
        root, child, rx, ry, wx, wy, mask = c.c_ulong(), c.c_ulong(), c.c_int(), c.c_int(), c.c_int(), c.c_int(), c.c_uint()
        x.XQueryPointer(display, x.XDefaultRootWindow(display), c.byref(root), c.byref(child), c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask))
        for step in range(1, 19):
            xt.XTestFakeMotionEvent(display, -1, round(rx.value + (px - rx.value) * step / 18), round(ry.value + (py - ry.value) * step / 18), 0)
            x.XFlush(display)
            time.sleep(0.016)

    def terminate(_sig, _frame):
        raise InterruptedError('stopped')

    signal.signal(signal.SIGTERM, terminate)
    try:
        kind = action['action']
        if kind in ('move', 'click', 'drag', 'scroll'):
            move(action['x'], action['y'])
        if kind == 'click':
            code = {'left': 1, 'middle': 2, 'right': 3}[action['button']]
            for _ in range(action['clickCount']):
                button(code, True); button(code, False); time.sleep(0.06)
        elif kind == 'drag':
            button(1, True); move(action['toX'], action['toY']); button(1, False)
        elif kind == 'scroll':
            code = {'up': 4, 'down': 5, 'left': 6, 'right': 7}[action['direction']]
            for _ in range(action['amount']):
                button(code, True); button(code, False)
        elif kind == 'key':
            aliases = {'Control': 'Control_L', 'Alt': 'Alt_L', 'Shift': 'Shift_L', 'Meta': 'Super_L',
                       'Enter': 'Return', 'Space': 'space', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'PageUp': 'Prior', 'PageDown': 'Next'}
            codes = [x.XKeysymToKeycode(display, x.XStringToKeysym(aliases.get(part, part.lower() if len(part) == 1 else part).encode())) for part in action['key'].split('+')]
            if not all(codes):
                raise RuntimeError('Key unavailable')
            for code in codes: key(code, True)
            for code in reversed(codes): key(code, False)
        elif kind == 'type':
            low, high, width = c.c_int(), c.c_int(), c.c_int()
            x.XDisplayKeycodes(display, c.byref(low), c.byref(high))
            mapping = x.XGetKeyboardMapping(display, low.value, high.value - low.value + 1, c.byref(width))
            try:
                spares = [code for code in range(high.value, low.value - 1, -1)
                          if all(mapping[(code - low.value) * width.value + index] == 0 for index in range(width.value))]
                symbols = [{'\n': 0xff0d, '\t': 0xff09}.get(char, ord(char) if ord(char) < 256 else 0x1000000 + ord(char)) for char in action['text']]
                planned, assigned = {}, []
                for symbol in set(symbols):
                    found = next(((code, index == 1) for code in range(low.value, high.value + 1)
                                  for index in range(min(2, width.value))
                                  if mapping[(code - low.value) * width.value + index] == symbol), None)
                    if found:
                        planned[symbol] = found
                    else:
                        if not spares: raise RuntimeError('Text needs more unmapped keys than this layout provides')
                        spare = spares.pop()
                        assigned.append((spare, symbol))
                        planned[symbol] = (spare, False)
                empty = (c.c_ulong * width.value)()
                try:
                    # Install once for the entire input. Reassigning one key
                    # for every character races the application's keymap cache.
                    for spare, symbol in assigned:
                        replacement = (c.c_ulong * width.value)(*([symbol] * width.value))
                        x.XChangeKeyboardMapping(display, spare, width.value, replacement, 1)
                    x.XSync(display, 0)
                    time.sleep(0.04)
                    shift = x.XKeysymToKeycode(display, x.XStringToKeysym(b'Shift_L'))
                    for symbol in symbols:
                        code, shifted = planned[symbol]
                        if shifted: key(shift, True)
                        key(code, True); key(code, False)
                        if shifted: key(shift, False)
                        x.XSync(display, 0)
                        time.sleep(0.001)
                    time.sleep(0.04)
                finally:
                    for spare, _ in assigned:
                        x.XChangeKeyboardMapping(display, spare, width.value, empty, 1)
            finally:
                x.XFree(mapping)
        elif kind == 'release':
            for code in (1, 2, 3): button(code, False)
            for name in ('Control_L', 'Alt_L', 'Shift_L', 'Super_L'):
                code = x.XKeysymToKeycode(display, x.XStringToKeysym(name.encode()))
                if code: key(code, False)
        x.XSync(display, 0)
    finally:
        for code in list(held_keys): key(code, False)
        for code in list(held_buttons): button(code, False)
        x.XSync(display, 0)
        x.XCloseDisplay(display)
    print('{"ok":true}')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
